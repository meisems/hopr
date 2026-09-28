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
}

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
export async function verifyFullAccessKey(accountId: string, publicKey: string, options?: NearRpcOptions): Promise<boolean> {
  try {
    const key = await nearRpc<{ permission: unknown }>('query', {
      request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey,
    }, options);
    return key.permission === 'FullAccess';
  } catch {
    return false;
  }
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

const REF_SMART_ROUTER = 'https://smartrouter.ref.finance/findPath';
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
  const url = `${REF_SMART_ROUTER}?${query}`;
  // One retry on a network error: the router occasionally drops connections under load.
  const response = await doFetch(url, { headers: { Accept: 'application/json' } })
    .catch(() => new Promise<Response>((resolve, reject) => setTimeout(() => doFetch(url, { headers: { Accept: 'application/json' } }).then(resolve, reject), 800)));
  if (!response.ok) throw new Error(`Ref Finance router returned HTTP ${response.status}`);
  const payload = await response.json() as SmartRouterResponse;
  const routes = payload.result_data?.routes ?? [];
  if (payload.result_code !== 0 || !routes.length) throw new Error('No Ref Finance route found for this pair');

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
  registration: { outputStorageDeposit: bigint; wrapStorageDeposit: bigint },
  fee?: RefSwapFee | null,
): NearTransactionPlan[] {
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

/** Hopr's fee on a Ref swap: paid in the input token (wNEAR for NEAR input). */
export interface RefSwapFee {
  account: string;
  amount: bigint;
  /** NEP-145 registration of the fee account on the input token, when it isn't registered yet. */
  storageDeposit: bigint;
}

/** Hopr platform fees in basis points: 0.5% on trades, 1% on bridges. */
export const HOPR_FEE_BPS = { swap: 50, bridge: 100 } as const;

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
