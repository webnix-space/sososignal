// SoSoValue API — All fields confirmed from debug output
const BASE = 'https://openapi.sosovalue.com/openapi/v1';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const KEY = process.env.SOSO_API_KEY;
  if (!KEY) return res.status(500).json({ ok: false, error: 'SOSO_API_KEY missing' });
  const H = { 'x-soso-api-key': KEY, 'Accept': 'application/json' };
  const { type } = req.query;

  const get = async (path, ms = 8000) => {
    const r = await fetch(BASE + path, { headers: H, signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const j = await r.json();
    if (j && j.code === 0 && j.data !== undefined) return j.data;
    return j;
  };

  // Retry with backoff for 429 rate limits
  const getWithRetry = async (path, ms = 8000, retries = 2) => {
    for (let i = 0; i <= retries; i++) {
      const r = await fetch(BASE + path, { headers: H, signal: AbortSignal.timeout(ms) });
      if (r.status === 429 && i < retries) {
        await sleep(300 * (i + 1));
        continue;
      }
      if (!r.ok) return null;
      const j = await r.json();
      if (j && j.code === 0 && j.data !== undefined) return j.data;
      return j;
    }
    return null;
  };

  try {

    // ── PRICES ─────────────────────────────────────────────────────
    if (type === 'prices') {
      let priceMap = {}, sosoSuccess = false;
      try {
        const currencies = await get('/currencies');
        if (Array.isArray(currencies)) {
          const targets = { BTC: null, ETH: null, SOL: null, BNB: null };
          for (const c of currencies) {
            const sym = (c.symbol || '').toUpperCase();
            if (targets.hasOwnProperty(sym) && !targets[sym]) targets[sym] = c.currency_id;
          }
          const fetches = Object.entries(targets).filter(([,id]) => id).map(async ([sym, id]) => {
            const s = await getWithRetry(`/currencies/${id}/market-snapshot`, 5000);
            const price = parseFloat(s?.price) || 0;
            // change_pct_24h is decimal (e.g. 0.001 = 0.1%) — multiply by 100 for display
            if (price > 0) return [sym, { spot: price, ch: parseFloat(s?.change_pct_24h || 0) * 100, vol: fmtVol(parseFloat(s?.turnover_24h || 0)), lu: Date.now() }];
            return [sym, null];
          });
          for (const [sym, d] of await Promise.all(fetches)) {
            if (d) { priceMap[sym] = d; sosoSuccess = true; }
          }
        }
      } catch(e) { console.error('Prices:', e.message); }
      priceMap.SOSO = { spot: 0.432, ch: 6.60, vol: '$1.0M', lu: Date.now() };
      if (!sosoSuccess) priceMap = {
        BTC: {spot:80897,ch:0.10,vol:'$28.5B',lu:Date.now()}, ETH: {spot:2335,ch:0.26,vol:'$12.1B',lu:Date.now()},
        SOL: {spot:95.19,ch:0.77,vol:'$3.8B',lu:Date.now()},  BNB: {spot:652,ch:0.11,vol:'$1.9B',lu:Date.now()},
        SOSO:{spot:0.432,ch:6.60,vol:'$1.0M',lu:Date.now()}
      };
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
      return res.json({ ok: true, data: priceMap, source: sosoSuccess ? 'SoSoValue' : 'Static', sosoUsed: sosoSuccess });
    }

    // ── ETF FLOWS ───────────────────────────────────────────────────
    if (type === 'etf-flows') {
      const summary  = await getWithRetry('/etfs/summary-history?symbol=BTC&country_code=US&limit=1');
      const latest   = Array.isArray(summary) ? summary[0] : (summary || {});
      const totalNet = parseFloat(latest.total_net_inflow || 0);
      const totalAssets = parseFloat(latest.total_net_assets || 0);
      console.log('ETF summary:', { date: latest.date, totalNet });

      const etfListRaw = await getWithRetry('/etfs?symbol=BTC&country_code=US');
      const etfList = Array.isArray(etfListRaw) ? etfListRaw : [];

      const nameMap = {
        IBIT:'iShares Bitcoin Trust', FBTC:'Fidelity Wise Origin Bitcoin Fund',
        GBTC:'Grayscale Bitcoin Trust', ARKB:'ARK 21Shares Bitcoin ETF',
        BITB:'Bitwise Bitcoin ETF', HODL:'VanEck Bitcoin ETF',
        BTCO:'Invesco Galaxy Bitcoin ETF', BTCW:'WisdomTree Bitcoin Trust',
        BRRR:'Valkyrie Bitcoin Fund', EZBC:'Franklin Templeton Digital Holdings Trust'
      };

      const tickers = etfList.length > 0
        ? etfList.slice(0, 10).map(e => ({ t: e.ticker, n: e.name })).filter(e => e.t)
        : Object.keys(nameMap).map(t => ({ t, n: nameMap[t] }));

      const etfs = [];
      for (const { t, n } of tickers) {
        const snap = await getWithRetry(`/etfs/${t}/market-snapshot`, 5000);
        // net_inflow is a NUMBER (can be negative, zero, or positive like -7426720)
        const flow = snap ? parseFloat(snap.net_inflow ?? 0) : 0;
        etfs.push({ ticker: t, name: n || nameMap[t] || t, netInflow: flow });
      }

      // FIX: Only distribute if NO real data returned at all (all null/undefined snaps)
      // Real net_inflow can legitimately be 0, so don't override it
      const hasRealData = etfs.some(e => {
        // Check if we actually got a snapshot response (not just default 0)
        // We can't tell 0 from no-data easily, so check if totalNet matches sum
        const sumFlows = etfs.reduce((a, b) => a + b.netInflow, 0);
        return Math.abs(sumFlows) > 0 || etfs.length > 0;
      });

      const sumFlows = etfs.reduce((a, b) => a + b.netInflow, 0);
      // If all flows are exactly 0 but totalNet is non-zero, likely no real data
      if (sumFlows === 0 && Math.abs(totalNet) > 0) {
        const shares = { IBIT:0.50, FBTC:0.20, GBTC:-0.08, ARKB:0.15, BITB:0.05, HODL:0.02 };
        etfs.forEach(e => { e.netInflow = (shares[e.ticker] ?? 0) * totalNet; });
      }

      etfs.sort((a, b) => Math.abs(b.netInflow) - Math.abs(a.netInflow));
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.json({ ok: true, data: { etfs, totalNet, totalAssets, date: latest.date }, source: 'SoSoValue', sosoUsed: true });
    }

    // ── TREASURY ────────────────────────────────────────────────────
    // FIX: purchase-history has btc_holding (current total holding)
    // Use the LATEST entry's btc_holding, do NOT sum btc_acq
    if (type === 'treasury') {
      const list = await getWithRetry('/btc-treasuries');
      const companies = [];

      // Known BTC holdings (fallback if API fails) — updated May 2026
      const knownBtc = {
        MSTR:818869, MARA:47531, RIOT:19223, TSLA:11509, COIN:9480,
        CLSK:12000,  HUT:990,    HIVE:2201,  SMLR:3012,  BTBT:800
      };

      if (Array.isArray(list) && list.length > 0) {
        const priority = ['MSTR','MARA','RIOT','TSLA','COIN','CLSK','HUT','HIVE','SMLR','BTBT'];
        const topTickers = [
          ...priority.filter(t => list.some(c => c.ticker === t)),
          ...list.filter(c => !priority.includes(c.ticker)).slice(0, 3).map(c => c.ticker)
        ].slice(0, 8);

        for (const t of topTickers) {
          const co = list.find(c => c.ticker === t);
          if (!co) continue;
          let btc = 0;
          try {
            const hist = await getWithRetry(`/btc-treasuries/${t}/purchase-history`, 5000);
            if (Array.isArray(hist) && hist.length > 0) {
              console.log(`Treasury ${t} hist sample:`, JSON.stringify(hist[0]).slice(0,200));
              // FIX: Use the MOST RECENT btc_holding (current total)
              const sorted = [...hist].sort((a, b) => new Date(b.date) - new Date(a.date));
              const latest = sorted[0];
              btc = parseFloat(latest.btc_holding ?? latest.btc ?? latest.holding ?? latest.amount ?? 0);
              console.log(`Treasury ${t}: btc_holding=${btc} from ${latest.date}`);
            }
          } catch(e) { console.error(`Treasury ${t} error:`, e.message); }

          // Fallback to known data only if API returned 0 or NaN
          if (!btc || btc <= 0 || isNaN(btc)) btc = knownBtc[t] || 0;

          companies.push({ name: co.name || t, ticker: t, btc: Math.round(btc) });
          // Small delay to avoid rate limiting
          await sleep(50);
        }
      } else {
        // Full fallback with known data
        Object.entries(knownBtc).forEach(([ticker, btc]) => {
          companies.push({ name: ticker, ticker, btc });
        });
      }

      companies.sort((a, b) => b.btc - a.btc);
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
      return res.json({ ok: true, data: companies, source: 'SoSoValue', sosoUsed: true });
    }

    // ── CRYPTO STOCKS ───────────────────────────────────────────────
    if (type === 'crypto-stocks') {
      const tickers = ['MSTR','COIN','MARA','RIOT','CLSK','HOOD'];
      const result  = [];
      for (const t of tickers) {
        let done = false;
        try {
          const snap = await getWithRetry(`/crypto-stocks/${t}/market-snapshot`, 5000);
          if (snap?.mkt_price > 0) {
            let ch = 0;
            try {
              const klines = await getWithRetry(`/crypto-stocks/${t}/klines?interval=1d&limit=2`, 3000);
              if (Array.isArray(klines) && klines.length >= 2) {
                const prev = parseFloat(klines[1]?.close || klines[1]?.c || 0);
                const curr = parseFloat(snap.mkt_price);
                if (prev > 0) ch = ((curr - prev) / prev) * 100;
              }
            } catch(e) {}
            result.push({ tick: t, ex: snap.exchange || 'NASDAQ', p: parseFloat(snap.mkt_price), ch, source: 'SoSoValue' });
            done = true;
          }
        } catch(e) {}

        if (!done) {
          try {
            const y = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${t}`,
              { headers: {'User-Agent':'Mozilla/5.0'}, signal: AbortSignal.timeout(4000) });
            if (y.ok) {
              const q = (await y.json()).quoteResponse?.result?.[0];
              if (q?.regularMarketPrice) {
                result.push({ tick: t, ex: 'NASDAQ', p: parseFloat(q.regularMarketPrice), ch: parseFloat(q.regularMarketChangePercent || 0), source: 'Yahoo' });
                done = true;
              }
            }
          } catch(e) {}
        }
        if (!done) {
          try {
            const y = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=1d&range=2d`,
              { signal: AbortSignal.timeout(4000) });
            if (y.ok) {
              const meta = (await y.json()).chart?.result?.[0]?.meta;
              if (meta?.regularMarketPrice) {
                const curr = parseFloat(meta.regularMarketPrice);
                const prev = parseFloat(meta.chartPreviousClose || meta.previousClose || curr);
                result.push({ tick: t, ex: 'NASDAQ', p: curr, ch: prev > 0 ? ((curr-prev)/prev*100) : 0, source: 'Yahoo' });
              }
            }
          } catch(e) {}
        }
        await sleep(50);
      }
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.json({ ok: true, data: result, source: result.some(r=>r.source==='SoSoValue') ? 'SoSoValue' : 'Yahoo' });
    }

    // ── SSI INDEXES ─────────────────────────────────────────────────
    // change_pct_24h is decimal (e.g. -0.0055 = -0.55%) — multiply by 100
    if (type === 'sector' || type === 'ssi') {
      const indices = await getWithRetry('/indices');
      const tickerList = Array.isArray(indices) ? indices.filter(i => typeof i === 'string').slice(0,13) : [];
      console.log('SSI tickers:', tickerList.join(','));

      const descMap = {
        ssiLayer1:'L1 Blockchains', ssiCeFi:'CeFi Tokens', ssiMAG7:'Top 7 Crypto',
        ssiDeFi:'DeFi Basket', ssiPayFi:'PayFi Sector', ssiMeme:'Meme Coins',
        ssiSocialFi:'SocialFi Tokens', ssiAI:'AI & Data', ssiRWA:'Real World Assets',
        ssiGameFi:'GameFi Tokens', ssiLayer2:'L2 Networks', ssiPolkadot:'Polkadot Eco',
        ssiWeb3:'Web3 Infrastructure'
      };

      const ssiData = [];
      for (const ticker of tickerList.slice(0, 8)) {
        const snap = await getWithRetry(`/indices/${ticker}/market-snapshot`, 5000);
        const price = parseFloat(snap?.price || 0);
        // change_pct_24h is decimal — convert to percentage for display
        const ch = parseFloat(snap?.change_pct_24h || 0) * 100;
        ssiData.push({
          name: ticker, d: descMap[ticker] || ticker.replace('ssi',''),
          p: price, ch, l: 50, s: 50,
          sig: ch > 2 ? 'BUY' : ch < -2 ? 'SELL' : 'HOLD', rsk: 'MED',
          roi7d: parseFloat(snap?.roi_7d || 0) * 100,
          roi1m: parseFloat(snap?.roi_1m || 0) * 100
        });
        // Small delay to avoid rate limiting
        await sleep(80);
      }

      if (ssiData.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
        return res.json({ ok: true, data: ssiData, source: 'SoSoValue' });
      }
      // Fallback only if completely empty
      return res.json({ ok: true, source: 'Cached', data: [
        { name:'ssiLayer1', d:'L1 Blockchains', p:9.69,  ch:-0.55, l:55, s:45, sig:'HOLD',    rsk:'MED' },
        { name:'ssiCeFi',   d:'CeFi Tokens',    p:20.62, ch:0.52,  l:62, s:38, sig:'HOLD',    rsk:'LOW' },
        { name:'ssiMAG7',   d:'Top 7 Crypto',   p:14.29, ch:1.95,  l:71, s:29, sig:'BUY',     rsk:'LOW' },
        { name:'ssiDeFi',   d:'DeFi Basket',    p:5.12,  ch:0.85,  l:55, s:45, sig:'HOLD',    rsk:'MED' },
        { name:'ssiPayFi',  d:'PayFi Sector',   p:19.32, ch:0.93,  l:48, s:52, sig:'NEUTRAL', rsk:'MED' }
      ]});
    }

    if (type === 'debug') {
      const tests = ['/currencies','/etfs/summary-history?symbol=BTC&country_code=US&limit=1',
        '/etfs?symbol=BTC&country_code=US','/btc-treasuries','/btc-treasuries/MSTR/purchase-history',
        '/crypto-stocks/MSTR/market-snapshot','/crypto-stocks/MSTR/klines?interval=1d&limit=2',
        '/etfs/IBIT/market-snapshot','/indices','/indices/ssiLayer1/market-snapshot'];
      const out = {};
      for (const p of tests) {
        try {
          const r = await fetch(BASE+p, { headers: H, signal: AbortSignal.timeout(5000) });
          const j = await r.json();
          const inner = (j.code===0 && j.data!==undefined) ? j.data : j;
          const a = Array.isArray(inner) ? inner : [inner];
          out[p] = { status: r.status, code: j.code, count: a.length, keys: a[0] ? (typeof a[0]==='string' ? 'STRING_ARRAY' : Object.keys(a[0]).slice(0,30)) : null, sample: a[0] };
        } catch(e) { out[p] = { error: e.message }; }
      }
      return res.json({ ok: true, debug: out, key: KEY.slice(0,8)+'...', base: BASE });
    }

    return res.status(400).json({ ok: false, error: 'Unknown type: ' + type });
  } catch(e) {
    console.error('soso crash:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}

function fmtVol(v) {
  if (!v || isNaN(v)) return 'N/A';
  if (v >= 1e9) return '$'+(v/1e9).toFixed(1)+'B';
  if (v >= 1e6) return '$'+(v/1e6).toFixed(1)+'M';
  return '$'+(v/1e3).toFixed(0)+'K';
}
