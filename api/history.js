// /api/history.js
import { Redis } from '@upstash/redis';

function getRedis() {
  const url = process.env.onchainedge_REDIS_URL || process.env.KV_URL || '';
  const token = process.env.KV_REST_API_TOKEN || '';
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = getRedis();
  if (!redis) {
    return res.json({ ok: true, count: 0, data: [], message: 'Redis not configured' });
  }

  try {
    if (req.method === 'POST') {
      const signal = req.body;
      if (!signal?.asset || !signal?.signal || signal.confidence === undefined) {
        return res.status(400).json({ ok: false, error: 'asset, signal, confidence required' });
      }
      signal.timestamp = Date.now();
      await redis.lpush('signals', JSON.stringify(signal));
      await redis.ltrim('signals', 0, 499);
      return res.json({ ok: true, stored: true });
    }

    if (req.method === 'GET') {
      const { asset, limit = '100' } = req.query;
      const signals = await redis.lrange('signals', 0, parseInt(limit) - 1);
      const parsed = signals.map(s => typeof s === 'string' ? JSON.parse(s) : s);
      const filtered = asset ? parsed.filter(s => s.asset === asset) : parsed;
      return res.json({ ok: true, count: filtered.length, data: filtered });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('History error:', e.message);
    return res.status(200).json({ ok: false, error: e.message, data: [] });
  }
}
