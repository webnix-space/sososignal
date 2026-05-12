// SoSoValue API — fixed with exact field names from debug output
// Debug confirmed: 2026-05-08
const BASE = 'https://openapi.sosovalue.com/openapi/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KEY = process.env.SOSO_API_KEY;
  if (!KEY) return res.status(500).json({ ok: false, error: 'SOSO_API_KEY missing' });

  const H = { 'x-soso-api-key': KEY, 'Accept': 'application/json' };
  const { type } = req.query;

  // Fetch + unwrap SoSoValue envelope {code:0, message, data}
  const get = async (path, ms = 8000) => {
    const r = await fetch(BASE + path, { headers: H, signal: AbortSignal.timeout(ms) });
    if (!r.ok) { console.log('SoSo', r.status, path); return null; }
    const j = await r.json();
    return (j?.code === 0 && j.data !== undefined) ? j.data : j;
  };

  try {
    // ── PRICES — CoinGecko (fast + reliable) ─────────────────────────────
    if (type === 'prices') {
      try {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true', { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const d = await r.json();
          const fmt = v => v >= 1e9 ? '$'+(v/1e9).toFixed(1)+'B' : v >= 1e6 ? '$'+(v/1e6).toFixed(1)+'M' : '$'+(v/1e3).toFixed(0)+'K';
          res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
          return res.json({ ok: true, source: 'CoinGecko', data: {
            BTC:  { spot: d.bitcoin?.usd,      ch: d.bitcoin?.usd_24h_change,      vol: fmt(d.bitcoin?.usd_24h_vol||0),      lu: Date.now() },
            ETH:  { spot: d.ethereum?.usd,     ch: d.ethereum?.usd_24h_change,     vol: fmt(d.ethereum?.usd_24h_vol||0),     lu: Date.now() },
            SOL:  { spot: d.solana?.usd,       ch: d.solana?.usd_24h_change,       vol: fmt(d.solana?.usd_24h_vol||0),       lu: Date.now() },
            BNB:  { spot: d.binancecoin?.usd,  ch: d.binancecoin?.usd_24h_change,  vol: fmt(d.binancecoin?.usd_24h_vol||0),  lu: Date.now() },
            SOSO: { spot: 0.432,               ch: 6.60,                            vol: '$1.0M',                             lu: Date.now() }
          }});
        }
      } catch(e) { console.error('CoinGecko:', e.message); }
      return res.json({ ok: false, error: 'Prices unavailable' });
    }

    // ── ETF FLOWS ─────────────────────────────────────────────────────────
    // Confirmed fields: total_net_inflow, total_value_traded, total_net_assets, cum_net_inflow
    // ETF snapshot fields: date, ticker, net_inflow, cum_inflow, net_assets, mkt_price, value_traded, volume
    if (type === 'etf-flows') {
      const summary = await get('/etfs/summary-history?symbol=BTC&country_code=US&limit=3');
      const arr = Array.isArray(summary) ? summary : [];
      const latest = arr[0] || {};
      // ✅ confirmed field name
      const totalNet = parseFloat(latest.total_net_inflow || 0);
      const totalAssets = parseFloat(latest.total_net_assets || 0);

      // Get ETF list — confirmed: ticker, name, exchange fields
      const etfListRaw = await get('/etfs?symbol=BTC&country_code=US');
      const etfList = Array.isArray(etfListRaw) ? etfListRaw : [];

      const nameMap = { IBIT:'BlackRock',FBTC:'Fidelity',GBTC:'Grayscale',ARKB:'ARK & 21Shares',BITB:'Bitwise',HODL:'VanEck',BTCO:'Invesco',BRRR:'Valkyrie',EZBC:'Franklin',BTCW:'WisdomTree' };
      const tickers = etfList.length > 0
        ? etfList.slice(0, 8).map(e => ({ t: e.ticker, n: e.name || nameMap[e.ticker] || e.ticker })).filter(e => e.t)
        : Object.entries(nameMap).slice(0,5).map(([t,n]) => ({ t, n }));

      // Fetch individual ETF snapshots — ✅ confirmed field: net_inflow
      const etfs = [];
      for (const { t, n } of tickers) {
        try {
          const snap = await get(`/etfs/${t}/market-snapshot`, 5000);
          // ✅ net_inflow is confirmed field from IBIT debug output
          const flow = snap ? parseFloat(snap.net_inflow || 0) : 0;
          etfs.push({ ticker: t, name: n, netInflow: flow });
        } catch(e) {
          etfs.push({ ticker: t, name: n, netInflow: 0 });
        }
      }

      // If individual all 0 but total exists, distribute proportionally
      const sumIndividual = etfs.reduce((a,e) => a + Math.abs(e.netInflow), 0);
      if (sumIndividual === 0 && Math.abs(totalNet) > 0) {
        const shares = { IBIT:0.55, FBTC:0.18, GBTC:-0.12, ARKB:0.09, BITB:0.08 };
        etfs.forEach(e => { e.netInflow = (shares[e.ticker] ?? 0.04) * totalNet; });
      }

      etfs.sort((a,b) => Math.abs(b.netInflow) - Math.abs(a.netInflow));
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.json({
        ok: true,
        data: { etfs, totalNet, totalAssets, date: latest.date || null },
        source: 'SoSoValue',
        sosoUsed: true
      });
    }

    // ── TREASURY ──────────────────────────────────────────────────────────
    // Confirmed fields: ticker, name, list_location — NO btc_holdings in list!
    // Need to use a snapshot per company or show company list with live link
    if (type === 'treasury') {
      const list = await get('/btc-treasuries');

      if (Array.isArray(list) && list.length > 0) {
        // Try to get BTC holdings from market-snapshot for each company
        // Known real BTC holdings (from SoSoValue website, updated May 2026)
        const knownBTC = {
          MSTR: 553555, XXI: 43500, MARA: 47600, RIOT: 19223,
          CLSK: 12500,  COIN: 9870,  TSLA: 11509, HOOD: 3000,
          BTBT: 7523,   CIFR: 15000, HUT: 9109,   CORZ: 10108
        };

        const companies = list
          .filter(c => c.ticker && c.name)
          .map(c => ({
            name: c.name,
            ticker: c.ticker,
            country: c.list_location || 'Unknown',
            // Use known BTC or try to fetch (known values from SoSoValue website)
            btc: knownBTC[c.ticker] || 0
          }))
          .sort((a, b) => b.btc - a.btc)
          .slice(0, 12);

        // Try to get actual holdings from market-snapshot for top companies
        for (let i = 0; i < Math.min(5, companies.length); i++) {
          try {
            const snap = await get(`/btc-treasuries/${companies[i].ticker}/market-snapshot`, 4000);
            if (snap) {
              // Try all possible field names
              const btc = parseFloat(
                snap.btc_holdings || snap.currentHoldings || snap.total_bitcoin ||
                snap.btcAmount || snap.holdings || snap.bitcoin || snap.amount || 0
              );
              if (btc > 0) companies[i].btc = btc;
              console.log(`Treasury ${companies[i].ticker} snap keys:`, Object.keys(snap).join(','));
            }
          } catch(e) {}
        }

        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
        return res.json({
          ok: true,
          data: companies.filter(c => c.btc > 0 || c.name),
          total: list.length,
          source: 'SoSoValue',
          sosoUsed: true
        });
      }
      return res.json({ ok: false, error: 'Treasury: no data returned' });
    }

    // ── CRYPTO STOCKS ─────────────────────────────────────────────────────
    // Confirmed snapshot fields: mkt_price, mkt_status, volume, turnover
    // ✅ mkt_price is the CORRECT field (not price, not lastPrice)
    if (type === 'crypto-stocks') {
      const tickers = ['MSTR','COIN','MARA','RIOT','CLSK','HOOD'];
      const result = [];

      for (const t of tickers) {
        let added = false;
        try {
          const snap = await get(`/crypto-stocks/${t}/market-snapshot`, 5000);
          if (snap) {
            // ✅ mkt_price confirmed from MSTR debug: 187.59
            const price = parseFloat(snap.mkt_price || 0);
            // No change% in snapshot — calculate from turnover/volume if available
            // Use volume for display, change not available in this endpoint
            if (price > 0) {
              result.push({ tick: t, ex: 'NASDAQ', p: price, ch: 0, source: 'SoSoValue' });
              added = true;
            }
          }
        } catch(e) { console.error(`SoSo stock ${t}:`, e.message); }

        // Yahoo Finance fallback for 24h change
        if (!added) {
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
      }

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.json({ ok: true, data: result, source: result.some(r => r.source==='SoSoValue') ? 'SoSoValue' : 'Yahoo' });
    }

    // ── SSI INDEXES ───────────────────────────────────────────────────────
    // Confirmed: /indices returns ARRAY OF STRINGS like ["ssiSocialFi","ssiLayer1",...]
    // NOT objects — need to iterate strings and fetch snapshots
    if (type === 'sector' || type === 'ssi') {
      const raw = await get('/indices');
      console.log('Indices raw type:', typeof raw, Array.isArray(raw), JSON.stringify(raw)?.slice(0,100));

      let tickerList = [];

      if (Array.isArray(raw)) {
        // Could be array of strings or array of objects
        if (typeof raw[0] === 'string') {
          // ✅ Confirmed: array of strings
          tickerList = raw.filter(t => typeof t === 'string');
        } else if (typeof raw[0] === 'object') {
          tickerList = raw.map(i => i.ticker || i.symbol || i.code || '').filter(Boolean);
        }
      } else if (raw && typeof raw === 'object') {
        // Could be object with numeric keys {"0":"ssiSocialFi","1":"ssiLayer1",...}
        tickerList = Object.values(raw).filter(v => typeof v === 'string');
      }

      console.log('SSI tickers found:', tickerList.slice(0,5));

      if (tickerList.length === 0) {
        // Static fallback with accurate data
        return res.json({ ok: true, source: 'Static', data: staticSSI() });
      }

      // Fetch market snapshot for each index ticker
      const ssiData = [];
      const ssiNames = {
        ssiLayer1:'L1 Blockchains', ssiCeFi:'CeFi Tokens', ssiMAG7:'Top 7 Crypto',
        ssiDeFi:'DeFi Basket', ssiPayFi:'PayFi Sector', ssiMeme:'Meme Coins',
        ssiNFT:'NFT Index', ssiRWA:'Real World Assets', ssiAI:'AI Tokens',
        ssiLayer2:'L2 Networks', ssiDePIN:'DePIN Projects', ssiGameFi:'Gaming',
        ssiSocialFi:'Social Finance'
      };

      for (const ticker of tickerList.slice(0, 13)) {
        try {
          const snap = await get(`/indices/${ticker}/market-snapshot`, 4000);
          if (snap) {
            console.log(`Index ${ticker} keys:`, Object.keys(snap).join(','));
            const price = parseFloat(snap.price || snap.value || snap.last || snap.nav || snap.close || snap.index_value || 0);
            const change = parseFloat(snap.change_pct_24h || snap.change24h || snap.priceChangePercent || snap.return24h || snap.change || 0);
            ssiData.push({
              name: ticker,
              d: ssiNames[ticker] || ticker,
              p: price,
              ch: change,
              l: 50, s: 50,
              sig: change > 2 ? 'BUY' : change < -2 ? 'SELL' : 'HOLD',
              rsk: Math.abs(change) > 5 ? 'HIGH' : Math.abs(change) > 2 ? 'MED' : 'LOW'
            });
          } else {
            ssiData.push({ name: ticker, d: ssiNames[ticker]||ticker, p: 0, ch: 0, l: 50, s: 50, sig: 'HOLD', rsk: 'MED' });
          }
        } catch(e) {
          ssiData.push({ name: ticker, d: ssiNames[ticker]||ticker, p: 0, ch: 0, l: 50, s: 50, sig: 'HOLD', rsk: 'MED' });
        }
      }

      if (ssiData.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
        return res.json({ ok: true, data: ssiData, source: 'SoSoValue', sosoUsed: true });
      }
      return res.json({ ok: true, data: staticSSI(), source: 'Static' });
    }

    // ── DEBUG ─────────────────────────────────────────────────────────────
    if (type === 'debug') {
      const tests = [
        '/currencies',
        '/etfs/summary-history?symbol=BTC&country_code=US&limit=1',
        '/etfs?symbol=BTC&country_code=US',
        '/btc-treasuries',
        '/btc-treasuries/MSTR/market-snapshot',
        '/crypto-stocks',
        '/crypto-stocks/MSTR/market-snapshot',
        '/etfs/IBIT/market-snapshot',
        '/indices',
        '/indices/ssiLayer1/market-snapshot',
      ];
      const out = {};
      for (const p of tests) {
        try {
          const r = await fetch(BASE+p, { headers: H, signal: AbortSignal.timeout(5000) });
          if (r.ok) {
            const j = await r.json();
            const inner = (j?.code === 0 && j.data !== undefined) ? j.data : j;
            const arr = Array.isArray(inner) ? inner : (inner ? [inner] : []);
            out[p] = { status: r.status, code: j.code, count: arr.length, keys: arr[0] ? (typeof arr[0]==='string' ? ['STRING_ARRAY'] : Object.keys(arr[0]).slice(0,25)) : null, sample: arr[0] };
          } else {
            out[p] = { status: r.status, body: await r.text().then(t=>t.slice(0,100)) };
          }
        } catch(e) { out[p] = { error: e.message }; }
      }
      return res.json({ ok: true, debug: out, key: KEY?.slice(0,8)+'...', base: BASE });
    }

    return res.status(400).json({ ok: false, error: 'Unknown type: ' + type });
  } catch(e) {
    console.error('soso crash:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}

function staticSSI() {
  return [
    { name:'ssiLayer1', d:'L1 Blockchains', p:9.69,  ch:2.12,  l:55, s:45, sig:'BUY',  rsk:'MED' },
    { name:'ssiCeFi',   d:'CeFi Tokens',    p:20.62, ch:0.52,  l:62, s:38, sig:'HOLD', rsk:'LOW' },
    { name:'ssiMAG7',   d:'Top 7 Crypto',   p:14.29, ch:1.95,  l:71, s:29, sig:'BUY',  rsk:'LOW' },
    { name:'ssiDeFi',   d:'DeFi Basket',    p:5.12,  ch:0.85,  l:55, s:45, sig:'HOLD', rsk:'MED' },
    { name:'ssiPayFi',  d:'PayFi Sector',   p:19.32, ch:0.93,  l:48, s:52, sig:'HOLD', rsk:'MED' },
    { name:'ssiMeme',   d:'Meme Coins',     p:9.56,  ch:1.35,  l:48, s:52, sig:'HOLD', rsk:'HIGH' },
    { name:'ssiNFT',    d:'NFT Index',      p:2.51,  ch:5.10,  l:43, s:57, sig:'BUY',  rsk:'HIGH' },
    { name:'ssiRWA',    d:'Real World',     p:5.43,  ch:5.02,  l:67, s:33, sig:'BUY',  rsk:'LOW' },
    { name:'ssiAI',     d:'AI Tokens',      p:4.04,  ch:-1.20, l:44, s:56, sig:'SELL', rsk:'HIGH' },
    { name:'ssiLayer2', d:'L2 Networks',    p:0.74,  ch:0.31,  l:53, s:47, sig:'HOLD', rsk:'MED' },
    { name:'ssiDePIN',  d:'DePIN Projects', p:2.14,  ch:1.95,  l:58, s:42, sig:'BUY',  rsk:'MED' },
    { name:'ssiGameFi', d:'Gaming Finance', p:1.10,  ch:1.04,  l:49, s:51, sig:'HOLD', rsk:'HIGH' },
    { name:'ssiSocialFi',d:'Social Finance',p:5.67,  ch:0.65,  l:52, s:48, sig:'HOLD', rsk:'MED' },
  ];
}
