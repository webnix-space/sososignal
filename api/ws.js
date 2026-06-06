// api/ws.js — Price Feed (Polling-based, Vercel-compatible)
// 
// WHY NOT REAL WEBSOCKET:
// Vercel serverless functions have a 10-30s max execution time and no
// persistent connections. A WebSocket relay inside a serverless function
// WILL die. SSE + WS inside same function also dies.
//
// SOLUTION: This endpoint is a REST snapshot proxy.
// Frontend polls every 5s. SoDEX REST tickers API returns latest prices.
// For true real-time, you need a separate always-on WS server (Railway/Render).
//
// BONUS: ?stream=1 returns SSE but backed by polling, not WS.
// Works within Vercel's 30s streaming limit for the dashboard refresh cycle.

const SPOT_TICKERS = 'https://mainnet-gw.sodex.dev/api/v1/spot/markets/tickers';
const TESTNET_TICKERS = 'https://testnet-gw.sodex.dev/api/v1/spot/markets/tickers';
// CoinGecko fallback (no key needed for simple prices)
const COINGECKO_SIMPLE = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true';

function fetchWithTimeout(url, options = {}, timeout = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

const SYMBOL_MAP = {
  'BTC_USDC': 'BTC', 'vBTC_vUSDC': 'BTC', 'BTC/USDC': 'BTC',
  'ETH_USDC': 'ETH', 'vETH_vUSDC': 'ETH', 'ETH/USDC': 'ETH',
  'SOL_USDC': 'SOL', 'vSOL_vUSDC': 'SOL', 'SOL/USDC': 'SOL',
  'BNB_USDC': 'BNB', 'vBNB_vUSDC': 'BNB', 'BNB/USDC': 'BNB'
};

const CG_MAP = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  binancecoin: 'BNB'
};

// ── Try SoDEX REST tickers ─────────────────────────────────────────────────
async function fetchSoDEXPrices(testnet = false) {
  const url = testnet ? TESTNET_TICKERS : SPOT_TICKERS;
  try {
    const r = await fetchWithTimeout(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'OnchainEdge/2.0' }
    }, 6000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const items = j?.data || [];
    if (!items.length) throw new Error('Empty tickers response');

    const prices = {};
    for (const t of items) {
      const rawSym = t.symbol || '';
      const sym = SYMBOL_MAP[rawSym] || SYMBOL_MAP[rawSym.replace(/^v/, '').replace(/_vUSDC$/, '_USDC')];
      if (!sym) continue;
      const price = parseFloat(t.lastPx || t.lastPrice || 0);
      if (!isFinite(price) || price <= 0) continue;
      prices[sym] = {
        price,
        change: parseFloat(t.changePct || t.changePct24h || 0),
        volume: parseFloat(t.quoteVolume || t.volume || 0),
        source: testnet ? 'sodex-testnet' : 'sodex-live',
        timestamp: Date.now()
      };
    }
    if (Object.keys(prices).length === 0) throw new Error('No matching symbols parsed');
    return prices;
  } catch (e) {
    console.warn('[ws] SoDEX failed:', e.message);
    return null;
  }
}

// ── CoinGecko fallback ─────────────────────────────────────────────────────
async function fetchCoinGeckoPrices() {
  try {
    const r = await fetchWithTimeout(COINGECKO_SIMPLE, {
      headers: { 'Accept': 'application/json' }
    }, 6000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const prices = {};
    for (const [cgId, sym] of Object.entries(CG_MAP)) {
      const d = j[cgId];
      if (!d) continue;
      prices[sym] = {
        price: d.usd || 0,
        change: d.usd_24h_change || 0,
        volume: d.usd_24h_vol || 0,
        source: 'coingecko',
        timestamp: Date.now()
      };
    }
    return prices;
  } catch (e) {
    console.warn('[ws] CoinGecko failed:', e.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const testnet = req.query.testnet === '1';

  // ── SSE streaming mode (single poll then close — frontend re-connects) ────
  if (req.query.stream === '1') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const prices = await fetchSoDEXPrices(testnet) || await fetchCoinGeckoPrices();
    if (!prices) {
      res.write(`data: ${JSON.stringify({ error: 'All price sources unavailable' })}\n\n`);
      res.end();
      return;
    }
    for (const [sym, data] of Object.entries(prices)) {
      res.write(`data: ${JSON.stringify({ symbol: sym, ...data })}\n\n`);
    }
    // Send a heartbeat then end — frontend polls again after interval
    res.write(`: heartbeat\n\n`);
    res.end();
    return;
  }

  // ── Standard REST snapshot (default) ─────────────────────────────────────
  const prices = await fetchSoDEXPrices(testnet) || await fetchCoinGeckoPrices();

  if (!prices || Object.keys(prices).length === 0) {
    return res.status(503).json({
      ok: false,
      error: 'All price sources unavailable (SoDEX + CoinGecko both failed)',
      updatedAt: Date.now()
    });
  }

  return res.json({
    ok: true,
    data: prices,
    source: Object.values(prices)[0]?.source || 'unknown',
    updatedAt: Date.now()
  });
}
