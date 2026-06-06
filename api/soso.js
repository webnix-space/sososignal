// api/soso.js - SoSoValue data (ETF, SSI, treasury, stocks, news)
// Fixed: AbortSignal.timeout() replaced with fetchWithTimeout for Node.js 18

const BASE = 'https://open-api.sosovalue.com/openapi/v1';

// Helper: fetch with timeout (Node.js 18 compatible)
function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KEY = process.env.SOSO_API_KEY;
  if (!KEY) {
    console.error('SOSO_API_KEY missing');
    return res.status(500).json({ ok: false, error: 'SOSO_API_KEY missing' });
  }

  const H = { 'x-soso-api-key': KEY, 'Accept': 'application/json' };
  const { type } = req.query;

  // Enhanced get with detailed error logging
  const get = async (path, ms = 8000) => {
    try {
      console.log(`[SoSoValue] Fetching: ${path}`);
      const r = await fetchWithTimeout(BASE + path, {
        headers: H
      }, ms);
      if (!r.ok) {
        console.error(`[SoSoValue] HTTP ${r.status} for ${path}`);
        return { error: `HTTP ${r.status}`, data: null, path };
      }
      const j = await r.json();
      if (j && j.code === 0 && j.data !== undefined) {
        console.log(`[SoSoValue] Success: ${path}`);
        return { data: j.data, error: null, path };
      }
      console.error(`[SoSoValue] API error code ${j?.code} for ${path}: ${j?.msg}`);
      return { data: null, error: j?.msg || `Code ${j?.code}`, path };
    } catch (e) {
      console.error(`[SoSoValue] Fetch error for ${path}:`, e.message);
      return { data: null, error: e.message, path };
    }
  };

  try {
    // ─── ETF FLOWS ────────────────────────────────────────────────────────────
    if (type === 'etf-flows') {
      const etf = await get('/etf/summary');
      if (etf.error || !etf.data) {
        return res.json({ ok: false, error: etf.error });
      }

      const d = etf.data;
      const totalNet = d.total_net_inflow || 0;
      const tickers = d.etf_list || [];

      // Check if markets are closed (all zero flows)
      const nonZeroCount = tickers.filter(t => (t.net_inflow || 0) !== 0).length;
      const isMarketsClosed = nonZeroCount === 0 && totalNet === 0;

      console.log(`[ETF] nonZeroCount: ${nonZeroCount}, totalNet: ${totalNet}, marketsClosed: ${isMarketsClosed}`);

      return res.json({
        ok: true,
        data: {
          etfs: tickers.map(t => ({
            ticker: t.ticker,
            name: t.name,
            netInflow: t.net_inflow || 0,
            assets: t.total_asset || 0
          })),
          totalNet,
          totalAssets: d.total_asset || 0,
          marketsClosed: isMarketsClosed,
          lastFlowDate: isMarketsClosed ? d.date : null,
          source: 'SoSoValue'
        }
      });
    }

    // ─── PRICES ───────────────────────────────────────────────────────────────
    if (type === 'prices') {
      const currencies = await get('/currency/list');
      if (currencies.error || !currencies.data) {
        return res.json({ ok: false, error: currencies.error });
      }

      const list = currencies.data;
      const targets = ['BTC', 'ETH', 'SOL', 'BNB'];
      const priceMap = {};
      let successCount = 0;

      await Promise.all(targets.map(async (sym) => {
        const item = list.find(c => c.symbol === sym);
        if (!item) {
          console.warn(`[Prices] Currency not found: ${sym}`);
          priceMap[sym] = { spot: 0, ch: 0, source: 'Not Found' };
          return;
        }
        const snap = await get(`/currency/${item.id}/market-snapshot`);
        if (snap.error || !snap.data) {
          console.warn(`[Prices] Snapshot failed for ${sym}: ${snap.error}`);
          priceMap[sym] = { spot: 0, ch: 0, source: 'API Error' };
        } else {
          const d = snap.data;
          priceMap[sym] = {
            spot: d.price || 0,
            ch: d.price_change_24h || 0,
            vol: d.volume_24h || 0,
            mcap: d.market_cap || 0,
            source: 'SoSoValue'
          };
          successCount++;
        }
      }));

      console.log(`[Prices] Success: ${successCount}/${targets.length}`);

      return res.json({
        ok: true,
        data: priceMap,
        successCount,
        updatedAt: Date.now()
      });
    }

    // ─── SSI SECTOR INDICES ───────────────────────────────────────────────────
    if (type === 'sector') {
      const tickers = ['ssiLayer1', 'ssiCeFi', 'ssiTop7', 'ssiDeFi', 'ssiPayFi', 'ssiMeme', 'ssiAI'];
      const names = ['L1 Blockchains', 'CeFi Tokens', 'Top 7 Crypto', 'DeFi Basket', 'PayFi Sector', 'Meme Coins', 'AI & Data'];
      const results = [];
      let successCount = 0;

      // Fallback data with explicit stale flag
      const fallback = [
        { t: 'ssiLayer1', n: 'L1 Blockchains', p: 9.69, ch: -0.55, sig: 'HOLD' },
        { t: 'ssiCeFi', n: 'CeFi Tokens', p: 20.62, ch: 0.52, sig: 'HOLD' },
        { t: 'ssiTop7', n: 'Top 7 Crypto', p: 14.29, ch: 1.95, sig: 'BUY' },
        { t: 'ssiDeFi', n: 'DeFi Basket', p: 5.12, ch: 0.85, sig: 'HOLD' },
        { t: 'ssiPayFi', n: 'PayFi Sector', p: 19.32, ch: 0.93, sig: 'NEUTRAL' },
        { t: 'ssiMeme', n: 'Meme Coins', p: 8.45, ch: 3.21, sig: 'BUY' },
        { t: 'ssiAI', n: 'AI & Data', p: 12.17, ch: 2.14, sig: 'BUY' }
      ];

      await Promise.all(tickers.map(async (tk, i) => {
        const snap = await get(`/indices/${tk}/market-snapshot`);
        if (snap.error || !snap.data) {
          console.warn(`[SSI] Failed: ${tk} - ${snap.error}`);
          results.push({
            ...fallback[i],
            source: 'Fallback',
            stale: true,
            error: snap.error
          });
        } else {
          const d = snap.data;
          const ch = d.price_change_24h || 0;
          const sig = ch > 2 ? 'BUY' : ch < -2 ? 'SELL' : 'HOLD';
          results.push({
            t: tk,
            n: names[i],
            p: d.price || 0,
            ch,
            sig,
            source: 'SoSoValue',
            stale: false
          });
          successCount++;
        }
      }));

      console.log(`[SSI] Success: ${successCount}/${tickers.length}`);

      return res.json({
        ok: true,
        data: results,
        successCount,
        totalCount: tickers.length,
        updatedAt: Date.now()
      });
    }

    // ─── CRYPTO STOCKS ────────────────────────────────────────────────────────
    if (type === 'crypto-stocks') {
      const stocks = await get('/crypto-stock/list');
      if (stocks.error || !stocks.data) {
        return res.json({ ok: false, error: stocks.error });
      }

      const list = stocks.data;
      const tickers = ['MSTR', 'COIN', 'MARA', 'RIOT', 'CLSK', 'HOOD'];
      const result = [];

      await Promise.all(tickers.map(async (sym) => {
        const item = list.find(s => s.symbol === sym);
        if (!item) {
          result.push({ tick: sym, ex: 'NASDAQ', p: 0, ch: 0, source: 'Not Found' });
          return;
        }
        const snap = await get(`/crypto-stock/${item.id}/market-snapshot`);
        if (snap.error || !snap.data) {
          result.push({ tick: sym, ex: 'NASDAQ', p: 0, ch: 0, source: 'API Error' });
        } else {
          const d = snap.data;
          result.push({
            tick: sym,
            ex: 'NASDAQ',
            p: d.price || 0,
            ch: d.price_change_24h || 0,
            source: 'SoSoValue'
          });
        }
      }));

      return res.json({ ok: true, data: result, updatedAt: Date.now() });
    }

    // ─── BTC TREASURIES ───────────────────────────────────────────────────────
    if (type === 'treasury') {
      const btc = await get('/btc-treasury/list');
      if (btc.error || !btc.data) {
        return res.json({ ok: false, error: btc.error });
      }

      const list = btc.data;
      const tickers = ['MSTR', 'MARA', 'RIOT', 'CLSK', 'TSLA', 'COIN', 'SMLR', 'HIVE'];
      const result = [];

      await Promise.all(tickers.map(async (sym) => {
        const item = list.find(c => c.symbol === sym);
        if (!item) {
          result.push({ tick: sym, qty: 0, source: 'Not Found' });
          return;
        }
        const detail = await get(`/btc-treasury/${item.id}/detail`);
        if (detail.error || !detail.data) {
          result.push({ tick: sym, qty: 0, source: 'API Error' });
        } else {
          result.push({
            tick: sym,
            qty: detail.data.btc_holdings || 0,
            source: 'SoSoValue'
          });
        }
      }));

      return res.json({ ok: true, data: result, updatedAt: Date.now() });
    }

    // ─── NEWS ─────────────────────────────────────────────────────────────────
    if (type === 'news') {
      const feeds = await get('/feed/list');
      if (feeds.error || !feeds.data) {
        return res.json({ ok: false, error: feeds.error });
      }

      const items = (feeds.data || []).slice(0, 8).map(item => {
        // Normalize date - handles multiple formats
        let date = new Date();
        let dateFormatted = 'Just now';

        if (item.publish_time) {
          const d = new Date(item.publish_time * 1000);
          if (!isNaN(d.getTime())) {
            date = d;
            dateFormatted = d.toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
          }
        } else if (item.pubDate) {
          const d = new Date(item.pubDate);
          if (!isNaN(d.getTime())) {
            date = d;
            dateFormatted = d.toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
          }
        }

        return {
          title: item.title || 'Untitled',
          source: item.source || 'Unknown',
          date: date.toISOString(),
          dateFormatted,
          url: item.url || '#'
        };
      });

      return res.json({ ok: true, data: items, updatedAt: Date.now() });
    }

    return res.status(400).json({ ok: false, error: 'Unknown type: ' + type });
  } catch (e) {
    console.error('[soso.js] Handler error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
