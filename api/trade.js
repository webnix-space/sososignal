// /api/trade.js
// SoDEX testnet trading — prepare + submit orders
// FIXED: GET for account-state/markets, POST for prepare-order/submit-order.
// FIXED: Added wallet_addEthereumChain for ValueChain Testnet.

const SODEX_TESTNET_RPC = 'https://testnet-v2.valuechain.xyz';
const SODEX_TESTNET_CHAIN_ID = 138565;

// EIP-712 Domain for SoDEX testnet
const EIP712_DOMAIN = {
  name: "spot",
  version: "1",
  chainId: SODEX_TESTNET_CHAIN_ID,
  verifyingContract: "0x0000000000000000000000000000000000000000"
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── GET endpoints ──────────────────────────────────────────────
  if (req.method === 'GET') {
    // Account state
    if (action === 'account-state') {
      const { address } = req.query;
      if (!address) {
        return res.status(400).json({ ok: false, error: 'address required' });
      }

      try {
        // Fetch account state from SoDEX testnet
        const r = await fetch(`${SODEX_TESTNET_RPC}/api/v1/account/${address}`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000)
        });

        if (!r.ok) {
          // If SoDEX API doesn't have this endpoint, return structured error
          return res.status(200).json({
            ok: false,
            error: `SoDEX account API returned ${r.status}`,
            address,
            note: 'Ensure wallet has SoDEX Testnet (ValueChain) configured'
          });
        }

        const data = await r.json();
        return res.json({ ok: true, data, address });
      } catch (e) {
        return res.status(200).json({
          ok: false,
          error: e.message,
          address,
          note: 'SoDEX testnet account fetch failed'
        });
      }
    }

    // Markets list
    if (action === 'markets') {
      try {
        const r = await fetch('https://mainnet-gw.sodex.dev/api/v1/spot/markets', {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000)
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        return res.json({ ok: true, data: data?.data || [] });
      } catch (e) {
        return res.status(503).json({ ok: false, error: e.message });
      }
    }

    return res.status(400).json({ ok: false, error: 'Unknown GET action: ' + action });
  }

  // ── POST endpoints ─────────────────────────────────────────────
  if (req.method === 'POST') {
    // Prepare order (generate EIP-712 payload)
    if (action === 'prepare-order') {
      const { symbol, side, price, quantity, nonce, apiKeyName, accountID } = req.body || {};

      if (!symbol || !side || !price || !quantity || !nonce || !apiKeyName || !accountID) {
        return res.status(400).json({
          ok: false,
          error: 'Missing required fields: symbol, side, price, quantity, nonce, apiKeyName, accountID'
        });
      }

      // Validate constraints
      if (!/^[0-9a-zA-Z_-]{1,36}$/.test(apiKeyName) || apiKeyName === 'default') {
        return res.status(400).json({ ok: false, error: 'Invalid apiKeyName format' });
      }

      const orderPayload = {
        domain: EIP712_DOMAIN,
        types: {
          Order: [
            { name: 'symbol', type: 'string' },
            { name: 'side', type: 'string' },
            { name: 'price', type: 'string' },
            { name: 'quantity', type: 'string' },
            { name: 'nonce', type: 'uint256' }
          ]
        },
        primaryType: 'Order',
        message: {
          symbol,
          side: side.toUpperCase(),
          price: String(price),
          quantity: String(quantity),
          nonce: String(nonce)
        }
      };

      return res.json({
        ok: true,
        payload: orderPayload,
        meta: {
          chainId: SODEX_TESTNET_CHAIN_ID,
          rpc: SODEX_TESTNET_RPC,
          note: 'Sign this payload with MetaMask, then submit via POST /api/trade?action=submit-order'
        }
      });
    }

    // Submit order
    if (action === 'submit-order') {
      const { params, signature, masterSign, masterNonce } = req.body || {};

      if (!params || !signature) {
        return res.status(400).json({ ok: false, error: 'params and signature required' });
      }

      try {
        // Proxy to SoDEX testnet
        const r = await fetch(`${SODEX_TESTNET_RPC}/api/v1/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            params,
            signature,
            masterSign,
            masterNonce
          }),
          signal: AbortSignal.timeout(10000)
        });

        const data = await r.json();
        return res.status(r.ok ? 200 : r.status).json({
          ok: r.ok,
          data,
          status: r.status
        });
      } catch (e) {
        return res.status(503).json({ ok: false, error: e.message });
      }
    }

    return res.status(400).json({ ok: false, error: 'Unknown POST action: ' + action });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed: ' + req.method });
}
