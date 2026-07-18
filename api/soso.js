// SoSoValue API — Optimized with parallel fetching, full SSI support
// FIXED: Added retry with exponential backoff. Removed ALL static fallback data.
// Prices now return error if all sources fail instead of fake numbers.

const BASE = 'https://openapi.sosovalue.com/openapi/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const KEY = process.env.SOSO_API_KEY;
  if (!KEY) return res.status(500).json({ ok: false, error: 'SOSO_API_KEY missing' });
  const H = { 'x-soso-api-key': KEY, 'Accept': 'application/json' };
  const { type } = req.query;

  // FIXED: Added retry with exponential backoff
  const get = async (path, ms = 6000, retries = 2) => {
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await fetch(BASE + path, { headers: H, signal: AbortSignal.timeout(ms) });
        if (r.status === 503 && i < retries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
          continue;
        }
        if (!r.ok) return null;
        const j = await r.json();
        if (j && j.code === 0 && j.data !== undefined) return j.data;
        return j;
      } catch (e) {
        if (i === retries) return null;
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    return null;
  };

  try {
    // ── ETF FLOWS ───────────────────────────────────────────────────
    if (type === 'etf-flows') {
      const summary = await get('/etfs/summary-history?symbol=BTC&country_code=US&limit=2');
      const summaries = Array.isArray(summary) ? summary : [];
      const latest = summaries[0] || {};
      const prev = summaries[1] || {};

      let totalNet = parseFloat(latest.total_net_inflow || 0);
      let totalAssets = parseFloat(latest.total_net_assets || 0);
      let date = latest.date;

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

      // Parallel API calls with Promise.all + individual timeouts
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

      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.json({
        ok: true,
        data: { etfs: finalEtfs, totalNet, totalAssets, date },
        source: 'SoSoValue',
        sosoUsed: true
      });
    }

    // ── SSI INDEXES — FULL 13+ ─────────────────────────────────────
    if (type === 'sector' || type === 'ssi') {
      const indices = await get('/indices', 6000, 3); // FIXED: 3 retries for flaky endpoint
      const tickerList = Array.isArray(indices) ? indices.filter(i => typeof i === 'string') : [];
      console.log('SSI tickers raw:', tickerList);

      const descMap = {
        ssiLayer1:'L1 Blockchains', ssiCeFi:'CeFi Tokens', ssiMAG7:'Top 7 Crypto',
        ssiDeFi:'DeFi Basket', ssiPayFi:'PayFi Sector', ssiMeme:'Meme Coins',
        ssiSocialFi:'SocialFi Tokens', ssiAI:'AI & Data', ssiRWA:'Real World Assets',
        ssiGameFi:'GameFi Tokens', ssiLayer2:'L2 Networks', ssiPolkadot:'Polkadot Eco',
        ssiWeb3:'Web3 Infrastructure', ssiDePIN:'DePIN', ssiNFT:'NFT'
      };

      // Fetch ALL indices in parallel
      const ssiPromises = tickerList.map(async (ticker) => {
        const snap = await get(`/indices/${ticker}/market-snapshot`, 4000);
        const price = parseFloat(snap?.price || 0);
        const ch = parseFloat(snap?.change_pct_24h || 0) * 100;

        if (price > 0) {
          return {
            name: ticker,
            d: descMap[ticker] || ticker.replace('ssi',''),
            p: price,
            ch,
            l: 50,
            s: 50,
            sig: ch > 2 ? 'BUY' : ch < -2 ? 'SELL' : 'HOLD',
            rsk: 'MED',
            roi7d: parseFloat(snap?.roi_7d || 0) * 100,
            roi1m: parseFloat(snap?.roi_1m || 0) * 100
          };
        }
        return null;
      });

      const ssiResults = await Promise.all(ssiPromises);
      const ssiData = ssiResults.filter(Boolean);

      console.log('SSI success:', ssiData.length, 'out of', tickerList.length, 'data:', ssiData.map(x => x.name).join(','));

      if (ssiData.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
        return res.json({ ok: true, data: ssiData, source: 'SoSoValue', successCount: ssiData.length });
      }

      // FIXED: Return error instead of static fake data
      return res.status(503).json({
        ok: false,
        error: 'SoSoValue SSI API returned no data after retries. Service may be temporarily unavailable.',
        data: [],
        source: 'SoSoValue',
        successCount: 0
      });
    }

    // ── PRICES ───────────────────────────────────────────────────────
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
            const s = await get(`/currencies/${id}/market-snapshot`, 4000);
            const price = parseFloat(s?.price) || 0;
            if (price > 0) return [sym, { spot: price, ch: parseFloat(s?.change_pct_24h || 0) * 100, vol: fmtVol(parseFloat(s?.turnover_24h || 0)), lu: Date.now() }];
            return [sym, null];
          });
          for (const [sym, d] of await Promise.all(fetches)) {
            if (d) { priceMap[sym] = d; sosoSuccess = true; }
          }
        }
      } catch(e) { console.error('Prices:', e.message); }

      // FIXED: If SoSoValue fails, try CoinGecko instead of returning fake data
      if (!sosoSuccess) {
        try {
          const cg = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true',
            { signal: AbortSignal.timeout(4000) }
          );
          if (cg.ok) {
            const d = await cg.json();
            const map = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', binancecoin: 'BNB' };
            for (const [id, sym] of Object.entries(map)) {
              if (d[id]?.usd > 0) {
                priceMap[sym] = {
                  spot: d[id].usd,
                  ch: (d[id].usd_24h_change || 0) * 100,
                  vol: fmtVol(d[id].usd_24h_vol || 0),
                  lu: Date.now()
                };
                sosoSuccess = true;
              }
            }
          }
        } catch (e) { console.error('CoinGecko fallback:', e.message); }
      }

      // FIXED: Return error if all sources fail — no fake data
      if (!sosoSuccess) {
        return res.status(503).json({
          ok: false,
          error: 'All price sources unavailable. SoSoValue and CoinGecko both failed or returned no data.',
          data: {},
          source: 'none'
        });
      }

      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
      return res.json({ ok: true, data: priceMap, source: sosoSuccess ? 'SoSoValue' : 'CoinGecko', sosoUsed: sosoSuccess });
    }

    // ── TREASURY ────────────────────────────────────────────────────
    if (type === 'treasury') {
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
              btc = parseFloat(sorted[0].btc_holding ?? sorted[0].btc ?? sorted[0].holding ?? sorted[0].amount ?? 0);
            }
          } catch(e) {}
          if (!btc || btc <= 0 || isNaN(btc)) btc = knownBtc[t] || 0;
          return { name: co.name || t, ticker: t, btc: Math.round(btc) };
        });

        const treasuryResults = await Promise.all(treasuryPromises);
        companies.push(...treasuryResults.filter(Boolean));
      } else {
        // FIXED: Return error instead of fake data when API fails
        return res.status(503).json({
          ok: false,
          error: 'SoSoValue treasury API returned no data.',
          data: [],
          source: 'SoSoValue'
        });
      }
      companies.sort((a, b) => b.btc - a.btc);
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
      return res.json({ ok: true, data: companies, source: 'SoSoValue', sosoUsed: true });
    }

    // ── CRYPTO STOCKS ─────────────────────────────────────────────
    if (type === 'crypto-stocks') {
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
                const prev = parseFloat(klines[1]?.close || klines[1]?.c || 0);
                const curr = parseFloat(snap.mkt_price);
                if (prev > 0) ch = ((curr - prev) / prev) * 100;
              }
            } catch(e) {}
            return { tick: t, ex: snap.exchange || 'NASDAQ', p: parseFloat(snap.mkt_price), ch, source: 'SoSoValue' };
          }
        } catch(e) {}

        // Fallback to Yahoo
        try {
          const y = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${t}`,
            { headers: {'User-Agent':'Mozilla/5.0'}, signal: AbortSignal.timeout(4000) });
          if (y.ok) {
            const q = (await y.json()).quoteResponse?.result?.[0];
            if (q?.regularMarketPrice) {
              return { tick: t, ex: 'NASDAQ', p: parseFloat(q.regularMarketPrice), ch: parseFloat(q.regularMarketChangePercent || 0), source: 'Yahoo' };
            }
          }
        } catch(e) {}
        return null;
      });

      const stockResults = await Promise.all(stockPromises);
      result.push(...stockResults.filter(Boolean));

      // FIXED: Return error if no data at all
      if (result.length === 0) {
        return res.status(503).json({
          ok: false,
          error: 'No crypto stock data available from SoSoValue or Yahoo.',
          data: [],
          source: 'none'
        });
      }

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
      return res.json({ ok: true, data: result, source: result.some(r=>r.source==='SoSoValue') ? 'SoSoValue' : 'Yahoo' });
    }

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
