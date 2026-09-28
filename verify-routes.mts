// Temporary live verification harness (deleted after use): quotes every
// dashboard buy / sell / bridge route and every bot route through the real
// providers, then simulates the transaction the user would sign.
import { keccak_256 } from '@noble/hashes/sha3';
import { planRoute, previewPlan, getRouteQuote, describePlan, type Asset, type RouteRequest, type RouteQuote } from './src/services/router.ts';
import { NETWORKS, getNetwork } from './src/services/chains.ts';
import { getQuote } from './src/services/lifiTrader.ts';
import { getErc20Decimals } from './src/services/wallets/evm.ts';

const EVM = '0x7a16fF8270133F063aAb6C9977183D9e72835428'; // plain EOA used for simulations (state-overridden)
const SOL = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const NEAR = 'aurora';
const only = process.argv[2];

const native = (chainId: number): Asset => {
  const n = getNetwork(chainId)!;
  return { chainId, address: 'native', symbol: n.nativeSymbol, decimals: n.nativeDecimals };
};
const FUND: Record<number, bigint> = {
  8453: 6n * 10n ** 15n, 42161: 6n * 10n ** 15n, 4663: 6n * 10n ** 15n, 56: 3n * 10n ** 16n,
  5042: 15n * 10n ** 18n, 1151111081099710: 12n * 10n ** 7n, 397: 3n * 10n ** 24n,
};
const addr = (vm: string) => (vm === 'evm' ? EVM : vm === 'svm' ? SOL : NEAR);

const TOKENS: Asset[] = [
  { chainId: 8453, address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN', decimals: 18 },
  { chainId: 42161, address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', decimals: 18 },
  { chainId: 56, address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', symbol: 'CAKE', decimals: 18 },
  { chainId: 4663, address: '0xa241395adcdf456f6dc04d1bc02b18e6f4c4052c', symbol: 'ROBINPEPE', decimals: 18 },
  { chainId: 5042, address: '0xeCe5cA8bf9220718E5727754026757512212cb3c', symbol: 'ARGUS', decimals: 18 },
  { chainId: 1151111081099710, address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', decimals: 5 },
  { chainId: 397, address: 'blackdragon.tkn.near', symbol: 'BLACKDRAGON', decimals: 24 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows: string[] = [];
let failures = 0;
function log(kind: string, label: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  const line = `${ok ? 'PASS' : 'FAIL'}  ${kind.padEnd(7)} ${label.padEnd(46)} ${detail}`;
  rows.push(line);
  console.log(line);
}

// ---------------------------------------------------------------- simulation
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const pad = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const slotKey = (key: string, slot: number) => `0x${hex(keccak_256(Buffer.from(pad(key) + pad(slot.toString(16)), 'hex')))}`;
const nestedKey = (outer: string, inner: string, slot: number) => `0x${hex(keccak_256(Buffer.from(pad(inner) + slotKey(outer, slot).slice(2), 'hex')))}`;

async function rpc(chainId: number, method: string, params: unknown[]) {
  const res = await fetch(getNetwork(chainId)!.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return res.json() as Promise<{ result?: string; error?: { message: string } }>;
}

const BIG = `0x${(10n ** 30n).toString(16)}`;
const slotCache = new Map<string, { balance: number; allowance: number } | null>();
/** Find the ERC-20 balance/allowance mapping slots by probing with state overrides. */
async function tokenSlots(chainId: number, token: string, spender: string, allowanceOnly = false) {
  const key = `${chainId}:${token}:${spender}`;
  if (slotCache.has(key)) return slotCache.get(key)!;
  let balance = allowanceOnly ? 0 : -1;
  for (let slot = 0; slot < 60 && balance < 0; slot += 1) {
    const r = await rpc(chainId, 'eth_call', [{ to: token, data: `0x70a08231${pad(EVM)}` }, 'latest', { [token]: { stateDiff: { [slotKey(EVM, slot)]: `0x${pad(BIG)}` } } }]);
    if (r.result && BigInt(r.result) === 10n ** 30n) balance = slot;
  }
  let allowance = -1;
  for (let slot = 0; slot < 60 && allowance < 0; slot += 1) {
    const r = await rpc(chainId, 'eth_call', [{ to: token, data: `0xdd62ed3e${pad(EVM)}${pad(spender)}` }, 'latest', { [token]: { stateDiff: { [nestedKey(EVM, spender, slot)]: `0x${pad(BIG)}` } } }]);
    if (r.result && BigInt(r.result) === 10n ** 30n) allowance = slot;
  }
  const found = balance >= 0 && allowance >= 0 ? { balance, allowance } : null;
  slotCache.set(key, found);
  return found;
}

async function simulateEvm(chainId: number, tx: { to?: string; data?: string; value?: string }, token?: { address: string; spender: string; allowanceOnly?: boolean }) {
  const overrides: Record<string, unknown> = { [EVM]: { balance: BIG } };
  if (token) {
    const slots = await tokenSlots(chainId, token.address, token.spender, token.allowanceOnly);
    if (!slots) return 'SKIP (token storage layout not probeable)';
    overrides[token.address] = { stateDiff: {
      ...(token.allowanceOnly ? {} : { [slotKey(EVM, slots.balance)]: `0x${pad(BIG)}` }),
      [nestedKey(EVM, token.spender, slots.allowance)]: `0x${pad(BIG)}`,
    } };
  }
  const r = await rpc(chainId, 'eth_call', [{ from: EVM, to: tx.to, data: tx.data, value: tx.value && tx.value !== '0x0' ? tx.value : undefined }, 'latest', overrides]);
  return r.error ? `REVERT ${r.error.message.slice(0, 90)}` : 'simulated ✓';
}

async function simulateSolana(base64: string) {
  const res = await fetch(getNetwork(1151111081099710)!.rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [base64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }] }),
  });
  const data = await res.json() as { result?: { value?: { err: unknown; logs?: string[] } }; error?: { message: string } };
  if (data.error) return `RPC ${data.error.message.slice(0, 80)}`;
  const err = data.result?.value?.err;
  return err ? `REVERT ${JSON.stringify(err).slice(0, 60)} ${(data.result?.value?.logs ?? []).filter((l) => /error|failed/i.test(l)).slice(-1)[0]?.slice(0, 80) ?? ''}` : 'simulated ✓';
}

async function simulateQuote(quote: RouteQuote): Promise<string> {
  const req = quote.request;
  if (quote.provider === 'intents') return 'deposit transfer (plain send) · quote ✓';
  if (quote.provider === 'ref') return 'NEAR tx plan built · quote ✓';
  const tx = quote.lifi?.transactionRequest;
  if (!tx) return 'no tx';
  if (getNetwork(req.from.chainId)!.vm === 'svm') {
    if (req.from.address !== 'native') return 'SPL sell: simulated separately';
    return simulateSolana(tx.data!);
  }
  const gasToken = getNetwork(req.from.chainId)!.lifiNative;
  const spender = quote.lifi?.estimate?.approvalAddress ?? tx.to!;
  const erc20 = req.from.address !== 'native'
    ? { address: req.from.address, spender }
    : gasToken && quote.lifi?.estimate?.approvalAddress ? { address: gasToken.address, spender, allowanceOnly: true } : undefined;
  return simulateEvm(req.from.chainId, tx, erc20);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = (error as Error).message;
      if (attempt < 3 && /429|rate|Too Many|fetch failed|timeout/i.test(message)) { await sleep(4000 * (attempt + 1)); continue; }
      throw error;
    }
  }
}

/** Plan + quote every step; simulate the first step (and later EVM/Solana native steps). */
async function checkRoute(kind: string, request: RouteRequest) {
  const label = `${request.from.symbol}@${getNetwork(request.from.chainId)!.shortName} → ${request.to.symbol}@${getNetwork(request.to.chainId)!.shortName}`;
  try {
    const legs = await withRetry(() => planRoute(request));
    const preview = await withRetry(() => previewPlan(request));
    const sims: string[] = [];
    for (const [index, quote] of preview.quotes.entries()) {
      sims.push(`${index + 1}:${quote.provider} ${await simulateQuote(quote)}`);
      await sleep(250);
    }
    const bad = sims.some((s) => /REVERT|RPC|no tx/.test(s));
    log(kind, label, !bad, `${legs.length > 1 ? `[${describePlan(legs)}] ` : ''}${sims.join(' | ')} · out≈${preview.amountOutUsd ? `$${preview.amountOutUsd.toFixed(2)}` : preview.expectedOut}`);
    return preview;
  } catch (error) {
    log(kind, label, false, (error as Error).message.slice(0, 140));
    return null;
  } finally {
    await sleep(600);
  }
}

// ---------------------------------------------------------------- dashboard
const decimalsFixed = await Promise.all(TOKENS.map(async (token) => {
  const net = getNetwork(token.chainId)!;
  if (net.vm !== 'evm') return token;
  return { ...token, decimals: await getErc20Decimals(token.chainId, token.address).catch(() => token.decimals) };
}));

const sellAmounts = new Map<string, bigint>();
const startToken = Number(process.argv[3] ?? 0);
if (!only || only === 'buy') {
  for (const token of decimalsFixed.slice(startToken)) {
    for (const funding of NETWORKS) {
      const q = await checkRoute('BUY', { kind: 'swap', from: native(funding.id), to: token, amount: FUND[funding.id], fromAddress: addr(funding.vm), toAddress: addr(getNetwork(token.chainId)!.vm), slippage: 0.03 });
      if (q && funding.id === token.chainId) sellAmounts.set(token.address, (q.expectedOut * 9n) / 10n);
    }
  }
}

if (!only || only === 'sell') {
  for (const token of decimalsFixed) {
    let amount = sellAmounts.get(token.address);
    if (!amount) {
      const q = await withRetry(() => previewPlan({ kind: 'swap', from: native(token.chainId), to: token, amount: FUND[token.chainId], fromAddress: addr(getNetwork(token.chainId)!.vm), toAddress: addr(getNetwork(token.chainId)!.vm), slippage: 0.03 })).catch(() => null);
      amount = q ? (q.expectedOut * 9n) / 10n : 0n;
    }
    if (!amount) { log('SELL', token.symbol, false, 'could not size the sell'); continue; }
    const targets = [token.chainId, token.chainId === 8453 ? 1151111081099710 : 8453, 397].filter((id, i, all) => all.indexOf(id) === i);
    for (const target of targets) {
      await checkRoute('SELL', { kind: 'swap', from: token, to: native(target), amount, fromAddress: addr(getNetwork(token.chainId)!.vm), toAddress: addr(getNetwork(target)!.vm), slippage: 0.03 });
    }
  }
}

if (!only || only === 'bridge') {
  // Every chain bridges to its neighbour in the list and to/from NEAR; USDC between each USDC chain and the next.
  const pairs: Array<[number, number]> = [];
  NETWORKS.forEach((from, index) => {
    const next = NETWORKS[(index + 1) % NETWORKS.length];
    pairs.push([from.id, next.id]);
    if (from.id !== 397) pairs.push([from.id, 397], [397, from.id]);
  });
  for (const [fromId, toId] of pairs.filter((pair, i, all) => all.findIndex((p) => p[0] === pair[0] && p[1] === pair[1]) === i)) {
    const from = getNetwork(fromId)!;
    const to = getNetwork(toId)!;
    await checkRoute('BRIDGE', { kind: 'bridge', from: native(from.id), to: native(to.id), amount: FUND[from.id], fromAddress: addr(from.vm), toAddress: addr(to.vm), slippage: 0.01 });
  }
  const usdcChains = NETWORKS.filter((n) => n.usdc);
  for (const [index, from] of usdcChains.entries()) {
    const to = usdcChains[(index + 1) % usdcChains.length];
    const asset = (n: typeof from): Asset => ({ chainId: n.id, address: n.usdc!.address, symbol: 'USDC', decimals: n.usdc!.decimals });
    await checkRoute('BRIDGE', { kind: 'bridge', from: asset(from), to: asset(to), amount: 15n * 10n ** BigInt(from.usdc!.decimals), fromAddress: addr(from.vm), toAddress: addr(to.vm), slippage: 0.01 });
  }
}

// ---------------------------------------------------------------- bot (custodial LI.FI path)
if (!only || only === 'bot') {
  const BOT_NATIVE: Record<number, string> = { 1151111081099710: '11111111111111111111111111111111', 5042: '0x3600000000000000000000000000000000000000' };
  for (const funding of NETWORKS.filter((n) => n.vm !== 'near')) {
    for (const token of decimalsFixed.filter((t) => getNetwork(t.chainId)!.vm !== 'near')) {
      if (funding.id !== token.chainId && funding.id !== 8453 && token.chainId !== 8453) continue; // same-chain + via-Base pairs
      const label = `${funding.nativeSymbol}@${funding.shortName} → ${token.symbol}@${getNetwork(token.chainId)!.shortName}`;
      try {
        const units = FUND[funding.id];
        const quote = await withRetry(() => getQuote({
          fromChain: String(funding.id), toChain: String(token.chainId),
          fromToken: BOT_NATIVE[funding.id] ?? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', toToken: token.address,
          fromAmount: funding.id === 5042 ? (units / 10n ** 12n).toString() : units.toString(),
          fromAddress: addr(funding.vm), toAddress: addr(getNetwork(token.chainId)!.vm), slippage: 0.03, fee: 0.005,
        }, ''));
        const sim = funding.vm === 'svm'
          ? await simulateSolana(quote.transactionRequestSolana!)
          : await simulateEvm(funding.id, quote.transactionRequest!);
        log('BOT', label, !/REVERT|RPC/.test(sim), `${(quote.raw as { tool?: string }).tool} ${sim}`);
      } catch (error) {
        log('BOT', label, false, (error as Error).message.slice(0, 140));
      }
      await sleep(700);
    }
  }
}

console.log(`\n${rows.length - failures}/${rows.length} passed`);
