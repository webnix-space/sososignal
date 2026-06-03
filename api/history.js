// /api/history.js
// Signal history for "What If?" Simulator

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') {
      const signal = req.body;
      signal.timestamp = Date.now();
      await kv.lpush('signals', JSON.stringify(signal));
      await kv.ltrim('signals', 0, 499);
      return res.json({ ok: true, stored: true });
    }

    if (req.method === 'GET') {
      const { asset, limit = '100' } = req.query;
      const signals = await kv.lrange('signals', 0, parseInt(limit) - 1);
      const parsed = signals.map(JSON.parse);
      const filtered = asset ? parsed.filter(s => s.asset === asset) : parsed;
      return res.json({ ok: true, count: filtered.length, data: filtered });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('History API error:', e.message);
    return res.status(200).json({ ok: false, error: e.message, data: [] });
  }
}
