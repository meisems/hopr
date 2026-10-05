// NEAR Protocol support shared by the dashboard and the worker: account ids,
// amounts, JSON-RPC reads, balances, and Ref Finance swap planning.
//
// Key generation, transaction encoding and signing live in nearSigner.ts,
// which only the worker imports, so the browser bundle stays free of signing
// code. Everything here depends only on Web APIs.


/** Internal chain id for NEAR mainnet (its SLIP-44 coin type). Not an EVM chain id. */
export const NEAR_CHAIN_ID = 397;
export const NEAR_DECIMALS = 24;
export const WRAP_NEAR = 'wrap.near';
export const REF_EXCHANGE = 'v2.ref-finance.near';
/** Sentinel token id meaning native NEAR (wrapped/unwrapped around Ref automatically). */
export const NATIVE_NEAR = 'near';

export const NEAR_CHAIN = {
  id: NEAR_CHAIN_ID,
  name: 'NEAR',
  key: 'near',
  type: 'NEAR' as const,
  nativeToken: 'NEAR',
  nativeSymbol: 'NEAR',
  color: '#00EC97',
  explorerTxUrl: 'https://nearblocks.io/txns/',
  explorerAccountUrl: 'https://nearblocks.io/address/',
};

/**
 * Public fallbacks only. Free NEAR RPCs are aggressively rate limited (and
 * rpc.mainnet.near.org is deprecated), so production should set NEAR_RPC_URL
 * to a keyed provider; it is always tried first.
 */
export const DEFAULT_NEAR_RPC_URLS = ['https://free.rpc.fastnear.com', 'https://near.drpc.org', 'https://rpc.shitzuapes.xyz', 'https://rpc.mainnet.near.org'];

/** Well-known NEP-141 tokens shown in balances and accepted by symbol in /swap. */
export const KNOWN_NEAR_TOKENS: Record<string, { id: string; symbol: string; decimals: number }> = {
  near: { id: NATIVE_NEAR, symbol: 'NEAR', decimals: NEAR_DECIMALS },
  wnear: { id: WRAP_NEAR, symbol: 'wNEAR', decimals: NEAR_DECIMALS },
  usdc: { id: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC', decimals: 6 },
  usdt: { id: 'usdt.tether-token.near', symbol: 'USDT', decimals: 6 },
};

const NEAR_TGAS = 1_000_000_000_000n;
/** Kept aside so a swap never leaves the account unable to pay gas. */
export const NEAR_GAS_RESERVE_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR
/** Cost of one byte of on-chain storage (protocol constant). */
const YOCTO_PER_STORAGE_BYTE = 10_000_000_000_000_000_000n;

// ---------------------------------------------------------------------------
// Account ids & amounts
// ---------------------------------------------------------------------------

/** 64 lowercase hex characters: an implicit account derived from an ed25519 key. */
export function isNearImplicitAccount(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * A NEAR account id: implicit (64 hex) or a named account on mainnet, e.g.
 * `alice.near`, `usdt.tether-token.near`, or a top-level contract like `aurora`.
 * Top-level names without a dot are accepted only when they are 2–64 chars
 * and lowercase, to avoid matching arbitrary words.
 */
/**
 * Any syntactically valid NEAR account id (implicit, or named with at least
 * one dot: `alice.near`, `x.sweat`, `bob.tg`…). Used for wallets and keys,
 * where the account is known to be an account rather than a token guess.
 */
export function isValidNearAccountId(value: string): boolean {
  if (value.length < 2 || value.length > 64) return false;
  if (isNearImplicitAccount(value)) return true;
  return value.includes('.') && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(value);
}

export function isNearAccountId(value: string): boolean {
  if (value.length < 2 || value.length > 64) return false;
  if (isNearImplicitAccount(value)) return true;
  if (!/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(value)) return false;
  return value.endsWith('.near') || value.endsWith('.tg') || value === WRAP_NEAR;
}

export function parseUnits(amount: string, decimals: number): bigint {
  const value = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid amount: ${amount}`);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Human-readable token amount, trimmed to `maxFractionDigits` without float rounding errors. */
export function formatUnits(units: string | bigint, decimals: number, maxFractionDigits = 4): string {
  const value = BigInt(units);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').slice(0, maxFractionDigits).replace(/0+$/, '');
  const wholeText = whole.toLocaleString('en-US');
  if (!fraction && whole === 0n && abs > 0n) return `${negative ? '-' : ''}<0.${'0'.repeat(Math.max(0, maxFractionDigits - 1))}1`;
  return `${negative ? '-' : ''}${wholeText}${fraction ? `.${fraction}` : ''}`;
}

export const formatNearAmount = (yocto: string | bigint, maxFractionDigits = 4) => formatUnits(yocto, NEAR_DECIMALS, maxFractionDigits);
export const parseNearAmount = (near: string) => parseUnits(near, NEAR_DECIMALS);

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

export class NearRpcError extends Error {
  constructor(message: string, readonly cause?: unknown, readonly kind?: string) {
    super(message);
    this.name = 'NearRpcError';
  }
}

export interface NearRpcOptions {
  urls?: string[];
  fetchImpl?: typeof fetch;
  /** Per-provider deadline; a hanging provider fails over instead of stalling the call. */
  timeoutMs?: number;
}

const NEAR_RPC_TIMEOUT_MS = 8_000;

function rpcUrls(options: NearRpcOptions = {}): string[] {
  const urls = (options.urls ?? []).filter(Boolean);
  return [...new Set([...urls, ...DEFAULT_NEAR_RPC_URLS])];
}

/**
 * Call NEAR JSON-RPC, failing over to the next provider on network errors,
 * HTTP 429/5xx, or provider-level rate limits. Contract/account errors are
 * returned to the caller immediately — retrying elsewhere would not help.
 */
export async function nearRpc<T>(method: string, params: unknown, options: NearRpcOptions = {}): Promise<T> {
  const doFetch = options.fetchImpl ?? fetch;
  let lastError: unknown;
  for (const url of rpcUrls(options)) {
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'hopr', method, params }),
        signal: AbortSignal.timeout(options.timeoutMs ?? NEAR_RPC_TIMEOUT_MS),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new NearRpcError(`NEAR RPC ${url} returned HTTP ${response.status}`);
        continue;
      }
      const payload = await response.json() as { result?: T; error?: { code?: number; message?: string; name?: string; cause?: { name?: string; info?: unknown }; data?: unknown } };
      if (payload.error) {
        if (payload.error.code === -429) {
          lastError = new NearRpcError(`NEAR RPC ${url} is rate limited`);
          continue;
        }
        const kind = payload.error.cause?.name ?? payload.error.name;
        throw new NearRpcError(
          typeof payload.error.data === 'string' ? payload.error.data : payload.error.message ?? 'NEAR RPC error',
          payload.error.cause,
          kind,
        );
      }
      if (payload.result === undefined) throw new NearRpcError('NEAR RPC returned no result');
      return payload.result;
    } catch (error) {
      if (error instanceof NearRpcError && !/HTTP|rate limited/.test(error.message)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new NearRpcError('All NEAR RPC providers failed');
}

interface ViewAccountResult { amount: string; locked: string; storage_usage: number }

/** Returns null when the account does not exist yet (e.g. an unfunded implicit account). */
export async function viewAccount(accountId: string, options?: NearRpcOptions): Promise<ViewAccountResult | null> {
  try {
    return await nearRpc<ViewAccountResult>('query', { request_type: 'view_account', finality: 'final', account_id: accountId }, options);
  } catch (error) {
    if (error instanceof NearRpcError && (error.kind === 'UNKNOWN_ACCOUNT' || /does not exist/.test(error.message))) return null;
    throw error;
  }
}

function encodeJsonBase64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Call a view method and JSON-decode its return value. */
export async function viewFunction<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}, options?: NearRpcOptions): Promise<T> {
  const result = await nearRpc<{ result: number[] }>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contractId,
    method_name: methodName,
    args_base64: encodeJsonBase64(args),
  }, options);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
}

export interface NearTokenMetadata { symbol: string; name: string; decimals: number }

export async function getTokenMetadata(tokenId: string, options?: NearRpcOptions): Promise<NearTokenMetadata> {
  if (tokenId === NATIVE_NEAR) return { symbol: 'NEAR', name: 'NEAR', decimals: NEAR_DECIMALS };
  const known = Object.values(KNOWN_NEAR_TOKENS).find((token) => token.id === tokenId);
  const metadata = await viewFunction<{ symbol?: string; name?: string; decimals?: number }>(tokenId, 'ft_metadata', {}, options)
    .catch(() => null);
  if (!metadata && !known) throw new Error(`${tokenId} is not a NEP-141 token`);
  return {
    symbol: metadata?.symbol ?? known!.symbol,
    name: metadata?.name ?? known?.symbol ?? tokenId,
    decimals: typeof metadata?.decimals === 'number' ? metadata.decimals : known!.decimals,
  };
}

export interface NearBalance {
  accountId: string;
  exists: boolean;
  /** Total balance in yoctoNEAR. */
  totalYocto: string;
  /** Spendable balance: total minus storage staking and locked stake. */
  availableYocto: string;
  tokens: Array<{ id: string; symbol: string; decimals: number; balance: string }>;
}

/**
 * Native NEAR balance plus NEP-141 balances for the well-known tokens and any
 * extra token ids (e.g. the user's open positions). Zero token balances are omitted.
 */
export async function getNearBalance(accountId: string, extraTokenIds: string[] = [], options?: NearRpcOptions): Promise<NearBalance> {
  const account = await viewAccount(accountId, options);
  if (!account) return { accountId, exists: false, totalYocto: '0', availableYocto: '0', tokens: [] };

  const total = BigInt(account.amount);
  const storageLocked = BigInt(account.storage_usage) * YOCTO_PER_STORAGE_BYTE;
  const available = total - storageLocked - BigInt(account.locked);

  const tokenIds = [...new Set([...Object.values(KNOWN_NEAR_TOKENS).map((token) => token.id).filter((id) => id !== NATIVE_NEAR), ...extraTokenIds])];
  const tokens = await Promise.all(tokenIds.map(async (id) => {
    try {
      const balance = await viewFunction<string>(id, 'ft_balance_of', { account_id: accountId }, options);
      if (!balance || BigInt(balance) === 0n) return null;
      const metadata = await getTokenMetadata(id, options);
      return { id, symbol: metadata.symbol, decimals: metadata.decimals, balance };
    } catch {
      return null;
    }
  }));

  return {
    accountId,
    exists: true,
    totalYocto: total.toString(),
    availableYocto: (available > 0n ? available : 0n).toString(),
    tokens: tokens.filter((token): token is NonNullable<typeof token> => token !== null),
  };
}

/**
 * Confirm `publicKey` is a full-access key on `accountId` — required before
 * accepting an imported key for a named account.
 */
/**
 * True when `publicKey` is a full-access key of `accountId`. A missing key or
 * account is a plain `false`; when every RPC provider is unreachable this
 * throws, so callers can say "try again" instead of "wrong key".
 */
export async function verifyFullAccessKey(accountId: string, publicKey: string, options?: NearRpcOptions): Promise<boolean> {
  try {
    const key = await nearRpc<{ permission: unknown }>('query', {
      request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey,
    }, options);
    return key.permission === 'FullAccess';
  } catch (error) {
    if (isNearRpcUnreachable(error)) throw error;
    return false;
  }
}

/** Every provider failed for transport reasons (timeouts, 429/5xx), not an answer about the account. */
export function isNearRpcUnreachable(error: unknown): boolean {
  return !(error instanceof NearRpcError) || /HTTP|rate limited|no result|All NEAR RPC/.test(error.message);
}

/**
 * Every account a key controls with full access. A NEAR key does not encode
 * its account: named accounts (`alice.near`) are looked up in FastNEAR's
 * public-key index, the key's own implicit account is always a candidate,
 * and each candidate is confirmed on-chain. Named accounts come first.
 */
export async function findNearAccountsForKey(
  publicKey: string,
  implicitAccountId: string,
  options?: NearRpcOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  let indexed: string[] = [];
  try {
    const response = await fetchImpl(`https://api.fastnear.com/v0/public_key/${publicKey}`, { signal: AbortSignal.timeout(4_000) });
    if (response.ok) {
      const body = await response.json() as { account_ids?: unknown };
      if (Array.isArray(body.account_ids)) indexed = body.account_ids.filter((id): id is string => typeof id === 'string' && isValidNearAccountId(id));
    }
  } catch {
    // Index unavailable: the implicit account is still checked below.
  }
  const candidates = [...new Set([...indexed, implicitAccountId])].slice(0, 8);
  const verified = await Promise.all(candidates.map(async (id) => (await verifyFullAccessKey(id, publicKey, options) ? id : null)));
  const implicit = (id: string) => /^[0-9a-f]{64}$/.test(id);
  return verified.filter((id): id is string => id !== null).sort((left, right) => Number(implicit(left)) - Number(implicit(right)));
}

// ---------------------------------------------------------------------------
// Transaction plans (signed and sent by nearSigner.ts)
// ---------------------------------------------------------------------------

export type NearAction =
  | { type: 'FunctionCall'; methodName: string; args: Record<string, unknown>; gas: bigint; deposit: bigint }
  | { type: 'Transfer'; deposit: bigint };

/** One transaction to one receiver; a swap may need several, sent in order. */
export interface NearTransactionPlan {
  receiverId: string;
  actions: NearAction[];
  /** Human description for confirmations and logs. */
  label: string;
}

// ---------------------------------------------------------------------------
// Ref Finance swaps
// ---------------------------------------------------------------------------

export interface RefSwapAction {
  pool_id: number;
  token_in: string;
  token_out: string;
  amount_in?: string;
  min_amount_out: string;
}

export interface RefSwapQuote {
  tokenIn: string; // may be NATIVE_NEAR
  tokenOut: string; // may be NATIVE_NEAR
  amountIn: string; // smallest units of tokenIn
  expectedOut: string;
  minOut: string;
  actions: RefSwapAction[];
  hops: number;
  slippage: number; // fraction, e.g. 0.01
  /**
   * Multi-venue route (Rhea DCL, or Ref then DCL): each leg is its own
   * ft_transfer_call, the next leg spending the previous leg's minimum
   * output. Absent on a plain Ref smart-router route (`actions`).
   */
  legs?: NearSwapLeg[];
  /** Human route label: "Ref Finance", "Rhea DCL", "Ref Finance → Rhea DCL". */
  venue?: string;
}

/** One hop group of a NEAR swap on a single venue. */
export interface NearSwapLeg {
  venue: 'ref' | 'dcl';
  /** Contract ids; NATIVE_NEAR only as the final output of a Ref leg (Ref unwraps it). */
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedOut: string;
  minOut: string;
  /** Ref smart-router actions (venue 'ref'). */
  actions?: RefSwapAction[];
  /** DCL pool path (venue 'dcl'). */
  poolIds?: string[];
  /** DCL output recipient (the trading account). */
  recipient?: string;
}

/** Rhea (Ref) concentrated-liquidity exchange: where launchpads like nearly.trade create their pools. */
export const REF_DCL = 'dclv2.ref-labs.near';
/** RHEA, a common quote token for launchpad DCL pools (besides wNEAR). */
export const RHEA_TOKEN = 'token.rhealab.near';
const DCL_FEE_TIERS = [100, 400, 2000, 10000];

/** DCL pool ids are `token_a|token_b|fee` with the two token ids in sorted order. */
export function dclPoolId(tokenA: string, tokenB: string, fee: number): string {
  return `${[tokenA, tokenB].sort().join('|')}|${fee}`;
}

/** Existing DCL pools pairing `token` with `quote` (one per fee tier). */
export async function findDclPools(token: string, quote: string, options?: NearRpcOptions): Promise<string[]> {
  const ids = DCL_FEE_TIERS.map((fee) => dclPoolId(token, quote, fee));
  const pools = await Promise.all(ids.map((poolId) => viewFunction<unknown>(REF_DCL, 'get_pool', { pool_id: poolId }, options).then((pool) => (pool ? poolId : null)).catch(() => null)));
  return pools.filter((poolId): poolId is string => Boolean(poolId));
}

/** DCL output for `amountIn` through a pool path, or 0n when the path cannot fill it. */
export async function dclQuote(poolIds: string[], tokenIn: string, tokenOut: string, amountIn: string, options?: NearRpcOptions): Promise<bigint> {
  const result = await viewFunction<{ amount?: string } | null>(REF_DCL, 'quote', { pool_ids: poolIds, input_token: tokenIn, output_token: tokenOut, input_amount: amountIn, tag: null }, options).catch(() => null);
  return result?.amount && /^\d+$/.test(result.amount) ? BigInt(result.amount) : 0n;
}

/**
 * Direct quote on one Ref classic pool, found through GeckoTerminal's NEAR
 * pool index and priced on-chain with the exchange's get_return — the
 * fallback when the smart router is slow or down.
 */
export async function getRefDirectQuote(params: { tokenIn: string; tokenOut: string; amountIn: string; slippage: number; rpc?: NearRpcOptions; fetchImpl?: typeof fetch }): Promise<RefSwapQuote> {
  const tokenIn = refToken(params.tokenIn);
  const tokenOut = refToken(params.tokenOut);
  const token = tokenIn === WRAP_NEAR ? tokenOut : tokenIn;
  const doFetch = params.fetchImpl ?? fetch;
  const getJson = (url: string) => doFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000) })
    .then((response) => (response.ok ? response.json() : null)).catch(() => null);
  // Two independent pool indexes (either may be rate limited): DexScreener and GeckoTerminal.
  const [screener, gecko] = await Promise.all([
    getJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`) as Promise<{ pairs?: Array<{ chainId?: string; pairAddress?: string; baseToken?: { address?: string }; quoteToken?: { address?: string }; liquidity?: { usd?: number } }> } | null>,
    getJson(`https://api.geckoterminal.com/api/v2/networks/near/tokens/${encodeURIComponent(token)}/pools?page=1`) as Promise<{ data?: Array<{ attributes?: { address?: string; reserve_in_usd?: string }; relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } } }> } | null>,
  ]);
  const found = new Map<number, number>();
  const consider = (address: string | undefined, sides: Array<string | undefined>, reserve: number) => {
    const id = /^refv1-(\d+)$/.exec(address ?? '')?.[1];
    if (id && sides.includes(tokenIn) && sides.includes(tokenOut)) found.set(Number(id), Math.max(found.get(Number(id)) ?? 0, reserve));
  };
  for (const pair of screener?.pairs ?? []) {
    if (pair.chainId === 'near') consider(pair.pairAddress, [pair.baseToken?.address, pair.quoteToken?.address], pair.liquidity?.usd ?? 0);
  }
  for (const pool of gecko?.data ?? []) {
    consider(pool.attributes?.address, [pool.relationships?.base_token?.data?.id, pool.relationships?.quote_token?.data?.id].map((ref) => ref?.replace(/^near_/, '')), Number(pool.attributes?.reserve_in_usd ?? 0));
  }
  const pools = [...found.entries()].map(([id, reserve]) => ({ id, reserve })).sort((x, y) => y.reserve - x.reserve).slice(0, 3);
  if (!pools.length) throw new Error('No Ref Finance pool found for this pair');
  const quotes = await Promise.all(pools.map(async (pool) => {
    const out = await viewFunction<string>(REF_EXCHANGE, 'get_return', { pool_id: pool.id, token_in: tokenIn, amount_in: params.amountIn, token_out: tokenOut }, params.rpc).catch(() => '0');
    return { pool, out: BigInt(out || '0') };
  }));
  const best = quotes.sort((a, b) => (b.out > a.out ? 1 : -1))[0];
  if (!best || best.out <= 0n) throw new Error('No Ref Finance route found for this pair');
  const slippage = Math.min(0.5, Math.max(0.0005, params.slippage));
  const minOut = withSlippage(best.out, slippage);
  return {
    tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, expectedOut: best.out.toString(), minOut: minOut.toString(),
    actions: [{ pool_id: best.pool.id, token_in: tokenIn, token_out: tokenOut, amount_in: params.amountIn, min_amount_out: minOut.toString() }],
    hops: 1, slippage, venue: 'Ref Finance',
  };
}

/** Classic Ref route: the smart router, with a direct on-chain pool quote racing it after a short head start. */
export async function getRefClassicQuote(params: { tokenIn: string; tokenOut: string; amountIn: string; slippage: number; rpc?: NearRpcOptions; fetchImpl?: typeof fetch }): Promise<RefSwapQuote> {
  const router = getRefSwapQuote(params).then((quote) => ({ ...quote, venue: 'Ref Finance' }));
  const direct = new Promise<void>((resolve) => setTimeout(resolve, 1_500)).then(() => getRefDirectQuote(params));
  return firstFulfilled([router, direct]).catch((errors: Error[]) => { throw errors[0] ?? new Error('No Ref Finance route found for this pair'); });
}

const withSlippage = (amount: bigint, slippage: number) => (amount * BigInt(Math.round((1 - slippage) * 10_000))) / 10_000n;

/**
 * Best route for a NEAR swap across venues: Ref's smart router (classic
 * pools) and Rhea DCL pools — direct against wNEAR, or through RHEA (Ref
 * wNEAR⇄RHEA, then DCL). Launchpad tokens (nearly.trade…) often trade only on
 * DCL, which the smart router does not route.
 */
export async function getNearSwapQuote(params: {
  tokenIn: string; tokenOut: string; amountIn: string; slippage: number; accountId?: string; rpc?: NearRpcOptions; fetchImpl?: typeof fetch;
}): Promise<RefSwapQuote> {
  const slippage = Math.min(0.5, Math.max(0.0005, params.slippage));
  const refRoute = getRefClassicQuote(params).catch((error: unknown) => error as Error);
  const inNear = params.tokenIn === NATIVE_NEAR || params.tokenIn === WRAP_NEAR;
  const outNear = params.tokenOut === NATIVE_NEAR || params.tokenOut === WRAP_NEAR;
  const dclRoutes: Array<Promise<RefSwapQuote | null>> = [];
  if (inNear !== outNear) {
    const token = inNear ? params.tokenOut : params.tokenIn;
    const legsOf = (legs: NearSwapLeg[], venue: string): RefSwapQuote => ({
      tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn,
      expectedOut: legs[legs.length - 1].expectedOut, minOut: legs[legs.length - 1].minOut,
      actions: [], hops: legs.length, slippage, legs, venue,
    });
    const dclLeg = async (poolIds: string[], tokenIn: string, tokenOut: string, amountIn: string): Promise<NearSwapLeg | null> => {
      const out = await dclQuote(poolIds, tokenIn, tokenOut, amountIn, params.rpc);
      if (out <= 0n) return null;
      return { venue: 'dcl', tokenIn, tokenOut, amountIn, expectedOut: out.toString(), minOut: withSlippage(out, slippage).toString(), poolIds, recipient: params.accountId };
    };
    // Direct: wNEAR ⇄ token on a DCL pool.
    dclRoutes.push(findDclPools(token, WRAP_NEAR, params.rpc).then(async (pools) => {
      const legs = await Promise.all(pools.map((pool) => dclLeg([pool], inNear ? WRAP_NEAR : token, inNear ? token : WRAP_NEAR, params.amountIn)));
      const best = legs.filter((leg): leg is NearSwapLeg => leg !== null).sort((a, b) => (BigInt(b.expectedOut) > BigInt(a.expectedOut) ? 1 : -1))[0];
      return best ? legsOf([best], 'Rhea DCL') : null;
    }).catch(() => null));
    // Through RHEA: Ref (wNEAR ⇄ RHEA) and DCL (RHEA ⇄ token), each leg spending the previous leg's minimum.
    if (token !== RHEA_TOKEN) {
      dclRoutes.push(findDclPools(token, RHEA_TOKEN, params.rpc).then(async (pools) => {
        if (!pools.length) return null;
        if (inNear) {
          const ref = await getRefClassicQuote({ ...params, tokenOut: RHEA_TOKEN });
          const refLeg: NearSwapLeg = { venue: 'ref', tokenIn: refToken(params.tokenIn), tokenOut: RHEA_TOKEN, amountIn: ref.amountIn, expectedOut: ref.expectedOut, minOut: ref.minOut, actions: ref.actions };
          const legs = await Promise.all(pools.map((pool) => dclLeg([pool], RHEA_TOKEN, token, ref.minOut)));
          const best = legs.filter((leg): leg is NearSwapLeg => leg !== null).sort((a, b) => (BigInt(b.expectedOut) > BigInt(a.expectedOut) ? 1 : -1))[0];
          return best ? legsOf([refLeg, best], 'Ref Finance → Rhea DCL') : null;
        }
        const legs = await Promise.all(pools.map((pool) => dclLeg([pool], token, RHEA_TOKEN, params.amountIn)));
        const best = legs.filter((leg): leg is NearSwapLeg => leg !== null).sort((a, b) => (BigInt(b.expectedOut) > BigInt(a.expectedOut) ? 1 : -1))[0];
        if (!best) return null;
        const ref = await getRefClassicQuote({ ...params, tokenIn: RHEA_TOKEN, amountIn: best.minOut });
        const refLeg: NearSwapLeg = { venue: 'ref', tokenIn: RHEA_TOKEN, tokenOut: params.tokenOut, amountIn: ref.amountIn, expectedOut: ref.expectedOut, minOut: ref.minOut, actions: ref.actions };
        return legsOf([best, refLeg], 'Rhea DCL → Ref Finance');
      }).catch(() => null));
    }
  }
  // Once one route has answered, give the others a short grace period instead of waiting on a slow router.
  const settled = await settleWithGrace<RefSwapQuote | Error | null>([refRoute, ...dclRoutes], QUOTE_GRACE_MS);
  const ref = settled[0] === undefined ? new Error('Ref Finance router is slow right now') : settled[0];
  const dcl = settled.slice(1);
  const candidates = [...(ref instanceof Error || ref === null ? [] : [ref]), ...dcl.filter((quote): quote is RefSwapQuote => quote !== null && quote !== undefined && !(quote instanceof Error))];
  if (!candidates.length) throw ref instanceof Error ? new Error(`${ref.message}; no Rhea DCL pool either`) : new Error('No route found for this pair');
  return candidates.sort((a, b) => (BigInt(b.expectedOut) > BigInt(a.expectedOut) ? 1 : -1))[0];
}

const QUOTE_GRACE_MS = 2_500;

/** The first promise to fulfil; rejects with every reason (in input order) when all reject. */
function firstFulfilled<T>(promises: Array<Promise<T>>): Promise<T> {
  return new Promise((resolve, reject) => {
    const reasons: Error[] = [];
    let rejected = 0;
    promises.forEach((promise, index) => {
      promise.then(resolve, (reason: unknown) => {
        reasons[index] = reason instanceof Error ? reason : new Error(String(reason));
        rejected += 1;
        if (rejected === promises.length) reject(reasons);
      });
    });
  });
}

/**
 * Resolve when every promise settled, or `graceMs` after the first one
 * produced a usable value — whichever comes first. Unfinished entries are undefined.
 */
async function settleWithGrace<T>(promises: Array<Promise<T>>, graceMs: number): Promise<Array<T | undefined>> {
  const results: Array<T | undefined> = promises.map(() => undefined);
  let pending = promises.length;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { if (timer) clearTimeout(timer); resolve(results); };
    promises.forEach((promise, index) => {
      promise.then((value) => {
        results[index] = value;
        if (value && !(value instanceof Error) && !timer) timer = setTimeout(finish, graceMs);
      }, () => undefined).finally(() => { pending -= 1; if (pending === 0) finish(); });
    });
  });
}

/** Tokens a multi-leg route passes through (each needs the account registered to receive it). */
export function routeIntermediateTokens(quote: RefSwapQuote): string[] {
  return (quote.legs ?? []).slice(0, -1).map((leg) => leg.tokenOut).filter((token) => token !== NATIVE_NEAR);
}

interface SmartRouterResponse {
  result_code: number;
  result_message?: string;
  result_data?: {
    amount_out?: string;
    routes?: Array<{
      amount_in: string;
      min_amount_out: string;
      pools: Array<{ pool_id: string; token_in: string; token_out: string; amount_in: string; min_amount_out: string }>;
    }>;
  };
}

/** Ref's smart router answers on two hosts (Ref and its Rhea rebrand); both are asked and the first valid route wins. */
const REF_SMART_ROUTERS = ['https://smartrouter.ref.finance/findPath', 'https://smartrouter.rhea.finance/findPath'];
const ROUTER_TIMEOUT_MS = 8_000;
const refToken = (tokenId: string) => (tokenId === NATIVE_NEAR ? WRAP_NEAR : tokenId);

/**
 * Best route from Ref Finance's smart router. The router applies `slippage`
 * to each route's final hop; intermediate hops carry min 0 and only the
 * first hop of each route specifies amount_in, exactly as Ref's
 * ft_transfer_call message expects.
 */
export async function getRefSwapQuote(params: { tokenIn: string; tokenOut: string; amountIn: string; slippage: number; fetchImpl?: typeof fetch }): Promise<RefSwapQuote> {
  if (params.tokenIn === params.tokenOut) throw new Error('Choose two different tokens');
  if (BigInt(params.amountIn) <= 0n) throw new Error('Amount must be greater than zero');
  const slippage = Math.min(0.5, Math.max(0.0005, params.slippage));
  const query = new URLSearchParams({
    amountIn: params.amountIn,
    tokenIn: refToken(params.tokenIn),
    tokenOut: refToken(params.tokenOut),
    pathDeep: '3',
    slippage: String(slippage),
  });
  const doFetch = params.fetchImpl ?? fetch;
  const ask = async (router: string): Promise<SmartRouterResponse> => {
    const response = await doFetch(`${router}?${query}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Ref Finance router returned HTTP ${response.status}`);
    const payload = await response.json() as SmartRouterResponse;
    if (payload.result_code !== 0 || !payload.result_data?.routes?.length) throw new Error('No Ref Finance route found for this pair');
    return payload;
  };
  const payload = await firstFulfilled(REF_SMART_ROUTERS.map(ask)).catch((reasons: Error[]) => {
    throw reasons.find((reason) => /No Ref Finance route/.test(reason?.message ?? '')) ?? reasons[0] ?? new Error('Ref Finance router unavailable');
  });
  const routes = payload.result_data?.routes ?? [];

  const actions: RefSwapAction[] = [];
  let minOut = 0n;
  for (const route of routes) {
    route.pools.forEach((pool, index) => {
      const last = index === route.pools.length - 1;
      actions.push({
        pool_id: Number(pool.pool_id),
        token_in: pool.token_in,
        token_out: pool.token_out,
        ...(index === 0 ? { amount_in: route.amount_in } : {}),
        min_amount_out: last ? route.min_amount_out : '0',
      });
    });
    minOut += BigInt(route.min_amount_out);
  }
  const first = actions[0];
  const last = actions[actions.length - 1];
  if (first.token_in !== refToken(params.tokenIn) || last.token_out !== refToken(params.tokenOut)) {
    throw new Error('Ref Finance returned a route for a different pair');
  }
  const routedIn = routes.reduce((sum, route) => sum + BigInt(route.amount_in), 0n);
  if (routedIn !== BigInt(params.amountIn)) throw new Error('Ref Finance route does not spend the requested amount');
  if (minOut <= 0n) throw new Error('Ref Finance quoted zero output');

  return {
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
    expectedOut: payload.result_data?.amount_out ?? minOut.toString(),
    minOut: minOut.toString(),
    actions,
    hops: Math.max(...routes.map((route) => route.pools.length)),
    slippage,
  };
}

/** Storage deposit needed to register `accountId` on `tokenId`, or 0n if already registered. */
export async function storageDepositNeeded(tokenId: string, accountId: string, options?: NearRpcOptions): Promise<bigint> {
  const balance = await viewFunction<{ total: string } | null>(tokenId, 'storage_balance_of', { account_id: accountId }, options);
  if (balance) return 0n;
  const bounds = await viewFunction<{ min: string }>(tokenId, 'storage_balance_bounds', {}, options).catch(() => null);
  return BigInt(bounds?.min ?? '1250000000000000000000'); // 0.00125 NEAR, the common NEP-145 minimum
}

/**
 * Turn a Ref quote into the transactions to sign:
 *  1. register the user on the output token (if needed, and not unwrapping to NEAR),
 *  2. for NEAR input: register on wrap.near (if needed) + near_deposit, then
 *     ft_transfer_call into Ref — all in one transaction to wrap.near;
 *     for token input: ft_transfer_call on the input token.
 * Output NEAR is unwrapped by Ref itself (skip_unwrap_near: false).
 *
 * With a Hopr `fee`, the fee is taken from the input token inside the same
 * transaction as the swap (ft_transfer to the fee account, registering it on
 * the token first if needed), so it is only ever paid together with a swap.
 */
export function buildRefSwapPlan(
  quote: RefSwapQuote,
  registration: { outputStorageDeposit: bigint; wrapStorageDeposit: bigint; intermediateStorageDeposits?: Record<string, bigint> },
  fee?: RefSwapFee | null,
): NearTransactionPlan[] {
  if (quote.legs?.length) return buildLegPlan(quote, registration, fee);
  const plans: NearTransactionPlan[] = [];
  const outputIsNear = quote.tokenOut === NATIVE_NEAR;
  if (!outputIsNear && registration.outputStorageDeposit > 0n) {
    plans.push({
      receiverId: quote.tokenOut,
      label: 'Register output token',
      actions: [{ type: 'FunctionCall', methodName: 'storage_deposit', args: { registration_only: true }, gas: 30n * NEAR_TGAS, deposit: registration.outputStorageDeposit }],
    });
  }

  const message = JSON.stringify({
    force: 0,
    actions: quote.actions,
    ...(outputIsNear ? { skip_unwrap_near: false } : {}),
  });
  const transferGas = (quote.hops > 2 || outputIsNear ? 220n : 180n) * NEAR_TGAS;
  const transferCall: NearAction = {
    type: 'FunctionCall',
    methodName: 'ft_transfer_call',
    args: { receiver_id: REF_EXCHANGE, amount: quote.amountIn, msg: message },
    gas: transferGas,
    deposit: 1n,
  };

  const feeActions: NearAction[] = [];
  if (fee && fee.amount > 0n) {
    if (fee.storageDeposit > 0n) {
      feeActions.push({ type: 'FunctionCall', methodName: 'storage_deposit', args: { account_id: fee.account, registration_only: true }, gas: 20n * NEAR_TGAS, deposit: fee.storageDeposit });
    }
    feeActions.push({ type: 'FunctionCall', methodName: 'ft_transfer', args: { receiver_id: fee.account, amount: fee.amount.toString(), memo: 'hopr fee' }, gas: 15n * NEAR_TGAS, deposit: 1n });
  }
  const feeAmount = fee && fee.amount > 0n ? fee.amount : 0n;

  if (quote.tokenIn === NATIVE_NEAR) {
    const actions: NearAction[] = [];
    if (registration.wrapStorageDeposit > 0n) {
      actions.push({ type: 'FunctionCall', methodName: 'storage_deposit', args: { registration_only: true }, gas: 20n * NEAR_TGAS, deposit: registration.wrapStorageDeposit });
    }
    actions.push({ type: 'FunctionCall', methodName: 'near_deposit', args: {}, gas: 10n * NEAR_TGAS, deposit: BigInt(quote.amountIn) + feeAmount });
    actions.push(...feeActions, transferCall);
    plans.push({ receiverId: WRAP_NEAR, label: 'Wrap NEAR and swap on Ref Finance', actions });
  } else {
    plans.push({ receiverId: quote.tokenIn, label: 'Swap on Ref Finance', actions: [...feeActions, transferCall] });
  }
  return plans;
}

/** ft_transfer_call that runs one leg on its venue. */
function legTransferCall(leg: NearSwapLeg, final: boolean): NearAction {
  const toNativeNear = final && leg.tokenOut === NATIVE_NEAR;
  if (leg.venue === 'ref') {
    return {
      type: 'FunctionCall', methodName: 'ft_transfer_call', deposit: 1n, gas: 220n * NEAR_TGAS,
      args: { receiver_id: REF_EXCHANGE, amount: leg.amountIn, msg: JSON.stringify({ force: 0, actions: leg.actions ?? [], ...(toNativeNear ? { skip_unwrap_near: false } : {}) }) },
    };
  }
  return {
    type: 'FunctionCall', methodName: 'ft_transfer_call', deposit: 1n, gas: 200n * NEAR_TGAS,
    args: {
      receiver_id: REF_DCL,
      amount: leg.amountIn,
      msg: JSON.stringify({ Swap: { pool_ids: leg.poolIds ?? [], output_token: leg.tokenOut, min_output_amount: leg.minOut, ...(leg.recipient ? { swap_out_recipient: leg.recipient } : {}) } }),
    },
  };
}

/**
 * Transactions for a multi-leg route: register the output (and every token
 * passed through), wrap NEAR + take Hopr's fee + run leg 1 in one
 * transaction, then one ft_transfer_call per following leg, and unwrap wNEAR
 * at the end when a DCL leg delivers it for a sell to NEAR.
 */
function buildLegPlan(
  quote: RefSwapQuote,
  registration: { outputStorageDeposit: bigint; wrapStorageDeposit: bigint; intermediateStorageDeposits?: Record<string, bigint> },
  fee?: RefSwapFee | null,
): NearTransactionPlan[] {
  const legs = quote.legs!;
  const plans: NearTransactionPlan[] = [];
  const register = (token: string, deposit: bigint | undefined, label: string) => {
    if (deposit && deposit > 0n) {
      plans.push({ receiverId: token, label, actions: [{ type: 'FunctionCall', methodName: 'storage_deposit', args: { registration_only: true }, gas: 30n * NEAR_TGAS, deposit }] });
    }
  };
  const outputIsNear = quote.tokenOut === NATIVE_NEAR;
  if (!outputIsNear) register(quote.tokenOut, registration.outputStorageDeposit, 'Register output token');
  for (const [token, deposit] of Object.entries(registration.intermediateStorageDeposits ?? {})) register(token, deposit, `Register ${token}`);
  if (outputIsNear && quote.tokenIn !== NATIVE_NEAR && legs[legs.length - 1].venue === 'dcl') register(WRAP_NEAR, registration.wrapStorageDeposit, 'Register wNEAR');

  const feeAmount = fee && fee.amount > 0n ? fee.amount : 0n;
  const feeActions: NearAction[] = [];
  if (fee && feeAmount > 0n) {
    if (fee.storageDeposit > 0n) feeActions.push({ type: 'FunctionCall', methodName: 'storage_deposit', args: { account_id: fee.account, registration_only: true }, gas: 20n * NEAR_TGAS, deposit: fee.storageDeposit });
    feeActions.push({ type: 'FunctionCall', methodName: 'ft_transfer', args: { receiver_id: fee.account, amount: fee.amount.toString(), memo: 'hopr fee' }, gas: 15n * NEAR_TGAS, deposit: 1n });
  }

  legs.forEach((leg, index) => {
    const final = index === legs.length - 1;
    const call = legTransferCall(leg, final);
    const label = `${index === 0 && quote.tokenIn === NATIVE_NEAR ? 'Wrap NEAR and swap' : 'Swap'} on ${leg.venue === 'ref' ? 'Ref Finance' : 'Rhea DCL'}`;
    if (index === 0 && quote.tokenIn === NATIVE_NEAR) {
      const actions: NearAction[] = [];
      if (registration.wrapStorageDeposit > 0n) actions.push({ type: 'FunctionCall', methodName: 'storage_deposit', args: { registration_only: true }, gas: 20n * NEAR_TGAS, deposit: registration.wrapStorageDeposit });
      actions.push({ type: 'FunctionCall', methodName: 'near_deposit', args: {}, gas: 10n * NEAR_TGAS, deposit: BigInt(leg.amountIn) + feeAmount }, ...feeActions, call);
      plans.push({ receiverId: WRAP_NEAR, label, actions });
    } else {
      plans.push({ receiverId: leg.tokenIn, label, actions: index === 0 ? [...feeActions, call] : [call] });
    }
  });
  const last = legs[legs.length - 1];
  if (outputIsNear && last.venue === 'dcl') {
    plans.push({ receiverId: WRAP_NEAR, label: 'Unwrap NEAR', actions: [{ type: 'FunctionCall', methodName: 'near_withdraw', args: { amount: last.minOut }, gas: 10n * NEAR_TGAS, deposit: 1n }] });
  }
  return plans;
}

/** Hopr's fee on a Ref swap: paid in the input token (wNEAR for NEAR input). */
export interface RefSwapFee {
  account: string;
  amount: bigint;
  /** NEP-145 registration of the fee account on the input token, when it isn't registered yet. */
  storageDeposit: bigint;
}

/** Hopr platform fee in basis points: 0.75% on trades and bridges alike. */
export const HOPR_FEE_BPS = { swap: 75, bridge: 75 } as const;
/** The same fee as a display percentage (0.75). */
export const HOPR_FEE_PERCENT = HOPR_FEE_BPS.swap / 100;

/** Split a gross input amount into the fee and the part that is actually swapped. */
export function splitHoprFee(gross: bigint, bps: number): { net: bigint; fee: bigint } {
  const fee = bps > 0 ? (gross * BigInt(Math.round(bps))) / 10_000n : 0n;
  return { net: gross - fee, fee };
}

/** The contract that holds a Ref swap's input (native NEAR is wrapped first). */
export const refInputContract = (tokenIn: string) => (tokenIn === NATIVE_NEAR ? WRAP_NEAR : tokenIn);

/**
 * Transactions that deposit a NEAR-side asset into a NEAR Intents (1Click)
 * deposit account: register the account on the token if needed, wrap
 * native NEAR, then ft_transfer. Shared by the dashboard and the bot.
 */
export function buildIntentsDepositPlan(params: { token: string; native: boolean; amount: bigint; depositAddress: string; registration: bigint }): NearTransactionPlan[] {
  const actions: NearAction[] = [];
  if (params.registration > 0n) {
    actions.push({ type: 'FunctionCall', methodName: 'storage_deposit', args: { account_id: params.depositAddress, registration_only: true }, gas: 30n * NEAR_TGAS, deposit: params.registration });
  }
  if (params.native) actions.push({ type: 'FunctionCall', methodName: 'near_deposit', args: {}, gas: 10n * NEAR_TGAS, deposit: params.amount });
  actions.push({ type: 'FunctionCall', methodName: 'ft_transfer', args: { receiver_id: params.depositAddress, amount: params.amount.toString() }, gas: 30n * NEAR_TGAS, deposit: 1n });
  return [{ receiverId: params.token, label: 'Deposit to NEAR Intents', actions }];
}

/** Total yoctoNEAR the plan attaches (excluding gas). */
export function planAttachedDeposit(plans: NearTransactionPlan[]): bigint {
  return plans.reduce((sum, plan) => sum + plan.actions.reduce((inner, action) => inner + action.deposit, 0n), 0n);
}

/** Resolve a /swap argument ("near", "usdc", or a contract id) to a token id. */
export function resolveNearToken(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (KNOWN_NEAR_TOKENS[value]) return KNOWN_NEAR_TOKENS[value].id;
  return isNearAccountId(value) ? value : null;
}
