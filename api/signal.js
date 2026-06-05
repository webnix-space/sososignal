// /api/signal.js
// DUAL-MODEL AI SIGNAL ENGINE — WAVE 2
// Primary: llama-3.3-70b-versatile | Risk: llama-3.1-8b-instant

import { Redis } from '@upstash/redis';

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';

// Use Upstash Redis via REST URL
function getRedis() {
  const url = process.env.onchainedge_REDIS_URL || process.env.KV_URL || '';
  const token = process.env.KV_REST_API_TOKEN || '';
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function callGroq(key, model, messages, jsonMode = false, maxTokens = 800) {
  const body = { model, max_tokens: maxTokens, temperature: 0.3, messages };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const r = await fetch(GROQ, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Groq ${model} HTTP ${r.status}: ${err.slice(0, 150)}`);
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

function parseJSON(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const stripped = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

function detectDataSources(prompt) {
  const sources = [];
  if (/etf|ibit|fbtc|net inflow|net flow/i.test(prompt)) sources.push({ name: 'SoSoValue ETF Flows API', endpoint: '/etfs/{ticker}/market-snapshot', status: 'live', type: 'institutional' });
  if (/ssi|sector|layer1|defi|meme|index/i.test(prompt)) sources.push({ name: 'SoSoValue SSI Indexes API', endpoint: '/indices/{ticker}/market-snapshot', status: 'live', type: 'institutional' });
  if (/treasury|microstrategy|mstr|btc holdings/i.test(prompt)) sources.push({ name: 'SoSoValue BTC Treasury API', endpoint: '/btc-treasuries', status: 'live', type: 'institutional' });
  if (/price|btc \$|eth \$|sol \$/i.test(prompt)) sources.push({ name: 'SoSoValue Currency Snapshots', endpoint: '/currencies/{id}/market-snapshot', status: 'live', type: 'market' });
  if (sources.length === 0) sources.push({ name: 'SoSoValue Market Data', endpoint: 'openapi.sosovalue.com', status: 'live', type: 'institutional' });
  return sources;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const KEY = process.env.GROQ_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  const { prompt, mode, asset, price, etfFlow, pulseScore } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  // ── CHAT / ANALYZE ─────────────────────────────────────────────────────
  if (mode === 'chat' || mode === 'analyze') {
    const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    for (const model of models) {
      try {
        const result = await callGroq(KEY, model, [
          { role: 'system', content: 'You are OnchainEdge AI, a concise professional crypto analyst powered by SoSoValue institutional data. Max 3 sentences. No markdown. Be specific with numbers.' },
          { role: 'user', content: prompt }
        ], false, 400);
        return res.status(200).json({ result, model });
      } catch (e) {
        console.error(`${model} chat failed:`, e.message);
      }
    }
    return res.status(200).json({ result: 'AI temporarily unavailable. Please try again.' });
  }

  const dataSources = detectDataSources(prompt);
  const sosoSourceCount = dataSources.filter(s => s.name.includes('SoSoValue')).length;

  // ── SIGNAL MODE ─────────────────────────────────────────────────────────
  const signalPrompt = `You are a professional crypto trading analyst at OnchainEdge powered by SoSoValue institutional data.

═══ LIVE INSTITUTIONAL DATA (from SoSoValue API) ═══
${prompt}

Generate a trading signal. Respond ONLY with this JSON:
{
  "signal": "BUY",
  "confidence": 72,
  "confidence_evolution": [
    {"step":"Base Case","data":"Neutral starting point","confidence_delta":0,"running_total":50,"source":"Baseline"},
    {"step":"ETF Flows","data":"+$467M net inflow","confidence_delta":15,"running_total":65,"source":"SoSoValue ETF API"},
    {"step":"SSI Layer1","data":"-0.5% change","confidence_delta":-8,"running_total":57,"source":"SoSoValue SSI API"},
    {"step":"Fear & Greed","data":"65/100","confidence_delta":10,"running_total":67,"source":"alternative.me"},
    {"step":"Price Action","data":"BTC +2.3% 24h","confidence_delta":5,"running_total":72,"source":"SoSoValue Price API"}
  ],
  "summary": "one sentence verdict",
  "reasoning": "2-3 sentences citing actual numbers",
  "factors": ["factor 1","factor 2","factor 3"],
  "risk": "MEDIUM",
  "timeframe": "3-7 days",
  "stop_loss": "-5%",
  "take_profit": "+8%"
}`;

  let model1Result = null, model1Name = null;
  try {
    const raw = await callGroq(KEY, 'llama-3.3-70b-versatile', [
      { role: 'system', content: 'You are a crypto analyst. Respond ONLY with valid JSON. No markdown.' },
      { role: 'user', content: signalPrompt }
    ], true, 900);
    const parsed = parseJSON(raw);
    if (parsed?.signal && ['BUY','SELL','HOLD','NEUTRAL'].includes(parsed.signal)) {
      model1Result = parsed;
      model1Name = 'llama-3.3-70b-versatile';
    }
  } catch (e) {
    console.error('Model1 failed:', e.message);
  }

  if (!model1Result) {
    // Fallback to smaller model
    try {
      const raw = await callGroq(KEY, 'llama-3.1-8b-instant', [
        { role: 'system', content: 'You are a crypto analyst. Respond ONLY with valid JSON. No markdown.' },
        { role: 'user', content: signalPrompt }
      ], true, 900);
      const parsed = parseJSON(raw);
      if (parsed?.signal && ['BUY','SELL','HOLD','NEUTRAL'].includes(parsed.signal)) {
        model1Result = parsed;
        model1Name = 'llama-3.1-8b-instant';
      }
    } catch (e) {
      console.error('Fallback model failed:', e.message);
    }
  }

  if (!model1Result) {
    return res.status(200).json({ error: 'Signal generation failed — primary model unavailable' });
  }

  // ── RISK CHECK ──────────────────────────────────────────────────────────
  let riskCheck = null, m2Name = null;
  const riskPrompt = `You are a risk analyst reviewing this signal: ${model1Result.signal} at ${model1Result.confidence}% confidence.
Data: ${prompt}
Respond ONLY with JSON: {"agree":true,"adjusted_confidence":68,"risk_flags":["specific risk 1","specific risk 2"],"contrarian":"strongest counter-argument","final_recommendation":"CONFIRM"}`;

  try {
    const raw = await callGroq(KEY, 'llama-3.1-8b-instant', [
      { role: 'system', content: 'Risk analyst. Respond ONLY with valid JSON.' },
      { role: 'user', content: riskPrompt }
    ], true, 400);
    const parsed = parseJSON(raw);
    if (parsed?.final_recommendation && Array.isArray(parsed.risk_flags)) {
      riskCheck = parsed;
      m2Name = 'llama-3.1-8b-instant';
    }
  } catch (e) {
    console.error('Risk model failed:', e.message);
  }

  let finalConf = model1Result.confidence;
  if (riskCheck?.adjusted_confidence) {
    finalConf = Math.round(model1Result.confidence * 0.6 + riskCheck.adjusted_confidence * 0.4);
  }
  if (riskCheck?.final_recommendation === 'REDUCE') finalConf = Math.max(35, finalConf - 12);
  if (riskCheck?.final_recommendation === 'INCREASE') finalConf = Math.min(95, finalConf + 8);
  if (riskCheck?.agree === false) finalConf = Math.max(30, finalConf - 20);

  const riskScore = riskCheck ? Math.min(100, Math.max(0,
    (100 - (riskCheck.adjusted_confidence || finalConf)) +
    (riskCheck.risk_flags?.length || 0) * 5 +
    (riskCheck.agree === false ? 25 : 0)
  )) : 50;

  const riskCheckForFrontend = riskCheck ? {
    agreed: riskCheck.agree ?? true,
    verdict: riskCheck.final_recommendation || 'CONFIRM',
    score: Math.round(riskScore),
    warnings: riskCheck.risk_flags || [],
    flags: riskCheck.risk_flags || [],
    contrarian: riskCheck.contrarian || '',
    recommendation: riskCheck.final_recommendation || 'CONFIRM',
    independent_confidence: riskCheck.adjusted_confidence || null
  } : null;

  const finalResult = {
    signal: model1Result.signal,
    confidence: finalConf,
    confidence_evolution: model1Result.confidence_evolution || [],
    summary: model1Result.summary || '',
    reasoning: model1Result.reasoning || '',
    factors: model1Result.factors || [],
    risk: model1Result.risk || 'MEDIUM',
    risk_level: model1Result.risk || 'MEDIUM',
    timeframe: model1Result.timeframe || '3-7 days',
    stop_loss: model1Result.stop_loss || null,
    take_profit: model1Result.take_profit || null,
    riskCheck: riskCheckForFrontend,
    risk_check: riskCheckForFrontend,
    models_used: [model1Name, m2Name].filter(Boolean),
    dual_model: !!riskCheck,
    m1: model1Name,
    m2: m2Name || 'unavailable',
    data_sources: dataSources,
    soso_powered: sosoSourceCount > 0,
    powered_by: 'SoSoValue Institutional Data + Groq Dual-Model AI'
  };

  // ── STORE IN REDIS ──────────────────────────────────────────────────────
  try {
    const redis = getRedis();
    if (redis) {
      const signalRecord = JSON.stringify({
        asset: asset || 'BTC',
        signal: model1Result.signal,
        confidence: finalConf,
        confidence_evolution: model1Result.confidence_evolution || [],
        entryPrice: price || 0,
        etfFlow: etfFlow || 0,
        pulseScore: pulseScore || 0,
        timestamp: Date.now(),
        riskScore
      });
      await redis.lpush('signals', signalRecord);
      await redis.ltrim('signals', 0, 499);
    }
  } catch (e) {
    console.error('Redis store failed:', e.message);
  }

  return res.status(200).json({ result: JSON.stringify(finalResult) });
}
