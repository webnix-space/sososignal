// /api/history.js — Signal history (AI Signal Audit Trail)
// FIXES:
//  1. Upstash auto-deserialises list items -> JSON.parse(object) threw -> every row dropped -> empty trail
//  2. "all" read key `signals` which nothing ever writes -> now merges every signals:<ASSET> list
//  3. Removed fabricated metrics (-12% drawdown, +4.2% avg return, 15% false signals, hit rate = BUY share)
//  4. No edge caching, so Refresh actually refreshes
//  5. ?action=health to see exactly what is broken (Redis env, ping, keys)

import { Redis } from '@upstash/redis';

const memoryStore = [];
const DEFAULT_ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'SOSO'];

function errMsg(e) {
  return e?.message + (e?.cause?.code ? ` (${e.cause.code})` : '');
}

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const parseItem = s => {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
};

async function listAssetKeys(redis) {
  try {
    const keys = await redis.keys('signals:*');
    if (Array.isArray(keys) && keys.length) return keys;
  } catch (e) { console.error('keys() failed:', errMsg(e)); }
  return DEFAULT_ASSETS.map(a => `signals:${a}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, asset, days } = req.query || {};

  try {
    if (action === 'health') {
      const redis = getRedis();
      const out = {
        ok: true,
        env: {
          redisUrl: !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL),
          redisToken: !!(process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
          groqKey: !!process.env.GROQ_API_KEY
        },
        redis: null
      };
      if (redis) {
        try {
          await redis.ping();
          const keys = await listAssetKeys(redis);
          const counts = {};
          for (const k of keys) counts[k] = await redis.llen(k);
          out.redis = { ping: 'ok', lists: counts };
        } catch (e) {
          out.redis = { ping: 'FAILED', error: errMsg(e) };
        }
      }
      return res.status(200).json(out);
    }

    if (action === 'get' || !action) {
      let signals = [];
      let source = 'memory';
      let redisError = null;

      const redis = getRedis();
      if (redis) {
        try {
          const keys = asset && asset !== 'all' ? [`signals:${asset}`] : await listAssetKeys(redis);
          const lists = await Promise.all(keys.map(k => redis.lrange(k, 0, 99).catch(() => [])));
          signals = lists.flat().map(parseItem).filter(Boolean);
          source = 'redis';
        } catch (e) {
          redisError = errMsg(e);
          console.error('Redis get failed:', redisError);
        }
      }

      if (signals.length === 0 && memoryStore.length > 0) {
        signals = [...memoryStore];
        source = 'memory';
      }

      if (asset && asset !== 'all') signals = signals.filter(s => (s.asset || 'BTC') === asset);
      if (days) {
        const cutoff = Date.now() - parseInt(days) * 24 * 60 * 60 * 1000;
        signals = signals.filter(s => (s.timestamp || 0) > cutoff);
      }
      signals.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      const total = signals.length;
      const count = sig => signals.filter(s => s.signal === sig).length;
      const avgConfidence = total > 0 ? signals.reduce((a, s) => a + (s.confidence || 0), 0) / total : 0;

      return res.status(200).json({
        ok: true,
        signals: signals.slice(0, 50),
        count: total,
        source,
        ...(redisError ? { redisError } : {}),
        metrics: {
          total,
          buy: count('BUY'),
          sell: count('SELL'),
          hold: count('HOLD'),
          avgConfidence: Math.round(avgConfidence),
          // Real accuracy lives in /api/simulate. Not faking it here.
          hitRate: null, maxDrawdown: null, falseSignals: null, avgReturn: null
        },
        metricsNote: 'Hit rate, drawdown and returns are computed from real prices in /api/simulate.'
      });
    }

    if (action === 'add' && req.method === 'POST') {
      const body = req.body || {};
      const signal = {
        asset: body.asset || 'BTC',
        signal: body.signal || 'HOLD',
        confidence: body.confidence || 50,
        timestamp: Date.now(),
        entryPrice: body.entryPrice || 0,
        etfFlow: body.etfFlow || 0,
        pulseScore: body.pulseScore || 0
      };

      memoryStore.unshift(signal);
      if (memoryStore.length > 500) memoryStore.pop();

      const redis = getRedis();
      if (redis) {
        try {
          await redis.lpush(`signals:${signal.asset}`, JSON.stringify(signal));
          await redis.ltrim(`signals:${signal.asset}`, 0, 499);
        } catch (e) {
          console.error('Redis add failed:', errMsg(e));
        }
      }
      return res.status(200).json({ ok: true, signal });
    }

    if (action === 'backtest') {
      return res.status(200).json({ ok: false, error: 'Use /api/simulate for backtesting.', redirect: '/api/simulate' });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  } catch (e) {
    console.error('History error:', errMsg(e));
    return res.status(200).json({ ok: false, error: errMsg(e) });
  }
}
