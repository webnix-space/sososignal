// SoDEX Trading API — Fixed integer types for order submission
const SPOT_BASE = 'https://mainnet-gw.sodex.dev/api/v1/spot';
const TESTNET_BASE = 'https://testnet-gw.sodex.dev/api/v1/spot';

// Order type mapping: string → integer
const ORDER_TYPES = {
  'LIMIT': 1,
  'MARKET': 2
};

const TIF_TYPES = {
  'GTC': 1,
  'IOC': 2,
  'GTX': 3
};

const SIDE_TYPES = {
  'BUY': 1,
  'SELL': 2
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const { accountID, symbolID, orders, apiKey, apiSign, apiNonce, testnet } = req.body;

    if (!accountID || !symbolID || !orders || !Array.isArray(orders)) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    const base = testnet ? TESTNET_BASE : SPOT_BASE;

    // Convert string types to integers
    const formattedOrders = orders.map(o => {
      const orderType = ORDER_TYPES[o.type?.toUpperCase()] || o.type;
      const tif = TIF_TYPES[o.timeInForce?.toUpperCase()] || o.timeInForce;
      const side = SIDE_TYPES[o.side?.toUpperCase()] || o.side;

      const formatted = {
        clOrdID: o.clOrdID || `oe-${Date.now()}`,
        side: Number(side),
        type: Number(orderType),
        timeInForce: Number(tif),
        quantity: String(o.quantity || '0'),
        reduceOnly: Boolean(o.reduceOnly),
        positionSide: Number(o.positionSide || 1)
      };

      // Add price for limit orders only
      if (Number(orderType) === 1 && o.price) {
        formatted.price = String(o.price);
      }

      return formatted;
    });

    const payload = {
      accountID: Number(accountID),
      symbolID: Number(symbolID),
      orders: formattedOrders
    };

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-API-Key': apiKey || '',
      'X-API-Sign': apiSign || '',
      'X-API-Nonce': String(apiNonce || Date.now())
    };

    const r = await fetch(`${base}/trade/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });

    const data = await r.json();
    return res.status(r.status).json({ ok: r.ok, data, status: r.status });

  } catch (e) {
    console.error('Trade error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
