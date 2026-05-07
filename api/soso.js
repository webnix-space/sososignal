// /api/soso.js — Wave 1: Deep SoSoValue Integration with Better Field Detection

const SOSO_BASE = 'https://openapi.sosovalue.com/openapi/v1';
const SOSO_KEY = process.env.SOSO_API_KEY;

const sosoHeaders = {
  'x-soso-api-key': SOSO_KEY || '',
  'Content-Type': 'application/json'
};

// Cache currency_id mapping
let currencyIdCache = null;
let currencyIdCacheTime = 0;

async function getCurrencyIds() {
  const now = Date.now();
  if (currencyIdCache && (now - currencyIdCacheTime < 3600000)) return currencyIdCache;
  
  try {
    const res = await fetch(`${SOSO_BASE}/currencies`, { headers: sosoHeaders });
    if (res.ok) {
      const data = await res.json();
      const map = {};
      const list = Array.isArray(data) ? data : (data.data || data.list || data.currencies || []);
      for (const c of list) {
        const symbol = (c.symbol || c.ticker || '').toUpperCase();
        if (symbol) map[symbol] = c.currency_id || c.id || c._id;
      }
      currencyIdCache = map;
      currencyIdCacheTime = now;
      console.log('Currency IDs cached:', Object.keys(map).slice(0, 10).join(', '));
      return map;
    }
  } catch (e) { console.error('Currency ID fetch failed:', e.message); }
  
  return {};
}

// Helper: extract numeric value from nested object trying multiple field names
function extractNumber(obj, fields) {
  if (!obj) return 0;
  for (const f of fields) {
    if (obj[f] != null && !isNaN(parseFloat(obj[f]))) {
      return parseFloat(obj[f]);
    }
  }
  return 0;
}

// Helper: extract string trying multiple field names
function extractString(obj, fields) {
  if (!obj) return '';
  for (const f of fields) {
    if (obj[f] != null) return String(obj[f]);
  }
  return '';
}

// ============ PRICES ============
async function getPrices() {
  const result = {
    bitcoin: { usd: 82529, change24h: 0 },
    ethereum: { usd: 2417, change24h: 0 },
    solana: { usd: 89.62, change24h: 0 },
    bnb: { usd: 647, change24h: 0 }
  };
  let source = 'Fallback';
  let sosoUsed = false;
  
  // Try SoSoValue first
  try {
    const ids = await getCurrencyIds();
    const targets = { 'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'BNB': 'bnb' };
    let sosoSuccess = 0;
    
    for (const [sym, key] of Object.entries(targets)) {
      const cid = ids[sym];
      if (!cid) continue;
      try {
        const r = await fetch(`${SOSO_BASE}/currencies/${cid}/market-snapshot`, { headers: sosoHeaders });
        if (r.ok) {
          const d = await r.json();
          const data = d.data || d;
          const price = extractNumber(data, ['price', 'current_price', 'last_price', 'price_usd', 'usd_price']);
          const change = extractNumber(data, ['price_change_percentage_24h', 'change_24h', 'change24h', 'priceChangePercent24h', 'change_percentage_24h', 'percent_change_24h']);
          if (price > 0) {
            result[key] = { usd: price, change24h: change };
            sosoSuccess++;
          }
        }
      } catch (e) {}
    }
    
    if (sosoSuccess >= 2) {
      source = 'SoSoValue';
      sosoUsed = true;
    }
  } catch (e) { console.error('SoSoValue prices failed:', e.message); }
  
  // CoinGecko fallback
  if (source === 'Fallback') {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true');
      if (r.ok) {
        const d = await r.json();
        if (d.bitcoin) result.bitcoin = { usd: d.bitcoin.usd, change24h: d.bitcoin.usd_24h_change || 0 };
        if (d.ethereum) result.ethereum = { usd: d.ethereum.usd, change24h: d.ethereum.usd_24h_change || 0 };
        if (d.solana) result.solana = { usd: d.solana.usd, change24h: d.solana.usd_24h_change || 0 };
        if (d.binancecoin) result.bnb = { usd: d.binancecoin.usd, change24h: d.binancecoin.usd_24h_change || 0 };
        source = 'CoinGecko';
      }
    } catch (e) {}
  }
  
  return { ok: true, data: result, source, sosoUsed };
}

// ============ ETF FLOWS ============
async function getEtfFlows() {
  const fallback = {
    etfs: [
      { ticker: 'IBIT', name: 'BlackRock', netInflow: 257000000 },
      { ticker: 'FBTC', name: 'Fidelity', netInflow: 84000000 },
      { ticker: 'BITB', name: 'Bitwise', netInflow: 12000000 },
      { ticker: 'ARKB', name: 'ARK 21Shares', netInflow: 8000000 },
      { ticker: 'GBTC', name: 'Grayscale', netInflow: -32000000 }
    ],
    totalNet: 467000000
  };
  
  try {
    // First, try to get ETF list
    const list = await fetch(`${SOSO_BASE}/etfs`, { headers: sosoHeaders });
    if (!list.ok) {
      console.log('ETF list HTTP', list.status);
      return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
    }
    
    const lst = await list.json();
    console.log('ETF list response keys:', Object.keys(lst).join(', '));
    
    const etfs = Array.isArray(lst) ? lst : (lst.data || lst.list || lst.etfs || []);
    console.log('ETFs found:', etfs.length);
    
    if (etfs.length === 0) {
      return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
    }
    
    // Try to find BTC ETFs (case insensitive)
    const btcEtfs = etfs.filter(e => {
      const t = (e.ticker || e.symbol || '').toUpperCase();
      return /IBIT|FBTC|BITB|ARKB|GBTC|BTCO|EZBC|HODL|BRRR|DEFI|BTCW/.test(t);
    }).slice(0, 8);
    
    console.log('BTC ETFs filtered:', btcEtfs.length);
    
    if (btcEtfs.length === 0) {
      // Just take first 5 if we can't filter
      const first5 = etfs.slice(0, 5).map(e => ({
        ticker: extractString(e, ['ticker', 'symbol']),
        name: extractString(e, ['name', 'company_name', 'fund_name']),
        netInflow: 0
      }));
      return { ok: true, data: { etfs: first5, totalNet: 0 }, source: 'SoSoValue', sosoUsed: true };
    }
    
    const enriched = [];
    let total = 0;
    
    for (const etf of btcEtfs) {
      const ticker = etf.ticker || etf.symbol;
      try {
        const snap = await fetch(`${SOSO_BASE}/etfs/${ticker}/market-snapshot`, { headers: sosoHeaders });
        if (snap.ok) {
          const s = await snap.json();
          const d = s.data || s;
          const flow = extractNumber(d, ['daily_net_inflow', 'net_inflow', 'totalNetInflow', 'total_net_inflow', 'netFlow', 'net_flow_today']);
          enriched.push({
            ticker,
            name: extractString(etf, ['name', 'company_name', 'fund_name', 'issuer']) || ticker,
            netInflow: flow,
            aum: extractNumber(d, ['aum', 'total_assets', 'market_cap'])
          });
          total += flow;
        }
      } catch (e) { console.error('ETF snapshot failed:', ticker, e.message); }
    }
    
    if (enriched.length >= 3) {
      return { ok: true, data: { etfs: enriched, totalNet: total }, source: 'SoSoValue', sosoUsed: true };
    }
  } catch (e) { console.error('ETF fetch failed:', e.message); }
  
  return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
}

// ============ SSI INDEXES ============
async function getSSI() {
  const fallback = [
    { ticker: 'ssiLayer1', name: 'Layer 1', change24h: 2.4, value: 145.8 },
    { ticker: 'ssiDefi', name: 'DeFi', change24h: -1.2, value: 98.3 },
    { ticker: 'ssiMeme', name: 'Meme', change24h: 5.8, value: 87.2 },
    { ticker: 'ssiAi', name: 'AI', change24h: 3.1, value: 132.5 },
    { ticker: 'ssiGaming', name: 'Gaming', change24h: 0.4, value: 76.9 }
  ];
  
  try {
    const list = await fetch(`${SOSO_BASE}/indices`, { headers: sosoHeaders });
    if (!list.ok) return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
    
    const lst = await list.json();
    console.log('SSI list keys:', Object.keys(lst).join(', '));
    
    const indices = Array.isArray(lst) ? lst : (lst.data || lst.list || lst.indices || []);
    console.log('Indices found:', indices.length);
    
    const ssiOnly = indices.filter(i => {
      const t = (i.ticker || i.symbol || '').toLowerCase();
      return t.startsWith('ssi');
    }).slice(0, 8);
    
    console.log('SSI filtered:', ssiOnly.length);
    
    if (ssiOnly.length === 0) {
      return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
    }
    
    const enriched = [];
    for (const idx of ssiOnly) {
      const ticker = idx.ticker || idx.symbol;
      try {
        const snap = await fetch(`${SOSO_BASE}/indices/${ticker}/market-snapshot`, { headers: sosoHeaders });
        if (snap.ok) {
          const s = await snap.json();
          const d = s.data || s;
          enriched.push({
            ticker,
            name: extractString(idx, ['name', 'index_name']) || ticker.replace('ssi', ''),
            change24h: extractNumber(d, ['change_24h', 'price_change_percentage_24h', 'change24h', 'priceChangePercent24h', 'percent_change_24h']),
            value: extractNumber(d, ['value', 'price', 'current_value', 'index_value']),
            marketCap: extractNumber(d, ['market_cap', 'total_market_cap'])
          });
        }
      } catch (e) {}
    }
    
    if (enriched.length >= 3) {
      return { ok: true, data: enriched, source: 'SoSoValue', sosoUsed: true };
    }
  } catch (e) { console.error('SSI fetch failed:', e.message); }
  
  return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
}

// ============ BTC TREASURY ============
async function getTreasury() {
  const fallback = [
    { name: 'MicroStrategy', ticker: 'MSTR', btc: 499226 },
    { name: 'Marathon Digital', ticker: 'MARA', btc: 47531 },
    { name: 'Galaxy Digital', ticker: 'GLXY', btc: 17518 },
    { name: 'Riot Platforms', ticker: 'RIOT', btc: 19223 },
    { name: 'Tesla', ticker: 'TSLA', btc: 11509 },
    { name: 'Coinbase', ticker: 'COIN', btc: 9480 }
  ];
  
  try {
    const r = await fetch(`${SOSO_BASE}/btc-treasuries`, { headers: sosoHeaders });
    if (!r.ok) {
      console.log('Treasury HTTP', r.status);
      return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
    }
    
    const d = await r.json();
    console.log('Treasury response keys:', Object.keys(d).join(', '));
    
    const list = Array.isArray(d) ? d : (d.data || d.companies || d.list || d.treasuries || d.holdings || []);
    console.log('Treasury entries:', list.length);
    
    if (list.length < 3) {
      return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
    }
    
    const mapped = list.slice(0, 10).map(c => ({
      name: extractString(c, ['name', 'company_name', 'companyName', 'company']) || extractString(c, ['ticker', 'symbol']),
      ticker: extractString(c, ['ticker', 'symbol', 'stockTicker']),
      btc: extractNumber(c, ['btc_holdings', 'btc', 'holdings', 'btcHoldings', 'amount', 'btc_amount', 'total_btc'])
    })).filter(c => c.btc > 0);
    
    if (mapped.length >= 3) {
      return { ok: true, data: mapped, source: 'SoSoValue', sosoUsed: true };
    }
  } catch (e) { console.error('Treasury fetch failed:', e.message); }
  
  return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
}

// ============ CRYPTO STOCKS ============
async function getCryptoStocks() {
  const tickers = ['MSTR', 'COIN', 'MARA', 'RIOT', 'CLSK', 'HUT'];
  const result = [];
  let sosoCount = 0;
  
  for (const ticker of tickers) {
    let added = false;
    
    // Try SoSoValue
    try {
      const r = await fetch(`${SOSO_BASE}/crypto-stocks/${ticker}/market-snapshot`, { headers: sosoHeaders });
      if (r.ok) {
        const d = await r.json();
        const data = d.data || d;
        const price = extractNumber(data, ['price', 'current_price', 'last_price', 'stock_price']);
        const change = extractNumber(data, ['change_24h', 'price_change_percentage_24h', 'change24h', 'percent_change']);
        if (price > 0) {
          result.push({ ticker, price, change24h: change, source: 'SoSoValue' });
          sosoCount++;
          added = true;
        }
      }
    } catch (e) {}
    
    if (added) continue;
    
    // Yahoo fallback with proper change calculation
    try {
      const y = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`);
      if (y.ok) {
        const yd = await y.json();
        const meta = yd.chart?.result?.[0]?.meta;
        if (meta) {
          const price = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose || meta.previousClose;
          const changePercent = meta.regularMarketChangePercent;
          
          let change24h = 0;
          if (changePercent != null) {
            change24h = changePercent;
          } else if (price && prevClose && prevClose > 0) {
            change24h = ((price - prevClose) / prevClose) * 100;
          }
          
          result.push({
            ticker,
            price: parseFloat(price),
            change24h: parseFloat(change24h.toFixed(2)),
            source: 'Yahoo'
          });
        }
      }
    } catch (e) {}
  }
  
  return {
    ok: true,
    data: result,
    source: sosoCount >= 3 ? 'SoSoValue' : (sosoCount > 0 ? 'Hybrid' : 'Yahoo'),
    sosoUsed: sosoCount > 0
  };
}

// ============ MARKET PULSE ============
async function getMarketPulse() {
  const [etf, ssi, treasury] = await Promise.all([getEtfFlows(), getSSI(), getTreasury()]);
  const topSSI = [...(ssi.data || [])].sort((a, b) => (b.change24h || 0) - (a.change24h || 0))[0];
  const etfTotal = etf.data?.totalNet || 0;
  const etfSentiment = etfTotal > 100000000 ? 'bullish' : etfTotal < -100000000 ? 'bearish' : 'neutral';
  const totalBtc = (treasury.data || []).reduce((sum, c) => sum + (c.btc || 0), 0);
  
  return {
    ok: true,
    data: {
      etfTotal,
      etfSentiment,
      etfTopBuyer: etf.data?.etfs?.[0]?.ticker || 'IBIT',
      ssiLeader: topSSI?.name || 'Layer 1',
      ssiLeaderChange: topSSI?.change24h || 0,
      treasuryTotal: totalBtc,
      treasuryCount: (treasury.data || []).length,
      pulseScore: calculatePulseScore(etfTotal, topSSI?.change24h || 0, totalBtc),
      sources: {
        etf: etf.source,
        ssi: ssi.source,
        treasury: treasury.source
      }
    },
    source: 'SoSoValue',
    sosoUsed: true
  };
}

function calculatePulseScore(etfFlow, ssiChange, treasury) {
  let score = 50;
  if (etfFlow > 200000000) score += 20;
  else if (etfFlow > 0) score += 10;
  else if (etfFlow < -100000000) score -= 15;
  if (ssiChange > 3) score += 15;
  else if (ssiChange > 0) score += 5;
  else if (ssiChange < -3) score -= 10;
  if (treasury > 600000) score += 10;
  return Math.max(0, Math.min(100, score));
}

// ============ DEBUG ENDPOINT ============
async function debugSoSo() {
  const results = {};
  
  // Test each endpoint
  const endpoints = [
    { name: 'currencies', url: '/currencies' },
    { name: 'etfs', url: '/etfs' },
    { name: 'indices', url: '/indices' },
    { name: 'btc-treasuries', url: '/btc-treasuries' },
    { name: 'crypto-stocks', url: '/crypto-stocks' }
  ];
  
  for (const ep of endpoints) {
    try {
      const r = await fetch(`${SOSO_BASE}${ep.url}`, { headers: sosoHeaders });
      const status = r.status;
      let sample = null;
      if (r.ok) {
        const d = await r.json();
        const list = Array.isArray(d) ? d : (d.data || d.list || []);
        sample = {
          isArray: Array.isArray(d),
          topKeys: Object.keys(d).slice(0, 10),
          itemCount: list.length,
          firstItemKeys: list[0] ? Object.keys(list[0]).slice(0, 15) : null,
          firstItem: list[0] || null
        };
      }
      results[ep.name] = { status, sample };
    } catch (e) {
      results[ep.name] = { error: e.message };
    }
  }
  
  return { ok: true, debug: results, hasKey: !!SOSO_KEY };
}

// ============ MAIN HANDLER ============
export default async function handler(req, res) {
  const { type } = req.query || {};
  
  try {
    let result;
    switch (type) {
      case 'prices': result = await getPrices(); break;
      case 'etf-flows': result = await getEtfFlows(); break;
      case 'ssi':
      case 'sector': result = await getSSI(); break;
      case 'treasury': result = await getTreasury(); break;
      case 'crypto-stocks': result = await getCryptoStocks(); break;
      case 'pulse': result = await getMarketPulse(); break;
      case 'debug': result = await debugSoSo(); break;
      default: result = await getPrices();
    }
    return res.status(200).json(result);
  } catch (e) {
    console.error('Handler error:', e.message);
    return res.status(200).json({ ok: false, data: null, source: 'Error', error: e.message });
  }
}
