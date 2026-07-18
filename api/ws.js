// SoDEX WebSocket → SSE Bridge
// Single long-lived connection, no polling
const SPOT_WS = 'wss://mainnet-gw.sodex.dev/ws/spot';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { stream } = req.query;

  if (stream === 'prices') {
    // SSE stream
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

        // Heartbeat
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

  } else {
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
  }
}
