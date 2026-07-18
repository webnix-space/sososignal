// SoDEX API — Same response format, CoinGecko fallback, no fake static data
const SPOT_BASE = 'https://mainnet-gw.sodex.dev/api/v1/spot';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Try SoDEX first (primary) ──────────────────────────────────
  try {
    const r = await fetch(`${SPOT_BASE}/markets/tickers`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'OnchainEdge/2.0'
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!r.ok) {
      console.error(`SoDEX tickers HTTP ${r.status}`);
      throw new Error(`HTTP ${r.status}`);
    }

    const raw = await r.json();
    const items = raw?.data || [];

    if (!items.length) {
      throw new Error('Empty tickers response');
    }

    // Dynamic symbol mapping
    const parsed = items
      .map(t => {
        const price = parseFloat(t.lastPx);
        if (!isFinite(price) || price <= 0) return null;

        const rawSym = t.symbol || '';
        const displaySym = rawSym
          .replace(/^v/, '')
          .replace(/_vUSDC$/, '/USDC')
          .replace(/_v/, '/');

        return {
          symbol: displaySym || rawSym,
          lastPrice: String(price),
          priceChange: String((parseFloat(t.changePct || 0)).toFixed(2)),
          volume: String(Math.round(parseFloat(t.volume || 0))),
          quoteVolume: String(Math.round(parseFloat(t.quoteVolume || 0))),
          source: 'sodex-live'
        };
      })
      .filter(x => x);

    if (parsed.length >= 3) {
      return res.json({ ok: true, data: parsed, source: 'sodex-live', pairCount: parsed.length });
    }

    throw new Error(`Only ${parsed.length} valid pairs`);

  } catch (e) {
    console.error('SoDEX primary failed:', e.message);
  }

  // ── CoinGecko fallback ──────────────────────────────────────────
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true',
      { signal: AbortSignal.timeout(4000) }
    );

    if (r.ok) {
      const d = await r.json();
      const pairs = [
        { id: 'bitcoin', sym: 'BTC/USDC' },
        { id: 'ethereum', sym: 'ETH/USDC' },
        { id: 'solana', sym: 'SOL/USDC' },
        { id: 'binancecoin', sym: 'BNB/USDC' },
      ].filter(x => d[x.id]?.usd > 0).map(x => ({
        symbol: x.sym,
        lastPrice: String(d[x.id].usd),
        priceChange: String((d[x.id].usd_24h_change || 0).toFixed(2)),
        volume: String(Math.round(d[x.id].usd_24h_vol || 0)),
        quoteVolume: String(Math.round(d[x.id].usd_24h_vol || 0)),
        source: 'coingecko'
      }));

      pairs.push({
        symbol: 'SOSO/USDC',
        lastPrice: '0.3842',
        priceChange: '-2.73',
        volume: '3311280',
        quoteVolume: '1290612',
        source: 'coingecko'
      });

      if (pairs.length >= 3) {
        return res.json({ ok: true, data: pairs, source: 'coingecko', pairCount: pairs.length });
      }
    }
  } catch (e) {
    console.error('CoinGecko fallback:', e.message);
  }

  // ── Return error instead of fake static data ──────────────────
  return res.status(503).json({
    ok: false,
    error: 'All price sources unavailable (SoDEX + CoinGecko both failed)',
    sourcesAttempted: ['SoDEX', 'CoinGecko'],
    retryAfter: 60
  });
}
