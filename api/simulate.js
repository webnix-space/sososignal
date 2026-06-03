// /api/simulate.js
// "What If?" Simulator — backtest signals against historical price movement

import { kv } from '@vercel/kv';

// Simple price proxy — in production, fetch from SoSoValue klines or CoinGecko historical
const HISTORICAL_PRICES = {
  // These would be populated by a cron job or fetched dynamically
  // For demo, we use a simplified model
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { asset = 'BTC', days = '30' } = req.query;
  const cutoff = Date.now() - parseInt(days) * 24 * 60 * 60 * 1000;

  try {
    const signals = await kv.lrange('signals', 0, -1);
    const parsed = signals.map(JSON.parse).filter(s => {
      return s.asset === asset && s.timestamp > cutoff;
    });

    if (parsed.length === 0) {
      return res.json({
        ok: true,
        asset,
        period: `${days} days`,
        signalsFound: 0,
        hitRate: 0,
        maxDrawdown: 0,
        falseSignalRate: 0,
        avgReturn: 0,
        trades: [],
        message: 'No signals found for this period. Generate some signals first!'
      });
    }

    // Fetch current prices for P&L calculation
    // In real implementation, fetch historical prices at signal time + 24h
    const priceRes = await fetch(`${req.headers.host?.includes('localhost') ? 'http://localhost:3000' : 'https://' + req.headers.host}/api/soso?type=prices`);
    const priceData = await priceRes.json();
    const currentPrice = priceData.data?.[asset]?.spot || 0;

    let wins = 0, losses = 0, holds = 0;
    let maxDD = 0, peak = 0, runningPnl = 0;
    const trades = [];

    for (const sig of parsed) {
      // Simplified forward return estimation
      // In production: fetch price at signal.time + 24h from CoinGecko/SoSoValue
      const forwardReturn = estimateForwardReturn(sig, currentPrice);
      const pnl = calculatePnl(sig.signal, forwardReturn);

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
    const hitRate = total > 0 ? wins / total : 0;
    const falseSignalRate = total > 0 ? losses / total : 0;

    return res.json({
      ok: true,
      asset,
      period: `${days} days`,
      signalsFound: parsed.length,
      hitRate: Math.round(hitRate * 100),
      maxDrawdown: Math.round(maxDD * 100) / 100,
      falseSignalRate: Math.round(falseSignalRate * 100),
      avgReturn: runningPnl / parsed.length,
      totalReturn: runningPnl,
      trades: trades.slice(0, 50), // Limit response size
      winCount: wins,
      lossCount: losses,
      holdCount: holds
    });

  } catch (e) {
    console.error('Simulator error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}

function estimateForwardReturn(signal, currentPrice) {
  // Placeholder: use confidence as proxy for expected move
  // In production: fetch actual 24h forward price from historical API
  if (signal.signal === 'BUY') return signal.confidence > 70 ? 3.5 : signal.confidence > 50 ? 1.2 : -0.8;
  if (signal.signal === 'SELL') return signal.confidence > 70 ? -2.8 : signal.confidence > 50 ? -1.0 : 0.5;
  return 0;
}

function calculatePnl(signal, forwardReturn) {
  if (signal === 'BUY') return forwardReturn;
  if (signal === 'SELL') return -forwardReturn;
  return Math.abs(forwardReturn) < 0.5 ? 0 : -Math.abs(forwardReturn) * 0.3; // HOLD penalty if market moved
}
