// api/signal.js — Dual-Model AI Signal Engine
// M1: llama-3.3-70b-versatile  → primary analysis + structured JSON
// M2: llama-3.1-8b-instant     → risk validation + agreement check
// Both modes: chat + signal — always inject live SoSoValue data

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const SOSO_BASE = 'https://openapi.sosovalue.com/openapi/v1';

const MODEL_M1 = 'llama-3.3-70b-versatile';   // Primary analyst
const MODEL_M2 = 'llama-3.1-8b-instant';       // Risk validator (fast)

function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

// Reuses the same Redis cache api/soso.js populates on its own poll cycle,
// instead of firing a second independent set of ~12 SoSoValue calls every
// time "Load Signals" is clicked. Between the dashboard's auto-refresh and
// this reuse, live signal generation usually costs zero extra SoSoValue
// calls — it just reads what's already cached from the last dashboard poll.
let sharedRedis = null;
let sharedRedisTried = false;
async function getSharedCache(type) {
  if (!sharedRedisTried) {
    sharedRedisTried = true;
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (url && token) {
      try {
        const { Redis } = await import('@upstash/redis');
        sharedRedis = new Redis({ url, token });
      } catch (e) { sharedRedis = null; }
    }
  }
  if (!sharedRedis) return null;
  try {
    return await sharedRedis.get(`soso-cache:${type}`);
  } catch (e) {
    return null;
  }
}

// ── Fetch live market data from SoSoValue ──────────────────────────────────
// Real endpoints confirmed against SoSoValue docs (the previous version of
// this function called /currency/list, /etf/summary, and
// /indices/ssiTop7/market-snapshot — none of which exist, which is why the
// UI was showing "LIVE DATA UNAVAILABLE" for every field regardless of
// whether SOSO_API_KEY was configured correctly):
//   GET /currencies                              — list, has currency_id + symbol
//   GET /currencies/{currency_id}/market-snapshot — price / 24h change / volume
//   GET /etfs/summary-history                     — aggregate ETF flow history
//   GET /indices                                  — list, has index_ticker + name
//   GET /indices/{index_ticker}/market-snapshot    — index price / 24h change

let currencyIdCache = null;
async function getCurrencyIdMap(headers) {
  if (!currencyIdCache) {
    const r = await fetchWithTimeout(`${SOSO_BASE}/currencies`, { headers }, 5000);
    const j = await r.json();
    const list = Array.isArray(j) ? j : (j.data || []);
    currencyIdCache = {};
    for (const c of list) {
      if (c.symbol) currencyIdCache[c.symbol.toUpperCase()] = c.currency_id;
    }
  }
  return currencyIdCache;
}

let ssiTickerCache = null;
async function getSsiTop7Ticker(headers) {
  if (ssiTickerCache !== null) return ssiTickerCache; // '' means "looked, found nothing"
  try {
    const r = await fetchWithTimeout(`${SOSO_BASE}/indices`, { headers }, 5000);
    const j = await r.json();
    const list = Array.isArray(j) ? j : (j.data || []);
    const match = list.find(idx =>
      /top ?7/i.test(idx.name || '') || /top ?7/i.test(idx.index_ticker || '')
    );
    ssiTickerCache = match ? match.index_ticker : '';
  } catch (e) {
    ssiTickerCache = '';
  }
  return ssiTickerCache;
}

async function fetchLiveData() {
  try {
    const sosoKey = process.env.SOSO_API_KEY;
    if (!sosoKey) return null;

    // Cache-only, deliberately. This used to fall back to its own live
    // SoSoValue calls when the cache missed — but that fallback competes
    // with soso.js's dashboard polling for the SAME 20/min rate-limit
    // budget on the same API key, which is exactly what caused BTC, SOL,
    // and etfs/summary-history to all 429 in a single "Load Signals"
    // click. Reading only the cache soso.js already maintains means this
    // endpoint never adds its own load to that budget — worst case is a
    // few seconds of "Unavailable" right after a cold deploy, which is a
    // far better failure mode than cascading 429s.
    const [cachedPrices, cachedEtf, cachedSector] = await Promise.all([
      getSharedCache('prices'), getSharedCache('etf-flows'), getSharedCache('sector')
    ]);

    const getCurrencySnap = (sym) => {
      if (cachedPrices && cachedPrices[sym]) {
        return { price: cachedPrices[sym].spot, change_pct_24h: cachedPrices[sym].ch, turnover_24h: cachedPrices[sym].vol };
      }
      return null;
    };

    const getEtfSummary = () => {
      if (cachedEtf) return { total_net_inflow: cachedEtf.totalNet };
      return null;
    };

    const getSsiSnap = () => {
      if (cachedSector && cachedSector.length) {
        // sector cache is the SSI sector list, not the Top7 index itself —
        // approximate with the average change across sectors as a stand-in.
        const avgCh = cachedSector.reduce((s, x) => s + (x.ch || 0), 0) / cachedSector.length;
        return { price: 0, change_pct_24h: avgCh };
      }
      return null;
    };

    const [btc, eth, sol, etfLatest, ssi] = await Promise.all([
      getCurrencySnap('BTC'), getCurrencySnap('ETH'), getCurrencySnap('SOL'),
      getEtfSummary(), getSsiSnap()
    ]);


    // Field names for etfs/summary-history and indices market-snapshot were
    // not in the confirmed doc set — these fall back across a few plausible
    // names rather than assuming one. If live values still show 0/N/A after
    // SOSO_API_KEY is confirmed working, log the raw etfLatest/ssi objects
    // and correct the field names here.
    const etfNet = etfLatest
      ? (etfLatest.total_net_inflow ?? etfLatest.net_inflow ?? etfLatest.netInflow ?? 0)
      : 0;
    const ssiPrice = ssi ? (ssi.price ?? ssi.value ?? 0) : 0;
    const ssiCh = ssi ? (ssi.change_pct_24h ?? ssi.price_change_24h ?? ssi['24h_change_pct'] ?? 0) : 0;

    return {
      BTC: btc ? { price: btc.price, ch: btc.change_pct_24h, vol: btc.turnover_24h } : null,
      ETH: eth ? { price: eth.price, ch: eth.change_pct_24h, vol: eth.turnover_24h } : null,
      SOL: sol ? { price: sol.price, ch: sol.change_pct_24h, vol: sol.turnover_24h } : null,
      etf: {
        totalNet: etfNet,
        available: !!etfLatest
      },
      ssi: {
        top7Price: ssiPrice,
        top7Ch: ssiCh,
        available: !!ssi
      },
      timestamp: new Date().toUTCString()
    };
  } catch (e) {
    console.error('[signal] Live data fetch failed:', e.message);
    return null;
  }
}

// ── Call Groq with a model ─────────────────────────────────────────────────
async function callGroq(model, messages, maxTokens = 400, temperature = 0.3) {
  const r = await fetchWithTimeout(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
  }, 12000);

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Groq ${model} error ${r.status}: ${err.slice(0, 200)}`);
  }

  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}

// ── Parse JSON from M1 response ────────────────────────────────────────────
function parseSignalJSON(text) {
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {}

  // Fallback: extract key fields from text
  const signal = text.toUpperCase().includes('BUY') ? 'BUY'
    : text.toUpperCase().includes('SELL') ? 'SELL' : 'HOLD';
  const confMatch = text.match(/(\d{1,3})\s*%/);
  return {
    signal,
    confidence: confMatch ? parseInt(confMatch[1]) : 55,
    reasoning: text.slice(0, 300),
    stop_loss: 'N/A',
    take_profit: 'N/A',
    timeframe: '24h',
    risk_reward: 'N/A'
  };
}

// ── Save to Redis (non-blocking) ───────────────────────────────────────────
async function saveToRedis(symbol, payload) {
  const attempt = async () => {
    const { Redis } = await import('@upstash/redis');
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      console.warn('[signal] Redis not configured — signal will not be saved for backtesting');
      return;
    }
    const redis = new Redis({ url, token });
    await redis.lpush(`signals:${symbol}`, JSON.stringify({
      ...payload,
      timestamp: Date.now()
    }));
    await redis.ltrim(`signals:${symbol}`, 0, 99); // Keep last 100
  };

  try {
    await attempt();
  } catch (e) {
    // "fetch failed" (no HTTP status) is a transport-level blip, not a
    // code bug — one retry after a short delay is cheap insurance.
    console.warn('[signal] Redis save failed, retrying once:', e.message);
    try {
      await new Promise(r => setTimeout(r, 300));
      await attempt();
    } catch (e2) {
      console.warn('[signal] Redis save failed on retry:', e2.message);
    }
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  if (!GROQ_API_KEY) {
    return res.status(500).json({ ok: false, error: 'GROQ_API_KEY missing' });
  }

  const { mode = 'signal', asset = 'BTC', prompt, price, etfFlow, pulseScore } = req.body || {};

  try {
    // ── Always fetch live data ───────────────────────────────────────────────
    const liveData = await fetchLiveData();
    const assetData = liveData?.[asset] || null;

    const dataBlock = liveData
      ? `LIVE MARKET DATA (${liveData.timestamp}):
BTC: $${liveData.BTC?.price || 'N/A'} (${liveData.BTC?.ch > 0 ? '+' : ''}${(liveData.BTC?.ch || 0).toFixed(2)}% 24h)
ETH: $${liveData.ETH?.price || 'N/A'} (${liveData.ETH?.ch > 0 ? '+' : ''}${(liveData.ETH?.ch || 0).toFixed(2)}% 24h)
SOL: $${liveData.SOL?.price || 'N/A'} (${liveData.SOL?.ch > 0 ? '+' : ''}${(liveData.SOL?.ch || 0).toFixed(2)}% 24h)
BTC ETF Net Flow: $${((liveData.etf?.totalNet || 0) / 1e6).toFixed(2)}M
SSI Top7 Index: $${liveData.ssi?.top7Price || 'N/A'} (${liveData.ssi?.top7Ch > 0 ? '+' : ''}${(liveData.ssi?.top7Ch || 0).toFixed(2)}%)
CRITICAL: Use ONLY these live figures. Never use training-data prices.`
      : '[LIVE DATA UNAVAILABLE — use general analysis only, state this clearly]';

    // ════════════════════════════════════════════════════════════════
    // CHAT MODE
    // ════════════════════════════════════════════════════════════════
    if (mode === 'chat') {
      if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });

      const chatPrompt = `${dataBlock}\n\nUSER QUESTION: ${prompt}`;

      const [m1Text, m2Text] = await Promise.all([
        callGroq(MODEL_M1, [
          { role: 'system', content: 'You are an expert crypto analyst. Use ONLY the live data provided. Keep response under 200 words. Be direct and specific.' },
          { role: 'user', content: chatPrompt }
        ], 400),
        callGroq(MODEL_M2, [
          { role: 'system', content: 'You are a risk analyst. Review the question and live data. Add risk perspective in 1-2 sentences.' },
          { role: 'user', content: chatPrompt }
        ], 150)
      ]);

      return res.json({
        ok: true,
        result: m1Text,
        riskNote: m2Text,
        liveDataInjected: !!liveData,
        models: { m1: MODEL_M1, m2: MODEL_M2 },
        dataFreshness: liveData?.timestamp || 'N/A',
        timestamp: Date.now()
      });
    }

    // ════════════════════════════════════════════════════════════════
    // SIGNAL MODE — Dual Model, Structured JSON
    // ════════════════════════════════════════════════════════════════
    const currentPrice = assetData?.price || price || 0;
    const etfFlowVal = (liveData?.etf?.totalNet || etfFlow || 0) / 1e6;
    const change24h = assetData?.ch || 0;

    const signalPrompt = `${dataBlock}

ANALYZE: ${asset}
Current Price: $${currentPrice}
24h Change: ${change24h > 0 ? '+' : ''}${change24h.toFixed(2)}%
ETF Net Flow: $${etfFlowVal.toFixed(2)}M
SSI Top7 Change: ${liveData?.ssi?.top7Ch > 0 ? '+' : ''}${(liveData?.ssi?.top7Ch || 0).toFixed(2)}%
Market Pulse: ${pulseScore || 50}/100

Respond ONLY with valid JSON (no markdown, no explanation outside JSON):
{
  "signal": "BUY|SELL|HOLD",
  "confidence": <integer 0-100>,
  "reasoning": "<2-3 sentence analysis using live data above>",
  "stop_loss": "$<price>",
  "take_profit": "$<price>",
  "timeframe": "<4h|24h|3d|1w>",
  "risk_reward": "<ratio like 1:2.5>",
  "key_factor": "<single most important driver>",
  "data_sources": [
    {"name": "BTC Spot Price", "status": "${liveData?.BTC ? 'Live' : 'Unavailable'}"},
    {"name": "ETF Flow", "status": "${liveData?.etf?.available ? 'Live' : 'Unavailable'}"},
    {"name": "SSI Top7 Index", "status": "${liveData?.ssi?.available ? 'Live' : 'Unavailable'}"}
  ],
  "confidence_evolution": [
    {"step": "Price Action", "data": "$${currentPrice} (${change24h > 0 ? '+' : ''}${change24h.toFixed(2)}%)", "source": "SoSoValue", "confidence_delta": <int>, "running_total": <int>},
    {"step": "ETF Flow", "data": "$${etfFlowVal.toFixed(1)}M net", "source": "SoSoValue", "confidence_delta": <int>, "running_total": <int>},
    {"step": "SSI Sector", "data": "${(liveData?.ssi?.top7Ch || 0).toFixed(2)}% change", "source": "SoSoValue", "confidence_delta": <int>, "running_total": <int>}
  ]
}`;

    // M1 — Primary analysis
    const m1Raw = await callGroq(MODEL_M1, [
      {
        role: 'system',
        content: 'You are an institutional crypto analyst. Output ONLY valid JSON as specified. No markdown. No text outside the JSON object.'
      },
      { role: 'user', content: signalPrompt }
    ], 600, 0.2);

    const signalData = parseSignalJSON(m1Raw);

    // M2 — Risk validation (fast, parallel-friendly, small model)
    const riskPrompt = `M1 Signal: ${signalData.signal} with ${signalData.confidence}% confidence for ${asset} at $${currentPrice}.
M1 Reasoning: ${signalData.reasoning}
ETF Flow: $${etfFlowVal.toFixed(2)}M

Respond ONLY with JSON:
{
  "agreed": <true|false>,
  "risk_score": <0-100, 100=high risk>,
  "verdict": "<one sentence>",
  "adjusted_confidence": <integer 0-100>
}`;

    let riskCheck = null;
    try {
      const m2Raw = await callGroq(MODEL_M2, [
        { role: 'system', content: 'You are a risk validator. Output ONLY valid JSON. No markdown.' },
        { role: 'user', content: riskPrompt }
      ], 200, 0.1);

      const parsed = parseSignalJSON(m2Raw);
      riskCheck = {
        agreed: parsed.agreed ?? true,
        score: parsed.risk_score ?? 50,
        verdict: parsed.verdict || 'Risk assessment complete',
        adjustedConfidence: parsed.adjusted_confidence ?? signalData.confidence
      };
    } catch (e) {
      console.warn('[signal] M2 failed:', e.message);
      riskCheck = {
        agreed: true,
        score: 50,
        verdict: 'Risk validation unavailable',
        adjustedConfidence: signalData.confidence
      };
    }

    // Final confidence = weighted average of M1 and M2
    const finalConfidence = riskCheck.agreed
      ? Math.round(signalData.confidence * 0.6 + riskCheck.adjustedConfidence * 0.4)
      : Math.round(signalData.confidence * 0.7 + riskCheck.adjustedConfidence * 0.3);

    const result = {
      ...signalData,
      confidence: finalConfidence,
      riskCheck,
      m1: MODEL_M1,
      m2: MODEL_M2,
      liveDataInjected: !!liveData,
      dataFreshness: liveData?.timestamp || 'N/A'
    };

    // Save to Redis non-blocking
    saveToRedis(asset, {
      signal: result.signal,
      confidence: finalConfidence,
      asset,
      entryPrice: currentPrice,
      etfFlow: etfFlowVal,
      pulseScore: pulseScore || 50,
      mode: 'signal'
    });

    return res.json({
      ok: true,
      result: JSON.stringify(result),
      signal: result.signal,
      confidence: finalConfidence,
      timestamp: Date.now()
    });

  } catch (e) {
    console.error('[signal] Handler error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
