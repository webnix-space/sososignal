// SoDEX API — Live prices, NO static fallbacks, cache-busting
const SPOT_BASE = 'https://mainnet-gw.sodex.dev/api/v1/spot';
const TESTNET_BASE = 'https://testnet-gw.sodex.dev/api/v1/spot';

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
  // NO CACHE — always fresh
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { testnet } = req.query;
  const base = testnet === '1' ? TESTNET_BASE : SPOT_BASE;

  // ── Try SoDEX first ──────────────────────────────────────────
  try {
    const r = await fetchWithTimeout(`${base}/markets/tickers`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'OnchainEdge/2.0'
      }
    }, 8000);

    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    const items = raw?.data || [];

    if (items.length > 0) {
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
            symbolID: t.symbolID || null,
            lastPrice: String(price),
            priceChange: String((parseFloat(t.changePct || 0)).toFixed(2)),
            volume: String(Math.round(parseFloat(t.volume || 0))),
            quoteVolume: String(Math.round(parseFloat(t.quoteVolume || 0))),
            source: testnet === '1' ? 'sodex-testnet' : 'sodex-live',
            updatedAt: Date.now()
          };
        })
        .filter(x => x);

      return res.json({
        ok: true,
        data: parsed,
        source: testnet === '1' ? 'sodex-testnet' : 'sodex-live',
        pairCount: parsed.length,
        updatedAt: Date.now()
      });
    }
  } catch (e) {
    console.error('SoDEX failed:', e.message);
  }

  // ── No static fallback — return error so user knows ──────────
  return res.status(503).json({
    ok: false,
    error: 'SoDEX API unavailable. Check testnet status.',
    updatedAt: Date.now()
  });
}
