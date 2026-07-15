// api/news.js — SoSoValue news feed, proxied to the REAL API.
//
// Previous version called https://api.sosovalue.com/v1/crypto/news with a
// Bearer token — fictional domain/path, same mistake as the old soso.js.
// Real endpoint (confirmed): GET /news under the same base + auth header
// already working in signal.js/simulate.js/soso.js.
//
// KNOWN GAP: exact article field names weren't in the confirmed doc set —
// mapped defensively across a few plausible names below.

const SOSO_BASE = 'https://openapi.sosovalue.com/openapi/v1';

function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const fallbackArticles = [
    {
      title: "Bitcoin Institutional Inflows Accelerate as Net ETF Submissions Standardize",
      url: "https://sosovalue.xyz",
      source: "SoSoValue Insights",
      published: new Date().toISOString()
    },
    {
      title: "SoDEX Volume Matrix Hits Record Highs on Velocity Testnet Waves",
      url: "https://testnet.sodex.com",
      source: "SoDEX News",
      published: new Date().toISOString()
    },
    {
      title: "Macro Sector Indices Indicate Layer-1 Outperformance Protocols",
      url: "https://sosovalue.xyz",
      source: "MacroCrypto",
      published: new Date().toISOString()
    }
  ];

  try {
    const apiKey = process.env.SOSO_API_KEY;
    if (!apiKey) {
      return res.status(200).json({ ok: true, articles: fallbackArticles, source: 'Fallback — no API key configured' });
    }

    const r = await fetchWithTimeout(`${SOSO_BASE}/news`, {
      headers: { 'x-soso-api-key': apiKey, 'Accept': 'application/json' }
    }, 8000);

    if (!r.ok) throw new Error(`News server responded with status ${r.status}`);
    const j = await r.json();
    // CONFIRMED: SoSoValue's feeds endpoints wrap responses as
    // {code, message, data:{list:[...], page, total}} — j.data is an
    // object, not the array itself. Reading j.data directly (as before)
    // meant `list.length` was always undefined, so this endpoint always
    // threw and fell back to the 3 hardcoded articles regardless of
    // whether the live fetch actually worked.
    const list = Array.isArray(j) ? j : (j.data && j.data.list) || (Array.isArray(j.data) ? j.data : []);

    if (!list.length) throw new Error('Live news feed returned no articles');

    const articles = list.slice(0, 10).map(a => ({
      title: a.title || a.headline || (a.multilanguageContent && a.multilanguageContent[0] && a.multilanguageContent[0].title) || 'Untitled',
      url: a.url || a.link || a.sourceLink || a.source_link || 'https://sosovalue.xyz',
      source: a.source || a.author || a.nick_name || 'SoSoValue',
      published: a.published || a.releaseTime || a.release_time || a.publish_time || a.created_at || new Date().toISOString()
    }));

    return res.status(200).json({ ok: true, articles, source: 'SoSoValue (Live)' });

  } catch (error) {
    console.error("[news] Route execution failed, using fallbacks:", error.message);
    return res.status(200).json({ ok: true, articles: fallbackArticles, source: 'Fallback' });
  }
}
