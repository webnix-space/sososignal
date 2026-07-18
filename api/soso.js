// SoSoValue API — MINIMAL: ETF + Treasury + Stocks only
// Prices → CoinGecko | SSI → Removed | News → CoinTelegraph + CoinGecko
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
    // ── ETF FLOWS — 1 call only ────────────────────────────────────
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

    // ── TREASURY — 1 call only (list), filter real holders ─────────
    if (type === 'treasury') {
      const list = await get('/btc-treasuries', 6000);
      if (!Array.isArray(list) || list.length === 0) {
        return res.status(503).json({ ok: false, error: 'SoSoValue treasury data unavailable', retryAfter: 600 });
      }
      // Filter only companies with actual BTC holdings
      const realHolders = list
        .filter(c => (c.btc_holding || c.btc || 0) > 0)
        .sort((a, b) => (b.btc_holding || b.btc || 0) - (a.btc_holding || a.btc || 0))
        .slice(0, 8)
        .map(c => ({
          name: c.name || c.ticker,
          ticker: c.ticker,
          btc: Math.round(c.btc_holding || c.btc || 0)
        }));

      if (realHolders.length === 0) {
        return res.status(503).json({ ok: false, error: 'No BTC treasury data available', retryAfter: 600 });
      }

      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
      return res.json({ ok: true, data: realHolders, source: 'SoSoValue' });
    }

    // ── CRYPTO STOCKS — 1 call per ticker (max 6) ──────────────────
    if (type === 'crypto-stocks') {
      const tickers = ['MSTR', 'COIN', 'MARA', 'RIOT', 'CLSK', 'HOOD'];
      const results = [];

      for (const t of tickers) {
        try {
          const snap = await get(`/crypto-stocks/${t}/market-snapshot`, 4000);
          if (snap?.mkt_price > 0) {
            results.push({
              tick: t,
              ex: snap.exchange || 'NASDAQ',
              p: parseFloat(snap.mkt_price),
              ch: parseFloat(snap.change_pct_24h || 0) * 100,
              source: 'SoSoValue'
            });
          }
        } catch (e) {}
      }

      if (results.length === 0) {
        // Fallback to Yahoo Finance batch
        try {
          const y = await fetch(
            `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
          );
          if (y.ok) {
            const q = (await y.json()).quoteResponse?.result || [];
            const yahooResults = q.map(r => ({
              tick: r.symbol,
              ex: r.exchange || 'NASDAQ',
              p: r.regularMarketPrice,
              ch: r.regularMarketChangePercent || 0,
              source: 'Yahoo'
            })).filter(r => r.p);
            res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
            return res.json({ ok: true, data: yahooResults, source: 'Yahoo' });
          }
        } catch (e) {}
        return res.status(503).json({ ok: false, error: 'Stock data unavailable', retryAfter: 300 });
      }

      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
      return res.json({ ok: true, data: results, source: 'SoSoValue' });
    }

    return res.status(400).json({ ok: false, error: 'Unknown type: ' + type });
  } catch (e) {
    console.error('soso crash:', e.message);
    return res.status(503).json({ ok: false, error: e.message, retryAfter: 60 });
  }
}
