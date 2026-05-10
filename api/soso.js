const BASE = 'https://openapi.sosovalue.com/openapi/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KEY = process.env.SOSO_API_KEY;
  if (!KEY) return res.status(500).json({ ok: false, error: 'SOSO_API_KEY missing' });

  const H = { 'x-soso-api-key': KEY, 'Accept': 'application/json' };
  const { type } = req.query;

  // Fetch helper — unwraps SoSoValue envelope {code,message,data}
  const get = async (path) => {
    const url = BASE + path;
    console.log('GET', url);
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(8000) });
    console.log('Status', r.status, path);
    if (!r.ok) return null;
    const j = await r.json();
    // SoSoValue wraps response: {code:0, message:"success", data: [...]}
    if (j && j.code === 0 && j.data !== undefined) return j.data;
    return j;
  };

  const num = (obj, keys) => {
    for (const k of keys) {
      const v = obj?.[k];
      if (v !== null && v !== undefined && !isNaN(parseFloat(v))) return parseFloat(v);
    }
    return 0;
  };
  const str = (obj, keys) => {
    for (const k of keys) { if (obj?.[k]) return String(obj[k]); }
    return '';
  };

  try {
    // ── PRICES ──────────────────────────────────────────────────────
    if (type === 'prices') {
      // CoinGecko is free and reliable — use as primary for prices
      try {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true', { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const d = await r.json();
          const fmt = v => v > 1e9 ? '$'+(v/1e9).toFixed(1)+'B' : v > 1e6 ? '$'+(v/1e6).toFixed(1)+'M' : '$'+(v/1e3).toFixed(0)+'K';
          const data = {
            BTC:  { spot: d.bitcoin?.usd,       ch: d.bitcoin?.usd_24h_change,      vol: fmt(d.bitcoin?.usd_24h_vol||0),      lu: Date.now() },
            ETH:  { spot: d.ethereum?.usd,      ch: d.ethereum?.usd_24h_change,     vol: fmt(d.ethereum?.usd_24h_vol||0),     lu: Date.now() },
            SOL:  { spot: d.solana?.usd,        ch: d.solana?.usd_24h_change,       vol: fmt(d.solana?.usd_24h_vol||0),       lu: Date.now() },
            BNB:  { spot: d.binancecoin?.usd,   ch: d.binancecoin?.usd_24h_change,  vol: fmt(d.binancecoin?.usd_24h_vol||0),  lu: Date.now() },
            SOSO: { spot: 0.432,                ch: 6.60,                            vol: '$1.0M',                             lu: Date.now() }
          };
          res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
          return res.status(200).json({ ok: true, data, source: 'CoinGecko' });
        }
      } catch(e) { console.error('CoinGecko error:', e.message); }
      return res.status(200).json({ ok: false, error: 'Prices unavailable' });
    }

    // ── ETF FLOWS ───────────────────────────────────────────────────
    if (type === 'etf-flows') {
      // CORRECT params: symbol + country_code are required
      const summary = await get('/etfs/summary-history?symbol=BTC&country_code=US&limit=3');
      console.log('ETF summary:', JSON.stringify(summary)?.slice(0, 200));

      // Get ETF list with correct params
      const etfList = await get('/etfs?symbol=BTC&country_code=US');
      console.log('ETF list:', Array.isArray(etfList) ? etfList.length + ' items' : typeof etfList);

      const arr = Array.isArray(summary) ? summary : (summary ? [summary] : []);
      const latest = arr[0] || {};
      const totalNet = num(latest, ['total_net_inflow', 'totalNetInflow', 'net_inflow', 'netInflow']);

      // Try individual ETF snapshots from the list
      let etfs = [];
      if (Array.isArray(etfList) && etfList.length > 0) {
        const nameMap = { IBIT:'BlackRock', FBTC:'Fidelity', GBTC:'Grayscale', ARKB:'ARK', BITB:'Bitwise', HODL:'VanEck', EZBC:'Franklin' };
        for (const e of etfList.slice(0, 6)) {
          const t = str(e, ['ticker','symbol','etfTicker']);
          if (!t) continue;
          const snap = await get(`/etfs/${t}/market-snapshot`);
          if (snap) {
            const flow = num(snap, ['daily_net_inflow','net_inflow','netInflow','totalNetInflow','dailyNetInflow','inflow','flow']);
            etfs.push({ ticker: t, name: nameMap[t] || str(e,['name','fundName','fund_name']) || t, netInflow: flow });
          }
        }
      }

      // Fallback breakdown if no individual data
      if (etfs.length === 0) {
        const names = { IBIT:'BlackRock', FBTC:'Fidelity', GBTC:'Grayscale', ARKB:'ARK', BITB:'Bitwise' };
        etfs = Object.entries(names).map(([t,n]) => ({ ticker:t, name:n, netInflow: 0 }));
      }

      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.status(200).json({
        ok: true,
        data: { etfs, totalNet: totalNet || 0, date: latest.date || null, totalAssets: num(latest, ['total_net_assets','totalNetAssets']) },
        source: totalNet > 0 || etfs.some(e=>e.netInflow!==0) ? 'SoSoValue' : 'Fallback',
        sosoUsed: totalNet > 0
      });
    }

    // ── TREASURY ────────────────────────────────────────────────────
    if (type === 'treasury') {
      const list = await get('/btc-treasuries');
      console.log('Treasury:', Array.isArray(list) ? list.length + ' items' : typeof list);
      if (list?.[0]) console.log('Treasury keys:', Object.keys(list[0]).slice(0, 20));

      if (Array.isArray(list) && list.length > 0) {
        const companies = list.map(c => ({
          name: str(c, ['entityName','companyName','name','company_name','issuer']),
          ticker: str(c, ['ticker','stockTicker','stock_ticker','symbol']),
          btc: num(c, ['currentHoldings','btcHoldings','btc_holdings','holdings','amount','btc','total_bitcoin','bitcoin','btcAmount','currentBitcoin','current_bitcoin'])
        })).filter(c => c.btc > 0 || c.name).sort((a,b) => b.btc - a.btc).slice(0, 10);

        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
        return res.status(200).json({ ok: true, data: companies, source: 'SoSoValue', sosoUsed: true });
      }

      return res.status(200).json({ ok: false, error: 'Treasury returned no data' });
    }

    // ── CRYPTO STOCKS ───────────────────────────────────────────────
    if (type === 'crypto-stocks') {
      const tickers = ['MSTR','COIN','MARA','RIOT','CLSK'];
      const result = [];

      for (const t of tickers) {
        try {
          const snap = await get(`/crypto-stocks/${t}/market-snapshot`);
          if (snap) {
            console.log(`${t} keys:`, Object.keys(snap).slice(0, 15));
            const price = num(snap, ['price','mktPrice','marketPrice','lastPrice','current_price','close','closePrice','stockPrice','last_price']);
            const change = num(snap, ['change24h','change_24h','priceChangePercent','percent_change_24h','changePercent','percentChange24h','dailyChange']);
            if (price > 0) { result.push({ tick: t, ex: 'NASDAQ', p: price, ch: change, source: 'SoSoValue' }); continue; }
          }
        } catch(e) {}

        // Yahoo Finance fallback
        try {
          const y = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=1d&range=1d`, { signal: AbortSignal.timeout(4000) });
          if (y.ok) {
            const yd = await y.json();
            const meta = yd.chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice) {
              result.push({ tick: t, ex: 'NASDAQ', p: parseFloat(meta.regularMarketPrice), ch: parseFloat(meta.regularMarketChangePercent||0), source: 'Yahoo' });
            }
          }
        } catch(e) {}
      }

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.status(200).json({ ok: true, data: result, source: result.some(r=>r.source==='SoSoValue') ? 'Hybrid' : 'Yahoo' });
    }

    // ── SSI INDEXES ─────────────────────────────────────────────────
    if (type === 'sector' || type === 'ssi') {
      const indices = await get('/indices');
      console.log('Indices:', Array.isArray(indices) ? indices.length : typeof indices);

      if (Array.isArray(indices) && indices.length > 0) {
        if (indices[0]) console.log('Index keys:', Object.keys(indices[0]).slice(0, 20));
        const ssi = indices
          .filter(i => (str(i,['ticker','symbol','code','index_code'])).toLowerCase().startsWith('ssi'))
          .slice(0, 13)
          .map(i => ({
            name: str(i, ['ticker','symbol','code','index_code']),
            d:    str(i, ['name','index_name','description','indexName']),
            p:    num(i, ['price','value','last','current_price','indexValue','nav']),
            ch:   num(i, ['change24h','change_24h','priceChangePercent','percent_change_24h','return24h']),
            l: 50, s: 50, // sentiment — not available from API
            sig: 'HOLD', rsk: 'MED' // placeholder signals
          }));

        if (ssi.length > 0) {
          res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
          return res.status(200).json({ ok: true, data: ssi, source: 'SoSoValue' });
        }
      }
      return res.status(200).json({ ok: false, error: 'No SSI data' });
    }

    // ── DEBUG — visit /api/soso?type=debug to see raw responses ────
    if (type === 'debug') {
      const tests = [
        '/etfs/summary-history?symbol=BTC&country_code=US&limit=1',
        '/etfs?symbol=BTC&country_code=US',
        '/btc-treasuries',
        '/crypto-stocks',
        '/crypto-stocks/MSTR/market-snapshot',
        '/etfs/IBIT/market-snapshot',
        '/indices',
        '/currencies'
      ];
      const out = {};
      for (const p of tests) {
        try {
          const r = await fetch(BASE+p, { headers: H, signal: AbortSignal.timeout(5000) });
          const status = r.status;
          if (r.ok) {
            const j = await r.json();
            const inner = j.data !== undefined ? j.data : j;
            const arr = Array.isArray(inner) ? inner : (inner ? [inner] : []);
            out[p] = { status, code: j.code, count: arr.length, keys: arr[0] ? Object.keys(arr[0]).slice(0,20) : null, sample: arr[0] };
          } else {
            out[p] = { status, body: await r.text().then(t=>t.slice(0,100)) };
          }
        } catch(e) { out[p] = { error: e.message }; }
      }
      return res.status(200).json({ ok: true, debug: out, key: KEY ? KEY.slice(0,8)+'...' : 'MISSING' });
    }

    return res.status(400).json({ ok: false, error: 'Unknown type: ' + type });
  } catch(e) {
    console.error('Handler error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}
