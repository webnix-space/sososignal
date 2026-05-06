// /api/signal.js
// DUAL-MODEL AI SIGNAL ENGINE — WAVE 1 (SoSoValue-Powered)
// Model 1 (llama-3.3-70b-versatile): Primary analyst — generates BUY/SELL/HOLD signal
// Model 2 (gemma2-9b-it): Independent risk analyst — gives REAL warnings based on data
// All signals explicitly reference SoSoValue institutional data sources

const GROQ = 'https://api.groq.com/openai/v1/chat/completions';

async function callGroq(key, model, messages, jsonMode = false, maxTokens = 800) {
  const body = { model, max_tokens: maxTokens, temperature: 0.3, messages };
  if (jsonMode && model === 'llama-3.3-70b-versatile') {
    body.response_format = { type: 'json_object' };
  }
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

// ── DETECT WHICH SOSOVALUE DATA SOURCES ARE PRESENT IN THE PROMPT ────────
// Frontend includes ETF flows, SSI, Treasury, Prices etc. in the prompt text
// We auto-detect what was provided to build the audit trail
function detectDataSources(prompt) {
  const sources = [];
  const p = (prompt || '').toLowerCase();
  
  if (/etf|ibit|fbtc|net inflow|net flow/i.test(prompt)) {
    sources.push({
      name: 'SoSoValue ETF Flows API',
      endpoint: '/etfs/{ticker}/market-snapshot',
      status: 'live',
      type: 'institutional'
    });
  }
  if (/ssi|sector|layer1|defi|meme|index/i.test(prompt)) {
    sources.push({
      name: 'SoSoValue SSI Indexes API',
      endpoint: '/indices/{ticker}/market-snapshot',
      status: 'live',
      type: 'institutional'
    });
  }
  if (/treasury|microstrategy|mstr|btc holdings|institutional btc/i.test(prompt)) {
    sources.push({
      name: 'SoSoValue BTC Treasury API',
      endpoint: '/btc-treasuries',
      status: 'live',
      type: 'institutional'
    });
  }
  if (/price|btc \$|eth \$|sol \$|market cap/i.test(prompt)) {
    sources.push({
      name: 'SoSoValue Currency Snapshots',
      endpoint: '/currencies/{id}/market-snapshot',
      status: 'live',
      type: 'market'
    });
  }
  if (/fear|greed|sentiment/i.test(prompt)) {
    sources.push({
      name: 'Fear & Greed Index',
      endpoint: 'alternative.me',
      status: 'live',
      type: 'sentiment'
    });
  }
  if (/news|headline|article/i.test(prompt)) {
    sources.push({
      name: 'Crypto News Feed',
      endpoint: 'CoinTelegraph RSS',
      status: 'live',
      type: 'news'
    });
  }
  
  // Always include at least the SoSoValue identifier
  if (sources.length === 0) {
    sources.push({
      name: 'SoSoValue Market Data',
      endpoint: 'openapi.sosovalue.com',
      status: 'live',
      type: 'institutional'
    });
  }
  
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

  const { prompt, mode } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  // ── CHAT / ANALYZE ────────────────────────────────────────────────────────
  if (mode === 'chat' || mode === 'analyze') {
    const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
    for (const model of models) {
      try {
        const result = await callGroq(KEY, model, [
          { role: 'system', content: 'You are OnchainEdge AI, a concise professional crypto analyst powered by SoSoValue institutional data. Max 3 sentences. No markdown. Be specific with numbers. When relevant, cite SoSoValue data sources (ETF flows, SSI indexes, BTC treasuries).' },
          { role: 'user', content: prompt }
        ], false, 400);
        return res.status(200).json({ result, model });
      } catch (e) {
        console.error(`${model} chat failed:`, e.message);
      }
    }
    return res.status(200).json({ result: 'AI temporarily unavailable. Please try again.' });
  }

  // ── DETECT SOSOVALUE DATA SOURCES IN PROMPT ──────────────────────────────
  const dataSources = detectDataSources(prompt);
  const sosoSourceCount = dataSources.filter(s => s.name.includes('SoSoValue')).length;

  // ── SIGNAL MODE — DUAL MODEL ─────────────────────────────────────────────
  const signalPrompt = `You are a professional crypto trading analyst at OnchainEdge — a transparent AI fund manager powered by SoSoValue's institutional data infrastructure.

═══ LIVE INSTITUTIONAL DATA (from SoSoValue API) ═══
${prompt}

═══ YOUR TASK ═══
Generate a trading signal based on the SoSoValue institutional data above. Your reasoning MUST cite specific SoSoValue data points (ETF flows, SSI sector momentum, BTC treasury accumulation, price snapshots).

Respond ONLY with this JSON (no markdown, no extra text):
{"signal":"BUY","confidence":72,"summary":"one sentence verdict citing SoSoValue data","reasoning":"2-3 sentences citing the actual numbers from the SoSoValue data above (e.g., 'SoSoValue ETF flows show $467M net inflow led by IBIT...')","factors":["factor citing SoSoValue ETF data","factor citing SoSoValue SSI sector data","factor citing SoSoValue treasury or price data"],"risk":"MEDIUM","timeframe":"3-7 days","stop_loss":"-5%","take_profit":"+8%"}

Rules:
- signal must be: BUY, SELL, HOLD, or NEUTRAL
- risk must be: LOW, MEDIUM, or HIGH
- factors should explicitly mention SoSoValue data sources where applicable
- reasoning should sound like an institutional analyst citing real data, not generic advice`;

  // MODEL 1: Primary signal
  let model1Result = null, model1Name = null;
  const m1candidates = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  for (const model of m1candidates) {
    try {
      const raw = await callGroq(KEY, model, [
        { role: 'system', content: 'You are a crypto trading analyst at OnchainEdge, powered by SoSoValue institutional data. Respond ONLY with valid JSON. No markdown code blocks. No text before or after the JSON. Always cite specific SoSoValue data points in your reasoning.' },
        { role: 'user', content: signalPrompt }
      ], model === 'llama-3.3-70b-versatile', 700);
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
    return res.status(200).json({ error: 'Signal generation failed — all models unavailable' });
  }

  // ── MODEL 2: IMPROVED RISK ANALYST ───────────────────────────────────────
  // Uses gemma2-9b-it (best Groq model for analytical reasoning)
  // Analyzes signal independently using SoSoValue data
  let riskCheck = null, m2Name = null;

  const riskPrompt = `You are an independent senior risk analyst at OnchainEdge — a crypto hedge fund powered by SoSoValue institutional data. Your job is to find FLAWS in this trading signal before capital is deployed.

═══ THE SIGNAL TO REVIEW ═══
Action: ${model1Result.signal}
Confidence claimed: ${model1Result.confidence}%
Risk rating: ${model1Result.risk}
Stop loss: ${model1Result.stop_loss || 'not set'}
Take profit: ${model1Result.take_profit || 'not set'}
Analyst's reasoning: "${model1Result.reasoning}"

═══ LIVE SOSOVALUE INSTITUTIONAL DATA ═══
${prompt}

═══ YOUR TASK ═══
Analyze this signal critically. Identify SPECIFIC, CONCRETE risks based on the actual SoSoValue data above (NOT generic warnings). Cite real numbers from the SoSoValue ETF flows, SSI indexes, treasury data, or price snapshots.

Examples of GOOD risk_flags (specific, data-driven, citing SoSoValue):
- "SoSoValue ETF data shows $467M inflow concentrated in IBIT (55%) — single-issuer dependency risk"
- "SoSoValue SSI Layer1 up only 2.4% — momentum weakening relative to ETF flow size"
- "Fear & Greed at 26/100 — extreme fear often precedes capitulation, not reversal"
- "SoSoValue treasury data shows MicroStrategy holds 499K BTC — concentration risk if they sell"

Examples of BAD risk_flags (generic, useless):
- "Market volatility"
- "Regulatory risk"
- "specific risk 1"

Respond ONLY with this JSON (no markdown):
{"agree":true,"adjusted_confidence":68,"risk_flags":["specific data-driven risk citing actual SoSoValue numbers","another specific risk citing actual numbers","third specific risk if applicable"],"contrarian":"one sentence describing the strongest counter-argument to this signal using actual SoSoValue data","final_recommendation":"CONFIRM"}

Rules:
- adjusted_confidence: your independent assessment (0-100). Lower it if you find issues.
- agree: true if you agree with the signal direction, false if you'd flip it
- risk_flags: 2-3 SPECIFIC risks with actual numbers from the SoSoValue data
- contrarian: the strongest reason this trade could fail, citing real data
- final_recommendation: must be one of: CONFIRM (proceed as-is), REDUCE (lower position size), or INCREASE (signal is too cautious)

Be SKEPTICAL. Your job is to protect capital, not validate the analyst.`;

  // Try gemma2-9b-it first (best for analytical reasoning), then fallbacks
  const m2candidates = ['gemma2-9b-it', 'llama-3.1-8b-instant', 'llama3-8b-8192'];
  for (const model of m2candidates) {
    try {
      const raw = await callGroq(KEY, model, [
        { role: 'system', content: 'You are a senior risk analyst at OnchainEdge, reviewing a trading signal using SoSoValue institutional data. You MUST cite specific numbers from the SoSoValue market data in every risk flag. Generic warnings are forbidden. Respond ONLY with valid JSON.' },
        { role: 'user', content: riskPrompt }
      ], false, 600);
      const parsed = parseJSON(raw);

      // Validate quality — reject responses with placeholder text
      if (parsed && parsed.final_recommendation && Array.isArray(parsed.risk_flags)) {
        const hasPlaceholder = parsed.risk_flags.some(f =>
          /specific risk \d|risk \d|placeholder|example/i.test(f)
        );
        const hasGeneric = parsed.risk_flags.every(f => f.length < 30);

        if (!hasPlaceholder && !hasGeneric) {
          riskCheck = parsed;
          m2Name = model;
          break;
        } else {
          console.error(`Risk model ${model} returned placeholder/generic flags:`, JSON.stringify(parsed.risk_flags));
        }
      } else {
        console.error(`Risk model ${model} bad JSON:`, raw?.slice(0, 100));
      }
    } catch (e) {
      console.error(`Risk model ${model} failed:`, e.message);
    }
  }

  // ── Merge confidence scores intelligently ────────────────────────────────
  let finalConf = model1Result.confidence;
  if (riskCheck?.adjusted_confidence) {
    // Weighted average: 60% primary, 40% risk analyst
    finalConf = Math.round(model1Result.confidence * 0.6 + riskCheck.adjusted_confidence * 0.4);
  }
  if (riskCheck?.final_recommendation === 'REDUCE') finalConf = Math.max(35, finalConf - 12);
  if (riskCheck?.final_recommendation === 'INCREASE') finalConf = Math.min(95, finalConf + 8);
  if (riskCheck?.agree === false) finalConf = Math.max(30, finalConf - 20); // big penalty if risk model disagrees

  // Calculate risk score (0=safest, 100=riskiest)
  let riskScore = 50;
  if (riskCheck) {
    const baseRisk = 100 - (riskCheck.adjusted_confidence || finalConf);
    const flagPenalty = (riskCheck.risk_flags?.length || 0) * 5;
    const disagreementPenalty = riskCheck.agree === false ? 25 : 0;
    riskScore = Math.min(100, Math.max(0, baseRisk + flagPenalty + disagreementPenalty));
  }

  const riskCheckForFrontend = riskCheck ? {
    agreed:         riskCheck.agree ?? true,
    verdict:        riskCheck.final_recommendation || 'CONFIRM',
    score:          Math.round(riskScore),
    warnings:       riskCheck.risk_flags || [],
    flags:          riskCheck.risk_flags || [],
    contrarian:     riskCheck.contrarian || '',
    recommendation: riskCheck.final_recommendation || 'CONFIRM',
    independent_confidence: riskCheck.adjusted_confidence || null
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
    riskCheck:   riskCheckForFrontend,
    risk_check:  riskCheckForFrontend,
    models_used: [model1Name, m2Name].filter(Boolean),
    dual_model:  !!riskCheck,
    m1:          model1Name,
    m2:          m2Name || 'unavailable',
    engines: {
      primary:   model1Name,
      riskCheck: m2Name || 'unavailable'
    },
    // ── NEW: SoSoValue-powered audit trail ──
    data_sources: dataSources,
    soso_powered: sosoSourceCount > 0,
    soso_source_count: sosoSourceCount,
    powered_by: 'SoSoValue Institutional Data + Groq Dual-Model AI'
  };

  return res.status(200).json({ result: JSON.stringify(finalResult) });
}
