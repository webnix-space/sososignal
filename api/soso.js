// api/soso.js — SoSoValue market data, proxied to the REAL API.
//
// Fixed against the actual sosovalue-1.gitbook.io docs (the one this repo's
// README points to — an earlier fix used a different, unrelated GitBook
// mirror and got both the base URL and several field names wrong):
//
//   Base:   https://openapi.sosovalue.com/openapi/v1
//   Header: x-soso-api-key: <key>
//
// CONFIRMED field names (previously wrong — was reading price_change_24h /
// volume_24h, which don't exist on this response):
//   /currencies/{id}/market-snapshot → { price, change_pct_24h, turnover_24h, ... }
//
// CONFIRMED: /btc-treasuries list has NO holdings field at all — only
// {ticker, name, list_location}. BTC holdings require a separate call per
// company: GET /btc-treasuries/{ticker}/purchase-history, using the most
// recent entry's `btc_holding` field. Previously this was reading a
// btc/btc_holdings field directly off the list, which never existed.
//
// CONFIRMED: /etfs list has NO flow data — only {ticker, name, exchange}.
// Per-fund net_inflow requires /etfs/{ticker}/market-snapshot.
//
// RATE LIMIT (confirmed): 20 requests/minute per API key. Fetching prices +
// etf-flows + sector + treasury + crypto-stocks live on every 30s poll was
// firing 30+ SoSoValue calls per cycle — over 60/min sustained from a single
// browser tab — which guaranteed constant 429s and explains why data still
// looked fake even after the endpoints were fixed. Fixed by:
//   1. Caching each `type`'s computed result in Redis with a TTL, so
//      concurrent/frequent polling reuses one fetch instead of re-hitting
//      SoSoValue every time.
//   2. Trimming per-cycle fan-out (fewer tickers per card) and sequencing
//      sub-requests with a small delay instead of firing them all at once,
//      so a single cache-miss cycle doesn't itself burst past 20/min.

export const config = {
  runtime: 'nodejs'
};

const SOSO_BASE = 'https://openapi.sosovalue.com/openapi/v1';

// Cache TTLs — long enough that sustained polling stays well under the
// rate limit, short enough that data doesn't go stale for a live demo.
const CACHE_TTL = {
  prices: 45,
  'etf-flows': 120,
  sector: 90,
  treasury: 600,       // BTC treasury holdings don't move intraday
  'crypto-stocks': 120
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

async function getJson(url, headers) {
  const r = await fetchWithTimeout(url, { headers }, 8000);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const j = await r.json();
  return Array.isArray(j) ? j : (j.data !== undefined ? j.data : j);
}

// ── Redis cache (optional — falls through to always-live if not configured) ─
let redisClient = null;
let redisTried = false;
async function getRedis() {
  if (redisTried) return redisClient;
  redisTried = true;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    redisClient = new Redis({ url, token });
  } catch (e) {
    redisClient = null;
  }
  return redisClient;
}

async function getCached(type) {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(`soso-cache:${type}`);
    return raw || null;
  } catch (e) {
    return null;
  }
}

async function setCached(type, data) {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(`soso-cache:${type}`, data, { ex: CACHE_TTL[type] || 60 });
  } catch (e) { /* non-fatal — just means next request re-fetches live */ }
}

// ── Currency ID lookup (module-scope cache, cheap, changes rarely) ─────────
let currencyIdCache = null;
async function getCurrencyIdMap(headers) {
  if (!currencyIdCache) {
    const list = await getJson(`${SOSO_BASE}/currencies`, headers);
    currencyIdCache = {};
    for (const c of (list || [])) {
      if (c.symbol) currencyIdCache[c.symbol.toUpperCase()] = c.currency_id;
    }
  }
  return currencyIdCache;
}

// ── prices ───────────────────────────────────────────────────────────────
async function fetchPrices(headers) {
  const ids = await getCurrencyIdMap(headers);
  const symbols = ['BTC', 'ETH', 'SOL', 'BNB'];
  const out = {};
  for (const sym of symbols) {
    const id = ids[sym];
    if (!id) continue;
    try {
      const snap = await getJson(`${SOSO_BASE}/currencies/${id}/market-snapshot`, headers);
      if (!snap) continue;
      out[sym] = {
        spot: snap.price ?? 0,
        ch: snap.change_pct_24h ?? 0,
        vol: snap.turnover_24h ?? 0,
        source: 'SoSoValue'
      };
    } catch (e) { /* leave this symbol out */ }
    await sleep(120);
  }
  return Object.keys(out).length ? out : null;
}

// ── etf-flows ────────────────────────────────────────────────────────────
async function fetchEtfFlows(headers) {
  const list = await getJson(`${SOSO_BASE}/etfs`, headers);
  if (!list || !list.length) return null;

  const btcTickers = ['IBIT', 'FBTC', 'GBTC']; // trimmed from 6 to limit per-cycle call volume
  const relevant = list.filter(e => btcTickers.includes((e.ticker || '').toUpperCase()));
  const targets = relevant.length ? relevant : list.slice(0, 3);

  const etfs = [];
  for (const e of targets) {
    try {
      const snap = await getJson(`${SOSO_BASE}/etfs/${e.ticker}/market-snapshot`, headers);
      etfs.push({
        ticker: e.ticker,
        name: e.name || e.ticker,
        netInflow: snap ? (snap.net_inflow ?? 0) : 0
      });
    } catch (e2) { /* skip this fund */ }
    await sleep(120);
  }

  if (!etfs.length) return null;
  const totalNet = etfs.reduce((sum, e) => sum + (e.netInflow || 0), 0);
  return { totalNet, marketsClosed: false, etfs };
}

// ── sector ───────────────────────────────────────────────────────────────
async function fetchSector(headers) {
  const data = await getJson(`${SOSO_BASE}/currencies/sector-spotlight`, headers);
  const sectors = data && data.sector;
  if (!sectors || !sectors.length) return null;
  return sectors.map(s => {
    const chPct = (s['24h_change_pct'] || 0) * 100;
    return {
      d: s.name,
      p: (s.marketcap_dom || 0) * 100,
      ch: chPct,
      sig: chPct > 1.5 ? 'BUY' : chPct < -1.5 ? 'SELL' : 'HOLD',
      source: 'SoSoValue'
    };
  });
}

// ── treasury ─────────────────────────────────────────────────────────────
// CONFIRMED: /btc-treasuries list has no holdings field. Real BTC amount
// comes from the most recent purchase-history entry's `btc_holding` field.
async function fetchTreasury(headers) {
  const list = await getJson(`${SOSO_BASE}/btc-treasuries`, headers);
  if (!list || !list.length) return null;

  // Trimmed to a handful of companies — a full purchase-history call per
  // company for every entry would burn the rate limit on its own. Cached
  // for 10 minutes since holdings don't move intraday, so this cost is
  // paid rarely, not every poll cycle.
  const targets = list.slice(0, 6);
  const out = [];
  for (const t of targets) {
    try {
      const history = await getJson(`${SOSO_BASE}/btc-treasuries/${t.ticker}/purchase-history`, headers);
      const latest = Array.isArray(history) && history.length ? history[0] : null;
      out.push({
        name: t.name || t.ticker,
        ticker: t.ticker || '',
        btc: latest ? (latest.btc_holding ?? 0) : 0
      });
    } catch (e) {
      out.push({ name: t.name || t.ticker, ticker: t.ticker || '', btc: 0 });
    }
    await sleep(120);
  }
  return out.length ? out : null;
}

// ── crypto-stocks ────────────────────────────────────────────────────────
async function fetchCryptoStocks(headers) {
  const list = await getJson(`${SOSO_BASE}/crypto-stocks`, headers);
  if (!list || !list.length) return null;
  const targets = list.slice(0, 5); // trimmed from 6
  const out = [];
  for (const s of targets) {
    try {
      const snap = await getJson(`${SOSO_BASE}/crypto-stocks/${s.ticker}/market-snapshot`, headers);
      out.push({
        tick: s.ticker,
        ex: s.exchange || 'NASDAQ',
        p: snap ? (snap.price ?? 0) : 0,
        ch: snap ? (snap.change_pct_24h ?? 0) : 0,
        source: 'SoSoValue'
      });
    } catch (e) { /* skip this stock */ }
    await sleep(120);
  }
  return out.length ? out : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type } = req.query;
  const apiKey = process.env.SOSO_API_KEY;

  const fallbacks = {
    prices: {
      BTC: { spot: 68420.50, ch: 2.45, vol: 28500000000, source: 'SoSoValue' },
      ETH: { spot: 3540.25, ch: -1.15, vol: 14200000000, source: 'SoSoValue' },
      SOL: { spot: 154.80, ch: 5.82, vol: 3100000000, source: 'SoSoValue' },
      BNB: { spot: 594.60, ch: 0.35, vol: 1200000000, source: 'SoSoValue' }
    },
    'etf-flows': {
      totalNet: 142600000,
      marketsClosed: false,
      etfs: [
        { ticker: 'IBIT', name: 'BlackRock', netInflow: 85000000 },
        { ticker: 'FBTC', name: 'Fidelity', netInflow: 42000000 },
        { ticker: 'GBTC', name: 'Grayscale', netInflow: -11200000 }
      ]
    },
    sector: [
      { d: 'ssiDeFi', p: 5.35, ch: 1.89, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiLayer1', p: 7.42, ch: 2.50, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiMAG7', p: 11.09, ch: 3.37, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiPayFi', p: 14.98, ch: 3.45, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiSocialFi', p: 6.59, ch: 13.16, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiMeme', p: 7.63, ch: 6.04, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiRWA', p: 4.65, ch: 1.91, sig: 'BUY', source: 'SoSoValue' }
    ],
    treasury: [
      { name: 'MicroStrategy', ticker: 'MSTR', btc: 843706 },
      { name: 'XXI Corp', ticker: 'CEP', btc: 43500 },
      { name: 'Metaplanet', ticker: '3350', btc: 40177 },
      { name: 'Coinbase Inc', ticker: 'COIN', btc: 16949 },
      { name: 'Tesla', ticker: 'TSLA', btc: 11509 },
      { name: 'Block Inc.', ticker: 'XYZ', btc: 9032 }
    ],
    'crypto-stocks': [
      { tick: 'COIN', ex: 'NASDAQ', p: 242.50, ch: 4.25, source: 'SoSoValue' },
      { tick: 'MSTR', ex: 'NASDAQ', p: 1620.00, ch: 8.75, source: 'SoSoValue' },
      { tick: 'MARA', ex: 'NASDAQ', p: 18.40, ch: -2.10, source: 'SoSoValue' },
      { tick: 'RIOT', ex: 'NASDAQ', p: 10.15, ch: -1.05, source: 'SoSoValue' },
      { tick: 'CLSK', ex: 'NASDAQ', p: 15.30, ch: 2.10, source: 'SoSoValue' }
    ]
  };

  if (!apiKey) {
    return res.status(200).json({ ok: true, data: fallbacks[type] || fallbacks['prices'], source: 'SoSoValue (Fallback — no API key configured)' });
  }

  const validTypes = ['prices', 'etf-flows', 'sector', 'treasury', 'crypto-stocks'];
  if (!validTypes.includes(type)) {
    return res.status(200).json({ ok: true, data: fallbacks['prices'], source: 'SoSoValue (Fallback)' });
  }

  // Serve from cache first — this is what actually keeps this endpoint
  // under the 20 req/min SoSoValue limit under real traffic.
  const cached = await getCached(type);
  if (cached) {
    return res.status(200).json({ ok: true, data: cached, source: 'SoSoValue (Cached)', updatedAt: Date.now() });
  }

  const headers = { 'x-soso-api-key': apiKey, 'Accept': 'application/json' };

  try {
    let liveData = null;
    if (type === 'prices') liveData = await fetchPrices(headers);
    else if (type === 'etf-flows') liveData = await fetchEtfFlows(headers);
    else if (type === 'sector') liveData = await fetchSector(headers);
    else if (type === 'treasury') liveData = await fetchTreasury(headers);
    else if (type === 'crypto-stocks') liveData = await fetchCryptoStocks(headers);

    if (liveData) {
      await setCached(type, liveData);
      return res.status(200).json({ ok: true, data: liveData, source: 'SoSoValue (Live)', updatedAt: Date.now() });
    }
    throw new Error('Live fetch returned no usable data');
  } catch (error) {
    console.error(`[soso] Live fetch failed for type ${type}:`, error.message);
    return res.status(200).json({
      ok: true,
      data: fallbacks[type] || fallbacks['prices'],
      source: 'SoSoValue (Fallback)',
      updatedAt: Date.now()
    });
  }
}
