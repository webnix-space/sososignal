export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const FALLBACK_ITEMS = [
    { title: "Bitcoin ETFs draw $2B in April for highest monthly inflows this year", url: "https://cointelegraph.com", source: "CoinTelegraph", published_on: Math.floor(Date.now()/1000) - 18000, categories: "MARKETS" },
    { title: "Spot Bitcoin ETF outflows top $490M: Is BTC's rally losing momentum?", url: "https://cointelegraph.com", source: "CoinTelegraph", published_on: Math.floor(Date.now()/1000) - 14400, categories: "MARKETS" },
    { title: "Brazil bars crypto settlement in regulated cross-border payment rails", url: "https://cointelegraph.com", source: "CoinTelegraph", published_on: Math.floor(Date.now()/1000) - 21600, categories: "REGULATION" },
    { title: "DeFi can freeze stolen funds, but not everyone agrees it should", url: "https://cointelegraph.com", source: "CoinTelegraph", published_on: Math.floor(Date.now()/1000) - 7200, categories: "DEFI" },
    { title: "Ethereum layer-2 ecosystem grows as transaction fees hit yearly lows", url: "https://cointelegraph.com", source: "CoinTelegraph", published_on: Math.floor(Date.now()/1000) - 10800, categories: "MARKETS" },
    { title: "Stablecoin market cap reaches new all-time high above $160 billion", url: "https://cointelegraph.com", source: "CoinTelegraph", published_on: Math.floor(Date.now()/1000) - 25200, categories: "MARKETS" },
  ];

  const feeds = [
    { url: 'https://cointelegraph.com/rss', source: 'CoinTelegraph' },
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
    { url: 'https://decrypt.co/feed', source: 'Decrypt' },
    { url: 'https://bitcoinmagazine.com/.rss/full/', source: 'Bitcoin Magazine' },
  ];

  for (const feed of feeds) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      let r;
      try {
        r = await fetch(feed.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; OnchainEdge/2.0)',
            'Accept': 'application/rss+xml, application/xml, text/xml, */*'
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!r || !r.ok) {
        console.error(`Feed ${feed.source}: HTTP ${r?.status}`);
        continue;
      }

      let xml;
      try {
        xml = await r.text();
      } catch (e) {
        console.error(`Feed ${feed.source} read error:`, e.message);
        continue;
      }

      if (!xml || xml.length < 100) {
        console.error(`Feed ${feed.source}: empty response`);
        continue;
      }

      const items = [];
      let matches;
      try {
        matches = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)];
      } catch (e) {
        console.error(`Feed ${feed.source} parse error:`, e.message);
        continue;
      }

      for (const m of matches) {
        try {
          const block = m[1];
          const title = decode(extract(block, 'title'));
          const link = extract(block, 'link') || extract(block, 'guid');
          const pubDate = extract(block, 'pubDate');
          const category = extract(block, 'category') || 'CRYPTO';
          if (!title || !link) continue;

          const ts = pubDate
            ? Math.floor(new Date(pubDate).getTime() / 1000)
            : Math.floor(Date.now() / 1000);

          // Skip invalid dates
          if (isNaN(ts) || ts <= 0) continue;

          items.push({
            title,
            url: link.trim(),
            source: feed.source,
            published_on: ts,
            categories: category
          });
          if (items.length >= 8) break;
        } catch (e) {
          console.error(`Item parse error (${feed.source}):`, e.message);
          continue;
        }
      }

      if (items.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
        return res.status(200).json({ items, source: feed.source, fallback: false });
      }

      console.error(`Feed ${feed.source}: parsed 0 items from ${matches.length} raw items`);

    } catch (e) {
      console.error(`Feed ${feed.source} failed:`, e.message);
      continue;
    }
  }

  // Always return fallback so news renders even if all RSS feeds fail
  console.error('All feeds failed — returning static fallback');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  return res.status(200).json({
    items: FALLBACK_ITEMS,
    source: 'Cached',
    fallback: true
  });
}

function extract(text, tag) {
  if (!text || !tag) return '';
  const patterns = [
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'),
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'),
    new RegExp(`<${tag}[^>]*\\/?>([\\s\\S]*?)(?:<\\/${tag}>|$)`, 'i'),
  ];
  for (const p of patterns) {
    try {
      const m = text.match(p);
      if (m && m[1]) return m[1].trim();
    } catch (e) {
      continue;
    }
  }
  return '';
}

function decode(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();
}
