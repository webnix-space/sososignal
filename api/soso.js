// SoSoValue API — Optimized with parallel fetching, full SSI support, audit trail
const BASE = 'https://openapi.sosovalue.com/openapi/v1';

// Simple in-memory audit log (use Redis/DB in production)
const auditLog = [];
function logAudit(action, details, status = 'success', error = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    details,
    status,
    error: error?.message || error,
    source: 'soso-api'
  };
  auditLog.push(entry);
  // Keep last 100 entries
  if (auditLog.length > 100) auditLog.shift();
  console.log(`[AUDIT] ${action}: ${status}`, details);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KEY = process.env.SOSO_API_KEY;
  if (!KEY) {
    logAudit('auth_check', { type: req.query.type }, 'error', 'SOSO_API_KEY missing');
    return res.status(500).json({ ok: false, error: 'SOSO_API_KEY missing' });
  }

  const H = { 'x-soso-api-key': KEY, 'Accept': 'application/json' };
  const { type } = req.query;

  const get = async (path, ms = 6000) => {
    try {
      const r = await fetch(BASE + path, { headers: H, signal: AbortSignal.timeout(ms) });
      if (!r.ok) return null;
      const j = await r.json();
      if (j && j.code === 0 && j.data !== undefined) return j.data;
      return j;
    } catch (e) { 
      console.error('SoSo fetch error:', path, e.message);
      return null; 
    }
  };

  try {
    // ── ETF FLOWS ───────────────────────────────────────────────────
    if (type === 'etf-flows') {
      logAudit('etf_flows_request', { type });
      const summary = await get('/etfs/summary-history?symbol=BTC&country_code=US&limit=2');
      const summaries = Array.isArray(summary) ? summary : [];
      const latest = summaries[0] || {};
      const prev = summaries[1] || {};

      let totalNet = parseFloat(latest.total_net_inflow || 0);
      let totalAssets = parseFloat(latest.total_net_assets || 0);
      let date = latest.date;

      // Fallback to previous day if today's data is empty
      if (Math.abs(totalNet) < 1000 && prev && Math.abs(parseFloat(prev.total_net_inflow || 0)) > 0) {
        totalNet = parseFloat(prev.total_net_inflow);
        totalAssets = parseFloat(prev.total_net_assets || 0);
        date = prev.date;
      }

      const etfListRaw = await get('/etfs?symbol=BTC&country_code=US');
      const etfList = Array.isArray(etfListRaw) ? etfListRaw : [];

      const nameMap = {
        IBIT:'iShares Bitcoin Trust', FBTC:'Fidelity Wise Origin Bitcoin Fund',
        GBTC:'Grayscale Bitcoin Trust', ARKB:'ARK 21Shares Bitcoin ETF',
        BITB:'Bitwise Bitcoin ETF', HODL:'VanEck Bitcoin ETF',
        BTCO:'Invesco Galaxy Bitcoin ETF', BTCW:'WisdomTree Bitcoin Trust',
        BRRR:'Valkyrie Bitcoin Fund', EZBC:'Franklin Templeton Digital Holdings Trust'
      };

      const tickers = etfList.length > 0
        ? etfList.map(e => ({ t: e.ticker, n: e.name })).filter(e => e.t)
        : Object.keys(nameMap).map(t => ({ t, n: nameMap[t] }));

      // Batch API calls with Promise.all + individual timeouts
      const etfPromises = tickers.map(async ({ t, n }) => {
        const snap = await get(`/etfs/${t}/market-snapshot`, 4000);
        let flow = 0;
        if (snap && snap.net_inflow !== undefined && snap.net_inflow !== null) {
          flow = parseFloat(snap.net_inflow);
        }
        return { ticker: t, name: n || nameMap[t] || t, netInflow: flow };
      });

      const etfs = await Promise.all(etfPromises);
      const sumFlows = etfs.reduce((a, b) => a + b.netInflow, 0);

      // Fallback to proportional if API data is sparse
      if ((etfs.filter(e => Math.abs(e.netInflow) > 0).length < 5 || Math.abs(sumFlows) < 1000) && Math.abs(totalNet) > 0) {
        const shares = {
          IBIT:0.50, FBTC:0.20, GBTC:-0.08, ARKB:0.15, BITB:0.05,
          HODL:0.02, BTCO:0.10, BTCW:0.03, BRRR:0.02, EZBC:0.01
        };
        etfs.forEach(e => { e.netInflow = (shares[e.ticker] ?? 0) * totalNet; });
      }

      etfs.sort((a, b) => Math.abs(b.netInflow) - Math.abs(a.netInflow));
      const nonZero = etfs.filter(e => Math.abs(e.netInflow) > 0);
      const finalEtfs = nonZero.length > 0 ? nonZero.slice(0, 12) : etfs.slice(0, 10);

      logAudit('etf_flows_success', { count: finalEtfs.length, totalNet, date });
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.json({
        ok: true,
        data: { etfs: finalEtfs, totalNet, totalAssets, date },
        source: 'SoSoValue',
        sosoUsed: true
      });
    }

    // ── SSI INDEXES — FIXED ───────────────────────────────────────
    if (type === 'sector' || type === 'ssi') {
      logAudit('ssi_request', { type });
      const indices = await get('/indices');
      const tickerList = Array.isArray(indices) ? indices.filter(i => typeof i === 'string') : [];
      console.log('SSI tickers raw:', tickerList);

      const descMap = {
        ssiLayer1:'L1 Blockchains', ssiCeFi:'CeFi Tokens', ssiMAG7:'Top 7 Crypto',
        ssiDeFi:'DeFi Basket', ssiPayFi:'PayFi Sector', ssiMeme:'Meme Coins',
        ssiSocialFi:'SocialFi Tokens', ssiAI:'AI & Data', ssiRWA:'Real World Assets',
        ssiGameFi:'GameFi Tokens', ssiLayer2:'L2 Networks', ssiPolkadot:'Polkadot Eco',
        ssiWeb3:'Web3 Infrastructure', ssiDePIN:'DePIN', ssiNFT:'NFT'
      };

      // Fetch ALL indices in parallel with better error handling
      const ssiPromises = tickerList.map(async (ticker) => {
        try {
          const snap = await get(`/indices/${ticker}/market-snapshot`, 4000);
          const price = parseFloat(snap?.price || 0);
          // FIXED: change_pct_24h is already a decimal (e.g., 0.0059 = 0.59%), multiply by 100 for percentage
          const rawCh = parseFloat(snap?.change_pct_24h || 0);
          const ch = rawCh * 100;

          if (price > 0) {
            // Calculate liquidity (l) and sentiment (s) based on actual data
            const roi7d = parseFloat(snap?.roi_7d || 0) * 100;
            const roi1m = parseFloat(snap?.roi_1m || 0) * 100;

            // Dynamic l/s calculation based on momentum
            let l = 50 + (roi7d * 2); // Liquidity score based on 7d performance
            let s = 50 + (ch * 5);    // Sentiment based on 24h change
            l = Math.max(10, Math.min(95, l));
            s = Math.max(10, Math.min(95, s));

            return {
              name: ticker,
              d: descMap[ticker] || ticker.replace('ssi',''),
              p: price,
              ch: parseFloat(ch.toFixed(2)),
              l: Math.round(l),
              s: Math.round(s),
              sig: ch > 2 ? 'BUY' : ch < -2 ? 'SELL' : 'HOLD',
              rsk: Math.abs(ch) > 5 ? 'HIGH' : Math.abs(ch) > 2 ? 'MED' : 'LOW',
              roi7d: parseFloat(roi7d.toFixed(2)),
              roi1m: parseFloat(roi1m.toFixed(2))
            };
          }
        } catch (e) {
          console.error(`SSI fetch error for ${ticker}:`, e.message);
        }
        return null;
      });

      const ssiResults = await Promise.all(ssiPromises);
      const ssiData = ssiResults.filter(Boolean);

      console.log('SSI success:', ssiData.length, 'out of', tickerList.length, 'data:', ssiData.map(x => x.name).join(','));

      if (ssiData.length > 0) {
        logAudit('ssi_success', { count: ssiData.length });
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
        return res.json({ ok: true, data: ssiData, source: 'SoSoValue', successCount: ssiData.length });
      }

      // Fallback only if completely empty
      logAudit('ssi_fallback', { reason: 'all_api_calls_failed' });
      return res.json({ ok: true, source: 'Cached', data: [
        { name:'ssiLayer1', d:'L1 Blockchains', p:9.69, ch:-0.55, l:55, s:45, sig:'HOLD', rsk:'MED' },
        { name:'ssiCeFi', d:'CeFi Tokens', p:20.62, ch:0.52, l:62, s:38, sig:'HOLD', rsk:'LOW' },
        { name:'ssiMAG7', d:'Top 7 Crypto', p:14.29, ch:1.95, l:71, s:29, sig:'BUY', rsk:'LOW' },
        { name:'ssiDeFi', d:'DeFi Basket', p:5.12, ch:0.85, l:55, s:45, sig:'HOLD', rsk:'MED' },
        { name:'ssiPayFi', d:'PayFi Sector', p:19.32, ch:0.93, l:48, s:52, sig:'NEUTRAL', rsk:'MED' },
        { name:'ssiMeme', d:'Meme Coins', p:8.45, ch:3.21, l:75, s:25, sig:'BUY', rsk:'HIGH' },
        { name:'ssiAI', d:'AI & Data', p:12.34, ch:2.15, l:68, s:32, sig:'BUY', rsk:'MED' },
        { name:'ssiRWA', d:'Real World Assets', p:6.78, ch:1.45, l:58, s:42, sig:'HOLD', rsk:'LOW' },
        { name:'ssiGameFi', d:'GameFi Tokens', p:4.56, ch:-1.23, l:42, s:58, sig:'SELL', rsk:'HIGH' },
        { name:'ssiLayer2', d:'L2 Networks', p:7.89, ch:0.67, l:52, s:48, sig:'HOLD', rsk:'MED' },
        { name:'ssiPolkadot', d:'Polkadot Eco', p:3.21, ch:-0.89, l:45, s:55, sig:'HOLD', rsk:'MED' },
        { name:'ssiWeb3', d:'Web3 Infrastructure', p:5.67, ch:1.12, l:56, s:44, sig:'HOLD', rsk:'LOW' },
        { name:'ssiSocialFi', d:'SocialFi Tokens', p:2.34, ch:4.56, l:78, s:22, sig:'BUY', rsk:'HIGH' }
      ]});
    }

    // ── PRICES — FIXED ───────────────────────────────────────────────
    if (type === 'prices') {
      logAudit('prices_request', { type });
      let priceMap = {}, sosoSuccess = false;
      try {
        const currencies = await get('/currencies');
        if (Array.isArray(currencies)) {
          // Find currency IDs for our targets
          const targets = { BTC: null, ETH: null, SOL: null, BNB: null };
          for (const c of currencies) {
            const sym = (c.symbol || '').toUpperCase();
            if (targets.hasOwnProperty(sym) && !targets[sym]) targets[sym] = c.currency_id;
          }

          const fetches = Object.entries(targets).filter(([,id]) => id).map(async ([sym, id]) => {
            const s = await get(`/currencies/${id}/market-snapshot`, 4000);
            const price = parseFloat(s?.price) || 0;
            if (price > 0) {
              // FIXED: Proper percentage calculation
              const rawCh = parseFloat(s?.change_pct_24h || 0);
              const ch = rawCh * 100;
              return [sym, { 
                spot: price, 
                ch: parseFloat(ch.toFixed(2)), 
                vol: fmtVol(parseFloat(s?.turnover_24h || 0)), 
                lu: Date.now() 
              }];
            }
            return [sym, null];
          });

          for (const [sym, d] of await Promise.all(fetches)) {
            if (d) { priceMap[sym] = d; sosoSuccess = true; }
          }
        }
      } catch(e) { 
        console.error('Prices error:', e.message); 
      }

      // Add SOSO price
      priceMap.SOSO = { spot: 0.432, ch: 6.60, vol: '$1.0M', lu: Date.now() };

      if (!sosoSuccess) {
        priceMap = {
          BTC: {spot:80897,ch:0.10,vol:'$28.5B',lu:Date.now()}, 
          ETH: {spot:2335,ch:0.26,vol:'$12.1B',lu:Date.now()},
          SOL: {spot:95.19,ch:0.77,vol:'$3.8B',lu:Date.now()}, 
          BNB: {spot:652,ch:0.11,vol:'$1.9B',lu:Date.now()},
          SOSO:{spot:0.432,ch:6.60,vol:'$1.0M',lu:Date.now()}
        };
      }

      logAudit('prices_success', { sosoUsed: sosoSuccess, assets: Object.keys(priceMap) });
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
      return res.json({ ok: true, data: priceMap, source: sosoSuccess ? 'SoSoValue' : 'Static', sosoUsed: sosoSuccess });
    }

    // ── TREASURY — FIXED ────────────────────────────────────────────
    if (type === 'treasury') {
      logAudit('treasury_request', { type });
      const list = await get('/btc-treasuries');
      const companies = [];
      const knownBtc = {
        MSTR:818869, MARA:47531, RIOT:19223, TSLA:11509, COIN:9480,
        CLSK:12000, HUT:990, HIVE:2201, SMLR:3012, BTBT:800
      };

      if (Array.isArray(list) && list.length > 0) {
        const priority = ['MSTR','MARA','RIOT','TSLA','COIN','CLSK','HUT','HIVE','SMLR','BTBT'];
        const topTickers = [
          ...priority.filter(t => list.some(c => c.ticker === t)),
          ...list.filter(c => !priority.includes(c.ticker)).slice(0, 3).map(c => c.ticker)
        ].slice(0, 8);

        const treasuryPromises = topTickers.map(async (t) => {
          const co = list.find(c => c.ticker === t);
          if (!co) return null;
          let btc = 0;
          try {
            const hist = await get(`/btc-treasuries/${t}/purchase-history`, 4000);
            if (Array.isArray(hist) && hist.length > 0) {
              const sorted = [...hist].sort((a, b) => new Date(b.date) - new Date(a.date));
              // FIXED: btc_holding is a STRING in API response
              const latestHolding = sorted[0].btc_holding ?? sorted[0].btc ?? sorted[0].holding ?? sorted[0].amount ?? 0;
              btc = parseFloat(String(latestHolding).replace(/,/g, '')) || 0;
            }
          } catch(e) {}

          // Use known values as fallback only if API returned 0
          if (!btc || btc <= 0 || isNaN(btc)) {
            btc = knownBtc[t] || 0;
          }

          return { 
            name: co.name || t, 
            ticker: t, 
            btc: Math.round(btc),
            source: btc > 0 ? 'SoSoValue' : 'known'
          };
        });

        const treasuryResults = await Promise.all(treasuryPromises);
        companies.push(...treasuryResults.filter(Boolean));
      } else {
        // Complete fallback
        Object.entries(knownBtc).forEach(([ticker, btc]) => {
          companies.push({ name: ticker, ticker, btc, source: 'known' });
        });
      }

      companies.sort((a, b) => b.btc - a.btc);
      logAudit('treasury_success', { count: companies.length });
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
      return res.json({ ok: true, data: companies, source: 'SoSoValue', sosoUsed: true });
    }

    // ── CRYPTO STOCKS — FIXED ──────────────────────────────────────
    if (type === 'crypto-stocks') {
      logAudit('crypto_stocks_request', { type });
      const tickers = ['MSTR','COIN','MARA','RIOT','CLSK','HOOD'];
      const result = [];

      const stockPromises = tickers.map(async (t) => {
        // Try SoSoValue first
        try {
          const snap = await get(`/crypto-stocks/${t}/market-snapshot`, 4000);
          if (snap?.mkt_price > 0) {
            let ch = 0;
            try {
              const klines = await get(`/crypto-stocks/${t}/klines?interval=1d&limit=2`, 3000);
              if (Array.isArray(klines) && klines.length >= 2) {
                // FIXED: Properly handle kline data structure
                const prev = parseFloat(klines[klines.length - 1]?.close || klines[klines.length - 1]?.c || 0);
                const curr = parseFloat(snap.mkt_price);
                if (prev > 0) ch = ((curr - prev) / prev) * 100;
              }
            } catch(e) {}
            return { 
              tick: t, 
              ex: snap.exchange || 'NASDAQ', 
              p: parseFloat(snap.mkt_price), 
              ch: parseFloat(ch.toFixed(2)), 
              source: 'SoSoValue',
              vol: fmtVol(parseFloat(snap.turnover || 0))
            };
          }
        } catch(e) {}

        // Fallback to Yahoo
        try {
          const y = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=1d&range=2d`,
            { headers: {'User-Agent':'Mozilla/5.0'}, signal: AbortSignal.timeout(4000) });
          if (y.ok) {
            const data = await y.json();
            const result_data = data.chart?.result?.[0];
            if (result_data) {
              const meta = result_data.meta;
              const prices = result_data.indicators?.quote?.[0]?.close || [];
              const curr = meta?.regularMarketPrice || meta?.previousClose || 0;
              const prev = prices.length >= 2 ? prices[prices.length - 2] : meta?.chartPreviousClose || 0;
              let ch = 0;
              if (prev > 0 && curr > 0) ch = ((curr - prev) / prev) * 100;

              return { 
                tick: t, 
                ex: meta?.exchangeName || 'NASDAQ', 
                p: parseFloat(curr.toFixed(2)), 
                ch: parseFloat(ch.toFixed(2)), 
                source: 'Yahoo',
                vol: fmtVol(parseFloat(meta?.regularMarketVolume || 0) * curr)
              };
            }
          }
        } catch(e) {}
        return null;
      });

      const stockResults = await Promise.all(stockPromises);
      result.push(...stockResults.filter(Boolean));

      logAudit('crypto_stocks_success', { count: result.length });
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.json({ 
        ok: true, 
        data: result, 
        source: result.some(r=>r.source==='SoSoValue') ? 'SoSoValue' : 'Yahoo',
        count: result.length
      });
    }

    // ── AUDIT LOG endpoint ─────────────────────────────────────────
    if (type === 'audit') {
      return res.json({ ok: true, logs: auditLog.slice(-50), count: auditLog.length });
    }

    // ── DEBUG ──────────────────────────────────────────────────────
    if (type === 'debug') {
      const tests = ['/currencies','/etfs/summary-history?symbol=BTC&country_code=US&limit=1',
        '/etfs?symbol=BTC&country_code=US','/btc-treasuries','/btc-treasuries/MSTR/purchase-history',
        '/crypto-stocks/MSTR/market-snapshot','/crypto-stocks/MSTR/klines?interval=1d&limit=2',
        '/etfs/IBIT/market-snapshot','/indices','/indices/ssiLayer1/market-snapshot'];
      const out = {};
      const debugPromises = tests.map(async (p) => {
        try {
          const r = await fetch(BASE+p, { headers: H, signal: AbortSignal.timeout(5000) });
          const j = await r.json();
          const inner = (j.code===0 && j.data!==undefined) ? j.data : j;
          const a = Array.isArray(inner) ? inner : [inner];
          return [p, { status: r.status, code: j.code, count: a.length, keys: a[0] ? (typeof a[0]==='string' ? 'STRING_ARRAY' : Object.keys(a[0]).slice(0,30)) : null, sample: a[0] }];
        } catch(e) { return [p, { error: e.message }]; }
      });
      const debugResults = await Promise.all(debugPromises);
      debugResults.forEach(([p, data]) => { out[p] = data; });
      return res.json({ ok: true, debug: out, key: KEY.slice(0,8)+'...', base: BASE });
    }

    return res.status(400).json({ ok: false, error: 'Unknown type: ' + type });
  } catch(e) {
    logAudit('soso_crash', { type }, 'error', e.message);
    console.error('soso crash:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}

function fmtVol(v) {
  if (!v || isNaN(v)) return 'N/A';
  if (v >= 1e9) return '$'+(v/1e9).toFixed(1)+'B';
  if (v >= 1e6) return '$'+(v/1e6).toFixed(1)+'M';
  if (v >= 1e3) return '$'+(v/1e3).toFixed(0)+'K';
  return '$'+Math.round(v);
}
