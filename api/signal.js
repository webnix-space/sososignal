// DUAL-MODEL AI SIGNAL ENGINE
// Model 1 (llama-3.3-70b-versatile): Primary analyst
// Model 2 Risk checker: gemma2-9b-it → llama3-8b-8192 → llama-3.1-8b-instant

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';

async function callGroq(key, model, messages, jsonMode = false) {
  const body = { model, max_tokens: 600, temperature: 0.2, messages };
  if (jsonMode && model === 'llama-3.3-70b-versatile') {
    body.response_format = { type: 'json_object' };
  }
  const r = await fetch(GROQ, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(18000)
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const KEY = process.env.GROQ_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  const { prompt, mode } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  // ── CHAT / ANALYZE ────────────────────────────────────────────────────────
  if (mode === 'chat' || mode === 'analyze') {
    const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    for (const model of models) {
      try {
        const result = await callGroq(KEY, model, [
          {
            role: 'system',
            content: 'You are OnchainEdge AI, a concise professional crypto analyst. Max 3 sentences. No markdown.'
          },
          { role: 'user', content: prompt }
        ]);
        return res.status(200).json({ result, model });
      } catch (e) {
        console.error(`${model} chat failed:`, e.message);
      }
    }
    return res.status(200).json({ result: 'AI temporarily unavailable. Please try again.' });
  }

  // ── SIGNAL MODE — DUAL MODEL ──────────────────────────────────────────────
  const signalPrompt = `You are a professional crypto trading analyst with live market data access.

${prompt}

Respond ONLY with this exact JSON (no markdown, no extra text):
{"signal":"BUY","confidence":72,"summary":"one sentence verdict","reasoning":"2-3 sentences using the actual data","factors":["factor 1 with data","factor 2 with data","factor 3 with data"],"risk":"MEDIUM","timeframe":"3-7 days","stop_loss":"-5%","take_profit":"+8%"}

signal must be: BUY, SELL, HOLD, or NEUTRAL`;

  // MODEL 1: Primary signal
  let model1Result = null, model1Name = null;
  const m1candidates = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  for (const model of m1candidates) {
    try {
      const raw = await callGroq(KEY, model, [
        {
          role: 'system',
          content: 'You are a crypto trading analyst. Respond ONLY with valid JSON. No markdown code blocks. No text before or after the JSON.'
        },
        { role: 'user', content: signalPrompt }
      ], model === 'llama-3.3-70b-versatile');

      const parsed = parseJSON(raw);
      if (parsed?.signal && ['BUY','SELL','HOLD','NEUTRAL'].includes(parsed.signal)) {
        model1Result = parsed;
        model1Name = model;
        break;
      }
      console.error(`Model1 ${model} bad signal:`, raw?.slice(0, 100));
    } catch (e) {
      console.error(`Model1 ${model} failed:`, e.message);
    }
  }

  if (!model1Result) {
    return res.status(200).json({
      error: 'Signal generation failed — all models unavailable'
    });
  }

  // MODEL 2: Risk validator
  let riskCheck = null, m2Name = null;
  const riskPrompt = `You are a crypto risk analyst reviewing this trading signal:
Signal: ${model1Result.signal} | Confidence: ${model1Result.confidence}% | Risk: ${model1Result.risk}
Reasoning: ${model1Result.reasoning}
Market context: ${prompt.slice(0, 300)}

Respond ONLY with this JSON (no markdown):
{"agree":true,"adjusted_confidence":72,"risk_flags":["specific risk 1","specific risk 2"],"contrarian":"one sentence why signal could be wrong","final_recommendation":"CONFIRM"}

final_recommendation must be: CONFIRM, REDUCE, or INCREASE`;

  const m2candidates = ['gemma2-9b-it', 'llama-3.1-8b-instant', 'llama3-8b-8192'];
  for (const model of m2candidates) {
    try {
      const raw = await callGroq(KEY, model, [
        { role: 'user', content: riskPrompt }
      ]);
      const parsed = parseJSON(raw);
      if (parsed && parsed.final_recommendation) {
        riskCheck = parsed;
        m2Name = model;
        break;
      }
      console.error(`Risk model ${model} bad JSON:`, raw?.slice(0, 100));
    } catch (e) {
      console.error(`Risk model ${model} failed:`, e.message);
    }
  }

  // Merge confidence
  let finalConf = model1Result.confidence;
  if (riskCheck?.adjusted_confidence) {
    finalConf = Math.round((model1Result.confidence + riskCheck.adjusted_confidence) / 2);
  }
  if (riskCheck?.final_recommendation === 'REDUCE') finalConf = Math.max(40, finalConf - 10);
  if (riskCheck?.final_recommendation === 'INCREASE') finalConf = Math.min(95, finalConf + 5);

  // Build riskCheck in a consistent shape the frontend always expects
  const riskCheckForFrontend = riskCheck ? {
    agreed:         riskCheck.agree ?? true,
    verdict:        riskCheck.final_recommendation || 'CONFIRM',
    score:          riskCheck.adjusted_confidence
                      ? Math.round(100 - riskCheck.adjusted_confidence)
                      : 50,
    warnings:       riskCheck.risk_flags || [],
    flags:          riskCheck.risk_flags || [],
    contrarian:     riskCheck.contrarian || '',
    recommendation: riskCheck.final_recommendation || 'CONFIRM'
  } : null;

  const finalResult = {
    signal:      model1Result.signal,
    confidence:  finalConf,
    summary:     model1Result.summary || '',
    reasoning:   model1Result.reasoning || '',
    factors:     model1Result.factors || [],
    risk:        model1Result.risk || 'MEDIUM',
    risk_level:  model1Result.risk || 'MEDIUM',
    timeframe:   model1Result.timeframe || '3-7 days',
    stop_loss:   model1Result.stop_loss || null,
    take_profit: model1Result.take_profit || null,
    // riskCheck field — this is what the frontend renderSig() reads
    riskCheck:   riskCheckForFrontend,
    risk_check:  riskCheckForFrontend,
    models_used: [model1Name, m2Name].filter(Boolean),
    dual_model:  !!riskCheck,
    m1:          model1Name,
    m2:          m2Name || 'unavailable',
    engines: {
      primary:   model1Name,
      riskCheck: m2Name || 'unavailable'
    }
  };

  return res.status(200).json({ result: JSON.stringify(finalResult) });
}
