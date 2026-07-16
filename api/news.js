// api/news.js — SoSoValue news feed, proxied to the REAL API.
//
// Real endpoint (confirmed): GET /news under the same base + auth header
// used elsewhere. CONFIRMED via live logs this endpoint returns 429
// (rate limited) under regular polling — it had zero caching while every
// other SoSoValue-backed route already got a Redis cache layer, so it was
// the one thing still hitting SoSoValue fresh on every single poll.

const SOSO_BASE = 'https://openapi.sosovalue.com/openapi/v1';
const CACHE_TTL_SECONDS = 300; // news doesn't need 30-60s freshness

function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

let redisClient = null;
let redisTried = false;
async function getRedis() {
  if (redisTried) return redisClient;
  redisTried = true;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    redisClient = new Redis({ url, token });
  } catch (e) {
    redisClient = null;
  }
  return redisClient;
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

  const redis = await getRedis();
  if (redis) {
    try {
      const cached = await redis.get('soso-cache:news');
      if (cached) {
        return res.status(200).json({ ok: true, articles: cached, source: 'SoSoValue (Cached)' });
      }
    } catch (e) { /* fall through to live fetch */ }
  }

  try {
    const apiKey = process.env.SOSO_API_KEY;
    if (!apiKey) {
      return res.status(200).json({ ok: true, articles: fallbackArticles, source: 'Fallback — no API key configured' });
    }

    const r = await fetchWithTimeout(`${SOSO_BASE}/news`, {
      headers: { 'x-soso-api-key': apiKey, 'Accept': 'application/json' }
    }, 8000);

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`News server responded with status ${r.status} — ${body.slice(0, 200)}`);
    }
    const j = await r.json();
    // CONFIRMED: SoSoValue's feeds endpoints wrap responses as
    // {code, message, data:{list:[...], page, total}}.
    const list = Array.isArray(j) ? j : (j.data && j.data.list) || (Array.isArray(j.data) ? j.data : []);

    if (!list.length) throw new Error('Live news feed returned no articles');

    const articles = list.slice(0, 10).map(a => {
      const nestedTitle = a.multilanguageContent && a.multilanguageContent[0] && a.multilanguageContent[0].title;
      const nestedContent = a.multilanguageContent && a.multilanguageContent[0] && a.multilanguageContent[0].content;
      // Some SoSoValue feed items (e.g. whale-alert style posts) have no
      // formal headline field at all — only a body/content field. Rather
      // than show a bare "Untitled" for those, fall back to a truncated
      // snippet of whatever text content exists.
      const rawText = a.title || a.headline || nestedTitle || a.content || a.text || a.desc || nestedContent || '';
      const title = rawText ? (rawText.length > 120 ? rawText.slice(0, 117) + '...' : rawText) : 'Untitled';
      return {
        title,
        url: a.url || a.link || a.sourceLink || a.source_link || 'https://sosovalue.xyz',
        source: a.source || a.author || a.nick_name || 'SoSoValue',
        published: a.published || a.releaseTime || a.release_time || a.publish_time || a.created_at || new Date().toISOString()
      };
    });

    if (redis) {
      try { await redis.set('soso-cache:news', articles, { ex: CACHE_TTL_SECONDS }); } catch (e) { /* non-fatal */ }
    }

    return res.status(200).json({ ok: true, articles, source: 'SoSoValue (Live)' });

  } catch (error) {
    console.error("[news] Route execution failed, using fallbacks:", error.message);
    return res.status(200).json({ ok: true, articles: fallbackArticles, source: 'Fallback' });
  }
}
