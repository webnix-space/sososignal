// SoDEX Real Trading API — EIP-712 signed orders on Testnet
// Supports: newOrder, cancelOrder, getAccountState, addAPIKey

const TESTNET_SPOT = 'https://testnet-gw.sodex.dev/api/v1/spot';
const TESTNET_PERPS = 'https://testnet-gw.sodex.dev/api/v1/perps';

// EIP-712 Domain for testnet spot
const SPOT_DOMAIN = {
  name: "spot",
  version: "1",
  chainId: 138565,  // TESTNET
  verifyingContract: "0x0000000000000000000000000000000000000000"
};

const EIP712_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" }
  ],
  ExchangeAction: [
    { name: "payloadHash", type: "bytes32" },
    { name: "nonce", type: "uint64" }
  ]
};

// Keccak256 helper (using ethers.js or built-in)
function keccak256(data) {
  // In production, use ethers.utils.keccak256 or crypto.createHash
  // This is a placeholder — the frontend will compute this with ethers.js
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-API-Sign, X-API-Nonce');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── GET ACCOUNT STATE ──────────────────────────────────────────
  if (action === 'account-state' && req.method === 'GET') {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    try {
      const r = await fetch(`${TESTNET_SPOT}/accounts/${address}/state`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      const data = await r.json();
      return res.json({ ok: r.ok, data, status: r.status });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET MARKETS / TICKERS ────────────────────────────────────
  if (action === 'markets' && req.method === 'GET') {
    try {
      const r = await fetch(`${TESTNET_SPOT}/markets/tickers`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      const data = await r.json();
      return res.json({ ok: r.ok, data: data?.data || [], status: r.status });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PREPARE ORDER (returns payload to sign) ─────────────────
  if (action === 'prepare-order' && req.method === 'POST') {
    const { accountID, symbolID, side, price, quantity, clOrdID } = req.body || {};
    if (!accountID || !symbolID || !side || !price || !quantity) {
      return res.status(400).json({ error: 'accountID, symbolID, side, price, quantity required' });
    }

    const nonce = Date.now();
    const order = {
      clOrdID: clOrdID || `oe-${nonce}`,
      modifier: 1,
      side: parseInt(side),      // 1=BUY, 2=SELL
      type: 1,                    // LIMIT
      timeInForce: 1,
      price: String(price),     // MUST be string!
      quantity: String(quantity), // MUST be string!
      reduceOnly: false
    };

    const payload = {
      type: "newOrder",
      params: {
        accountID: parseInt(accountID),
        symbolID: parseInt(symbolID),
        orders: [order]
      }
    };

    // Compact JSON for hashing (exact Go struct order)
    const compactPayload = JSON.stringify(payload);

    return res.json({
      ok: true,
      payload,
      compactPayload,
      nonce,
      domain: SPOT_DOMAIN,
      types: EIP712_TYPES,
      message: {
        payloadHash: "<compute keccak256(compactPayload) on client>",
        nonce: nonce
      },
      instructions: {
        step1: "Compute payloadHash = keccak256(compactPayload) using ethers.js",
        step2: "Sign EIP-712 typed data: {domain, types: {EIP712Domain, ExchangeAction}, primaryType: 'ExchangeAction', message: {payloadHash, nonce}}",
        step3: "Prepend 0x01 to signature for X-API-Sign",
        step4: "POST to /api/trade?action=submit-order with X-API-Key, X-API-Sign, X-API-Nonce headers"
      }
    });
  }

  // ── SUBMIT ORDER (proxy to SoDEX) ────────────────────────────
  if (action === 'submit-order' && req.method === 'POST') {
    const { params, apiKey, apiSign, apiNonce } = req.body || {};
    if (!params || !apiKey || !apiSign || !apiNonce) {
      return res.status(400).json({ error: 'params, apiKey, apiSign, apiNonce required' });
    }

    try {
      const r = await fetch(`${TESTNET_SPOT}/trade/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-Key': apiKey,
          'X-API-Sign': apiSign,
          'X-API-Nonce': String(apiNonce)
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(10000)
      });

      const data = await r.json().catch(() => null);
      return res.json({
        ok: r.ok,
        status: r.status,
        data,
        headers: Object.fromEntries(r.headers)
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── ADD API KEY (master wallet signs) ────────────────────────
  if (action === 'add-api-key' && req.method === 'POST') {
    const { params, masterSign, masterNonce } = req.body || {};
    if (!params || !masterSign || !masterNonce) {
      return res.status(400).json({ error: 'params, masterSign, masterNonce required' });
    }

    try {
      const r = await fetch(`${TESTNET_SPOT}/account/api-keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-Sign': masterSign,
          'X-API-Nonce': String(masterNonce)
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(10000)
      });

      const data = await r.json().catch(() => null);
      return res.json({ ok: r.ok, status: r.status, data });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}
