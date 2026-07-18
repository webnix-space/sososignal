// SoDEX WebSocket → SSE Bridge
// Same response format, proper SSE with heartbeat
const SPOT_WS = 'wss://mainnet-gw.sodex.dev/ws/spot';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { stream, snapshot } = req.query;

  if (stream === 'prices') {
    // SSE stream — single long-lived connection
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let ws = null;
    let heartbeat = null;
    let reconnectCount = 0;
    const maxReconnect = 3;

    const connect = () => {
      try {
        ws = new WebSocket(SPOT_WS);

        ws.onopen = () => {
          reconnectCount = 0;
          ws.send(JSON.stringify({
            op: 'subscribe',
            args: ['ticker:BTC_USDC', 'ticker:ETH_USDC', 'ticker:SOL_USDC', 'ticker:BNB_USDC']
          }));
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.topic && data.data) {
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            }
          } catch (e) {}
        };

        ws.onerror = (e) => {
          console.error('WS error:', e.message);
        };

        ws.onclose = () => {
          if (reconnectCount < maxReconnect) {
            reconnectCount++;
            setTimeout(connect, 3000 * reconnectCount);
          } else {
            res.write(`data: ${JSON.stringify({ error: 'WebSocket disconnected', retryAfter: 10 })}\n\n`);
            res.end();
          }
        };

        // Heartbeat every 30s
        heartbeat = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 'ping' }));
          }
        }, 30000);

      } catch (e) {
        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        res.end();
      }
    };

    connect();

    req.on('close', () => {
      clearInterval(heartbeat);
      if (ws) ws.close();
    });

  } else if (snapshot === '1') {
    // REST snapshot fallback
    try {
      const r = await fetch('https://mainnet-gw.sodex.dev/api/v1/spot/markets/tickers', {
        signal: AbortSignal.timeout(3000)
      });
      if (r.ok) {
        const data = await r.json();
        return res.json({ ok: true, data: data.data, source: 'sodex-rest' });
      }
    } catch (e) {}
    return res.status(503).json({ ok: false, error: 'WebSocket unavailable', retryAfter: 10 });

  } else {
    // Default: return current tickers via REST
    try {
      const r = await fetch('https://mainnet-gw.sodex.dev/api/v1/spot/markets/tickers', {
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) {
        const raw = await r.json();
        const items = raw?.data || [];
        const parsed = items
          .map(t => {
            const price = parseFloat(t.lastPx);
            if (!isFinite(price) || price <= 0) return null;
            const rawSym = t.symbol || '';
            const displaySym = rawSym.replace(/^v/, '').replace(/_vUSDC$/, '/USDC').replace(/_v/, '/');
            return {
              symbol: displaySym || rawSym,
              lastPrice: String(price),
              priceChange: String((parseFloat(t.changePct || 0)).toFixed(2)),
              volume: String(Math.round(parseFloat(t.volume || 0))),
              quoteVolume: String(Math.round(parseFloat(t.quoteVolume || 0))),
              source: 'sodex-live'
            };
          })
          .filter(x => x);
        return res.json({ ok: true, data: parsed, source: 'sodex-live', pairCount: parsed.length });
      }
    } catch (e) {}
    return res.status(503).json({ ok: false, error: 'SoDEX unavailable', retryAfter: 10 });
  }
}
