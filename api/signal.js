// api/signal.js - AI signal generation (Groq)
// Fixed: AbortSignal.timeout() replaced with fetchWithTimeout

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const SOSO_BASE = 'https://open-api.sosovalue.com/openapi/v1';

// Helper: fetch with timeout (Node.js 18 compatible)
function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!GROQ_API_KEY) {
    return res.status(500).json({ ok: false, error: 'GROQ_API_KEY missing' });
  }

  const { mode, symbol, prompt, marketContext } = req.body || {};

  try {
    let enrichedPrompt = prompt;
    let dataFreshness = 'N/A';
    let liveData = null;

    // ─── FETCH LIVE DATA FOR ALL MODES ──────────────────────────────────────
    if (mode === 'chat' || mode === 'signal') {
      try {
        const sosoKey = process.env.SOSO_API_KEY;
        const headers = { 'x-soso-api-key': sosoKey, 'Accept': 'application/json' };

        // Fetch prices
        const pricesRes = await fetchWithTimeout(`${SOSO_BASE}/currency/list`, { headers }, 5000);
        const pricesJson = await pricesRes.json();
        const currencies = pricesJson.data || [];

        const getPrice = async (sym) => {
          const c = currencies.find(x => x.symbol === sym);
          if (!c) return null;
          const r = await fetchWithTimeout(`${SOSO_BASE}/currency/${c.id}/market-snapshot`, { headers }, 5000);
          const j = await r.json();
          return j.data;
        };

        const [btc, eth] = await Promise.all([getPrice('BTC'), getPrice('ETH')]);

        // Fetch ETF
        const etfRes = await fetchWithTimeout(`${SOSO_BASE}/etf/summary`, { headers }, 5000);
        const etfJson = await etfRes.json();
        const etfData = etfJson.data || {};

        liveData = {
          btc: btc ? { price: btc.price, ch: btc.price_change_24h } : null,
          eth: eth ? { price: eth.price, ch: eth.price_change_24h } : null,
          etf: { totalNet: etfData.total_net_inflow || 0 },
          timestamp: new Date().toUTCString()
        };

        dataFreshness = liveData.timestamp;
      } catch (e) {
        console.error('[signal] Live data fetch failed:', e.message);
        liveData = null;
      }
    }

    // ─── BUILD ENRICHED PROMPT ──────────────────────────────────────────────
    if (mode === 'chat' && prompt) {
      const dataBlock = liveData
        ? `LIVE MARKET DATA (as of ${liveData.timestamp}):
- BTC: $${liveData.btc?.price || 'N/A'} (${liveData.btc?.ch > 0 ? '+' : ''}${liveData.btc?.ch || 0}% 24h)
- ETH: $${liveData.eth?.price || 'N/A'} (${liveData.eth?.ch > 0 ? '+' : ''}${liveData.eth?.ch || 0}% 24h)
- ETF Total Net Inflow: $${(liveData.etf?.totalNet / 1e6).toFixed(2) || 0}M

CRITICAL: Use ONLY the above live data for your analysis. NEVER use training data prices.
If live data shows "N/A", explicitly state that data is unavailable.

USER QUESTION: ${prompt}`
        : `[DATA UNAVAILABLE - PROVIDING GENERAL ANALYSIS ONLY]\n\nUSER QUESTION: ${prompt}`;

      enrichedPrompt = dataBlock;
    }

    // ─── SIGNAL MODE ──────────────────────────────────────────────────────────
    if (mode === 'signal') {
      const ctx = marketContext || {};
      enrichedPrompt = `Analyze ${symbol} with LIVE data:
- Price: $${ctx.price || 'N/A'}
- 24h Change: ${ctx.change || 0}%
- 24h Volume: $${ctx.volume || 0}B
- Market Cap: $${ctx.mcap || 0}B
- RSI (14): ${ctx.rsi || 'N/A'}
- MACD: ${ctx.macd || 'N/A'}
- 50-day MA: $${ctx.ma50 || 'N/A'}
- ETF Net Inflow: $${ctx.etfFlow || 0}M
- Sector Signal: ${ctx.sector || 'N/A'}

Provide trading signal (BUY/SELL/HOLD) with specific numbers. Be concise.`;
    }

    const messages = [
      {
        role: 'system',
        content: 'You are an expert crypto analyst. You MUST use only the live data provided. Never hallucinate prices. Keep under 150 words.'
      },
      { role: 'user', content: enrichedPrompt }
    ];

    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        messages,
        temperature: 0.3,
        max_tokens: 300
      })
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      throw new Error(`Groq API error ${groqRes.status}: ${err}`);
    }

    const groqData = await groqRes.json();
    const text = groqData.choices?.[0]?.message?.content || 'No response';

    const signal = text.toUpperCase().includes('BUY') ? 'BUY' :
      text.toUpperCase().includes('SELL') ? 'SELL' : 'HOLD';

    // Try to save to Redis (non-blocking)
    try {
      const { Redis } = await import('@upstash/redis');
      if (process.env.UPSTASH_REDIS_REST_URL) {
        const redis = new Redis({
          url: process.env.UPSTASH_REDIS_REST_URL,
          token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });
        await redis.lpush(`signals:${symbol || 'chat'}`, JSON.stringify({
          signal, text, timestamp: Date.now(), mode
        }));
      }
    } catch (redisErr) {
      console.warn('[signal] Redis save failed (non-critical):', redisErr.message);
    }

    return res.json({
      ok: true,
      signal,
      text,
      dataFreshness,
      liveDataInjected: !!liveData,
      mode: mode || 'unknown',
      timestamp: Date.now()
    });

  } catch (e) {
    console.error('[signal] Handler error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
