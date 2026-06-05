// /api/simulate.js
// "What If?" Simulator — backtest signals against historical price movement

import { Redis } from '@upstash/redis';

function getRedis() {
  const url = process.env.onchainedge_REDIS_URL || process.env.KV_URL || '';
  const token = process.env.KV_REST_API_TOKEN || '';
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { asset = 'BTC', days = '30' } = req.query;
  const cutoff = Date.now() - parseInt(days) * 24 * 60 * 60 * 1000;

  try {
    const redis = getRedis();
    if (!redis) {
      return res.json({ ok: true, asset, period: `${days} days`, signalsFound: 0, hitRate: 0, maxDrawdown: 0, falseSignalRate: 0, avgReturn: 0, trades: [], message: 'Redis not configured.' });
    }

    const signals = await redis.lrange('signals', 0, -1);
    const parsed = signals.map(s => typeof s === 'string' ? JSON.parse(s) : s).filter(s => s.asset === asset && s.timestamp > cutoff);

    if (parsed.length === 0) {
      return res.json({ ok: true, asset, period: `${days} days`, signalsFound: 0, hitRate: 0, maxDrawdown: 0, falseSignalRate: 0, avgReturn: 0, trades: [], message: 'No signal history for ' + asset + ' in last ' + days + ' days. Generate signals first!' });
    }

    const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
    const priceRes = await fetch(`${baseUrl}/api/soso?type=prices`);
    const priceData = await priceRes.json();
    const currentPrice = priceData.data?.[asset]?.spot || 0;

    let wins = 0, losses = 0, holds = 0, maxDD = 0, peak = 0, runningPnl = 0;
    const trades = [];

    for (const sig of parsed) {
      const baseMove = sig.confidence > 70 ? 3.5 : sig.confidence > 50 ? 1.2 : -0.8;
      const forwardReturn = sig.signal === 'BUY' ? baseMove : sig.signal === 'SELL' ? -baseMove : 0;
      const pnl = sig.signal === 'BUY' ? forwardReturn : sig.signal === 'SELL' ? -forwardReturn : 0;

      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
      else holds++;

      runningPnl += pnl;
      peak = Math.max(peak, runningPnl);
      maxDD = Math.max(maxDD, peak - runningPnl);

      trades.push({
        date: new Date(sig.timestamp).toISOString(),
        signal: sig.signal,
        confidence: sig.confidence,
        entryPrice: sig.entryPrice,
        estimatedReturn: pnl.toFixed(2) + '%',
        result: pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'NEUTRAL',
        etfFlow: sig.etfFlow,
        pulseScore: sig.pulseScore
      });
    }

    const total = wins + losses;
    return res.json({
      ok: true, asset, period: `${days} days`,
      signalsFound: parsed.length,
      hitRate: total > 0 ? Math.round(wins / total * 100) : 0,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      falseSignalRate: total > 0 ? Math.round(losses / total * 100) : 0,
      avgReturn: parsed.length > 0 ? runningPnl / parsed.length : 0,
      totalReturn: runningPnl,
      trades: trades.slice(0, 50),
      winCount: wins, lossCount: losses, holdCount: holds,
      disclaimer: 'Estimated returns based on signal confidence. Integrate historical price API for accurate backtesting.'
    });

  } catch (e) {
    console.error('Simulator error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}
