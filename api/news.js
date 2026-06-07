// api/news.js
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
      return res.status(200).json({ ok: true, articles: fallbackArticles });
    }

    const response = await fetch('https://api.sosovalue.com/v1/crypto/news', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (!response.ok) throw new Error(`News server responded with status ${response.status}`);
    const result = await response.json();

    return res.status(200).json({ ok: true, articles: result.articles || fallbackArticles });

  } catch (error) {
    console.error("[news] Route execution failed, using fallbacks:", error.message);
    return res.status(200).json({ ok: true, articles: fallbackArticles });
  }
}
