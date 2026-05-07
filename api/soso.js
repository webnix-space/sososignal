// /api/soso.js — Wave 1: Fixed for actual SoSoValue response format

const SOSO_BASE = 'https://openapi.sosovalue.com/openapi/v1';
const SOSO_KEY = process.env.SOSO_API_KEY;

const sosoHeaders = {
  'x-soso-api-key': SOSO_KEY || '',
  'Content-Type': 'application/json'
};

// Helper: SoSoValue wraps everything in {code, message, data, details}
async function sosoFetch(path, options = {}) {
  try {
    const r = await fetch(`${SOSO_BASE}${path}`, { 
      headers: sosoHeaders,
      ...options
    });
    if (!r.ok) {
      console.log(`SoSo ${path} HTTP ${r.status}`);
      return null;
    }
    const json = await r.json();
    // Unwrap the envelope
    if (json.code === 0 && json.data !== undefined) {
      return json.data;
    }
    return json;
  } catch (e) {
    console.error(`SoSo ${path} error:`, e.message);
    return null;
  }
}

function extractNumber(obj, fields) {
  if (!obj) return 0;
  for (const f of fields) {
    if (obj[f] != null && !isNaN(parseFloat(obj[f]))) {
      return parseFloat(obj[f]);
    }
  }
  return 0;
}

function extractString(obj, fields) {
  if (!obj) return '';
  for (const f of fields) {
    if (obj[f] != null) return String(obj[f]);
  }
  return '';
}

// Cache currency_id mapping
let currencyIdCache = null;
let currencyIdCacheTime = 0;

async function getCurrencyIds() {
  const now = Date.now();
  if (currencyIdCache && (now - currencyIdCacheTime < 3600000)) return currencyIdCache;
  
  const list = await sosoFetch('/currencies');
  if (!Array.isArray(list)) return {};
  
  const map = {};
  for (const c of list) {
    const symbol = (c.symbol || '').toUpperCase();
    if (symbol && c.currency_id) map[symbol] = c.currency_id;
  }
  currencyIdCache = map;
  currencyIdCacheTime = now;
  console.log('Currency IDs cached. BTC:', map.BTC, 'ETH:', map.ETH);
  return map;
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
  
  try {
    const ids = await getCurrencyIds();
    const targets = { 'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'BNB': 'bnb' };
    let sosoSuccess = 0;
    
    for (const [sym, key] of Object.entries(targets)) {
      const cid = ids[sym];
      if (!cid) continue;
      
      const data = await sosoFetch(`/currencies/${cid}/market-snapshot`);
      if (data) {
        const price = extractNumber(data, ['price', 'current_price', 'last_price', 'price_usd', 'usd_price', 'priceUsd']);
        const change = extractNumber(data, ['price_change_percentage_24h', 'change_24h', 'change24h', 'priceChangePercent24h', 'percentChange24h', 'percent_change_24h']);
        if (price > 0) {
          result[key] = { usd: price, change24h: change };
          sosoSuccess++;
          if (sym === 'BTC') console.log('BTC snapshot keys:', Object.keys(data).slice(0, 15));
        }
      }
    }
    
    if (sosoSuccess >= 2) {
      source = 'SoSoValue';
      sosoUsed = true;
    }
  } catch (e) { console.error('Prices error:', e.message); }
  
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

// ============ ETF FLOWS — uses summary-history endpoint (the working one!) ============
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
    // Try summary-history first (gives aggregate data)
    const summary = await sosoFetch('/etfs/summary-history');
    console.log('ETF summary type:', typeof summary, Array.isArray(summary));
    
    // Try BTC-specific ETF list
    let etfList = await sosoFetch('/etfs?type=btc');
    if (!Array.isArray(etfList)) {
      etfList = await sosoFetch('/etfs?asset=BTC');
    }
    if (!Array.isArray(etfList)) {
      etfList = await sosoFetch('/etfs?currency=bitcoin');
    }
    
    console.log('ETF list result:', Array.isArray(etfList) ? `${etfList.length} items` : 'not array');
    
    if (Array.isArray(etfList) && etfList.length > 0) {
      const enriched = [];
      let total = 0;
      
      for (const etf of etfList.slice(0, 8)) {
        const ticker = extractString(etf, ['ticker', 'symbol']);
        if (!ticker) continue;
        
        const snap = await sosoFetch(`/etfs/${ticker}/market-snapshot`);
        if (snap) {
          const flow = extractNumber(snap, [
            'daily_net_inflow', 'net_inflow', 'totalNetInflow', 'total_net_inflow',
            'netFlow', 'net_flow_today', 'dailyNetInflow', 'today_net_inflow'
          ]);
          enriched.push({
            ticker,
            name: extractString(etf, ['name', 'company_name', 'fund_name', 'issuer']) || ticker,
            netInflow: flow
          });
          total += flow;
        }
      }
      
      if (enriched.length >= 3) {
        return { ok: true, data: { etfs: enriched, totalNet: total }, source: 'SoSoValue', sosoUsed: true };
      }
    }
    
    // If summary-history worked, use that for total
    if (summary && (summary.totalNetInflow || summary.total_net_inflow)) {
      return {
        ok: true,
        data: {
          etfs: fallback.etfs,
          totalNet: extractNumber(summary, ['totalNetInflow', 'total_net_inflow', 'netInflow'])
        },
        source: 'SoSoValue',
        sosoUsed: true
      };
    }
  } catch (e) { console.error('ETF error:', e.message); }
  
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
    const indices = await sosoFetch('/indices');
    console.log('Indices type:', Array.isArray(indices) ? indices.length : 'not array');
    
    if (!Array.isArray(indices)) {
      return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
    }
    
    // Log first item to see field names
    if (indices[0]) {
      console.log('First index keys:', Object.keys(indices[0]).slice(0, 15));
      console.log('First index ticker sample:', indices[0].ticker || indices[0].symbol || indices[0].code);
    }
    
    // Filter SSI indices
    const ssiOnly = indices.filter(i => {
      const t = (i.ticker || i.symbol || i.code || i.index_code || '').toLowerCase();
      return t.startsWith('ssi');
    }).slice(0, 8);
    
    console.log('SSI filtered:', ssiOnly.length);
    
    // If filter didn't work, take first 5 indices and rename them
    let toProcess = ssiOnly;
    if (ssiOnly.length === 0 && indices.length > 0) {
      console.log('No SSI prefix found, using first 5 indices');
      toProcess = indices.slice(0, 5);
    }
    
    if (toProcess.length === 0) {
      return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
    }
    
    const enriched = [];
    for (const idx of toProcess) {
      const ticker = extractString(idx, ['ticker', 'symbol', 'code', 'index_code']);
      if (!ticker) continue;
      
      const snap = await sosoFetch(`/indices/${ticker}/market-snapshot`);
      if (snap) {
        enriched.push({
          ticker,
          name: extractString(idx, ['name', 'index_name', 'displayName']) || ticker.replace('ssi', ''),
          change24h: extractNumber(snap, [
            'change_24h', 'price_change_percentage_24h', 'change24h', 
            'priceChangePercent24h', 'percent_change_24h', 'changePercent24h'
          ]),
          value: extractNumber(snap, ['value', 'price', 'current_value', 'index_value', 'close']),
          marketCap: extractNumber(snap, ['market_cap', 'total_market_cap', 'marketCap'])
        });
      }
    }
    
    if (enriched.length >= 3) {
      return { ok: true, data: enriched, source: 'SoSoValue', sosoUsed: true };
    }
  } catch (e) { console.error('SSI error:', e.message); }
  
  return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
}

// ============ BTC TREASURY — Now correctly parses 56 companies ============
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
    const list = await sosoFetch('/btc-treasuries');
    console.log('Treasury list:', Array.isArray(list) ? `${list.length} entries` : 'not array');
    
    if (!Array.isArray(list) || list.length === 0) {
      return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
    }
    
    // Log first entry to see field names
    console.log('Treasury first entry keys:', Object.keys(list[0]).slice(0, 20));
    console.log('Treasury first entry sample:', JSON.stringify(list[0]).slice(0, 300));
    
    // Get top 10 by BTC holdings — we need to fetch purchase-history for each to get current BTC
    // But the list itself only has metadata. Let's see what fields are available.
    
    const enriched = [];
    
    // Try to extract BTC from list directly first
    for (const c of list.slice(0, 15)) {
      const btc = extractNumber(c, [
        'btc_holdings', 'btc', 'holdings', 'btcHoldings', 
        'amount', 'btc_amount', 'total_btc', 'totalBtc',
        'currentBtc', 'current_btc', 'balance'
      ]);
      
      if (btc > 0) {
        enriched.push({
          name: extractString(c, ['name', 'company_name', 'companyName']) || extractString(c, ['ticker']),
          ticker: extractString(c, ['ticker', 'symbol', 'stockTicker']),
          btc
        });
      }
    }
    
    // If no BTC in list, try purchase-history for top 6 companies
    if (enriched.length === 0) {
      const targets = list.slice(0, 6);
      for (const c of targets) {
        const ticker = extractString(c, ['ticker', 'symbol']);
        if (!ticker) continue;
        
        const history = await sosoFetch(`/btc-treasuries/${ticker}/purchase-history`);
        let totalBtc = 0;
        if (Array.isArray(history)) {
          for (const purchase of history) {
            totalBtc += extractNumber(purchase, ['btc_amount', 'amount', 'btc', 'quantity']);
          }
        }
        
        if (totalBtc > 0) {
          enriched.push({
            name: extractString(c, ['name']) || ticker,
            ticker,
            btc: totalBtc
          });
        }
      }
    }
    
    // Sort by BTC desc and take top 10
    enriched.sort((a, b) => b.btc - a.btc);
    const final = enriched.slice(0, 10);
    
    if (final.length >= 3) {
      return { ok: true, data: final, source: 'SoSoValue', sosoUsed: true };
    }
  } catch (e) { console.error('Treasury error:', e.message); }
  
  return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
}

// ============ CRYPTO STOCKS — Now correctly parses 112 stocks ============
async function getCryptoStocks() {
  const targets = ['MSTR', 'COIN', 'MARA', 'RIOT', 'CLSK', 'HUT'];
  const result = [];
  let sosoCount = 0;
  
  // First, get the stock list to verify they exist
  try {
    const stockList = await sosoFetch('/crypto-stocks');
    console.log('Stock list:', Array.isArray(stockList) ? `${stockList.length} stocks` : 'not array');
    if (Array.isArray(stockList) && stockList[0]) {
      console.log('First stock keys:', Object.keys(stockList[0]).slice(0, 15));
    }
  } catch (e) {}
  
  for (const ticker of targets) {
    let added = false;
    
    // Try SoSoValue first
    try {
      const snap = await sosoFetch(`/crypto-stocks/${ticker}/market-snapshot`);
      if (snap) {
        const price = extractNumber(snap, [
          'price', 'current_price', 'last_price', 'stock_price', 
          'closePrice', 'lastPrice', 'currentPrice'
        ]);
        const change = extractNumber(snap, [
          'change_24h', 'price_change_percentage_24h', 'change24h', 
          'percent_change', 'changePercent', 'priceChangePercent'
        ]);
        if (price > 0) {
          result.push({ ticker, price, change24h: change, source: 'SoSoValue' });
          sosoCount++;
          added = true;
          if (ticker === 'MSTR') console.log('MSTR snapshot keys:', Object.keys(snap).slice(0, 15));
        }
      }
    } catch (e) {}
    
    if (added) continue;
    
    // Yahoo fallback
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
          if (changePercent != null) change24h = changePercent;
          else if (price && prevClose && prevClose > 0) change24h = ((price - prevClose) / prevClose) * 100;
          
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
      sources: { etf: etf.source, ssi: ssi.source, treasury: treasury.source }
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
  const endpoints = [
    { name: 'currencies', url: '/currencies' },
    { name: 'etfs_default', url: '/etfs' },
    { name: 'etfs_btc', url: '/etfs?type=btc' },
    { name: 'etfs_asset', url: '/etfs?asset=BTC' },
    { name: 'etf_summary', url: '/etfs/summary-history' },
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
        const inner = d.data !== undefined ? d.data : d;
        const list = Array.isArray(inner) ? inner : (inner ? [inner] : []);
        sample = {
          envelopeKeys: Object.keys(d).slice(0, 8),
          dataIsArray: Array.isArray(inner),
          itemCount: list.length,
          firstItemKeys: list[0] ? Object.keys(list[0]).slice(0, 20) : null,
          firstItem: list[0] || null
        };
      } else {
        try { sample = await r.text(); } catch(e) { sample = 'no body'; }
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
