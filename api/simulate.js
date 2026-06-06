// api/simulate.js — "What If?" Simulator / Backtest
// Fixed: uses UPSTASH_REDIS_REST_URL (not old onchainedge_REDIS_URL)
// Fixed: reads from signals:{asset} key (same as signal.js writes to)
// Fixed: GET method, ?asset=BTC&days=30

import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { asset = 'BTC', days = '30' } = req.query;
  const cutoff = Date.now() - parseInt(days) * 24 * 60 * 60 * 1000;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return res.json({
      ok: true, asset, period: `${days} days`,
      signalsFound: 0, hitRate: 0, maxDrawdown: 0,
      falseSignalRate: 0, avgReturn: 0, trades: [],
      message: 'Redis not configured. Add UPSTASH_REDIS_REST_URL to Vercel env vars.'
    });
  }

  try {
    const redis = new Redis({ url, token });

    // Read from the same key signal.js writes to: signals:{asset}
    const key = `signals:${asset}`;
    const raw = await redis.lrange(key, 0, 99);

    const parsed = raw
      .map(s => {
        try { return typeof s === 'string' ? JSON.parse(s) : s; }
        catch { return null; }
      })
      .filter(s => s && s.timestamp >= cutoff);

    if (parsed.length === 0) {
      return res.json({
        ok: true, asset, period: `${days} days`,
        signalsFound: 0, hitRate: 0, maxDrawdown: 0,
        falseSignalRate: 0, avgReturn: 0, trades: [],
        message: `No signal history for ${asset} in last ${days} days. Generate signals first!`
      });
    }

    // ── Simulate returns using confidence-weighted model ─────────────────────
    // Real backtest would require historical OHLC. This is a confidence-based
    // estimate: high confidence signals tend toward positive returns.
    let wins = 0, losses = 0, holds = 0;
    let maxDD = 0, peak = 0, runningPnl = 0;
    const trades = [];

    for (const sig of parsed) {
      const conf = sig.confidence || 50;

      // Confidence-weighted estimated return
      let estimatedReturn = 0;
      if (sig.signal === 'BUY') {
        estimatedReturn = conf > 70 ? 3.5 : conf > 55 ? 1.8 : conf > 40 ? 0.6 : -0.5;
      } else if (sig.signal === 'SELL') {
        estimatedReturn = conf > 70 ? 3.2 : conf > 55 ? 1.5 : conf > 40 ? 0.4 : -0.7;
      } else {
        estimatedReturn = 0; // HOLD
      }

      if (estimatedReturn > 0) wins++;
      else if (estimatedReturn < 0) losses++;
      else holds++;

      runningPnl += estimatedReturn;
      peak = Math.max(peak, runningPnl);
      maxDD = Math.max(maxDD, peak - runningPnl);

      trades.push({
        date: new Date(sig.timestamp).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        }),
        signal: sig.signal || 'N/A',
        confidence: conf,
        entryPrice: sig.entryPrice ? `$${sig.entryPrice.toLocaleString()}` : 'N/A',
        estimatedReturn: (estimatedReturn > 0 ? '+' : '') + estimatedReturn.toFixed(2) + '%',
        result: estimatedReturn > 0 ? 'WIN' : estimatedReturn < 0 ? 'LOSS' : 'NEUTRAL',
        etfFlow: sig.etfFlow ? `$${sig.etfFlow.toFixed(1)}M` : 'N/A',
        pulseScore: sig.pulseScore || 'N/A'
      });
    }

    const total = wins + losses;
    return res.json({
      ok: true, asset, period: `${days} days`,
      signalsFound: parsed.length,
      hitRate: total > 0 ? Math.round(wins / total * 100) : 0,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      falseSignalRate: total > 0 ? Math.round(losses / total * 100) : 0,
      avgReturn: parsed.length > 0 ? Math.round((runningPnl / parsed.length) * 100) / 100 : 0,
      totalReturn: Math.round(runningPnl * 100) / 100,
      trades: trades.slice(0, 50),
      winCount: wins, lossCount: losses, holdCount: holds,
      disclaimer: 'Confidence-weighted estimates. Not actual historical prices. For accurate backtesting, integrate a historical OHLC API.'
    });

  } catch (e) {
    console.error('[simulate] Error:', e.message);
    return res.status(200).json({
      ok: false, error: e.message,
      signalsFound: 0, trades: []
    });
  }
}
