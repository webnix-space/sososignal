// api/history.js — Signal history from Upstash Redis
// Fixed: accepts GET (not POST), correct key format signals:{asset}, proper response

import { Redis } from '@upstash/redis';

const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    })
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Frontend calls: GET /api/history?asset=BTC&days=7
  const { asset = 'BTC', days = '7' } = req.query;

  if (!redis) {
    return res.json({
      ok: false,
      data: [],
      error: 'Redis not configured. Add UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to Vercel env vars.',
      redisEnabled: false
    });
  }

  try {
    const key = `signals:${asset}`;
    const raw = await redis.lrange(key, 0, 99);

    const cutoff = Date.now() - parseInt(days) * 24 * 60 * 60 * 1000;
    const parsed = raw
      .map(h => {
        try { return typeof h === 'string' ? JSON.parse(h) : h; }
        catch { return null; }
      })
      .filter(h => h && h.timestamp >= cutoff);

    return res.json({
      ok: true,
      data: parsed,
      total: parsed.length,
      asset,
      days: parseInt(days),
      redisEnabled: true
    });
  } catch (e) {
    console.error('[history] Redis error:', e.message);
    return res.status(500).json({
      ok: false,
      data: [],
      error: e.message,
      redisEnabled: true
    });
  }
}
