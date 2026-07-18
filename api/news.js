// News API — CoinTelegraph RSS + CoinGecko news
// No SoSoValue calls. No fake static fallback.
const FEEDS = [
  { url: 'https://cointelegraph.com/rss', name: 'CoinTelegraph' }
];

const COINGECKO_NEWS = 'https://api.coingecko.com/api/v3/news';

function parseRSS(xml, sourceName) {
  const items = [];
  if (!xml || typeof xml !== 'string') return items;

  const itemRegex = /<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/gi;
  const matches = xml.match(itemRegex) || [];

  for (const item of matches.slice(0, 10)) {
    try {
      const titleMatch = item.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
      const linkMatch = item.match(/<link[^>]*?(?:href=["']([^"']+)["'][^>]*\/>|>([^<]+)<\/link>)/i);
      const descMatch = item.match(/<(?:description|summary|content)[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/(?:description|summary|content)>/i);
      const dateMatch = item.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i);

      const title = (titleMatch?.[1] || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();
      const link = (linkMatch?.[1] || linkMatch?.[2] || '').trim();
      const summary = (descMatch?.[1] || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").substring(0, 200).trim();
      const pubDate = (dateMatch?.[1] || new Date().toISOString()).trim();

      if (title && title.length > 5) {
        items.push({ title, link, summary, pubDate, source: sourceName });
      }
    } catch (e) {}
  }

  return items;
}

async function fetchFeed(feed) {
  try {
    const r = await fetch(feed.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OnchainEdge/2.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!r.ok) return [];
    const xml = await r.text();
    return parseRSS(xml, feed.name);
  } catch (e) {
    console.error(`Feed ${feed.name} failed:`, e.message);
    return [];
  }
}

async function fetchCoinGeckoNews() {
  try {
    const r = await fetch(COINGECKO_NEWS, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return [];
    const data = await r.json();
    if (!Array.isArray(data?.data)) return [];

    return data.data.slice(0, 10).map(item => ({
      title: item.title || 'Untitled',
      link: item.url || '#',
      summary: (item.description || '').substring(0, 200),
      pubDate: item.updated_at || new Date().toISOString(),
      source: item.source || 'CoinGecko'
    }));
  } catch (e) {
    console.error('CoinGecko news failed:', e.message);
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');

  const results = await Promise.allSettled([
    fetchFeed(FEEDS[0]),
    fetchCoinGeckoNews()
  ]);

  let allArticles = [];
  let sources = [];

  if (results[0].status === 'fulfilled' && results[0].value.length > 0) {
    allArticles = allArticles.concat(results[0].value);
    sources.push('CoinTelegraph');
  }

  if (results[1].status === 'fulfilled' && results[1].value.length > 0) {
    allArticles = allArticles.concat(results[1].value);
    sources.push('CoinGecko');
  }

  // Deduplicate by title
  const seen = new Set();
  allArticles = allArticles
    .filter(a => {
      const key = (a.title || '').toLowerCase().substring(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 12);

  if (allArticles.length === 0) {
    return res.status(503).json({
      ok: false,
      error: 'News sources temporarily unavailable',
      sourcesAttempted: ['CoinTelegraph', 'CoinGecko'],
      retryAfter: 300
    });
  }

  return res.status(200).json({
    ok: true,
    articles: allArticles,
    count: allArticles.length,
    sources: sources
  });
}
