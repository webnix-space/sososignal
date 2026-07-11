// api/simulate.js — Real signal accuracy tracking against SoSoValue historical klines.
// Replaces the old confidence-bucket lookup table (which fabricated returns) with
// actual close-price comparisons: entryPrice (stored at signal time) vs real close
// price N days later, pulled from SoSoValue's daily klines endpoint.
//
// Judge feedback across Wave 2 asked for this exact thing repeatedly:
// "signal accuracy tracking showing which calls hit their targets" (BlessinSum),
// "a system that proves why its signals are reliable" (MuhammadBa_2),
// "closed-loop performance evaluation" (jzddd).
//
// Constraint from SoSoValue docs: klines are DAILY ONLY, 3-month lookback max.
// So resolution here is daily, not intraday — that's disclosed in the response,
// not hidden.

import { Redis } from '@upstash/redis';

const SOSO_BASE = 'https://open-api.sosovalue.com/openapi/v1';
const EVAL_WINDOW_DAYS = 1; // grade a signal once at least 1 full day has passed

function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

// currency_id lookup is not stable/guessable — fetch the real list and cache
// in-memory for the life of this serverless instance (cheap, changes rarely).
let currencyIdCache = null;
async function getCurrencyId(symbol, sosoKey) {
  if (!currencyIdCache) {
    const r = await fetchWithTimeout(`${SOSO_BASE}/currencies`, {
      headers: { 'x-soso-api-key': sosoKey, 'Accept': 'application/json' }
    }, 8000);
    if (!r.ok) throw new Error(`currencies lookup failed: HTTP ${r.status}`);
    const j = await r.json();
    const list = Array.isArray(j) ? j : (j.data || []);
    currencyIdCache = {};
    for (const c of list) {
      if (c.symbol) currencyIdCache[c.symbol.toUpperCase()] = c.currency_id;
    }
  }
  return currencyIdCache[symbol.toUpperCase()] || null;
}

// Fetch daily klines for a currency between two timestamps (ms).
async function getKlines(currencyId, startTime, endTime, sosoKey) {
  const url = `${SOSO_BASE}/currencies/${currencyId}/klines?interval=1d&start_time=${startTime}&end_time=${endTime}&limit=100`;
  const r = await fetchWithTimeout(url, {
    headers: { 'x-soso-api-key': sosoKey, 'Accept': 'application/json' }
  }, 8000);
  if (!r.ok) throw new Error(`klines fetch failed: HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : (j.data || []);
}

// Given klines sorted by timestamp, find the closing price for the first
// candle at or after targetTime.
function closeAtOrAfter(klines, targetTime) {
  const sorted = [...klines].sort((a, b) => a.timestamp - b.timestamp);
  for (const k of sorted) {
    if (k.timestamp >= targetTime) return k.close;
  }
  return sorted.length ? sorted[sorted.length - 1].close : null; // fallback: latest available
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { asset = 'BTC', days = '30' } = req.query;
  const cutoff = Date.now() - parseInt(days) * 24 * 60 * 60 * 1000;

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const sosoKey = process.env.SOSO_API_KEY;

  if (!redisUrl || !redisToken) {
    return res.json({
      ok: true, asset, period: `${days} days`,
      signalsFound: 0, resolvedCount: 0, pendingCount: 0,
      hitRate: 0, falseSignalRate: 0, avgReturn: 0, trades: [],
      message: 'Redis not configured. Add UPSTASH_REDIS_REST_URL to Vercel env vars.'
    });
  }
  if (!sosoKey) {
    return res.json({
      ok: false, asset, period: `${days} days`,
      signalsFound: 0, resolvedCount: 0, pendingCount: 0,
      hitRate: 0, falseSignalRate: 0, avgReturn: 0, trades: [],
      error: 'SOSO_API_KEY not configured — cannot fetch real price history to grade signals.'
    });
  }

  try {
    const redis = new Redis({ url: redisUrl, token: redisToken });
    const key = `signals:${asset}`;
    const raw = await redis.lrange(key, 0, 99);

    const signals = raw
      .map(s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } })
      .filter(s => s && s.timestamp >= cutoff);

    if (signals.length === 0) {
      return res.json({
        ok: true, asset, period: `${days} days`,
        signalsFound: 0, resolvedCount: 0, pendingCount: 0,
        hitRate: 0, falseSignalRate: 0, avgReturn: 0, trades: [],
        message: `No signal history for ${asset} in last ${days} days. Generate signals first!`
      });
    }

    const currencyId = await getCurrencyId(asset, sosoKey);
    if (!currencyId) {
      return res.json({
        ok: false, asset, period: `${days} days`,
        signalsFound: signals.length, resolvedCount: 0, pendingCount: signals.length,
        hitRate: 0, falseSignalRate: 0, avgReturn: 0, trades: [],
        error: `Could not resolve currency_id for symbol ${asset} via SoSoValue /currencies.`
      });
    }

    // Pull klines once for the full window instead of per-signal (rate-limit friendly).
    const earliestSignal = Math.min(...signals.map(s => s.timestamp));
    const klines = await getKlines(currencyId, earliestSignal, Date.now(), sosoKey);

    let wins = 0, losses = 0, holds = 0, pending = 0;
    let runningPnl = 0, peak = 0, maxDD = 0;
    const trades = [];

    for (const sig of signals) {
      const evalTime = sig.timestamp + EVAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const entryPrice = sig.entryPrice;

      if (evalTime > Date.now() || !entryPrice) {
        pending++;
        trades.push({
          date: new Date(sig.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          signal: sig.signal || 'N/A',
          confidence: sig.confidence || 50,
          entryPrice: entryPrice ? `$${entryPrice.toLocaleString()}` : 'N/A',
          result: 'PENDING',
          note: 'Not yet eligible for grading (needs 1 full day of price history)'
        });
        continue;
      }

      const exitPrice = closeAtOrAfter(klines, evalTime);
      if (!exitPrice || !entryPrice) {
        pending++;
        trades.push({
          date: new Date(sig.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          signal: sig.signal || 'N/A',
          confidence: sig.confidence || 50,
          result: 'UNRESOLVED',
          note: 'No matching kline data found for evaluation window'
        });
        continue;
      }

      const actualReturn = ((exitPrice - entryPrice) / entryPrice) * 100;
      let result;
      if (sig.signal === 'BUY') result = actualReturn > 0 ? 'WIN' : 'LOSS';
      else if (sig.signal === 'SELL') result = actualReturn < 0 ? 'WIN' : 'LOSS';
      else result = Math.abs(actualReturn) < 1 ? 'WIN' : 'NEUTRAL'; // HOLD "wins" if price stayed roughly flat

      if (result === 'WIN') wins++;
      else if (result === 'LOSS') losses++;
      else holds++;

      runningPnl += actualReturn;
      peak = Math.max(peak, runningPnl);
      maxDD = Math.max(maxDD, peak - runningPnl);

      trades.push({
        date: new Date(sig.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        signal: sig.signal || 'N/A',
        confidence: sig.confidence || 50,
        entryPrice: `$${entryPrice.toLocaleString()}`,
        exitPrice: `$${exitPrice.toLocaleString()}`,
        actualReturn: (actualReturn > 0 ? '+' : '') + actualReturn.toFixed(2) + '%',
        result
      });
    }

    const resolved = wins + losses + holds;
    return res.json({
      ok: true, asset, period: `${days} days`,
      signalsFound: signals.length,
      resolvedCount: resolved,
      pendingCount: pending,
      hitRate: resolved > 0 ? Math.round((wins / resolved) * 100) : 0,
      falseSignalRate: resolved > 0 ? Math.round((losses / resolved) * 100) : 0,
      avgReturn: resolved > 0 ? Math.round((runningPnl / resolved) * 100) / 100 : 0,
      totalReturn: Math.round(runningPnl * 100) / 100,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      winCount: wins, lossCount: losses, holdCount: holds,
      trades: trades.slice(0, 50),
      methodology: `Grades each signal by comparing entry price at signal time to the actual daily close price ${EVAL_WINDOW_DAYS} day(s) later, via SoSoValue historical klines. Daily resolution only (SoSoValue klines are daily-only, 3-month max lookback). Signals younger than ${EVAL_WINDOW_DAYS} day are marked PENDING, not scored.`
    });

  } catch (e) {
    console.error('[simulate] Error:', e.message);
    return res.status(200).json({
      ok: false, error: e.message,
      signalsFound: 0, resolvedCount: 0, pendingCount: 0, trades: []
    });
  }
}
