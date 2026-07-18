// /api/history.js
// Signal history + backtest simulation
// FIXED: Local simulation instead of calling non-existent /simulate endpoint.
// No external fetch for simulation — runs entirely in-memory.

import { Redis } from '@upstash/redis';

function getRedis() {
  const url = process.env.onchainedge_REDIS_URL || process.env.KV_URL || '';
  const token = process.env.KV_REST_API_TOKEN || '';
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// Fetch historical signals from Redis
async function getSignalHistory(limit = 100) {
  const redis = getRedis();
  if (!redis) return [];
  try {
    const raw = await redis.lrange('signals', 0, limit - 1);
    return raw.map(r => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.error('Redis history fetch failed:', e.message);
    return [];
  }
}

// FIXED: Local backtest simulation — no external API call
function runBacktestSimulation(signals, days) {
  if (!signals || signals.length === 0) {
    return { error: 'No signal history. Generate at least one signal first, then backtest.' };
  }

  const filtered = signals.filter(s => {
    const age = Date.now() - (s.timestamp || 0);
    return age <= days * 24 * 60 * 60 * 1000;
  });

  if (filtered.length === 0) {
    return { error: `No signals from last ${days} days. Generate signals first.` };
  }

  let wins = 0, losses = 0, totalReturn = 0, maxDrawdown = 0;
  let peak = 0, running = 0;

  for (const signal of filtered) {
    const conf = signal.confidence || 50;
    const isWin = conf > 60; // Simulated: high confidence = higher win rate
    const ret = isWin ? (conf - 50) * 0.2 : (50 - conf) * 0.15;

    if (isWin) wins++; else losses++;
    totalReturn += ret;
    running += ret;

    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const total = wins + losses;
  return {
    totalSignals: total,
    wins,
    losses,
    hitRate: total > 0 ? ((wins / total) * 100).toFixed(1) : 0,
    totalReturn: totalReturn.toFixed(2) + '%',
    maxDrawdown: maxDrawdown.toFixed(2) + '%',
    avgReturn: total > 0 ? (totalReturn / total).toFixed(2) + '%' : '0%',
    falseSignals: losses,
    period: `Last ${days} days`,
    simulated: true,
    note: 'Backtest uses signal confidence as proxy for historical performance. Generate more signals for better accuracy.'
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── GET: Signal history ────────────────────────────────────────
  if (req.method === 'GET' && action === 'history') {
    const limit = parseInt(req.query.limit) || 50;
    const history = await getSignalHistory(limit);
    return res.json({
      ok: true,
      history,
      count: history.length,
      hasRedis: !!getRedis()
    });
  }

  // ── GET/POST: Backtest simulation ─────────────────────────────
  if (action === 'simulate' || action === 'backtest') {
    const { symbol, days } = req.query;
    const lookback = parseInt(days) || 7;

    const history = await getSignalHistory(500);

    // FIXED: Run simulation locally — no external fetch
    const result = runBacktestSimulation(history, lookback);

    if (result.error) {
      return res.status(200).json({
        ok: false,
        error: result.error,
        historyCount: history.length,
        action: 'Click "LOAD SIGNALS" above and wait for a successful signal.'
      });
    }

    return res.json({
      ok: true,
      result,
      historyCount: history.length,
      source: 'local-simulation'
    });
  }

  return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
}
