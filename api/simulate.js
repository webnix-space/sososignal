// api/simulate.js — STATELESS signal accuracy grading. No database.
// The browser sends its saved signals (POST body); this grades each against real daily prices.
// Prices: Kraken daily OHLC (keyless) -> CoinGecko daily (keyless) fallback.
// Daily resolution only; disclosed in the response.

const EVAL_WINDOW_DAYS = 1;
const DAY = 24 * 60 * 60 * 1000;

const KRAKEN_PAIRS = { BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD' };
const GECKO_IDS = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin' };

function errMsg(e) {
  return e?.message + (e?.cause?.code ? ` (${e.cause.code})` : '');
}

// Normalised candle: { timestamp (ms, UTC day start), open, close }
async function krakenDaily(asset, startMs) {
  const pair = KRAKEN_PAIRS[asset];
  if (!pair) throw new Error('not on Kraken');
  const since = Math.floor((startMs - 2 * DAY) / 1000);
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440&since=${since}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error(`Kraken HTTP ${r.status}`);
  const j = await r.json();
  if (j.error?.length) throw new Error('Kraken: ' + j.error.join(','));
  const key = Object.keys(j.result || {}).find(k => k !== 'last');
  const rows = key ? j.result[key] : [];
  if (!rows.length) throw new Error('Kraken: empty');
  return rows.map(c => ({ timestamp: c[0] * 1000, open: parseFloat(c[1]), close: parseFloat(c[4]) }));
}

async function geckoDaily(asset, startMs) {
  const id = GECKO_IDS[asset];
  if (!id) throw new Error(`no price source for ${asset}`);
  const days = Math.min(365, Math.ceil((Date.now() - startMs) / DAY) + 3);
  const r = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);
  const j = await r.json();
  const p = j.prices || [];
  if (!p.length) throw new Error('CoinGecko: empty');
  return p.map(([t, price]) => ({ timestamp: t, open: price, close: price }));
}

async function getCandles(asset, startMs) {
  const errors = [];
  for (const [name, fn] of [['kraken', krakenDaily], ['coingecko', geckoDaily]]) {
    try {
      const candles = await fn(asset, startMs);
      return { candles: candles.sort((a, b) => a.timestamp - b.timestamp), source: name };
    } catch (e) { errors.push(`${name}: ${errMsg(e)}`); }
  }
  throw new Error(errors.join(' | '));
}

// Candle whose UTC day contains time t (last candle starting at or before t)
function candleAt(candles, t) {
  let hit = null;
  for (const c of candles) { if (c.timestamp <= t) hit = c; else break; }
  return hit;
}

const fmtDate = ts => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const EMPTY = {
  signalsFound: 0, resolvedCount: 0, pendingCount: 0,
  hitRate: 0, falseSignalRate: 0, avgReturn: 0, totalReturn: 0, maxDrawdown: 0,
  winCount: 0, lossCount: 0, holdCount: 0, trades: []
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST {signals:[...]} only' });

  const asset = String(req.query.asset || 'BTC').toUpperCase();
  const days = String(req.query.days || '30');
  const cutoff = Date.now() - parseInt(days) * DAY;
  const period = `${days} days`;

  // Sanitise client-supplied signals (never trust the browser)
  const incoming = Array.isArray(req.body?.signals) ? req.body.signals.slice(0, 300) : [];
  const signals = incoming
    .filter(s => s && typeof s.timestamp === 'number' && s.timestamp >= cutoff && s.timestamp <= Date.now() + 60000)
    .filter(s => (s.asset || 'BTC').toUpperCase() === asset)
    .filter(s => ['BUY', 'SELL', 'HOLD', 'NEUTRAL'].includes(s.signal))
    .map(s => ({
      signal: s.signal,
      timestamp: s.timestamp,
      confidence: Number(s.confidence) || 50,
      entryPrice: Number(s.entryPrice) > 0 ? Number(s.entryPrice) : 0
    }))
    .sort((a, b) => b.timestamp - a.timestamp);

  if (signals.length === 0) {
    return res.json({ ok: true, asset, period, ...EMPTY, message: `No ${asset} signals saved in this browser for the last ${days} days. Generate signals first.` });
  }

  let stage = 'prices';
  try {
    const earliest = Math.min(...signals.map(s => s.timestamp));
    const { candles, source: priceSource } = await getCandles(asset, earliest);

    stage = 'grading';
    let wins = 0, losses = 0, holds = 0, pending = 0;
    let runningPnl = 0, peak = 0, maxDD = 0;
    const trades = [];

    // grade oldest-first so drawdown is chronological
    for (const sig of [...signals].sort((a, b) => a.timestamp - b.timestamp)) {
      const evalTime = sig.timestamp + EVAL_WINDOW_DAYS * DAY;
      let entryPrice = sig.entryPrice;
      let entryEstimated = false;
      if (!entryPrice) {
        const c = candleAt(candles, sig.timestamp);
        if (c) { entryPrice = c.open; entryEstimated = true; }
      }

      const base = { date: fmtDate(sig.timestamp), signal: sig.signal, confidence: sig.confidence };

      if (evalTime > Date.now()) {
        pending++;
        trades.push({ ...base, entryPrice: entryPrice ? `$${entryPrice.toLocaleString()}` : 'N/A', result: 'PENDING', note: 'Needs 1 full day before it can be graded' });
        continue;
      }

      const exitCandle = candleAt(candles, evalTime);
      if (!entryPrice || !exitCandle) {
        pending++;
        trades.push({ ...base, result: 'UNRESOLVED', note: 'No price data for this window' });
        continue;
      }

      const exitPrice = exitCandle.close;
      const actualReturn = ((exitPrice - entryPrice) / entryPrice) * 100;
      let result;
      if (sig.signal === 'BUY') result = actualReturn > 0 ? 'WIN' : 'LOSS';
      else if (sig.signal === 'SELL') result = actualReturn < 0 ? 'WIN' : 'LOSS';
      else result = Math.abs(actualReturn) < 1 ? 'WIN' : 'NEUTRAL';

      if (result === 'WIN') wins++;
      else if (result === 'LOSS') losses++;
      else holds++;

      const pnl = sig.signal === 'SELL' ? -actualReturn : (sig.signal === 'BUY' ? actualReturn : 0);
      runningPnl += pnl;
      peak = Math.max(peak, runningPnl);
      maxDD = Math.max(maxDD, peak - runningPnl);

      trades.push({
        ...base,
        entryPrice: `$${entryPrice.toLocaleString()}`,
        exitPrice: `$${exitPrice.toLocaleString()}`,
        actualReturn: (actualReturn > 0 ? '+' : '') + actualReturn.toFixed(2) + '%',
        result,
        ...(entryEstimated ? { note: 'Entry estimated from daily open' } : {})
      });
    }

    trades.reverse(); // newest first for display
    const resolved = wins + losses + holds;
    return res.json({
      ok: true, asset, period,
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
      priceSource,
      methodology: `Grades each saved signal by comparing its entry price to the daily close ${EVAL_WINDOW_DAYS} day(s) later (${priceSource}). Daily resolution only. Signals younger than ${EVAL_WINDOW_DAYS} day are PENDING, not scored. SELL signals count as profit when price falls.`
    });
  } catch (e) {
    console.error(`[simulate] ${stage} failed:`, errMsg(e));
    return res.status(200).json({ ok: false, error: `${stage}: ${errMsg(e)}`, asset, period, ...EMPTY });
  }
}
