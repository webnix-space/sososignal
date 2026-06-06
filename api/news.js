// api/news.js - Market news from SoSoValue
// Fixed: AbortSignal.timeout() replaced with fetchWithTimeout

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
    return res.status(500).json({ ok: false, error: 'SOSO_API_KEY missing' });
  }

  try {
    const r = await fetchWithTimeout(`${BASE}/feed/list`, {
      headers: { 'x-soso-api-key': KEY, 'Accept': 'application/json' }
    }, 8000);

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: `HTTP ${r.status}` });
    }

    const j = await r.json();
    if (j.code !== 0) {
      return res.json({ ok: false, error: j.msg || `Code ${j.code}` });
    }

    const items = (j.data || []).slice(0, 8).map(item => {
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
  } catch (e) {
    console.error('[news] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
