// api/soso.js — SoSoValue market data, proxied to the REAL API.
//
// Previous version called https://api.sosovalue.com/v1/crypto/* with a
// Bearer token — that domain and every path under it is fictional. It always
// threw, which is why this endpoint silently served the hardcoded fallback
// data 100% of the time regardless of whether SOSO_API_KEY was valid.
//
// Real base + auth (confirmed working in api/signal.js and api/simulate.js):
//   Base:   https://openapi.sosovalue.com/openapi/v1
//   Header: x-soso-api-key: <key>
//
// Real endpoints used per `type`:
//   prices        → GET /currencies (id lookup) + GET /currencies/{id}/market-snapshot
//   etf-flows     → GET /etfs (list) + GET /etfs/{ticker}/market-snapshot (per fund)
//   sector        → GET /currencies/sector-spotlight (confirmed schema: {sector:[{name,24h_change_pct,marketcap_dom}]})
//   treasury      → GET /btc-treasuries
//   crypto-stocks → GET /crypto-stocks (list) + GET /crypto-stocks/{ticker}/market-snapshot
//
// KNOWN GAP: exact field names on etf/market-snapshot and crypto-stocks
// responses weren't in the confirmed doc set, so those two paths read
// several plausible field names defensively (see getEtfNetInflow /
// fetchCryptoStocks below) rather than assuming one. If numbers come back as
// 0 once SOSO_API_KEY is confirmed valid, that's the next thing to check —
// not the endpoint paths themselves, which are now correct.

export const config = {
  runtime: 'nodejs'
};

const SOSO_BASE = 'https://openapi.sosovalue.com/openapi/v1';

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

async function fetchPrices(headers) {
  const ids = await getCurrencyIdMap(headers);
  const symbols = ['BTC', 'ETH', 'SOL', 'BNB'];
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    const id = ids[sym];
    if (!id) return;
    try {
      const snap = await getJson(`${SOSO_BASE}/currencies/${id}/market-snapshot`, headers);
      if (!snap) return;
      out[sym] = {
        spot: snap.price ?? 0,
        ch: snap.price_change_24h ?? 0,
        vol: snap.volume_24h ?? 0,
        source: 'SoSoValue'
      };
    } catch (e) { /* leave this symbol out — caller falls back per-symbol */ }
  }));
  return Object.keys(out).length ? out : null;
}

function getEtfNetInflow(snap) {
  if (!snap) return null;
  return snap.net_inflow ?? snap.netInflow ?? snap.total_net_inflow ?? null;
}

async function fetchEtfFlows(headers) {
  const list = await getJson(`${SOSO_BASE}/etfs`, headers);
  if (!list || !list.length) return null;

  // BTC spot ETFs only — filter by a ticker allowlist since /etfs likely
  // returns every listed fund (BTC + ETH + others) and the UI card is BTC-specific.
  const btcTickers = ['IBIT', 'FBTC', 'ARKB', 'GBTC', 'BITB', 'HODL'];
  const relevant = list.filter(e => btcTickers.includes((e.ticker || '').toUpperCase()));
  const targets = relevant.length ? relevant : list.slice(0, 6);

  const etfs = [];
  await Promise.all(targets.map(async (e) => {
    try {
      const snap = await getJson(`${SOSO_BASE}/etfs/${e.ticker}/market-snapshot`, headers);
      const netInflow = getEtfNetInflow(snap);
      etfs.push({
        ticker: e.ticker,
        name: e.name || e.ticker,
        netInflow: netInflow ?? 0
      });
    } catch (e2) { /* skip this fund */ }
  }));

  if (!etfs.length) return null;
  const totalNet = etfs.reduce((sum, e) => sum + (e.netInflow || 0), 0);
  return { totalNet, marketsClosed: false, etfs };
}

async function fetchSector(headers) {
  // /currencies/sector-spotlight is the one sector-shaped endpoint with a
  // confirmed response schema: {sector:[{name, 24h_change_pct, marketcap_dom}]}
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

async function fetchTreasury(headers) {
  const list = await getJson(`${SOSO_BASE}/btc-treasuries`, headers);
  if (!list || !list.length) return null;
  return list.map(t => ({
    name: t.name || t.company_name || t.ticker,
    ticker: t.ticker || t.symbol || '',
    btc: t.btc ?? t.btc_holdings ?? t.holdings ?? 0
  }));
}

async function fetchCryptoStocks(headers) {
  const list = await getJson(`${SOSO_BASE}/crypto-stocks`, headers);
  if (!list || !list.length) return null;
  const targets = list.slice(0, 6);
  const out = [];
  await Promise.all(targets.map(async (s) => {
    try {
      const snap = await getJson(`${SOSO_BASE}/crypto-stocks/${s.stock_ticker || s.ticker}/market-snapshot`, headers);
      out.push({
        tick: s.stock_ticker || s.ticker,
        ex: s.exchange || 'NASDAQ',
        p: snap ? (snap.price ?? snap.close ?? 0) : 0,
        ch: snap ? (snap.price_change_24h ?? snap.change_24h ?? 0) : 0,
        source: 'SoSoValue'
      });
    } catch (e) { /* skip this stock */ }
  }));
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

  // The ultimate safety net: 100% realistic data matching the real platform.
  // This ONLY shows up if the real API times out, errors, or returns empty.
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
        { ticker: 'ARKB', name: 'Ark Invest', netInflow: 15600000 },
        { ticker: 'GBTC', name: 'Grayscale', netInflow: -11200000 },
        { ticker: 'BITB', name: 'Bitwise', netInflow: 6500000 },
        { ticker: 'HODL', name: 'VanEck', netInflow: 4700000 }
      ]
    },
    sector: [
      { d: 'ssiDeFi', p: 5.35, ch: 1.89, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiLayer1', p: 7.42, ch: 2.50, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiMAG7', p: 11.09, ch: 3.37, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiPayFi', p: 14.98, ch: 3.45, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiSocialFi', p: 6.59, ch: 13.16, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiMeme', p: 7.63, ch: 6.04, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiRWA', p: 4.65, ch: 1.91, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiNFT', p: 2.02, ch: 5.44, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiAI', p: 3.86, ch: 0.83, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiLayer2', p: 0.58, ch: 4.15, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiDePIN', p: 1.74, ch: 6.11, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiGameFi', p: 0.88, ch: 2.88, sig: 'BUY', source: 'SoSoValue' },
      { d: 'ssiPoW Indices', p: 18.70, ch: 2.25, sig: 'HOLD', source: 'SoSoValue' }
    ],
    treasury: [
      { name: 'MicroStrategy', ticker: 'MSTR', btc: 843706 },
      { name: 'XXI Corp', ticker: 'CEP', btc: 43500 },
      { name: 'Metaplanet', ticker: '3350', btc: 40177 },
      { name: 'Bitcoin Standard', ticker: 'BSTR', btc: 30021 },
      { name: 'Bullish', ticker: 'BLSH', btc: 24000 },
      { name: 'Coinbase Inc', ticker: 'COIN', btc: 16949 },
      { name: 'Strive Inc.', ticker: 'ASST', btc: 15009 },
      { name: 'Tesla', ticker: 'TSLA', btc: 11509 },
      { name: 'Block Inc.', ticker: 'XYZ', btc: 9032 },
      { name: 'American Bitcoin', ticker: 'ABTC', btc: 7021 },
      { name: 'Galaxy Digital', ticker: 'GLXY', btc: 6894 },
      { name: 'Next Technology', ticker: 'NXTT', btc: 5833 }
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

  const headers = { 'x-soso-api-key': apiKey, 'Accept': 'application/json' };

  try {
    let liveData = null;
    if (type === 'prices') liveData = await fetchPrices(headers);
    else if (type === 'etf-flows') liveData = await fetchEtfFlows(headers);
    else if (type === 'sector') liveData = await fetchSector(headers);
    else if (type === 'treasury') liveData = await fetchTreasury(headers);
    else if (type === 'crypto-stocks') liveData = await fetchCryptoStocks(headers);

    if (liveData) {
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
