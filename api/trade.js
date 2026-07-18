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
    // ── ACCOUNT STATE ────────────────────────────────────────────
    if (action === 'account-state') {
      const { address } = req.query;
      if (!address) return res.status(400).json({ ok: false, error: 'address required' });

      logAudit('account_state_request', { address: address.slice(0, 10) + '...', isTestnet });

      const r = await fetch(`${base}/accounts/${address}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      logAudit('account_state_success', { address: address.slice(0, 10) + '...' });
      return res.json({ ok: true, data: data.data || data, source: isTestnet ? 'sodex-testnet' : 'sodex-mainnet' });
    }

    // ── MARKETS LIST ─────────────────────────────────────────────
    if (action === 'markets') {
      logAudit('markets_request', { isTestnet });

      const r = await fetch(`${base}/markets`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      logAudit('markets_success', { count: data.data?.length || 0 });
      return res.json({ ok: true, data: data.data || data, source: isTestnet ? 'sodex-testnet' : 'sodex-mainnet' });
    }

    // ── PREPARE ORDER ──────────────────────────────────────────
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

      // EIP-712 Domain for SoDEX
      const domain = {
        name: "spot",
        version: "1",
        chainId: isTestnet ? 138565 : 286623,
        verifyingContract: "0x0000000000000000000000000000000000000000"
      };

      // Order types
      const ORDER_TYPE = {
        Order: [
          { name: "accountID", type: "uint32" },
          { name: "marketID", type: "uint32" },
          { name: "side", type: "uint8" },
          { name: "price", type: "string" },
          { name: "amount", type: "string" },
          { name: "nonce", type: "uint64" }
        ]
      };

      // Generate nonce (must be unique and within time window)
      const nonce = Date.now();

      const orderPayload = {
        accountID: parseInt(accountID),
        marketID: 1, // Would need to lookup from symbol
        side: side.toUpperCase() === 'BUY' ? 1 : 2,
        price: String(price),
        amount: String(quantity),
        nonce: nonce
      };

      logAudit('prepare_order_success', { symbol, side, nonce });

      return res.json({
        ok: true,
        payload: orderPayload,
        domain,
        types: ORDER_TYPE,
        primaryType: 'Order',
        message: orderPayload,
        eip712: true,
        instructions: 'Sign this payload with your MetaMask using eth_signTypedData_v4'
      });
    }

    // ── SUBMIT ORDER ───────────────────────────────────────────
    if (action === 'submit-order' && req.method === 'POST') {
      const body = req.body || {};
      const { params, masterSign, masterNonce, apiKeyName } = body;

      if (!params || !masterSign || !masterNonce || !apiKeyName) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Missing required fields: params, masterSign, masterNonce, apiKeyName' 
        });
      }

      logAudit('submit_order', { 
        apiKeyName: apiKeyName.slice(0, 10),
        signature: masterSign.slice(0, 20) + '...'
      });

      // Submit to SoDEX
      const r = await fetch(`${base}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          params,
          masterSign,
          masterNonce: parseInt(masterNonce)
        }),
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
