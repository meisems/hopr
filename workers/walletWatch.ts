// Wallet tracking alerts and copy trading.
//
// Every minute (cron) the new on-chain activity of every tracked wallet is
// read once, however many users track it:
// - EVM chains: ERC-20 Transfer logs from / to all tracked addresses, one
//   eth_getLogs pair per chain (BNB's public RPCs only scan ≤50 blocks, so
//   ranges are chunked there).
// - Solana: the wallet's new signatures, each transaction's token balance
//   changes for that owner.
// - NEAR: NEP-141 balance changes from FastNEAR's account index.
// Token movements in one transaction are classified against each chain's
// base coins (WETH, USDC, WSOL, wNEAR…): a non-base token coming in is a buy,
// going out is a sell. Only tokens with a real market are reported (airdropped
// spam has none). Trackers get an alert; with copy trading on, the trade is
// mirrored once (a unique row in copy_trades), within a daily cap.

import { jsonRpcRace } from '../src/services/rpcPool';
import { getTokenMetadata, isValidNearAccountId, NEAR_CHAIN_ID, type NearRpcOptions } from '../src/services/nearService';
import { SOLANA_CHAIN_ID } from './rpcConfig';
import { readEvmBalances } from './portfolio';

export type WalletKind = 'evm' | 'svm' | 'near';
export type CopyMode = 'off' | 'buy' | 'buysell';

export interface TrackedWallet {
  id: string;
  user_id: string;
  address: string;
  kind: WalletKind;
  label: string;
  alerts: number;
  copy_mode: CopyMode;
  copy_amount_usd: number | null;
  copy_wallet_id: string | null;
  created_at: number;
  updated_at: number;
}

/** One buy or sell by a tracked wallet. */
export interface WalletTrade {
  address: string;
  chainId: number;
  /** Transaction hash (Solana signature); NEAR balance changes use a synthetic id. */
  txHash: string;
  side: 'buy' | 'sell';
  token: string;
  /** Absolute amount moved, smallest units. */
  amount: string;
  decimals: number;
  symbol: string;
  /** The wallet's balance of the token after the trade, when known (sizes copied sells). */
  remaining?: string;
  priceUsd?: number;
  valueUsd?: number;
  liquidityUsd?: number;
}

export const EVM_WATCH_CHAINS = [8453, 42161, 56, 4663, 5042];
export const MAX_TRACKED_PER_USER = 15;
export const MAX_COPY_TRADES_PER_DAY = 25;
/** Reported trades need a market at least this deep (filters airdropped spam). */
export const MIN_ALERT_LIQUIDITY_USD = 1_000;
/** Copied buys need deeper markets. */
export const MIN_COPY_LIQUIDITY_USD = 10_000;

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Blocks scanned per run at most (≈ several minutes); a longer outage skips ahead instead of piling up. */
const MAX_SCAN_BLOCKS: Record<number, number> = { 8453: 300, 42161: 2_400, 56: 400, 4663: 2_400, 5042: 1_200 };
/** Some RPCs cap eth_getLogs ranges (BNB's public ones at 50 blocks). */
const LOG_CHUNK_BLOCKS: Record<number, number> = { 56: 45 };

/** Base coins: moving these is the "money" side of a trade, not the token traded. */
const BASE_SYMBOLS = new Set(['ETH', 'WETH', 'BNB', 'WBNB', 'SOL', 'WSOL', 'NEAR', 'WNEAR', 'USDC', 'USDC.E', 'USDBC', 'USDT', 'USDT0', 'BUSD', 'DAI', 'FDUSD', 'USD1', 'USDE']);
const BASE_ADDRESSES = new Set([
  '0x4200000000000000000000000000000000000006', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base WETH, USDC
  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // Arbitrum
  '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', '0x55d398326f99059fF775485246999027B3197955', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // BNB
  'So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // Solana
  'wrap.near', '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', 'usdt.tether-token.near', // NEAR
].map((address) => address.toLowerCase()));

export function isBaseToken(token: string, symbol?: string): boolean {
  return BASE_ADDRESSES.has(token.toLowerCase()) || (symbol !== undefined && BASE_SYMBOLS.has(symbol.toUpperCase()));
}

/** EVM 0x…, NEAR account id, or Solana base58 address. */
export function walletKind(address: string): WalletKind | null {
  const value = address.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(value)) return 'evm';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return 'svm';
  // Any NEAR account: implicit (64 hex) or named with a dot (alice.near, bob.tg, x.sweat …).
  if (isValidNearAccountId(value.toLowerCase())) return 'near';
  return null;
}

export function normalizeWalletAddress(address: string, kind: WalletKind): string {
  return kind === 'svm' ? address.trim() : address.trim().toLowerCase();
}

type Log = { address: string; topics: string[]; data: string; transactionHash: string };
const topicAddress = (topic: string | undefined) => (topic && topic.length === 66 ? `0x${topic.slice(26)}`.toLowerCase() : '');
const padTopic = (address: string) => `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

/** Net token movements per (wallet, transaction) from Transfer logs. */
export function evmDeltas(logs: Log[], watched: Set<string>): Map<string, Map<string, bigint>> {
  const out = new Map<string, Map<string, bigint>>(); // `${wallet}|${tx}` → token → signed amount
  const seen = new Set<string>();
  for (const log of logs) {
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const key = `${log.transactionHash}:${(log as { logIndex?: string }).logIndex ?? ''}:${log.address}:${log.topics[1]}:${log.topics[2]}:${log.data}`;
    if (seen.has(key)) continue; // the from- and to-queries can return the same log
    seen.add(key);
    let amount: bigint;
    try {
      amount = BigInt(log.data && log.data !== '0x' ? log.data.slice(0, 66) : '0x0');
    } catch {
      continue;
    }
    if (amount === 0n) continue;
    const token = log.address.toLowerCase();
    for (const [wallet, sign] of [[topicAddress(log.topics[1]), -1n], [topicAddress(log.topics[2]), 1n]] as const) {
      if (!watched.has(wallet)) continue;
      const id = `${wallet}|${log.transactionHash}`;
      const deltas = out.get(id) ?? new Map<string, bigint>();
      deltas.set(token, (deltas.get(token) ?? 0n) + sign * amount);
      out.set(id, deltas);
    }
  }
  return out;
}

/** Buys (non-base token in) and sells (non-base token out) from one transaction's net movements. */
export function classifyMovements(deltas: Map<string, bigint>, symbols: Map<string, string>): Array<{ side: 'buy' | 'sell'; token: string; amount: bigint }> {
  const trades: Array<{ side: 'buy' | 'sell'; token: string; amount: bigint }> = [];
  for (const [token, amount] of deltas) {
    if (amount === 0n || isBaseToken(token, symbols.get(token))) continue;
    trades.push({ side: amount > 0n ? 'buy' : 'sell', token, amount: amount > 0n ? amount : -amount });
  }
  return trades;
}

async function getLogs(chainId: number, filter: Record<string, unknown>): Promise<Log[]> {
  // Every endpoint is a candidate: only some allow address-less log filters (on BNB, just 1rpc.io in ≤50-block windows).
  return jsonRpcRace<Log[]>(chainId, 'eth_getLogs', [filter], { hedgeMs: 600, timeoutMs: 8_000, maxParallel: 12, validate: (value) => Array.isArray(value) });
}

export async function latestEvmBlock(chainId: number): Promise<number> {
  const hex = await jsonRpcRace<string>(chainId, 'eth_blockNumber', [], { hedgeMs: 500, timeoutMs: 4_000, validate: (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) });
  // A few blocks behind the tip: every endpoint has them, and they no longer reorg in practice.
  return Number(BigInt(hex)) - 3;
}

/** Every buy / sell by `addresses` on one EVM chain in [fromBlock, toBlock]. */
export async function fetchEvmTrades(chainId: number, addresses: string[], fromBlock: number, toBlock: number): Promise<WalletTrade[]> {
  const watched = new Set(addresses.map((address) => address.toLowerCase()));
  const chunk = LOG_CHUNK_BLOCKS[chainId] ?? toBlock - fromBlock + 1;
  const logs: Log[] = [];
  const topics = [...watched].map(padTopic);
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(toBlock, start + chunk - 1);
    const range = { fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` };
    for (let index = 0; index < topics.length; index += 40) {
      const group = topics.slice(index, index + 40);
      const [sent, received] = await Promise.all([
        getLogs(chainId, { ...range, topics: [TRANSFER_TOPIC, group] }),
        getLogs(chainId, { ...range, topics: [TRANSFER_TOPIC, null, group] }),
      ]);
      logs.push(...sent, ...received);
    }
  }
  const perTx = evmDeltas(logs, watched);
  if (!perTx.size) return [];
  // Symbols, decimals and post-trade balances: one multicall per wallet for the tokens it moved.
  const tokensByWallet = new Map<string, Set<string>>();
  for (const [id, deltas] of perTx) {
    const wallet = id.split('|')[0];
    tokensByWallet.set(wallet, new Set([...(tokensByWallet.get(wallet) ?? []), ...deltas.keys()]));
  }
  const info = new Map<string, { symbol: string; decimals: number; balance: string }>();
  await Promise.all([...tokensByWallet].map(async ([wallet, tokens]) => {
    const balances = await readEvmBalances(chainId, wallet, [...tokens].slice(0, 40)).catch(() => []);
    for (const balance of balances) {
      if (balance.address !== 'native') info.set(`${wallet}|${balance.address.toLowerCase()}`, { symbol: balance.symbol ?? '', decimals: balance.decimals, balance: balance.amount });
    }
  }));
  const trades: WalletTrade[] = [];
  for (const [id, deltas] of perTx) {
    const [wallet, txHash] = id.split('|');
    const symbols = new Map([...deltas.keys()].map((token) => [token, info.get(`${wallet}|${token}`)?.symbol ?? '']));
    for (const trade of classifyMovements(deltas, symbols)) {
      const meta = info.get(`${wallet}|${trade.token}`);
      trades.push({ address: wallet, chainId, txHash, side: trade.side, token: trade.token, amount: trade.amount.toString(),
        decimals: meta?.decimals ?? 18, symbol: meta?.symbol || 'TOKEN', remaining: meta?.balance });
    }
  }
  return trades;
}

type ParsedTx = {
  meta?: { err?: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
};
type TokenBalance = { mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };

/** Token balance changes of `owner` in one Solana transaction (WSOL included, as a base coin). */
export function solanaDeltas(tx: ParsedTx, owner: string): { deltas: Map<string, bigint>; decimals: Map<string, number>; post: Map<string, string> } {
  const deltas = new Map<string, bigint>();
  const decimals = new Map<string, number>();
  const post = new Map<string, string>();
  for (const [entries, sign] of [[tx.meta?.preTokenBalances ?? [], -1n], [tx.meta?.postTokenBalances ?? [], 1n]] as const) {
    for (const entry of entries) {
      if (entry.owner !== owner) continue;
      deltas.set(entry.mint, (deltas.get(entry.mint) ?? 0n) + sign * BigInt(entry.uiTokenAmount.amount));
      decimals.set(entry.mint, entry.uiTokenAmount.decimals);
      if (sign === 1n) post.set(entry.mint, (BigInt(post.get(entry.mint) ?? '0') + BigInt(entry.uiTokenAmount.amount)).toString());
    }
  }
  return { deltas, decimals, post };
}

/** New buys / sells of one Solana wallet since `until` (the newest signature already seen). */
export async function fetchSolanaTrades(owner: string, until: string | null): Promise<{ trades: WalletTrade[]; cursor: string | null }> {
  const signatures = await jsonRpcRace<Array<{ signature: string; err: unknown }>>(SOLANA_CHAIN_ID, 'getSignaturesForAddress',
    [owner, { limit: 15, ...(until ? { until } : {}), commitment: 'confirmed' }], { hedgeMs: 600, timeoutMs: 5_000, maxParallel: 6, validate: (value) => Array.isArray(value) });
  const cursor = signatures[0]?.signature ?? until;
  if (!until) return { trades: [], cursor }; // first look: remember where we are, don't replay history
  const trades: WalletTrade[] = [];
  for (const { signature, err } of signatures.slice(0, 10).reverse()) {
    if (err) continue;
    const tx = await jsonRpcRace<ParsedTx | null>(SOLANA_CHAIN_ID, 'getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], {
      hedgeMs: 600, timeoutMs: 5_000, maxParallel: 6, validate: (value) => value === null || typeof value === 'object',
    }).catch(() => null);
    if (!tx || tx.meta?.err) continue;
    const { deltas, decimals, post } = solanaDeltas(tx, owner);
    for (const trade of classifyMovements(deltas, new Map())) {
      trades.push({ address: owner, chainId: SOLANA_CHAIN_ID, txHash: signature, side: trade.side, token: trade.token, amount: trade.amount.toString(),
        decimals: decimals.get(trade.token) ?? 9, symbol: 'TOKEN', remaining: post.get(trade.token) ?? '0' });
    }
  }
  return { trades, cursor };
}

/** NEP-141 balance changes of a NEAR account since the last snapshot (no snapshot: take one, report nothing). */
export async function fetchNearTrades(accountId: string, previous: Record<string, string> | null, rpc: NearRpcOptions = {}, fetchImpl: typeof fetch = fetch): Promise<{ trades: WalletTrade[]; snapshot: Record<string, string> }> {
  const response = await fetchImpl(`https://api.fastnear.com/v1/account/${encodeURIComponent(accountId)}/ft`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`FastNEAR HTTP ${response.status}`);
  const tokens = ((await response.json()) as { tokens?: Array<{ contract_id: string; balance: string | null }> }).tokens ?? [];
  const snapshot = Object.fromEntries(tokens.filter((token) => /^\d+$/.test(token.balance ?? '')).map((token) => [token.contract_id, token.balance!]));
  if (!previous) return { trades: [], snapshot };
  const trades: WalletTrade[] = [];
  for (const token of new Set([...Object.keys(previous), ...Object.keys(snapshot)])) {
    const delta = BigInt(snapshot[token] ?? '0') - BigInt(previous[token] ?? '0');
    if (delta === 0n || isBaseToken(token)) continue;
    const metadata = await getTokenMetadata(token, rpc).catch(() => null);
    if (!metadata || isBaseToken(token, metadata.symbol)) continue;
    trades.push({ address: accountId, chainId: NEAR_CHAIN_ID, txHash: `near:${accountId}:${token}:${snapshot[token] ?? '0'}`, side: delta > 0n ? 'buy' : 'sell',
      token, amount: (delta > 0n ? delta : -delta).toString(), decimals: metadata.decimals, symbol: metadata.symbol, remaining: snapshot[token] ?? '0' });
  }
  return { trades, snapshot };
}

export interface WatchEnv {
  DB?: D1Database;
  TELEGRAM_STATE?: KVNamespace;
  CACHE?: KVNamespace;
}

export interface WatchDeps {
  latestBlock: (chainId: number) => Promise<number>;
  evmTrades: (chainId: number, addresses: string[], fromBlock: number, toBlock: number) => Promise<WalletTrade[]>;
  solanaTrades: (owner: string, until: string | null) => Promise<{ trades: WalletTrade[]; cursor: string | null }>;
  nearTrades: (accountId: string, previous: Record<string, string> | null) => Promise<{ trades: WalletTrade[]; snapshot: Record<string, string> }>;
  /** Price, liquidity and symbol per token on one chain (lowercased address → market). */
  markets: (chainId: number, tokens: string[]) => Promise<Map<string, { priceUsd: number; liquidityUsd: number; symbol: string }>>;
  alert: (tracker: TrackedWallet, trade: WalletTrade) => Promise<void>;
  copy: (tracker: TrackedWallet, trade: WalletTrade) => Promise<{ txHash: string; explorerUrl?: string }>;
  copyResult: (tracker: TrackedWallet, trade: WalletTrade, outcome: { status: 'filled'; txHash: string; explorerUrl?: string } | { status: 'failed' | 'skipped'; reason: string }) => Promise<void>;
  now?: () => number;
}

export interface WatchResult { wallets: number; trades: number; alerts: number; copies: number; copyFailures: number }

const kvOf = (env: WatchEnv) => env.TELEGRAM_STATE ?? env.CACHE;

/** One pass: read new activity of every tracked wallet once, alert trackers, mirror trades for copy traders. */
export async function runWalletWatch(env: WatchEnv, deps: WatchDeps): Promise<WatchResult> {
  const result: WatchResult = { wallets: 0, trades: 0, alerts: 0, copies: 0, copyFailures: 0 };
  const kv = kvOf(env);
  if (!env.DB || !kv) return result;
  const now = deps.now ?? Date.now;
  const trackers = (await env.DB.prepare(`SELECT * FROM tracked_wallets LIMIT 5000`).all<TrackedWallet>()).results ?? [];
  if (!trackers.length) return result;
  const byAddress = new Map<string, TrackedWallet[]>();
  for (const tracker of trackers) byAddress.set(tracker.address, [...(byAddress.get(tracker.address) ?? []), tracker]);
  result.wallets = byAddress.size;
  const addressesOf = (kind: WalletKind) => [...byAddress.entries()].filter(([, list]) => list[0].kind === kind).map(([address]) => address);

  const trades: WalletTrade[] = [];
  const evm = addressesOf('evm');
  if (evm.length) {
    await Promise.all(EVM_WATCH_CHAINS.map(async (chainId) => {
      try {
        const latest = await deps.latestBlock(chainId);
        const key = `watch:evm:${chainId}`;
        const cursor = Number(await kv.get(key) ?? NaN);
        if (Number.isFinite(cursor) && latest > cursor) {
          const from = Math.max(cursor + 1, latest - (MAX_SCAN_BLOCKS[chainId] ?? 1_000) + 1);
          trades.push(...await deps.evmTrades(chainId, evm, from, latest));
        }
        // Advance only after a successful read: a failed run is retried next minute.
        if (!Number.isFinite(cursor) || latest > cursor) await kv.put(key, String(latest), { expirationTtl: 7 * 24 * 60 * 60 });
      } catch (error) {
        console.error(`Wallet watch: chain ${chainId} unavailable`, error);
      }
    }));
  }
  await Promise.all(addressesOf('svm').map(async (owner) => {
    try {
      const key = `watch:sol:${owner}`;
      const { trades: found, cursor } = await deps.solanaTrades(owner, await kv.get(key));
      trades.push(...found);
      if (cursor) await kv.put(key, cursor, { expirationTtl: 30 * 24 * 60 * 60 });
    } catch (error) {
      console.error('Wallet watch: Solana wallet unavailable', error);
    }
  }));
  await Promise.all(addressesOf('near').map(async (accountId) => {
    try {
      const key = `watch:near:${accountId}`;
      const raw = await kv.get(key);
      const { trades: found, snapshot } = await deps.nearTrades(accountId, raw ? JSON.parse(raw) as Record<string, string> : null);
      trades.push(...found);
      await kv.put(key, JSON.stringify(snapshot), { expirationTtl: 30 * 24 * 60 * 60 });
    } catch (error) {
      console.error('Wallet watch: NEAR account unavailable', error);
    }
  }));
  if (!trades.length) return result;

  // Markets: one request per chain; tokens without a real market are spam or dust.
  const tokensByChain = new Map<number, string[]>();
  for (const trade of trades) tokensByChain.set(trade.chainId, [...new Set([...(tokensByChain.get(trade.chainId) ?? []), trade.token])]);
  const markets = new Map<string, { priceUsd: number; liquidityUsd: number; symbol: string }>();
  await Promise.all([...tokensByChain].map(async ([chainId, tokens]) => {
    const found = await deps.markets(chainId, tokens).catch(() => new Map());
    for (const [token, market] of found) markets.set(`${chainId}:${token.toLowerCase()}`, market);
  }));

  for (const trade of trades) {
    const market = markets.get(`${trade.chainId}:${trade.token.toLowerCase()}`);
    if (!market || !(market.priceUsd > 0) || market.liquidityUsd < MIN_ALERT_LIQUIDITY_USD) continue;
    trade.priceUsd = market.priceUsd;
    trade.liquidityUsd = market.liquidityUsd;
    if (trade.symbol === 'TOKEN' && market.symbol) trade.symbol = market.symbol;
    const units = Number(BigInt(trade.amount)) / 10 ** trade.decimals;
    trade.valueUsd = units * market.priceUsd;
    if (trade.valueUsd < 1) continue; // dust
    result.trades += 1;
    for (const tracker of byAddress.get(trade.address) ?? []) {
      if (tracker.alerts) {
        await deps.alert(tracker, trade).catch(() => undefined);
        result.alerts += 1;
      }
      const copying = tracker.copy_mode === 'buysell' || (tracker.copy_mode === 'buy' && trade.side === 'buy');
      if (!copying) continue;
      // At most once per leader trade, per user.
      const claim = await env.DB.prepare(
        `INSERT OR IGNORE INTO copy_trades (id, user_id, tracked_id, chain_id, token_address, side, leader_tx, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'executing', ?8)`,
      ).bind(crypto.randomUUID(), tracker.user_id, tracker.id, trade.chainId, trade.token, trade.side, trade.txHash, now()).run();
      if ((claim.meta?.changes ?? 0) === 0) continue;
      const finish = (status: string, txHash: string | null, error: string | null) => env.DB!.prepare(
        `UPDATE copy_trades SET status = ?1, tx_hash = ?2, error = ?3 WHERE user_id = ?4 AND leader_tx = ?5 AND token_address = ?6 AND side = ?7`,
      ).bind(status, txHash, error, tracker.user_id, trade.txHash, trade.token, trade.side).run();
      const today = await env.DB.prepare(`SELECT COUNT(*) AS total FROM copy_trades WHERE user_id = ?1 AND status IN ('executing','filled') AND created_at > ?2`)
        .bind(tracker.user_id, now() - 24 * 60 * 60_000).first<{ total: number }>();
      const skip = (today?.total ?? 0) > MAX_COPY_TRADES_PER_DAY ? `daily copy limit (${MAX_COPY_TRADES_PER_DAY}) reached`
        : trade.side === 'buy' && trade.liquidityUsd! < MIN_COPY_LIQUIDITY_USD ? `liquidity under $${MIN_COPY_LIQUIDITY_USD.toLocaleString('en-US')}` : null;
      if (skip) {
        await finish('skipped', null, skip);
        await deps.copyResult(tracker, trade, { status: 'skipped', reason: skip }).catch(() => undefined);
        continue;
      }
      try {
        const done = await deps.copy(tracker, trade);
        await finish('filled', done.txHash, null);
        result.copies += 1;
        await deps.copyResult(tracker, trade, { status: 'filled', ...done }).catch(() => undefined);
      } catch (error) {
        const reason = (error instanceof Error ? error.message : 'copy failed').slice(0, 200);
        await finish('failed', null, reason);
        result.copyFailures += 1;
        await deps.copyResult(tracker, trade, { status: 'failed', reason }).catch(() => undefined);
      }
    }
  }
  return result;
}
