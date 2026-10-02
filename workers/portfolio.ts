// Portfolio tracking for the bot: every token a Hopr wallet holds on all 7 chains.
//
// Speed comes from doing one request per chain:
// - EVM (Base, Arbitrum, BNB, Robinhood, Arc): a single Multicall3 eth_call
//   reads the native balance plus balanceOf/decimals/symbol of every tracked
//   token. Multicall3 is deployed at the same address on all five chains.
// - Solana: getTokenAccountsByOwner (SPL + Token-2022) finds every token.
// - NEAR: FastNEAR's account index lists every NEP-141 held.
// Reads are hedged across RPCs (rpcPool.jsonRpcRace), each chain has its own
// deadline, and the last good read per chain is kept in KV so a down RPC
// shows the last known balance instead of nothing.
//
// Tracked tokens = tokens the user traded or opened in the bot, plus tokens
// discovered by Alchemy (EVM, when ALCHEMY_API_KEY is set), the Solana token
// accounts, and FastNEAR. Prices and 24h change come from DexScreener, one
// request per chain (30 tokens each).

import { Interface } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { jsonRpcRace } from '../src/services/rpcPool';
import { getNearBalance, getTokenMetadata, NEAR_CHAIN_ID, type NearRpcOptions } from '../src/services/nearService';
import { alchemyNetwork, alchemyUrl, SOLANA_CHAIN_ID, type RpcEnv } from './rpcConfig';
import { nativePricesUsd } from './balances';

export const EVM_PORTFOLIO_CHAINS = [8453, 42161, 56, 4663, 5042];
export const NATIVE = 'native';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Arc's gas coin seen through its ERC-20 view; the native read already covers it. */
const ARC_NATIVE_VIEW = '0x3600000000000000000000000000000000000000';
const MAX_TOKENS_PER_CHAIN = 60;
const CHAIN_DEADLINE_MS = 5_000;
const MEMORY_TTL_MS = 15_000;
const LAST_KNOWN_TTL_SECONDS = 30 * 24 * 60 * 60;

const NATIVE_SYMBOL: Record<number, string> = { 8453: 'ETH', 42161: 'ETH', 56: 'BNB', 4663: 'ETH', 5042: 'USDC', [SOLANA_CHAIN_ID]: 'SOL', [NEAR_CHAIN_ID]: 'NEAR' };
const NATIVE_DECIMALS: Record<number, number> = { [SOLANA_CHAIN_ID]: 9, [NEAR_CHAIN_ID]: 24 };
const DEXSCREENER_SLUG: Record<number, string> = { 8453: 'base', 42161: 'arbitrum', 56: 'bsc', 4663: 'robinhood', 5042: 'arc', [SOLANA_CHAIN_ID]: 'solana', [NEAR_CHAIN_ID]: 'near' };

const multicall = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
const erc20 = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export interface PortfolioEnv extends RpcEnv {
  TELEGRAM_STATE?: KVNamespace;
  CACHE?: KVNamespace;
}

export interface PortfolioWallet {
  evmAddress?: string | null;
  solanaAddress?: string | null;
  nearAddress?: string | null;
}

export interface TrackedToken {
  chainId: number;
  address: string;
  symbol?: string;
}

export interface Holding {
  chainId: number;
  /** Token address, or 'native' for the chain's coin. */
  address: string;
  symbol: string;
  decimals: number;
  /** Smallest units, as a decimal string. */
  amount: string;
  priceUsd: number | null;
  valueUsd: number | null;
  change24h: number | null;
  /** Traded or opened in the bot: shown even without a market price. */
  tracked: boolean;
}

export interface Portfolio {
  holdings: Holding[];
  totalUsd: number;
  observedAt: number;
  /** Chains that could not be read live (last known balances are shown when available). */
  staleChains: number[];
  failedChains: number[];
  /** Chains still loading when a time budget ran out (home screen). */
  pendingChains: number[];
}

type RawBalance = { address: string; amount: string; decimals: number; symbol?: string };
type ChainRead = { chainId: number; balances: RawBalance[]; stale: boolean; failed: boolean };

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('deadline')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

const kv = (env: PortfolioEnv) => env.TELEGRAM_STATE ?? env.CACHE;

/** Run a chain read; on failure fall back to its last known result (kept 30 days). */
async function readWithMemory(env: PortfolioEnv, chainId: number, owner: string, reader: () => Promise<RawBalance[]>): Promise<ChainRead> {
  const key = `pf:v1:${chainId}:${owner.toLowerCase()}`;
  try {
    const balances = await withDeadline(reader(), CHAIN_DEADLINE_MS);
    await kv(env)?.put(key, JSON.stringify(balances), { expirationTtl: LAST_KNOWN_TTL_SECONDS }).catch(() => undefined);
    return { chainId, balances, stale: false, failed: false };
  } catch {
    const raw = await kv(env)?.get(key).catch(() => null);
    try {
      if (raw) return { chainId, balances: JSON.parse(raw) as RawBalance[], stale: true, failed: false };
    } catch {
      // fall through
    }
    return { chainId, balances: [], stale: false, failed: true };
  }
}

/** EVM token discovery through Alchemy (only when ALCHEMY_API_KEY is set). */
async function discoverEvmTokens(chainId: number, owner: string, env: RpcEnv, fetchImpl: typeof fetch): Promise<string[]> {
  const network = alchemyNetwork(env, chainId);
  if (!network || !env.ALCHEMY_API_KEY) return [];
  try {
    const response = await fetchImpl(alchemyUrl(network, env.ALCHEMY_API_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances', params: [owner, 'erc20'] }),
      signal: AbortSignal.timeout(3_000),
    });
    const payload = await response.json() as { result?: { tokenBalances?: Array<{ contractAddress?: string; tokenBalance?: string | null }> } };
    return (payload.result?.tokenBalances ?? [])
      .filter((item) => item.contractAddress && item.tokenBalance && BigInt(item.tokenBalance) > 0n)
      .map((item) => item.contractAddress!.toLowerCase());
  } catch {
    return [];
  }
}

/** Native balance + every token's balanceOf/decimals/symbol in one Multicall3 eth_call. */
export async function readEvmBalances(chainId: number, owner: string, tokens: string[]): Promise<RawBalance[]> {
  const list = [...new Set(tokens.map((token) => token.toLowerCase()))]
    .filter((token) => /^0x[0-9a-f]{40}$/.test(token) && !(chainId === 5042 && token === ARC_NATIVE_VIEW))
    .slice(0, MAX_TOKENS_PER_CHAIN);
  const calls = [
    { target: MULTICALL3, allowFailure: true, callData: multicall.encodeFunctionData('getEthBalance', [owner]) },
    ...list.flatMap((token) => [
      { target: token, allowFailure: true, callData: erc20.encodeFunctionData('balanceOf', [owner]) },
      { target: token, allowFailure: true, callData: erc20.encodeFunctionData('decimals', []) },
      { target: token, allowFailure: true, callData: erc20.encodeFunctionData('symbol', []) },
    ]),
  ];
  const data = multicall.encodeFunctionData('aggregate3', [calls]);
  const result = await jsonRpcRace<string>(chainId, 'eth_call', [{ to: MULTICALL3, data }, 'latest'], {
    hedgeMs: 700, timeoutMs: 4_000, validate: (value) => typeof value === 'string' && value.startsWith('0x') && value.length > 2,
  });
  const [returns] = multicall.decodeFunctionResult('aggregate3', result) as unknown as [Array<{ success: boolean; returnData: string }>];
  const decode = <T>(fn: 'balanceOf' | 'decimals' | 'symbol', entry: { success: boolean; returnData: string } | undefined): T | null => {
    if (!entry?.success || entry.returnData === '0x') return null;
    try {
      return erc20.decodeFunctionResult(fn, entry.returnData)[0] as T;
    } catch {
      return null; // e.g. bytes32 symbols on old tokens
    }
  };
  const nativeEntry = returns[0];
  const balances: RawBalance[] = [{
    address: NATIVE,
    amount: nativeEntry?.success ? BigInt(multicall.decodeFunctionResult('getEthBalance', nativeEntry.returnData)[0]).toString() : '0',
    decimals: 18,
    symbol: NATIVE_SYMBOL[chainId],
  }];
  list.forEach((token, index) => {
    const balance = decode<bigint>('balanceOf', returns[1 + index * 3]);
    const decimals = decode<bigint>('decimals', returns[2 + index * 3]);
    if (balance === null) return;
    balances.push({ address: token, amount: BigInt(balance).toString(), decimals: decimals === null ? 18 : Number(decimals), symbol: decode<string>('symbol', returns[3 + index * 3]) ?? undefined });
  });
  return balances;
}

type ParsedTokenAccounts = { value: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } }> };

const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAMS = [new PublicKey(SPL_TOKEN_PROGRAM), new PublicKey(TOKEN_2022_PROGRAM)];
/** Discovery is a bonus on public RPCs: it gets this long before the tracked-token read stands alone. */
const SOLANA_DISCOVERY_MS = 3_000;

type ParsedAccount = { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { amount: string; decimals: number } } } } } | null;

/**
 * Tracked mints through their associated token accounts (SPL and Token-2022),
 * in one getMultipleAccounts call — a plain account read every Solana RPC
 * serves, unlike the indexed getTokenAccountsByOwner.
 */
export async function readSolanaTokenAccounts(owner: string, mints: string[], timeoutMs = 3_000): Promise<RawBalance[]> {
  const pairs: Array<{ mint: string; address: string }> = [];
  for (const mint of [...new Set(mints)].slice(0, 50)) {
    try {
      const ownerKey = new PublicKey(owner);
      const mintKey = new PublicKey(mint);
      for (const program of TOKEN_PROGRAMS) {
        pairs.push({ mint, address: PublicKey.findProgramAddressSync([ownerKey.toBuffer(), program.toBuffer(), mintKey.toBuffer()], ATA_PROGRAM)[0].toBase58() });
      }
    } catch {
      // not a Solana mint
    }
  }
  if (!pairs.length) return [];
  const result = await jsonRpcRace<{ value: ParsedAccount[] }>(SOLANA_CHAIN_ID, 'getMultipleAccounts', [pairs.map((pair) => pair.address), { encoding: 'jsonParsed', commitment: 'confirmed' }], {
    hedgeMs: 500, timeoutMs, maxParallel: 6, validate: (value) => Array.isArray(value?.value),
  });
  const balances: RawBalance[] = [];
  result.value.forEach((account, index) => {
    const info = account?.data?.parsed?.info;
    if (info?.tokenAmount && info.mint === pairs[index].mint) balances.push({ address: info.mint, amount: info.tokenAmount.amount, decimals: info.tokenAmount.decimals });
  });
  return balances;
}

/**
 * SOL plus every SPL / Token-2022 balance. Tracked tokens are always read
 * through their token accounts (works on every RPC); discovery of the rest
 * uses getTokenAccountsByOwner, which only a few public RPCs allow — a Helius
 * or Alchemy key makes it reliable. SOL never waits on either.
 */
export async function readSolanaBalances(owner: string, tracked: string[] = []): Promise<RawBalance[]> {
  const accounts = (programId: string) => jsonRpcRace<ParsedTokenAccounts>(SOLANA_CHAIN_ID, 'getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }], {
    hedgeMs: 500, timeoutMs: SOLANA_DISCOVERY_MS, maxParallel: 6, validate: (value) => Array.isArray(value?.value),
  });
  const discovery = withDeadline(Promise.all([
    accounts(SPL_TOKEN_PROGRAM),
    accounts(TOKEN_2022_PROGRAM).catch(() => ({ value: [] }) as ParsedTokenAccounts),
  ]), SOLANA_DISCOVERY_MS + 500).then(([spl, token2022]) => [...spl.value, ...token2022.value].map((account) => ({
    address: account.account.data.parsed.info.mint,
    amount: account.account.data.parsed.info.tokenAmount.amount,
    decimals: account.account.data.parsed.info.tokenAmount.decimals,
  })));
  const [lamports, discovered, trackedBalances] = await Promise.all([
    jsonRpcRace<{ value: number }>(SOLANA_CHAIN_ID, 'getBalance', [owner, { commitment: 'confirmed' }], { hedgeMs: 500, timeoutMs: 3_000, maxParallel: 6, validate: (value) => typeof value?.value === 'number' && value.value >= 0 }),
    discovery.catch(() => [] as RawBalance[]),
    readSolanaTokenAccounts(owner, tracked).catch(() => [] as RawBalance[]),
  ]);
  // Discovery sums every account per mint; tracked reads cover mints discovery missed.
  const byMint = new Map<string, RawBalance>();
  for (const item of discovered) {
    const current = byMint.get(item.address);
    byMint.set(item.address, { ...item, amount: (BigInt(item.amount) + BigInt(current?.amount ?? '0')).toString() });
  }
  for (const item of trackedBalances) if (!byMint.has(item.address)) byMint.set(item.address, item);
  return [
    { address: NATIVE, amount: BigInt(Math.trunc(lamports.value)).toString(), decimals: 9, symbol: 'SOL' },
    ...[...byMint.values()].filter((item) => item.amount !== '0'),
  ];
}

const nearMetadataCache = new Map<string, { symbol: string; decimals: number }>();

async function nearMetadata(tokenId: string, rpc: NearRpcOptions) {
  const cached = nearMetadataCache.get(tokenId);
  if (cached) return cached;
  const metadata = await getTokenMetadata(tokenId, rpc);
  const value = { symbol: metadata.symbol, decimals: metadata.decimals };
  nearMetadataCache.set(tokenId, value);
  return value;
}

/** NEAR plus every NEP-141 the account holds (FastNEAR index), with tracked tokens read directly. */
export async function readNearBalances(accountId: string, tracked: string[], rpc: NearRpcOptions, fetchImpl: typeof fetch = fetch): Promise<RawBalance[]> {
  const [account, indexed] = await Promise.all([
    getNearBalance(accountId, tracked, rpc),
    fetchImpl(`https://api.fastnear.com/v1/account/${encodeURIComponent(accountId)}/ft`, { signal: AbortSignal.timeout(3_000) })
      .then(async (response) => (response.ok ? ((await response.json()) as { tokens?: Array<{ contract_id: string; balance: string }> }).tokens ?? [] : []))
      .catch(() => [] as Array<{ contract_id: string; balance: string }>),
  ]);
  const balances: RawBalance[] = [{ address: NATIVE, amount: account.availableYocto, decimals: 24, symbol: 'NEAR' }];
  const seen = new Set<string>();
  for (const token of account.tokens) {
    seen.add(token.id);
    balances.push({ address: token.id, amount: token.balance, decimals: token.decimals, symbol: token.symbol });
  }
  const extra = indexed.filter((token) => !seen.has(token.contract_id) && /^\d+$/.test(token.balance ?? '') && BigInt(token.balance) > 0n).slice(0, 20);
  const described = await Promise.all(extra.map(async (token) => {
    const metadata = await nearMetadata(token.contract_id, rpc).catch(() => null);
    return metadata ? { address: token.contract_id, amount: token.balance, decimals: metadata.decimals, symbol: metadata.symbol } : null;
  }));
  for (const item of described) if (item) balances.push(item);
  return balances;
}

type Market = { priceUsd: number; change24h: number | null; symbol: string; liquidityUsd: number };
const marketCache = new Map<string, { at: number; market: Market | null }>();
const MARKET_TTL_MS = 30_000;

/** DexScreener prices for tokens on one chain: one request per 30 tokens, cached 30s. */
export async function chainMarkets(chainId: number, addresses: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, Market>> {
  const out = new Map<string, Market>();
  const slug = DEXSCREENER_SLUG[chainId];
  if (!slug) return out;
  const missing: string[] = [];
  for (const address of new Set(addresses)) {
    const cached = marketCache.get(`${chainId}:${address.toLowerCase()}`);
    if (cached && Date.now() - cached.at < MARKET_TTL_MS) {
      if (cached.market) out.set(address.toLowerCase(), cached.market);
    } else missing.push(address);
  }
  const chunks: string[][] = [];
  for (let index = 0; index < missing.length; index += 30) chunks.push(missing.slice(index, index + 30));
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const response = await fetchImpl(`https://api.dexscreener.com/tokens/v1/${slug}/${chunk.map(encodeURIComponent).join(',')}`, { signal: AbortSignal.timeout(4_000) });
      if (!response.ok) return;
      const pairs = await response.json() as Array<{ baseToken?: { address?: string; symbol?: string }; priceUsd?: string; priceChange?: { h24?: number }; liquidity?: { usd?: number } }>;
      const best = new Map<string, Market>();
      for (const pair of Array.isArray(pairs) ? pairs : []) {
        const address = pair.baseToken?.address?.toLowerCase();
        const price = Number(pair.priceUsd);
        if (!address || !Number.isFinite(price) || price <= 0) continue;
        const liquidityUsd = pair.liquidity?.usd ?? 0;
        if ((best.get(address)?.liquidityUsd ?? -1) < liquidityUsd) {
          best.set(address, { priceUsd: price, change24h: typeof pair.priceChange?.h24 === 'number' ? pair.priceChange.h24 : null, symbol: pair.baseToken?.symbol ?? '', liquidityUsd });
        }
      }
      for (const address of chunk) {
        const market = best.get(address.toLowerCase()) ?? null;
        marketCache.set(`${chainId}:${address.toLowerCase()}`, { at: Date.now(), market });
        if (market) out.set(address.toLowerCase(), market);
      }
    } catch {
      // Holdings still render without USD values.
    }
  }));
  return out;
}

/** Below this a priced, untracked token is treated as dust/spam and hidden. */
const MIN_VISIBLE_USD = 0.01;
/** Airdropped spam often has a "price" from a pool nobody can trade against. */
const MIN_LIQUIDITY_USD = 500;

function units(amount: string, decimals: number): number {
  const value = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  return Number(value / base) + Number(value % base) / Number(base);
}

const portfolioCache = new Map<string, { at: number; portfolio: Portfolio }>();
/** Loads in progress, shared so a menu tap and a Portfolio tap never read the chains twice. */
const inflight = new Map<string, { chains: Array<Promise<PricedChain>>; settled: Map<number, PricedChain>; all: Promise<Portfolio> }>();

type PricedChain = { chainId: number; holdings: Holding[]; stale: boolean; failed: boolean };

const walletKey = (wallet: PortfolioWallet) => [wallet.evmAddress, wallet.solanaAddress, wallet.nearAddress].map((value) => value?.toLowerCase() ?? '').join('|');

/** Turn one chain's balances into priced, filtered holdings. */
function priceChain(read: ChainRead, markets: Map<string, Market>, nativePrices: Record<string, number>, tracked: TrackedToken[]): PricedChain {
  const holdings: Holding[] = [];
  for (const balance of read.balances) {
    if (balance.amount === '0') continue;
    const isNative = balance.address === NATIVE;
    const market = isNative ? null : markets.get(balance.address.toLowerCase()) ?? null;
    const trackedToken = tracked.find((token) => token.chainId === read.chainId && token.address.toLowerCase() === balance.address.toLowerCase());
    const priceUsd = isNative ? nativePrices[NATIVE_SYMBOL[read.chainId]] ?? null : market?.priceUsd ?? null;
    const decimals = isNative ? NATIVE_DECIMALS[read.chainId] ?? 18 : balance.decimals;
    const valueUsd = priceUsd === null ? null : units(balance.amount, decimals) * priceUsd;
    // Untracked discoveries need a real market to be shown (filters airdropped spam and dust).
    if (!isNative && !trackedToken && (!market || market.liquidityUsd < MIN_LIQUIDITY_USD || (valueUsd ?? 0) < MIN_VISIBLE_USD)) continue;
    holdings.push({
      chainId: read.chainId,
      address: balance.address,
      symbol: (isNative ? NATIVE_SYMBOL[read.chainId] : market?.symbol || balance.symbol || trackedToken?.symbol || 'TOKEN').slice(0, 16),
      decimals,
      amount: balance.amount,
      priceUsd,
      valueUsd,
      change24h: market?.change24h ?? null,
      tracked: Boolean(trackedToken),
    });
  }
  return { chainId: read.chainId, holdings, stale: read.stale, failed: read.failed };
}

function assemble(chains: PricedChain[], pendingChains: number[] = []): Portfolio {
  const holdings = chains.flatMap((chain) => chain.holdings).sort((left, right) => (right.valueUsd ?? -1) - (left.valueUsd ?? -1));
  return {
    holdings,
    totalUsd: holdings.reduce((sum, holding) => sum + (holding.valueUsd ?? 0), 0),
    observedAt: Date.now(),
    staleChains: chains.filter((chain) => chain.stale).map((chain) => chain.chainId),
    failedChains: chains.filter((chain) => chain.failed).map((chain) => chain.chainId),
    pendingChains,
  };
}

/**
 * Every holding of `wallet` across all supported chains, priced and sorted by
 * value. Each chain is read and priced on its own, so one slow chain never
 * holds up the others. Cached for 15s per isolate; pass `fresh` for Refresh.
 * With `budgetMs`, returns what is ready by then (the rest is listed in
 * `pendingChains`) while the full load finishes and fills the cache.
 */
export async function loadPortfolio(
  wallet: PortfolioWallet,
  env: PortfolioEnv,
  options: { tracked?: TrackedToken[]; fresh?: boolean; near?: NearRpcOptions; fetchImpl?: typeof fetch; budgetMs?: number } = {},
): Promise<Portfolio> {
  const cacheKey = walletKey(wallet);
  const cached = portfolioCache.get(cacheKey);
  if (!options.fresh && cached && Date.now() - cached.at < MEMORY_TTL_MS) return cached.portfolio;

  let load = options.fresh ? undefined : inflight.get(cacheKey);
  if (!load) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const tracked = options.tracked ?? [];
    const trackedOn = (chainId: number) => tracked.filter((token) => token.chainId === chainId).map((token) => token.address);
    const nativePrices = nativePricesUsd().catch(() => ({} as Record<string, number>));
    const settled = new Map<number, PricedChain>();
    const pipeline = (chainId: number, owner: string, reader: () => Promise<RawBalance[]>) => (async () => {
      const read = await readWithMemory(env, chainId, owner, reader);
      const tokens = read.balances.filter((item) => item.address !== NATIVE && item.amount !== '0').map((item) => item.address);
      const [markets, prices] = await Promise.all([chainMarkets(chainId, tokens, fetchImpl), nativePrices]);
      const priced = priceChain(read, markets, prices, tracked);
      settled.set(chainId, priced);
      return priced;
    })();

    const chains: Array<Promise<PricedChain>> = [];
    if (wallet.evmAddress) {
      const owner = wallet.evmAddress;
      for (const chainId of EVM_PORTFOLIO_CHAINS) {
        chains.push(pipeline(chainId, owner, async () => {
          const discovered = await discoverEvmTokens(chainId, owner, env, fetchImpl);
          return readEvmBalances(chainId, owner, [...trackedOn(chainId), ...discovered]);
        }));
      }
    }
    if (wallet.solanaAddress) {
      const owner = wallet.solanaAddress;
      chains.push(pipeline(SOLANA_CHAIN_ID, owner, () => readSolanaBalances(owner, trackedOn(SOLANA_CHAIN_ID))));
    }
    if (wallet.nearAddress) {
      const owner = wallet.nearAddress;
      chains.push(pipeline(NEAR_CHAIN_ID, owner, () => readNearBalances(owner, trackedOn(NEAR_CHAIN_ID), options.near ?? {}, fetchImpl)));
    }
    const all = Promise.all(chains).then((priced) => {
      const portfolio = assemble(priced);
      portfolioCache.set(cacheKey, { at: Date.now(), portfolio });
      return portfolio;
    }).finally(() => inflight.delete(cacheKey));
    load = { chains, settled, all };
    inflight.set(cacheKey, load);
  }

  if (!options.budgetMs) return load.all;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), options.budgetMs); });
  const finished = await Promise.race([load.all, budget]).finally(() => clearTimeout(timer));
  if (finished) return finished;
  const ready = [...load.settled.values()];
  const readyIds = new Set(ready.map((chain) => chain.chainId));
  const expected = [
    ...(wallet.evmAddress ? EVM_PORTFOLIO_CHAINS : []),
    ...(wallet.solanaAddress ? [SOLANA_CHAIN_ID] : []),
    ...(wallet.nearAddress ? [NEAR_CHAIN_ID] : []),
  ];
  return assemble(ready, expected.filter((chainId) => !readyIds.has(chainId)));
}

/** Finish an in-progress load in the background (e.g. ctx.waitUntil) so the next view is instant. */
export function pendingPortfolioLoad(wallet: PortfolioWallet): Promise<unknown> | undefined {
  return inflight.get(walletKey(wallet))?.all.catch(() => undefined);
}

/** Drop the cached portfolio after a trade so the next view is live. */
export function forgetPortfolio(wallet: PortfolioWallet) {
  portfolioCache.delete(walletKey(wallet));
}

/** One token's balance for the token card (fast path: a single hedged call, short deadline). */
export async function quickTokenBalance(chainId: number, token: string, owner: string, near: NearRpcOptions, deadlineMs = 2_500): Promise<{ amount: string; decimals: number } | null> {
  try {
    return await withDeadline((async () => {
      if (chainId === SOLANA_CHAIN_ID) {
        // The token's associated accounts: a plain account read every Solana RPC serves.
        const [balance] = await readSolanaTokenAccounts(owner, [token], deadlineMs);
        return balance ? { amount: balance.amount, decimals: balance.decimals } : { amount: '0', decimals: 0 };
      }
      if (chainId === NEAR_CHAIN_ID) {
        const balances = await getNearBalance(owner, [token], near);
        const held = balances.tokens.find((item) => item.id === token);
        return { amount: held?.balance ?? '0', decimals: held?.decimals ?? 18 };
      }
      const [balance] = (await readEvmBalances(chainId, owner, [token])).filter((item) => item.address !== NATIVE);
      return balance ? { amount: balance.amount, decimals: balance.decimals } : { amount: '0', decimals: 18 };
    })(), deadlineMs);
  } catch {
    return null;
  }
}

/** Native balance on one chain for the token card's "pay with" line. */
export async function quickNativeBalance(chainId: number, owner: string, near: NearRpcOptions, deadlineMs = 2_500): Promise<bigint | null> {
  try {
    return await withDeadline((async () => {
      if (chainId === SOLANA_CHAIN_ID) {
        const result = await jsonRpcRace<{ value: number }>(SOLANA_CHAIN_ID, 'getBalance', [owner, { commitment: 'confirmed' }], { hedgeMs: 500, timeoutMs: 2_500, validate: (value) => typeof value?.value === 'number' && value.value >= 0 });
        return BigInt(Math.trunc(result.value));
      }
      if (chainId === NEAR_CHAIN_ID) return BigInt((await getNearBalance(owner, [], near)).availableYocto);
      return BigInt(await jsonRpcRace<string>(chainId, 'eth_getBalance', [owner, 'latest'], { hedgeMs: 500, timeoutMs: 2_500, validate: (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) }));
    })(), deadlineMs);
  } catch {
    return null;
  }
}
