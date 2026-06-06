// api/history.js - Fixed: Handle missing Redis gracefully, return JSON not HTML
import { Redis } from '@upstash/redis';

const redis = process.env.UPSTASH_REDIS_REST_URL 
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { symbol, days = 7 } = req.body || {};

    if (!redis) {
      console.warn('[history] Redis not configured - returning empty history');
      return res.json({ 
        ok: true, 
        history: [],
        warning: 'Redis not configured. Signals not persisted. Add UPSTASH_REDIS_REST_URL to enable backtesting.',
        redisEnabled: false
      });
    }

    const key = `signals:${symbol}:${days}`;
    const history = await redis.lrange(key, 0, -1);

    return res.json({ 
      ok: true, 
      history: history.map(h => {
        try { return JSON.parse(h); } 
        catch { return h; }
      }),
      redisEnabled: true
    });
  } catch (e) {
    console.error('[history] Error:', e);
    return res.status(500).json({ 
      ok: false, 
      error: e.message,
      history: []
    });
  }
}
