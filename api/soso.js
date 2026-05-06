// /api/soso.js — Wave 1: Deep SoSoValue Integration
// Always returns HTTP 200 with fallback. Source flag included for transparency.

const SOSO_BASE = 'https://openapi.sosovalue.com/openapi/v1';
const SOSO_KEY = process.env.SOSO_API_KEY;

const sosoHeaders = {
  'x-soso-api-key': SOSO_KEY || '',
  'Content-Type': 'application/json'
};

// In-memory cache for currency_id mapping (fetched once per cold start)
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
      const list = Array.isArray(data) ? data : (data.data || data.list || []);
      for (const c of list) {
        const symbol = (c.symbol || '').toUpperCase();
        if (symbol) map[symbol] = c.currency_id || c.id;
      }
      currencyIdCache = map;
      currencyIdCacheTime = now;
      return map;
    }
  } catch (e) { console.error('Currency ID fetch failed:', e.message); }
  
  return {};
}

// ============ PRICES (SoSoValue primary, CoinGecko fallback) ============
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
          const price = data.price || data.current_price || data.last_price;
          if (price) {
            result[key] = {
              usd: parseFloat(price),
              change24h: parseFloat(data.price_change_percentage_24h || data.change_24h || 0),
              marketCap: parseFloat(data.market_cap || 0)
            };
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
  
  // CoinGecko fallback if SoSoValue gave <2 prices
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

// ============ ETF FLOWS (SoSoValue) ============
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
    const list = await fetch(`${SOSO_BASE}/etfs`, { headers: sosoHeaders });
    if (list.ok) {
      const lst = await list.json();
      const etfs = Array.isArray(lst) ? lst : (lst.data || lst.list || []);
      const btcEtfs = etfs.filter(e => (e.ticker || e.symbol || '').match(/IBIT|FBTC|BITB|ARKB|GBTC|BTCO|EZBC|HODL/i)).slice(0, 8);
      
      const enriched = [];
      let total = 0;
      
      for (const etf of btcEtfs) {
        const ticker = etf.ticker || etf.symbol;
        try {
          const snap = await fetch(`${SOSO_BASE}/etfs/${ticker}/market-snapshot`, { headers: sosoHeaders });
          if (snap.ok) {
            const s = await snap.json();
            const d = s.data || s;
            const flow = parseFloat(d.daily_net_inflow || d.net_inflow || d.totalNetInflow || d.total_net_inflow || 0);
            enriched.push({
              ticker,
              name: etf.name || ticker,
              netInflow: flow,
              aum: parseFloat(d.aum || d.total_assets || 0)
            });
            total += flow;
          }
        } catch (e) {}
      }
      
      if (enriched.length >= 3) {
        return { ok: true, data: { etfs: enriched, totalNet: total }, source: 'SoSoValue', sosoUsed: true };
      }
    }
  } catch (e) { console.error('ETF fetch failed:', e.message); }
  
  return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
}

// ============ SSI INDEXES (SoSoValue) ============
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
    if (list.ok) {
      const lst = await list.json();
      const indices = Array.isArray(lst) ? lst : (lst.data || lst.list || []);
      const ssiOnly = indices.filter(i => (i.ticker || '').toLowerCase().startsWith('ssi')).slice(0, 8);
      
      const enriched = [];
      for (const idx of ssiOnly) {
        const ticker = idx.ticker;
        try {
          const snap = await fetch(`${SOSO_BASE}/indices/${ticker}/market-snapshot`, { headers: sosoHeaders });
          if (snap.ok) {
            const s = await snap.json();
            const d = s.data || s;
            enriched.push({
              ticker,
              name: idx.name || ticker.replace('ssi', ''),
              change24h: parseFloat(d.change_24h || d.price_change_percentage_24h || 0),
              value: parseFloat(d.value || d.price || d.current_value || 0),
              marketCap: parseFloat(d.market_cap || 0)
            });
          }
        } catch (e) {}
      }
      
      if (enriched.length >= 3) {
        return { ok: true, data: enriched, source: 'SoSoValue', sosoUsed: true };
      }
    }
  } catch (e) { console.error('SSI fetch failed:', e.message); }
  
  return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
}

// ============ BTC TREASURY (SoSoValue) ============
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
    if (r.ok) {
      const d = await r.json();
      const list = Array.isArray(d) ? d : (d.data || d.companies || d.list || []);
      if (list.length >= 3) {
        const mapped = list.slice(0, 10).map(c => ({
          name: c.name || c.company_name || c.ticker,
          ticker: c.ticker || c.symbol,
          btc: parseInt(c.btc_holdings || c.btc || c.holdings || 0)
        })).filter(c => c.btc > 0);
        if (mapped.length >= 3) {
          return { ok: true, data: mapped, source: 'SoSoValue', sosoUsed: true };
        }
      }
    }
  } catch (e) { console.error('Treasury fetch failed:', e.message); }
  
  return { ok: true, data: fallback, source: 'Fallback', sosoUsed: false };
}

// ============ CRYPTO STOCKS (SoSoValue → Yahoo fallback) ============
async function getCryptoStocks() {
  const tickers = ['MSTR', 'COIN', 'MARA', 'RIOT', 'CLSK', 'HUT'];
  const result = [];
  let sosoCount = 0;
  
  // Try SoSoValue first
  for (const ticker of tickers) {
    try {
      const r = await fetch(`${SOSO_BASE}/crypto-stocks/${ticker}/market-snapshot`, { headers: sosoHeaders });
      if (r.ok) {
        const d = await r.json();
        const data = d.data || d;
        const price = data.price || data.current_price;
        if (price) {
          result.push({
            ticker,
            price: parseFloat(price),
            change24h: parseFloat(data.change_24h || data.price_change_percentage_24h || 0),
            source: 'SoSoValue'
          });
          sosoCount++;
          continue;
        }
      }
    } catch (e) {}
    
    // Yahoo fallback
    try {
      const y = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`);
      if (y.ok) {
        const yd = await y.json();
        const meta = yd.chart?.result?.[0]?.meta;
        if (meta) {
          const price = meta.regularMarketPrice;
          const prevClose = meta.previousClose;
          result.push({
            ticker,
            price: parseFloat(price),
            change24h: prevClose ? ((price - prevClose) / prevClose * 100) : 0,
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

// ============ MARKET PULSE (Combined SoSoValue intelligence) ============
async function getMarketPulse() {
  const [etf, ssi, treasury] = await Promise.all([getEtfFlows(), getSSI(), getTreasury()]);
  
  // Top SSI by 24h change
  const topSSI = [...(ssi.data || [])].sort((a, b) => (b.change24h || 0) - (a.change24h || 0))[0];
  
  // ETF sentiment
  const etfTotal = etf.data?.totalNet || 0;
  const etfSentiment = etfTotal > 100000000 ? 'bullish' : etfTotal < -100000000 ? 'bearish' : 'neutral';
  
  // Total BTC held by treasuries
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
      default: result = await getPrices();
    }
    return res.status(200).json(result);
  } catch (e) {
    console.error('Handler error:', e.message);
    return res.status(200).json({ ok: false, data: null, source: 'Error', error: e.message });
  }
}
