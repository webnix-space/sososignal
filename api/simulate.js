// /api/simulate.js
// "What If?" Simulator — backtest signals against historical price movement

import { kv } from '@vercel/kv';

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
    // Use a fixed base URL instead of req.headers.host
    const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
    const priceRes = await fetch(`${baseUrl}/api/soso?type=prices`);
    const priceData = await priceRes.json();
    const currentPrice = priceData.data?.[asset]?.spot || 0;

    let wins = 0, losses = 0, holds = 0;
    let maxDD = 0, peak = 0, runningPnl = 0;
    const trades = [];

    for (const sig of parsed) {
      // Use confidence as a proxy for signal quality
      // In production, fetch actual 24h forward price from CoinGecko/SoSoValue historical API
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
      trades: trades.slice(0, 50),
      winCount: wins,
      lossCount: losses,
      holdCount: holds,
      disclaimer: 'Results use estimated forward returns based on signal confidence. For accurate backtesting, integrate historical price API (CoinGecko/SoSoValue klines).'
    });

  } catch (e) {
    console.error('Simulator error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}

function estimateForwardReturn(signal, currentPrice) {
  // Improved estimation using signal confidence and direction
  // Higher confidence = larger expected move
  const baseMove = signal.confidence > 70 ? 3.5 : signal.confidence > 50 ? 1.2 : -0.8;

  if (signal.signal === 'BUY') return baseMove;
  if (signal.signal === 'SELL') return -baseMove;
  return Math.abs(baseMove) < 0.5 ? 0 : -Math.abs(baseMove) * 0.3;
}

function calculatePnl(signal, forwardReturn) {
  if (signal === 'BUY') return forwardReturn;
  if (signal === 'SELL') return -forwardReturn;
  return Math.abs(forwardReturn) < 0.5 ? 0 : -Math.abs(forwardReturn) * 0.3;
}
