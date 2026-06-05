// SoDEX WebSocket Proxy — Real-time price feed via WebSocket
// Bridges SoDEX WS to frontend via Server-Sent Events (SSE) for Vercel compatibility

const TESTNET_WS = 'wss://testnet-gw.sodex.dev/ws/spot';
const MAINNET_WS = 'wss://mainnet-gw.sodex.dev/ws/spot';

export default async function handler(req, res) {
  // SSE endpoint for real-time prices
  if (req.query.stream === 'prices') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const isTestnet = req.query.testnet === '1';
    const wsUrl = isTestnet ? TESTNET_WS : MAINNET_WS;
    const symbols = req.query.symbols ? req.query.symbols.split(',') : ['BTC_USDC', 'ETH_USDC', 'SOL_USDC', 'BNB_USDC'];

    let ws = null;
    let heartbeat = null;
    let reconnectAttempts = 0;
    const maxReconnects = 5;

    const connect = () => {
      try {
        ws = new WebSocket(wsUrl);

        ws.on('open', () => {
          reconnectAttempts = 0;
          // Subscribe to tickers
          ws.send(JSON.stringify({
            op: 'subscribe',
            args: symbols.map(s => `ticker:${s}`)
          }));
          // Heartbeat
          heartbeat = setInterval(() => {
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ op: 'ping' }));
            }
          }, 15000);
        });

        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data);
            if (msg.topic && msg.topic.startsWith('ticker:')) {
              const ticker = msg.data;
              const payload = {
                symbol: ticker.symbol,
                lastPrice: ticker.lastPrice || ticker.lastPx,
                priceChange: ticker.changePct24h || ticker.changePct || 0,
                volume: ticker.volume24h || ticker.volume || 0,
                high24h: ticker.high24h || ticker.high || 0,
                low24h: ticker.low24h || ticker.low || 0,
                timestamp: Date.now(),
                source: isTestnet ? 'sodex-ws-testnet' : 'sodex-ws-mainnet'
              };
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
            }
          } catch (e) {
            // Ignore non-JSON messages (pong, etc.)
          }
        });

        ws.on('error', (err) => {
          console.error('WS error:', err.message);
        });

        ws.on('close', () => {
          clearInterval(heartbeat);
          if (reconnectAttempts < maxReconnects) {
            reconnectAttempts++;
            setTimeout(connect, 2000 * reconnectAttempts);
          }
        });

      } catch (e) {
        console.error('WS connect failed:', e.message);
        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      }
    };

    connect();

    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      if (ws) {
        try { ws.close(); } catch (e) {}
      }
    });

    return;
  }

  // REST fallback: get latest snapshot from WS connection
  if (req.query.snapshot === '1') {
    const isTestnet = req.query.testnet === '1';
    const wsUrl = isTestnet ? TESTNET_WS : MAINNET_WS;

    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      const prices = {};
      let timeout = null;

      ws.on('open', () => {
        ws.send(JSON.stringify({
          op: 'subscribe',
          args: ['ticker:BTC_USDC', 'ticker:ETH_USDC', 'ticker:SOL_USDC', 'ticker:BNB_USDC']
        }));
        timeout = setTimeout(() => {
          ws.close();
          resolve(res.json({ ok: true, data: prices, source: 'sodex-ws', updatedAt: Date.now() }));
        }, 3000);
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.topic && msg.topic.startsWith('ticker:')) {
            const sym = msg.topic.replace('ticker:', '');
            prices[sym] = {
              lastPrice: msg.data.lastPrice || msg.data.lastPx,
              priceChange: msg.data.changePct24h || msg.data.changePct || 0,
              volume: msg.data.volume24h || msg.data.volume || 0,
              timestamp: Date.now()
            };
          }
        } catch (e) {}
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve(res.status(500).json({ ok: false, error: 'WebSocket connection failed' }));
      });

      ws.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  res.status(400).json({ ok: false, error: 'Use ?stream=prices for SSE or ?snapshot=1 for REST' });
}
