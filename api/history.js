// Signal History — Redis with in-memory fallback
let memoryCache = [];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let signals = [];

    // Try Redis first
    try {
      const { Redis } = await import('@upstash/redis');
      const redis = Redis.fromEnv();
      const raw = await redis.lrange('signals', 0, 49);
      signals = raw.map(s => {
        try { return JSON.parse(s); } catch (e) { return null; }
      }).filter(Boolean);
    } catch (e) {
      // Redis not configured, use in-memory
      signals = memoryCache.slice(0, 50);
    }

    if (signals.length === 0) {
      return res.status(200).json({
        ok: true,
        signals: [],
        count: 0,
        note: 'No signal history yet. Generate your first signal above.'
      });
    }

    return res.json({
      ok: true,
      signals,
      count: signals.length
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// Export for signal.js to use
export function addToMemory(signal) {
  memoryCache.unshift(signal);
  if (memoryCache.length > 500) memoryCache = memoryCache.slice(0, 500);
}
