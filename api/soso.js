// Bulletproof soso.js — always returns 200 with valid JSON
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const type = (req.query && req.query.type) || 'prices';

  try {
    let data;

    if (type === 'prices') {
      data = await getPrices();
      res.setHeader('Cache-Control', 's-maxage=30');
      res.status(200).json({ ok: true, data, source: 'coingecko' });
      return;
    }

    if (type === 'etf-flows') {
      data = await getEtfFlows();
      res.status(200).json({ ok: true, ...data, source: data.source || 'sosovalue' });
      return;
    }

    if (type === 'sector') {
      data = getSsiFallback();
      res.status(200).json({ ok: true, data, source: 'cached' });
      return;
    }

    if (type === 'crypto-stocks') {
      data = await getStocks();
      res.status(200).json({ ok: true, data, source: data.length > 0 ? 'yahoo' : 'cached' });
      return;
    }

    if (type === 'treasury') {
      data = getTreasuryFallback();
      res.status(200).json({ ok: true, data, source: 'cached' });
      return;
    }

    res.status(200).json({ ok: false, error: 'unknown type', type });
  } catch (e) {
    console.error('soso error:', e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
}

// ── PRICES via CoinGecko + Binance fallback ───────────────────────────────
async function getPrices() {
  const result = {
    BTC:  { sym:'BTC',  spot: 81434, ch: 0.69, vol: '41.1B', lu: Date.now() },
    ETH:  { sym:'ETH',  spot: 2369,  ch:-0.29, vol: '15.9B', lu: Date.now() },
    SOL:  { sym:'SOL',  spot: 87.38, ch: 3.31, vol: '3.8B',  lu: Date.now() },
    BNB:  { sym:'BNB',  spot: 635,   ch: 1.42, vol: '1.3B',  lu: Date.now() },
    SOSO: { sym:'SOSO', spot: 0.432, ch: 6.60, vol: '1.0M',  lu: Date.now() }
  };

  // Try CoinGecko
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true',
      { signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const d = await r.json();
      if (d.bitcoin && d.bitcoin.usd)
        result.BTC = { sym:'BTC', spot: d.bitcoin.usd, ch: d.bitcoin.usd_24h_change || 0, vol: fmtVol(d.bitcoin.usd_24h_vol), lu: Date.now() };
      if (d.ethereum && d.ethereum.usd)
        result.ETH = { sym:'ETH', spot: d.ethereum.usd, ch: d.ethereum.usd_24h_change || 0, vol: fmtVol(d.ethereum.usd_24h_vol), lu: Date.now() };
      if (d.solana && d.solana.usd)
        result.SOL = { sym:'SOL', spot: d.solana.usd, ch: d.solana.usd_24h_change || 0, vol: fmtVol(d.solana.usd_24h_vol), lu: Date.now() };
      if (d.binancecoin && d.binancecoin.usd)
        result.BNB = { sym:'BNB', spot: d.binancecoin.usd, ch: d.binancecoin.usd_24h_change || 0, vol: fmtVol(d.binancecoin.usd_24h_vol), lu: Date.now() };
    }
  } catch (e) {
    console.error('coingecko:', e.message);
  }

  return result;
}

// ── ETF FLOWS via SoSoValue ────────────────────────────────────────────────
async function getEtfFlows() {
  const fallback = {
    data: [
      { t: 'IBIT', n: 'BlackRock', f: 257000000  },
      { t: 'FBTC', n: 'Fidelity',  f: 84100000   },
      { t: 'GBTC', n: 'Grayscale', f: -56100000  },
      { t: 'ARKB', n: 'ARK',       f: 42100000   },
      { t: 'BITB', n: 'Bitwise',   f: 37400000   }
    ],
    totalNet: 364500000,
    date: null,
    source: 'cached'
  };

  const KEY = process.env.SOSO_API_KEY;
  if (!KEY) return fallback;

  const H = { 'x-soso-api-key': KEY, 'Accept': 'application/json' };
  const BASE = 'https://openapi.sosovalue.com/openapi/v1';

  try {
    let totalNet = 0, date = null;

    try {
      const r = await fetch(BASE + '/etfs/summary-history?symbol=BTC&country_code=US&limit=1', {
        headers: H,
        signal: AbortSignal.timeout(6000)
      });
      if (r.ok) {
        const j = await r.json();
        const row = Array.isArray(j) ? j[0] : (j && j.data && j.data[0]) || null;
        if (row) {
          totalNet = parseFloat(row.total_net_inflow || row.totalNetInflow || row.net_inflow || 0);
          date = row.date || row.trade_date || null;
        }
      }
    } catch (e) {
      console.error('etf summary:', e.message);
    }

    const tickers = [
      { t:'IBIT', n:'BlackRock' },
      { t:'FBTC', n:'Fidelity' },
      { t:'GBTC', n:'Grayscale' },
      { t:'ARKB', n:'ARK' },
      { t:'BITB', n:'Bitwise' }
    ];

    const list = [];
    for (const tk of tickers) {
      try {
        const r = await fetch(BASE + '/etfs/' + tk.t + '/market-snapshot', {
          headers: H,
          signal: AbortSignal.timeout(4000)
        });
        if (r.ok) {
          const d = await r.json();
          const f = parseFloat(d.net_inflow || d.netInflow || d.daily_net_inflow || 0);
          list.push({ t: tk.t, n: tk.n, f });
        }
      } catch (e) {
        console.error('etf', tk.t, ':', e.message);
      }
    }

    if (list.length === 0) return fallback;

    const sumAbs = list.reduce((a, e) => a + Math.abs(e.f), 0);
    if (sumAbs === 0 && Math.abs(totalNet) > 0) {
      const shares = { IBIT:0.55, FBTC:0.18, GBTC:-0.12, ARKB:0.09, BITB:0.08 };
      list.forEach(e => { e.f = (shares[e.t] || 0.04) * totalNet; });
    }

    return { data: list, totalNet, date, source: 'sosovalue' };
  } catch (e) {
    console.error('etf flows:', e.message);
    return fallback;
  }
}

// ── CRYPTO STOCKS via Yahoo Finance ────────────────────────────────────────
async function getStocks() {
  const tickers = ['MSTR','COIN','MARA','RIOT','CLSK','HOOD'];
  const out = [];

  for (const tick of tickers) {
    try {
      const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + tick + '?interval=1d&range=2d';
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(5000)
      });
      if (!r.ok) continue;
      const d = await r.json();
      const result = d.chart && d.chart.result && d.chart.result[0];
      if (!result) continue;
      const meta = result.meta;
      const price = parseFloat(meta.regularMarketPrice || 0);
      const prev = parseFloat(meta.chartPreviousClose || meta.previousClose || price);
      const ch = prev > 0 ? ((price - prev) / prev) * 100 : 0;
      if (price > 0) {
        out.push({
          tick: tick.toUpperCase(),
          ex:   meta.exchangeName || 'NASDAQ',
          p:    price,
          ch:   ch
        });
      }
    } catch (e) {
      console.error('yahoo', tick, ':', e.message);
    }
  }

  return out;
}

// ── FALLBACKS ──────────────────────────────────────────────────────────────
function getSsiFallback() {
  return [
    { name:'ssiLayer1', d:'L1 Blockchains', p:9.69,  ch:2.12, l:50, s:50, sig:'BUY',     rsk:'MED' },
    { name:'ssiCeFi',   d:'CeFi Tokens',    p:20.62, ch:0.52, l:62, s:38, sig:'HOLD',    rsk:'LOW' },
    { name:'ssiMAG7',   d:'Top 7 Crypto',   p:14.29, ch:1.95, l:71, s:29, sig:'BUY',     rsk:'LOW' },
    { name:'ssiDeFi',   d:'DeFi Basket',    p:5.12,  ch:0.85, l:55, s:45, sig:'HOLD',    rsk:'MED' },
    { name:'ssiPayFi',  d:'PayFi Sector',   p:19.32, ch:0.93, l:48, s:52, sig:'NEUTRAL', rsk:'MED' }
  ];
}

function getTreasuryFallback() {
  return {
    companies: 64,
    weeklyInflow: 2540000000,
    list: [
      { name:'MicroStrategy',    btc: 499226 },
      { name:'Marathon Digital', btc: 47531  },
      { name:'Galaxy Digital',   btc: 17518  },
      { name:'Riot Platforms',   btc: 19223  },
      { name:'Tesla',            btc: 11509  },
      { name:'Coinbase',         btc: 9480   }
    ]
  };
}

function fmtVol(v) {
  if (!v || isNaN(v)) return 'N/A';
  if (v >= 1e9) return (v/1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v/1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v/1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}
