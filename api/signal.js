// In your existing signal.js, update the system prompt to include:

const SYSTEM_PROMPT_PRIMARY = `You are an institutional crypto trading analyst.
You receive REAL data from SoSoValue's institutional API:
- SoSoValue ETF Flows (BTC ETF net inflows)
- SoSoValue SSI Indexes (sector momentum)
- SoSoValue BTC Treasury Holdings (institutional accumulation)
- SoSoValue Currency Snapshots (live prices)
- Fear & Greed Index
- Latest news headlines

Generate a trading signal with:
- action: BUY/SELL/HOLD
- confidence: 0-100
- entry, stopLoss, takeProfit prices
- reasoning: 2-3 sentences citing SoSoValue data specifically

Return valid JSON only.`;

// In the audit trail object, ensure you include:
const auditTrail = {
  dataIngested: [
    { source: 'SoSoValue ETF Flows', value: `Net: $${etfTotal/1e6}M`, status: 'live' },
    { source: 'SoSoValue SSI Indexes', value: `Top: ${topSSI}`, status: 'live' },
    { source: 'SoSoValue BTC Treasuries', value: `${treasuryTotal} BTC held`, status: 'live' },
    { source: 'SoSoValue Prices', value: `BTC $${btcPrice}`, status: 'live' },
    { source: 'Fear & Greed', value: fearGreed, status: 'live' },
    { source: 'News Sentiment', value: newsScore, status: 'live' }
  ],
  primaryAnalysis: { model: 'llama-3.3-70b-versatile', ... },
  riskCheck: { model: 'gemma2-9b-it', ... }
};
