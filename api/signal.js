// AI Signal Engine — Groq dual-model with real data validation
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_KEY = process.env.GROQ_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  if (!GROQ_KEY) return res.status(500).json({ ok: false, error: 'GROQ_API_KEY missing' });

  try {
    const { asset, price, etfFlow, ssiChange, source } = req.body;

    // Validate we have REAL data, not fake static fallback ($63950 is known fake)
    if (!price || price <= 0 || price === 63950) {
      return res.status(200).json({
        ok: false,
        error: 'No live price data available for signal generation. Price sources may be rate-limited.',
        retryAfter: 60,
        hint: 'Wait for price data to load before generating signals'
      });
    }

    if (!etfFlow && etfFlow !== 0) {
      return res.status(200).json({
        ok: false,
        error: 'No ETF flow data available for signal generation',
        retryAfter: 300
      });
    }

    const prompt = buildPrompt(asset, price, etfFlow, ssiChange, source);

    // Primary model
    const m1 = await groqCall('llama-3.3-70b-versatile', prompt, 0.3);
    const model1Result = parseSignal(m1);

    // Risk validation model
    const riskPrompt = buildRiskPrompt(model1Result, asset, price);
    const m2 = await groqCall('llama-3.1-8b-instant', riskPrompt, 0.2);
    const riskCheck = parseRisk(m2);

    // Confidence fusion
    let finalConf = model1Result.confidence;
    if (riskCheck?.adjusted_confidence) {
      finalConf = Math.round(model1Result.confidence * 0.6 + riskCheck.adjusted_confidence * 0.4);
    }
    if (riskCheck?.final_recommendation === 'REDUCE') finalConf = Math.max(35, finalConf - 12);
    if (riskCheck?.final_recommendation === 'INCREASE') finalConf = Math.min(95, finalConf + 8);
    if (riskCheck?.agree === false) finalConf = Math.max(30, finalConf - 20);

    const result = {
      ok: true,
      signal: model1Result.signal,
      confidence: finalConf,
      entry: price,
      stopLoss: Math.round(price * 0.95),
      takeProfit: Math.round(price * 1.05),
      timeframe: '24h',
      source: source || 'multi-source',
      models: {
        primary: { model: 'llama-3.3-70b', confidence: model1Result.confidence },
        risk: { model: 'llama-3.1-8b', agree: riskCheck?.agree, riskScore: riskCheck?.risk_score }
      }
    };

    // Save to Redis if available
    try {
      const { Redis } = await import('@upstash/redis');
      const redis = Redis.fromEnv();
      await redis.lpush('signals', JSON.stringify({ ...result, timestamp: Date.now(), asset }));
      await redis.ltrim('signals', 0, 499);
    } catch (e) {
      console.log('Redis not configured, signal not persisted');
    }

    return res.json(result);

  } catch (e) {
    console.error('Signal error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}

async function groqCall(model, content, temp) {
  const r = await fetch(GROQ_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      temperature: temp,
      max_tokens: 800,
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(30000)
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '{}';
}

function buildPrompt(asset, price, etfFlow, ssiChange, source) {
  return `You are an institutional-grade crypto analyst. Analyze ${asset} based on:
- Current price: $${price} (source: ${source || 'live'})
- ETF net flow: $${etfFlow}M
- SSI sector change: ${ssiChange || 'N/A'}%

Return ONLY valid JSON:
{
  "signal": "BUY|SELL|HOLD|NEUTRAL",
  "confidence": 0-100,
  "reasoning": "brief analysis",
  "risk": "low|medium|high",
  "timeframe": "24h"
}`;
}

function buildRiskPrompt(primary, asset, price) {
  return `Review this ${asset} signal at $${price}:
- Primary signal: ${primary.signal} at ${primary.confidence}% confidence
- Reasoning: ${primary.reasoning || 'N/A'}

Return ONLY valid JSON:
{
  "agree": true|false,
  "adjusted_confidence": 0-100,
  "risk_score": 0-100,
  "final_recommendation": "AGREE|REDUCE|INCREASE",
  "contrarian": "brief contrarian view"
}`;
}

function parseSignal(text) {
  try {
    const j = JSON.parse(text);
    return {
      signal: j.signal || 'NEUTRAL',
      confidence: Math.min(100, Math.max(0, parseInt(j.confidence) || 50)),
      reasoning: j.reasoning || '',
      risk: j.risk || 'medium',
      timeframe: j.timeframe || '24h'
    };
  } catch (e) {
    return { signal: 'NEUTRAL', confidence: 50, reasoning: '', risk: 'medium', timeframe: '24h' };
  }
}

function parseRisk(text) {
  try {
    const j = JSON.parse(text);
    return {
      agree: j.agree !== false,
      adjusted_confidence: parseInt(j.adjusted_confidence) || 50,
      risk_score: parseInt(j.risk_score) || 50,
      final_recommendation: j.final_recommendation || 'AGREE',
      contrarian: j.contrarian || ''
    };
  } catch (e) {
    return { agree: true, adjusted_confidence: 50, risk_score: 50, final_recommendation: 'AGREE' };
  }
}
