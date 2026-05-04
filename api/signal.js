const GROQ = 'https://api.groq.com/openai/v1/chat/completions';

async function callGroq(key, model, messages, jsonMode = false) {
  const body = { model, max_tokens: 600, temperature: 0.2, messages };
  // Only llama-3.3-70b-versatile supports json_object mode
  if (jsonMode && model === 'llama-3.3-70b-versatile') {
    body.response_format = { type: 'json_object' };
  }
  const r = await fetch(GROQ, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Groq ${model}: HTTP ${r.status} — ${err.slice(0, 120)}`);
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
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

  // Simple chat / analysis — single model
  if (mode === 'chat' || mode === 'analyze') {
    try {
      const result = await callGroq(KEY, 'llama-3.3-70b-versatile', [
        { role: 'system', content: 'You are OnchainEdge AI, a professional crypto market analyst. Be concise, direct, and data-driven. Max 3 sentences.' },
        { role: 'user', content: prompt }
      ]);
      return res.status(200).json({ result });
    } catch (e) {
      // Fallback to smaller model
      try {
        const result = await callGroq(KEY, 'llama3-8b-8192', [
          { role: 'system', content: 'You are a crypto analyst. Be concise.' },
          { role: 'user', content: prompt }
        ]);
        return res.status(200).json({ result });
      } catch (e2) {
        return res.status(500).json({ error: e2.message });
      }
    }
  }

  // DUAL-MODEL SIGNAL GENERATION
  // Model 1: Primary analyst (llama-3.3-70b) — generates signal
  // Model 2: Risk checker (llama3-8b) — validates and adjusts confidence
  try {
    const signalPrompt = `You are a professional crypto trading analyst with access to live market data.

${prompt}

Respond ONLY with this exact JSON (no markdown):
{"signal":"BUY","confidence":72,"summary":"one sentence verdict","reasoning":"2-3 sentences using the actual data provided","factors":["factor with data point","factor with data point","factor with data point"],"risk":"MEDIUM","timeframe":"3-7 days","stop_loss":"-5%","take_profit":"+8%"}`;

    let model1Result = null;
    let model1Error = null;

    // Try Model 1: llama-3.3-70b-versatile with json_object
    try {
      const raw = await callGroq(KEY, 'llama-3.3-70b-versatile', [
        { role: 'system', content: 'You are a professional crypto trading analyst. Always respond with valid JSON only. No markdown code blocks.' },
        { role: 'user', content: signalPrompt }
      ], true);
      const clean = raw.replace(/```json|```/g, '').trim();
      model1Result = JSON.parse(clean);
    } catch (e) {
      model1Error = e.message;
      console.error('Model 1 failed:', e.message);

      // Fallback Model 1b: llama3-8b-8192
      try {
        const raw = await callGroq(KEY, 'llama3-8b-8192', [
          { role: 'system', content: 'Crypto analyst. Respond ONLY with valid JSON object. No markdown.' },
          { role: 'user', content: signalPrompt }
        ]);
        const clean = raw.replace(/```json|```/g, '').trim();
        model1Result = JSON.parse(clean);
        model1Error = null;
      } catch (e2) {
        console.error('Model 1b failed:', e2.message);
      }
    }

    if (!model1Result) {
      return res.status(200).json({ error: 'Signal generation failed', model1Error });
    }

    // Model 2: Risk validation — gemma2-9b-it checks the signal
    let riskCheck = null;
    try {
      const riskPrompt = `You are a crypto risk analyst reviewing a trading signal for second opinion.

Signal to review:
- Asset signal: ${model1Result.signal}
- Confidence: ${model1Result.confidence}%
- Reasoning: ${model1Result.reasoning}
- Risk level: ${model1Result.risk}

Context from market data in the original prompt:
${prompt.slice(0, 400)}

Respond ONLY with this JSON (no markdown):
{"agree":true,"adjusted_confidence":72,"risk_flags":["flag1","flag2"],"contrarian":"one contrarian consideration","final_recommendation":"CONFIRM or REDUCE or INCREASE"}`;

      const riskRaw = await callGroq(KEY, 'gemma2-9b-it', [
        { role: 'user', content: riskPrompt }
      ]);
      const clean = riskRaw.replace(/```json|```/g, '').trim();
      riskCheck = JSON.parse(clean);
    } catch (e) {
      console.error('Risk model failed (non-critical):', e.message);
    }

    // Merge results — average confidence if risk model disagrees
    let finalConf = model1Result.confidence;
    if (riskCheck?.adjusted_confidence) {
      finalConf = Math.round((model1Result.confidence + riskCheck.adjusted_confidence) / 2);
    }

    // If risk model says REDUCE — lower confidence
    if (riskCheck?.final_recommendation === 'REDUCE') {
      finalConf = Math.max(45, finalConf - 10);
    } else if (riskCheck?.final_recommendation === 'INCREASE') {
      finalConf = Math.min(92, finalConf + 5);
    }

    const finalResult = {
      ...model1Result,
      confidence: finalConf,
      risk_check: riskCheck ? {
        agreed: riskCheck.agree,
        flags: riskCheck.risk_flags || [],
        contrarian: riskCheck.contrarian || '',
        recommendation: riskCheck.final_recommendation || 'CONFIRM'
      } : null,
      models_used: riskCheck ? ['llama-3.3-70b-versatile (primary)', 'gemma2-9b-it (risk validator)'] : ['llama-3.3-70b-versatile'],
      dual_model: !!riskCheck
    };

    return res.status(200).json({ result: JSON.stringify(finalResult) });

  } catch (e) {
    console.error('Signal handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
