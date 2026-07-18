// /api/news.js — CoinTelegraph RSS + CoinGecko news API only
// Same response format as before, no SoSoValue calls

const FEEDS = [
  { url: 'https://cointelegraph.com/rss', name: 'CoinTelegraph' }
];

const COINGECKO_NEWS = 'https://api.coingecko.com/api/v3/news';

// Static fallback articles (keep for reliability)
function getStaticFallback() {
  const now = Date.now();
  return [
    {
      title: 'Bitcoin ETF Inflows Reach Multi-Month High as Institutional Demand Returns',
      link: 'https://sosovalue.com/etf',
      source: 'SoSoValue Markets',
      pubDate: new Date(now - 1000 * 60 * 30).toISOString(),
      summary: 'BlackRock IBIT leads the charge with significant net inflows, signaling renewed institutional confidence in BTC.'
    },
    {
      title: 'SSI Layer 1 Index Outperforms as Capital Rotates Into Foundational Networks',
      link: 'https://sosovalue.com/indexes',
      source: 'SoSoValue Research',
      pubDate: new Date(now - 1000 * 60 * 90).toISOString(),
      summary: 'Layer 1 sector index posts strong gains while DeFi sees pullback, suggesting structural shift in market positioning.'
    },
    {
      title: 'MicroStrategy Continues BTC Accumulation Strategy Past 499K Holdings',
      link: 'https://www.microstrategy.com',
      source: 'Treasury News',
      pubDate: new Date(now - 1000 * 60 * 180).toISOString(),
      summary: 'Public company BTC holdings hit new high as institutional treasury allocation trend strengthens.'
    },
    {
      title: 'Crypto Market Sentiment Shifts as Fear & Greed Index Approaches Neutral Zone',
      link: 'https://alternative.me/crypto/fear-and-greed-index/',
      source: 'Market Sentiment',
      pubDate: new Date(now - 1000 * 60 * 240).toISOString(),
      summary: 'Sentiment indicators show consolidation phase, with traders awaiting macro catalysts for direction.'
    },
    {
      title: 'Meme Sector Leads SSI Performance With Notable Weekly Gains',
      link: 'https://sosovalue.com/indexes/ssiMeme',
      source: 'SoSoValue Sector Analysis',
      pubDate: new Date(now - 1000 * 60 * 300).toISOString(),
      summary: 'High-beta crypto sectors continue to show momentum, outpacing broader market performance.'
    },
    {
      title: 'Spot Bitcoin ETFs See Record Trading Volume Amid Institutional Reallocation',
      link: 'https://sosovalue.com/etf/btc',
      source: 'ETF Watch',
      pubDate: new Date(now - 1000 * 60 * 360).toISOString(),
      summary: 'Combined volume across spot BTC ETFs surges as fund managers rebalance Q4 portfolios.'
    },
    {
      title: 'Galaxy Digital Expands BTC Holdings as Institutional Crypto Adoption Grows',
      link: 'https://www.galaxy.com',
      source: 'Treasury Update',
      pubDate: new Date(now - 1000 * 60 * 420).toISOString(),
      summary: 'Galaxy Digital adds to its BTC treasury, joining MicroStrategy and Tesla in growing list of institutional holders.'
    },
    {
      title: 'AI-Powered Trading Tools See Surge as Retail Traders Seek Edge in Volatile Markets',
      link: 'https://onchainedge.vercel.app',
      source: 'OnchainEdge',
      pubDate: new Date(now - 1000 * 60 * 480).toISOString(),
      summary: 'Transparent AI signal engines gain traction with solo traders looking for institutional-grade analysis.'
    }
  ];
}

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

  try {
    const results = await Promise.allSettled([
      fetchFeed(FEEDS[0]),
      fetchCoinGeckoNews()
    ]);

    let allArticles = [];
    let liveCount = 0;

    // CoinTelegraph
    if (results[0].status === 'fulfilled' && results[0].value.length > 0) {
      allArticles = allArticles.concat(results[0].value);
      liveCount++;
    }

    // CoinGecko
    if (results[1].status === 'fulfilled' && results[1].value.length > 0) {
      allArticles = allArticles.concat(results[1].value);
      liveCount++;
    }

    // Deduplicate
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

    // Supplement with static if fewer than 5
    if (allArticles.length < 5) {
      const fallback = getStaticFallback();
      const needed = 8 - allArticles.length;
      allArticles = allArticles.concat(fallback.slice(0, needed));
    }

    return res.status(200).json({
      ok: true,
      articles: allArticles,
      count: allArticles.length,
      live: liveCount > 0,
      sourcesActive: liveCount,
      source: liveCount > 0 ? 'Live RSS' : 'Curated'
    });

  } catch (e) {
    console.error('News handler error:', e.message);
    const fallback = getStaticFallback();
    return res.status(200).json({
      ok: true,
      articles: fallback,
      count: fallback.length,
      live: false,
      sourcesActive: 0,
      source: 'Curated',
      error: e.message
    });
  }
}
