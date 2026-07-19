// /api/trade.js — SoDEX testnet trading with EIP-712 + audit trail
const SODEX_TESTNET = 'https://testnet-gw.sodex.dev/api/v1';
const SODEX_MAINNET = 'https://mainnet-gw.sodex.dev/api/v1';

const auditLog = [];
function logAudit(action, details, status = 'success', error = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    details: { ...details, ip: 'masked' },
    status,
    error: error?.message || error,
    source: 'trade-api'
  };
  auditLog.push(entry);
  if (auditLog.length > 100) auditLog.shift();
  console.log(`[AUDIT] ${action}: ${status}`, details);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;
  const isTestnet = req.query.testnet === '1';
  const base = isTestnet ? SODEX_TESTNET : SODEX_MAINNET;

  try {
    if (action === 'account-state') {
      const { address } = req.query;
      if (!address) return res.status(400).json({ ok: false, error: 'address required' });

      logAudit('account_state_request', { address: address.slice(0, 10) + '...', isTestnet });

      const r = await fetch(`${base}/accounts/${address}/state`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      logAudit('account_state_success', { address: address.slice(0, 10) + '...' });
      return res.json({ 
        ok: true, 
        data: data.data || data, 
        source: isTestnet ? 'sodex-testnet' : 'sodex-mainnet' 
      });
    }

    if (action === 'markets') {
      logAudit('markets_request', { isTestnet });

      const r = await fetch(`${base}/markets`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      logAudit('markets_success', { count: data.data?.length || 0 });
      return res.json({ 
        ok: true, 
        data: data.data || data, 
        source: isTestnet ? 'sodex-testnet' : 'sodex-mainnet' 
      });
    }

    if (action === 'prepare-order' && req.method === 'POST') {
      const body = req.body || {};
      const { symbol, side, price, quantity, accountID, apiKeyName } = body;

      if (!symbol || !side || !price || !quantity || !accountID || !apiKeyName) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Missing required fields: symbol, side, price, quantity, accountID, apiKeyName' 
        });
      }

      logAudit('prepare_order', { 
        symbol, side, accountID: String(accountID).slice(0, 6) + '...', 
        apiKeyName: apiKeyName.slice(0, 10) 
      });

      const domain = {
        name: "spot",
        version: "1",
        chainId: isTestnet ? 138565 : 286623,
        verifyingContract: "0x0000000000000000000000000000000000000000"
      };

      const types = {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" }
        ],
        ExchangeAction: [
          { name: 'payloadHash', type: "bytes32" },
          { name: 'nonce', type: 'uint64' }
        ]
      };

      const nonce = Date.now();

      const orderParams = {
        accountID: parseInt(accountID),
        symbolID: symbol,
        orders: [{
          clOrdID: `order-${Date.now()}`,
          modifier: 1,
          side: side.toUpperCase() === 'BUY' ? 1 : 2,
          type: 2,
          timeInForce: 3,
          price: String(price),
          quantity: String(quantity),
          reduceOnly: false,
          positionSide: 1
        }]
      };

      const payload = { type: "newOrder", params: orderParams };
      const payloadStr = JSON.stringify(payload);

      logAudit('prepare_order_success', { symbol, side, nonce });

      return res.json({
        ok: true,
        payload,
        payloadStr,
        domain,
        types,
        primaryType: 'ExchangeAction',
        message: {
          payloadHash: "0x",
          nonce
        },
        eip712: true,
        instructions: '1. Hash payloadStr with keccak256. 2. Sign ExchangeAction{payloadHash, nonce} with API key private key. 3. Prepend 0x01 to signature.'
      });
    }

    if (action === 'submit-order' && req.method === 'POST') {
      const body = req.body || {};
      const { params, signature, nonce, apiKeyName } = body;

      if (!params || !signature || !nonce || !apiKeyName) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Missing required fields: params, signature, nonce, apiKeyName' 
        });
      }

      logAudit('submit_order', { 
        apiKeyName: apiKeyName.slice(0, 10),
        signature: signature.slice(0, 20) + '...'
      });

      const r = await fetch(`${base}/trade/orders/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-Key': apiKeyName,
          'X-API-Sign': signature,
          'X-API-Nonce': String(nonce)
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(10000)
      });

      const data = await r.json();

      if (!r.ok) {
        logAudit('submit_order_failed', { status: r.status }, 'error', data.error || 'Unknown');
        return res.status(r.status).json({ 
          ok: false, 
          error: data.error || `SoDEX returned ${r.status}`,
          details: data 
        });
      }

      logAudit('submit_order_success', { orderId: data.orderId || 'unknown' });

      return res.json({
        ok: true,
        order: data.data || data,
        txHash: data.txHash,
        explorer: isTestnet 
          ? `https://testnet.sodex.com/tx/${data.txHash}` 
          : `https://sodex.com/tx/${data.txHash}`
      });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });

  } catch (e) {
    logAudit('trade_error', { action }, 'error', e.message);
    console.error('Trade error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}
