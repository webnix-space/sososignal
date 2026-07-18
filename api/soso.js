// SoSoValue API — Optimized with reduced calls, no fake fallback data
const BASE = 'https://openapi.sosovalue.com/openapi/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KEY = process.env.SOSO_API_KEY;
  if (!KEY) return res.status(500).json({ ok: false, error: 'SOSO_API_KEY missing' });

  const H = { 'x-soso-api-key': KEY, 'Accept': 'application/json' };
  const { type } = req.query;

  const get = async (path, ms = 6000) => {
    try {
      const r = await fetch(BASE + path, { headers: H, signal: AbortSignal.timeout(ms) });
      if (!r.ok) return null;
      const j = await r.json();
      if (j && j.code === 0 && j.data !== undefined) return j.data;
      return j;
    } catch (e) { return null; }
  };

  try {
    // ── ETF FLOWS — 1 call only (summary) ──────────────────────────
    if (type === 'etf-flows') {
      const summary = await get('/etfs/summary-history?symbol=BTC&country_code=US&limit=1', 6000);
      if (!summary || !Array.isArray(summary) || summary.length === 0) {
        return res.status(503).json({ ok: false, error: 'SoSoValue ETF data unavailable', retryAfter: 300 });
      }
      const latest = summary[0];
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
      return res.json({
        ok: true,
        data: {
          totalNet: parseFloat(latest.total_net_inflow || 0),
          totalAssets: parseFloat(latest.total_net_assets || 0),
          date: latest.date
        },
        source: 'SoSoValue'
      });
    }

    // ── SSI INDEXES — Top 5 only, not all 13+ ─────────────────────
    if (type === 'sector' || type === 'ssi') {
      const prioritySectors = ['ssiLayer1', 'ssiMAG7', 'ssiDeFi', 'ssiMeme', 'ssiAI'];
      const ssiPromises = prioritySectors.map(async (ticker) => {
        const snap = await get(`/indices/${ticker}/market-snapshot`, 4000);
        const price = parseFloat(snap?.price || 0);
        const ch = parseFloat(snap?.change_pct_24h || 0) * 100;
        if (price > 0) {
          return {
            name: ticker,
            d: ticker.replace('ssi', ''),
            p: price,
            ch,
            sig: ch > 2 ? 'BUY' : ch < -2 ? 'SELL' : 'HOLD',
            rsk: 'MED'
          };
        }
        return null;
      });

      const ssiData = (await Promise.all(ssiPromises)).filter(Boolean);
      if (ssiData.length === 0) {
        return res.status(503).json({ ok: false, error: 'SoSoValue SSI data unavailable', retryAfter: 300 });
      }

      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
      return res.json({ ok: true, data: ssiData, source: 'SoSoValue' });
    }

    // ── PRICES — Use CoinGecko fallback, no fake data ──────────────
    if (type === 'prices') {
      // Try SoSoValue first
      let priceMap = {};
      let sosoSuccess = false;
      try {
        const currencies = await get('/currencies', 4000);
        if (Array.isArray(currencies)) {
          const targets = { BTC: null, ETH: null, SOL: null, BNB: null };
          for (const c of currencies) {
            const sym = (c.symbol || '').toUpperCase();
            if (targets.hasOwnProperty(sym) && !targets[sym]) targets[sym] = c.currency_id;
          }
          const fetches = Object.entries(targets).filter(([, id]) => id).map(async ([sym, id]) => {
            const s = await get(`/currencies/${id}/market-snapshot`, 4000);
            const price = parseFloat(s?.price) || 0;
            if (price > 0) return [sym, { spot: price, ch: parseFloat(s?.change_pct_24h || 0) * 100, vol: fmtVol(parseFloat(s?.turnover_24h || 0)), lu: Date.now() }];
            return [sym, null];
          });
          for (const [sym, d] of await Promise.all(fetches)) {
            if (d) { priceMap[sym] = d; sosoSuccess = true; }
          }
        }
      } catch (e) { console.error('SoSoValue prices failed:', e.message); }

      // Fallback to CoinGecko (no fake data)
      if (!sosoSuccess || Object.keys(priceMap).length < 4) {
        try {
          const cg = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true',
            { signal: AbortSignal.timeout(5000) }
          );
          if (cg.ok) {
            const d = await cg.json();
            const map = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', binancecoin: 'BNB' };
            for (const [id, sym] of Object.entries(map)) {
              if (d[id]) {
                priceMap[sym] = {
                  spot: d[id].usd,
                  ch: d[id].usd_24h_change || 0,
                  vol: fmtVol(d[id].usd_24h_vol || 0),
                  lu: Date.now(),
                  source: 'CoinGecko'
                };
              }
            }
          }
        } catch (e) { console.error('CoinGecko fallback failed:', e.message); }
      }

      if (Object.keys(priceMap).length === 0) {
        return res.status(503).json({ ok: false, error: 'Price data unavailable from all sources', retryAfter: 60 });
      }

      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      return res.json({ ok: true, data: priceMap, source: sosoSuccess ? 'SoSoValue' : 'CoinGecko' });
    }

    // ── TREASURY — 1 call only (list), skip individual histories ───
    if (type === 'treasury') {
      const list = await get('/btc-treasuries', 6000);
      if (!Array.isArray(list) || list.length === 0) {
        return res.status(503).json({ ok: false, error: 'SoSoValue treasury data unavailable', retryAfter: 600 });
      }
      const top = list.slice(0, 8).map(c => ({
        name: c.name || c.ticker,
        ticker: c.ticker,
        btc: c.btc_holding || c.btc || 0
      }));
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
      return res.json({ ok: true, data: top, source: 'SoSoValue' });
    }

    // ── CRYPTO STOCKS — CoinGecko only, no SoSoValue ───────────────
    if (type === 'crypto-stocks') {
      const tickers = ['MSTR', 'COIN', 'MARA', 'RIOT', 'CLSK', 'HOOD'];
      try {
        const y = await fetch(
          `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
        );
        if (y.ok) {
          const q = (await y.json()).quoteResponse?.result || [];
          const result = q.map(r => ({
            tick: r.symbol,
            ex: r.exchange || 'NASDAQ',
            p: r.regularMarketPrice,
            ch: r.regularMarketChangePercent || 0,
            source: 'Yahoo'
          })).filter(r => r.p);
          res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
          return res.json({ ok: true, data: result, source: 'Yahoo' });
        }
      } catch (e) { console.error('Yahoo stocks failed:', e.message); }
      return res.status(503).json({ ok: false, error: 'Stock data unavailable', retryAfter: 300 });
    }

    return res.status(400).json({ ok: false, error: 'Unknown type: ' + type });
  } catch (e) {
    console.error('soso crash:', e.message);
    return res.status(503).json({ ok: false, error: e.message, retryAfter: 60 });
  }
}

function fmtVol(v) {
  if (!v || isNaN(v)) return 'N/A';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  return '$' + (v / 1e3).toFixed(0) + 'K';
}
