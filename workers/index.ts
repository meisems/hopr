/**
 * OmniSwap Cloudflare Worker
 * 
 * Handles API routes for:
 * - Chain detection (POST /api/detect)
 * - Wallet balance queries (GET /api/wallet/:address)
 * - Trade execution (POST /api/trade/buy, POST /api/trade/sell)
 * - Trade status polling (GET /api/trade/:id/status)
 * 
 * Deploy with: npx wrangler deploy
 */

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENCRYPTION_KEY: string;
  LIFI_API_KEY: string;
  ENVIRONMENT: string;
}

interface TradeRequest {
  userId: string;
  tokenAddress: string;
  amount: string;
  fundingChain: string;
  slippage: number;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // API Routes
      if (path.startsWith('/api/')) {
        return await handleApiRequest(request, env, ctx, corsHeaders);
      }

      // Health check
      if (path === '/health') {
        return Response.json({ status: 'ok', timestamp: Date.now() }, { headers: corsHeaders });
      }

      // For all other routes, serve the static site from Pages
      return fetch(request);
    } catch (error) {
      return Response.json(
        { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500, headers: corsHeaders }
      );
    }
  },
};

async function handleApiRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // POST /api/detect - Chain detection
  if (path === '/api/detect' && request.method === 'POST') {
    const body = await request.json() as { address: string };
    return handleChainDetection(body.address, env, corsHeaders);
  }

  // GET /api/wallet/:address/balances
  if (path.match(/^\/api\/wallet\/[^/]+\/balances$/) && request.method === 'GET') {
    const address = path.split('/')[3];
    return handleWalletBalances(address, env, corsHeaders);
  }

  // POST /api/trade/buy
  if (path === '/api/trade/buy' && request.method === 'POST') {
    const body = await request.json() as TradeRequest;
    return handleTradeBuy(body, env, corsHeaders);
  }

  // POST /api/trade/sell
  if (path === '/api/trade/sell' && request.method === 'POST') {
    const body = await request.json() as TradeRequest & { percentage: number };
    return handleTradeSell(body, env, corsHeaders);
  }

  // GET /api/trade/:id/status
  if (path.match(/^\/api\/trade\/[^/]+\/status$/) && request.method === 'GET') {
    const tradeId = path.split('/')[3];
    return handleTradeStatus(tradeId, env, corsHeaders);
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
}

async function handleChainDetection(
  address: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Check cache first
  const cacheKey = `detect:${address}`;
  const cached = await env.CACHE?.get(cacheKey);
  if (cached) {
    return Response.json(JSON.parse(cached), { headers: { ...corsHeaders, 'X-Cache': 'HIT' } });
  }

  // Detect chain
  const isBase58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  const isEvm = /^0x[a-fA-F0-9]{40}$/.test(address);

  let result;

  if (isBase58) {
    // Solana token detection via DexScreener
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    
    if (data.pairs && data.pairs.length > 0) {
      const pair = data.pairs[0];
      result = {
        address,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        decimals: 9,
        chainId: 1151111081099710,
        chainType: 'SVM',
        chainName: 'Solana',
        chainColor: '#9945FF',
        priceUsd: parseFloat(pair.priceUsd) || 0,
        liquidity: pair.liquidity?.usd || 0,
        fdv: pair.fdv || 0,
        change24h: pair.priceChange?.h24 || 0,
      };
    }
  } else if (isEvm) {
    // EVM token detection via DexScreener
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    
    if (data.pairs && data.pairs.length > 0) {
      const pair = data.pairs[0];
      const chainMap: Record<string, { id: number; name: string; color: string }> = {
        'arbitrum': { id: 42161, name: 'Arbitrum One', color: '#28A0F0' },
        'base': { id: 8453, name: 'Base', color: '#0052FF' },
        'bsc': { id: 56, name: 'BNB Chain', color: '#F0B90B' },
      };
      
      const chainInfo = chainMap[pair.chainId] || { id: 0, name: pair.chainId, color: '#666' };
      
      result = {
        address,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        decimals: 18,
        chainId: chainInfo.id,
        chainType: 'EVM',
        chainName: chainInfo.name,
        chainColor: chainInfo.color,
        priceUsd: parseFloat(pair.priceUsd) || 0,
        liquidity: pair.liquidity?.usd || 0,
        fdv: pair.fdv || 0,
        change24h: pair.priceChange?.h24 || 0,
      };
    }
  }

  if (!result) {
    return Response.json({ error: 'Token not found' }, { status: 404, headers: corsHeaders });
  }

  // Cache for 5 minutes
  if (env.CACHE) {
    ctx_wait(5 * 60); // Helper to set cache TTL
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 });
  }

  return Response.json(result, { headers: { ...corsHeaders, 'X-Cache': 'MISS' } });
}

function ctx_wait(seconds: number) {
  // Placeholder for cache TTL
}

async function handleWalletBalances(
  address: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Query balances across all chains
  const balances = await Promise.allSettled([
    // Solana balance
    fetchSolanaBalance(address),
    // EVM balances
    fetchEvmBalance(address, 42161),  // Arbitrum
    fetchEvmBalance(address, 8453),   // Base
    fetchEvmBalance(address, 56),     // BSC
    fetchEvmBalance(address, 4663),   // Robinhood
    fetchEvmBalance(address, 5042),   // Arc
  ]);

  const result = {
    address,
    balances: balances.map((b, i) => ({
      chainId: [1151111081099710, 42161, 8453, 56, 4663, 5042][i],
      balance: b.status === 'fulfilled' ? b.value : '0',
      error: b.status === 'rejected' ? b.reason.message : null,
    })),
  };

  return Response.json(result, { headers: corsHeaders });
}

async function fetchSolanaBalance(address: string): Promise<string> {
  const response = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [address],
    }),
  });
  const data = await response.json();
  return (data.result?.value / 1e9).toString();
}

async function fetchEvmBalance(address: string, chainId: number): Promise<string> {
  const rpcUrls: Record<number, string> = {
    42161: 'https://arb1.arbitrum.io/rpc',
    8453: 'https://mainnet.base.org',
    56: 'https://bsc-dataseed.binance.org',
    4663: 'https://rpc.robinhoodchain.io',
    5042: 'https://rpc.arcchain.io',
  };

  const rpcUrl = rpcUrls[chainId];
  if (!rpcUrl) return '0';

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [address, 'latest'],
    }),
  });
  const data = await response.json();
  const balance = BigInt(data.result || '0x0');
  return (Number(balance) / 1e18).toString();
}

async function handleTradeBuy(
  body: TradeRequest,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Validate request
  if (!body.userId || !body.tokenAddress || !body.amount) {
    return Response.json({ error: 'Missing required fields' }, { status: 400, headers: corsHeaders });
  }

  // Generate trade ID
  const tradeId = crypto.randomUUID();

  // TODO: Implement LI.FI quote and execution
  // 1. Get quote from LI.FI API
  // 2. Sign transaction with user's key
  // 3. Submit transaction
  // 4. Store trade record in D1

  // For now, return a mock response
  return Response.json({
    tradeId,
    status: 'PENDING',
    message: 'Trade initiated. Use /api/trade/:id/status to poll for completion.',
  }, { headers: corsHeaders });
}

async function handleTradeSell(
  body: TradeRequest & { percentage: number },
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!body.userId || !body.tokenAddress || !body.percentage) {
    return Response.json({ error: 'Missing required fields' }, { status: 400, headers: corsHeaders });
  }

  const tradeId = crypto.randomUUID();

  // TODO: Implement reverse LI.FI swap
  // 1. Look up original trade to get funding chain
  // 2. Get LI.FI quote for reverse direction
  // 3. Sign and execute
  // 4. Update trade record

  return Response.json({
    tradeId,
    status: 'PENDING',
    message: 'Sell initiated. Proceeds will return to original funding chain.',
  }, { headers: corsHeaders });
}

async function handleTradeStatus(
  tradeId: string,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  // TODO: Query D1 for trade status
  // Also poll LI.FI status API if trade is in bridge phase

  return Response.json({
    tradeId,
    status: 'COMPLETED',
    steps: [
      { name: 'Approval', status: 'DONE' },
      { name: 'Swap', status: 'DONE' },
      { name: 'Bridge', status: 'DONE' },
      { name: 'Delivery', status: 'DONE' },
    ],
  }, { headers: corsHeaders });
}
