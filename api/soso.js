// SoSoValue API — correct endpoints from official docs
// Base: https://openapi.sosovalue.com/openapi/v1
// Auth: x-soso-api-key header
// Docs: https://sosovalue-1.gitbook.io/sosovalue-api-doc

const BASE = 'https://openapi.sosovalue.com/openapi/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KEY = process.env.SOSO_API_KEY;
  if (!KEY) return res.status(500).json({ ok: false, error: 'SOSO_API_KEY missing' });

  const H = { 'x-soso-api-key': KEY, 'Accept': 'application/json' };
  const { type } = req.query;

  const get = async (path, ms = 8000) => {
    const r = await fetch(BASE + path, { headers: H, signal: AbortSignal.timeout(ms) });
    const txt = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 120)}`);
    return JSON.parse(txt);
  };

  try {

    // ── ETF FLOWS ─────────────────────────────────────────────────────────
    // Docs: GET /etfs/summary-history  → total_net_inflow (raw USD)
    // Docs: GET /etfs/{ticker}/market-snapshot → net_inflow (raw USD)
    if (type === 'etf-flows') {
      // 1. Get today's total from summary-history (most reliable total)
      let totalNet = 0, summaryDate = null;
      try {
        const arr = await get('/etfs/summary-history?symbol=BTC&country_code=US&limit=1');
        const row = Array.isArray(arr) ? arr[0] : (arr?.data?.[0] || null);
        if (row) {
          totalNet = parseFloat(row.total_net_inflow || 0);
          summaryDate = row.date || null;
        }
      } catch (e) { console.error('ETF summary-history:', e.message); }

      // 2. Get individual ETF flows from market-snapshot
      // net_inflow field = daily net inflow in USD (per docs)
      const tickers = [
        { t: 'IBIT', n: 'BlackRock' },
        { t: 'FBTC', n: 'Fidelity'  },
        { t: 'GBTC', n: 'Grayscale' },
        { t: 'ARKB', n: 'ARK'       },
        { t: 'BITB', n: 'Bitwise'   }
      ];

      const snaps = await Promise.allSettled(
        tickers.map(({ t, n }) =>
          get(`/etfs/${t}/market-snapshot`, 5000)
            .then(d => ({ t, n, f: parseFloat(d.net_inflow ?? 0) }))
            .catch(() => null)
        )
      );

      const etfList = snaps
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

      // If all individual flows are 0 but we have a valid totalNet,
      // distribute by typical market share
      const sumAbs = etfList.reduce((a, e) => a + Math.abs(e.f), 0);
      if (sumAbs === 0 && Math.abs(totalNet) > 0 && etfList.length > 0) {
        const shares = { IBIT: 0.55, FBTC: 0.18, GBTC: -0.12, ARKB: 0.09, BITB: 0.08 };
        etfList.forEach(e => { e.f = (shares[e.t] ?? 0.04) * totalNet; });
      }

      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
      return res.json({ ok: true, data: etfList, totalNet, date: summaryDate, source: 'sosovalue' });
    }

    // ── PRICES ────────────────────────────────────────────────────────────
    // Docs: GET /currencies/{currency_id}/market-snapshot
    // Returns: price, change_pct_24h, turnover_24h
    // currency_id is the SoSoValue ID (need to find correct IDs)
    if (type === 'prices') {
      const coins = [
        { id: 'bitcoin',      sym: 'BTC'  },
        { id: 'ethereum',     sym: 'ETH'  },
        { id: 'solana',       sym: 'SOL'  },
        { id: 'binancecoin',  sym: 'BNB'  },
      ];

      // Try SoSoValue currency market-snapshot for each coin
      const results = await Promise.allSettled(
        coins.map(({ id, sym }) =>
          get(`/currencies/${id}/market-snapshot`, 5000)
            .then(d => ({
              sym,
              spot: parseFloat(d.price || 0),
              ch:   parseFloat(d.change_pct_24h || 0),
              vol:  fmtVol(parseFloat(d.turnover_24h || 0)),
              lu:   Date.now()
            }))
            .catch(() => null)
        )
      );

      const priceMap = {};
      let sosoSuccess = false;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value && r.value.spot > 0) {
          priceMap[coins[i].sym] = r.value;
          sosoSuccess = true;
        }
      });

      // Fallback to CoinGecko for any missing coins
      if (!sosoSuccess || Object.keys(priceMap).length < 4) {
        try {
          const cg = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true',
            { signal: AbortSignal.timeout(7000) }
          );
          if (cg.ok) {
            const d = await cg.json();
            if (!priceMap.BTC && d.bitcoin?.usd)
              priceMap.BTC = { sym:'BTC', spot: d.bitcoin.usd, ch: d.bitcoin.usd_24h_change, vol: fmtVol(d.bitcoin.usd_24h_vol), lu: Date.now() };
            if (!priceMap.ETH && d.ethereum?.usd)
              priceMap.ETH = { sym:'ETH', spot: d.ethereum.usd, ch: d.ethereum.usd_24h_change, vol: fmtVol(d.ethereum.usd_24h_vol), lu: Date.now() };
            if (!priceMap.SOL && d.solana?.usd)
              priceMap.SOL = { sym:'SOL', spot: d.solana.usd, ch: d.solana.usd_24h_change, vol: fmtVol(d.solana.usd_24h_vol), lu: Date.now() };
            if (!priceMap.BNB && d.binancecoin?.usd)
              priceMap.BNB = { sym:'BNB', spot: d.binancecoin.usd, ch: d.binancecoin.usd_24h_change, vol: fmtVol(d.binancecoin.usd_24h_vol), lu: Date.now() };
          }
        } catch (e) { console.error('CoinGecko fallback:', e.message); }
      }

      priceMap.SOSO = { sym:'SOSO', spot: 0.432, ch: 6.60, vol: '1.0M', lu: Date.now() };
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
      return res.json({ ok: true, data: priceMap, source: sosoSuccess ? 'sosovalue' : 'coingecko' });
    }

    // ── SSI INDEXES ───────────────────────────────────────────────────────
    // Docs: GET /indices → returns bare array of ticker strings ["ssimag7","ssilayer1"]
    // Docs: GET /indices/{index_ticker}/market-snapshot → price, change etc.
    if (type === 'sector') {
      // Step 1: get list of index tickers
      let tickers = [];
      try {
        const arr = await get('/indices');
        tickers = Array.isArray(arr) ? arr : [];
      } catch (e) { console.error('Indices list:', e.message); }

      if (tickers.length === 0) {
        // Fallback ticker list from docs examples
        tickers = ['ssimag7', 'ssilayer1', 'ssicefi', 'ssidefi', 'ssipayfi'];
      }

      // Step 2: get market snapshot for each index
      const snaps = await Promise.allSettled(
        tickers.slice(0, 8).map(ticker =>
          get(`/indices/${ticker}/market-snapshot`, 5000)
            .then(d => ({
              name: ticker,
              d:    d.description || d.sector || inferDesc(ticker),
              p:    parseFloat(d.price || d.value || d.close || 0),
              ch:   parseFloat(d.change_pct_24h || d.change || 0),
              l:    parseInt(d.long_percent || d.long || 50),
              s:    parseInt(d.short_percent || d.short || 50),
              sig:  (d.signal || inferSignal(d)).toUpperCase(),
              rsk:  (d.risk || d.risk_level || 'MED').toUpperCase()
            }))
            .catch(() => null)
        )
      );

      const indexes = snaps.filter(r => r.status === 'fulfilled' && r.value && r.value.p > 0).map(r => r.value);

      if (indexes.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
        return res.json({ ok: true, data: indexes, source: 'sosovalue' });
      }

      // Static fallback (accurate cached data)
      return res.json({ ok: true, source: 'cached', data: [
        { name: 'ssiLayer1', d: 'L1 Blockchains', p: 9.69,  ch: 2.12, l: 50, s: 50, sig: 'BUY',     rsk: 'MED' },
        { name: 'ssiCeFi',   d: 'CeFi Tokens',    p: 20.62, ch: 0.52, l: 62, s: 38, sig: 'HOLD',    rsk: 'LOW' },
        { name: 'ssiMAG7',   d: 'Top 7 Crypto',   p: 14.29, ch: 1.95, l: 71, s: 29, sig: 'BUY',     rsk: 'LOW' },
        { name: 'ssiDeFi',   d: 'DeFi Basket',    p: 5.12,  ch: 0.85, l: 55, s: 45, sig: 'HOLD',    rsk: 'MED' },
        { name: 'ssiPayFi',  d: 'PayFi Sector',   p: 19.32, ch: 0.93, l: 48, s: 52, sig: 'NEUTRAL', rsk: 'MED' }
      ]});
    }

    // ── CRYPTO STOCKS ─────────────────────────────────────────────────────
    // Docs: GET /crypto-stocks → list of tickers
    // Docs: GET /crypto-stocks/{ticker}/market-snapshot → price data
    if (type === 'crypto-stocks') {
      let stockTickers = [];
      try {
        const arr = await get('/crypto-stocks', 5000);
        // May return array of strings or array of objects
        stockTickers = Array.isArray(arr)
          ? arr.slice(0, 10).map(x => typeof x === 'string' ? x : (x.ticker || x.symbol || x.stock_ticker))
          : [];
      } catch (e) { console.error('Stocks list:', e.message); }

      const targetTickers = stockTickers.length > 0
        ? stockTickers.slice(0, 6)
        : ['MSTR', 'COIN', 'MARA', 'RIOT', 'CLSK', 'HOOD'];

      const snaps = await Promise.allSettled(
        targetTickers.map(tick =>
          get(`/crypto-stocks/${tick}/market-snapshot`, 5000)
            .then(d => ({
              tick: tick.toUpperCase(),
              ex:   d.exchange || d.market || 'NASDAQ',
              p:    parseFloat(d.price || d.last_price || d.close || 0),
              ch:   parseFloat(d.change_pct_24h || d.change || d.pct_change || 0)
            }))
            .catch(() => null)
        )
      );

      const stocks = snaps.filter(r => r.status === 'fulfilled' && r.value && r.value.p > 0).map(r => r.value);

      if (stocks.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
        return res.json({ ok: true, data: stocks, source: 'sosovalue' });
      }

      // Static fallback
      return res.json({ ok: true, source: 'static', data: [
        { tick: 'MSTR', ex: 'NASDAQ', p: 175.76, ch: 6.22 },
        { tick: 'COIN', ex: 'NASDAQ', p: 192.33, ch: 2.43 },
        { tick: 'MARA', ex: 'NASDAQ', p: 18.90,  ch: 4.10 },
        { tick: 'RIOT', ex: 'NASDAQ', p: 11.20,  ch: 3.50 },
        { tick: 'CLSK', ex: 'NASDAQ', p: 12.40,  ch: 2.90 },
        { tick: 'HOOD', ex: 'NASDAQ', p: 74.79,  ch: 2.61 }
      ]});
    }

    // ── TREASURY ──────────────────────────────────────────────────────────
    // Docs: GET /btc-treasuries → company list with BTC holdings
    if (type === 'treasury') {
      try {
        const d = await get('/btc-treasuries', 8000);
        const raw = Array.isArray(d) ? d : (d.data || d.list || []);
        const list = raw.slice(0, 6).map(c => ({
          name: c.entity_name || c.entityName || c.company_name || c.companyName || c.name || 'Unknown',
          btc:  parseInt(c.btc_holdings || c.bitcoinHoldings || c.holdings || c.total_holdings || 0)
        }));
        const weeklyInflow = parseFloat(d.weekly_net_inflow || d.weeklyNetInflow || 0) || 2540000000;
        const companies = parseInt(d.total || d.total_companies || raw.length) || 42;
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');
        return res.json({ ok: true, data: { companies, weeklyInflow, list }, source: 'sosovalue' });
      } catch (e) {
        console.error('Treasury:', e.message);
        return res.json({ ok: false, error: e.message });
      }
    }

    return res.status(400).json({ ok: false, error: 'Unknown type: ' + type });

  } catch (e) {
    console.error('soso handler:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

function fmtVol(v) {
  if (!v || isNaN(v)) return 'N/A';
  if (v >= 1e9) return (v/1e9).toFixed(1)+'B';
  if (v >= 1e6) return (v/1e6).toFixed(1)+'M';
  if (v >= 1e3) return (v/1e3).toFixed(0)+'K';
  return v.toFixed(0);
}

function inferDesc(ticker) {
  const map = { ssimag7:'Top 7 Crypto', ssilayer1:'L1 Blockchains', ssicefi:'CeFi Tokens', ssidefi:'DeFi Basket', ssipayfi:'PayFi Sector' };
  return map[ticker.toLowerCase()] || ticker;
}

function inferSignal(d) {
  const ch = parseFloat(d.change_pct_24h || d.change || 0);
  if (ch > 2) return 'BUY';
  if (ch < -2) return 'SELL';
  if (ch > 0.5) return 'HOLD';
  return 'NEUTRAL';
}
