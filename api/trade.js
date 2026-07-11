// api/trade.js — SoDEX spot trading, proxied to the REAL API.
//
// Previous version called /order/prepare and /order/submit — those endpoints
// do not exist on SoDEX. There is no server-side "prepare" step. The client
// builds the payload, signs it with EIP-712 locally (in index.html), and this
// server does nothing but forward the already-signed request with the three
// auth headers the real API expects: X-API-Key, X-API-Sign, X-API-Nonce.
//
// Real endpoints used here (confirmed against SoDEX docs):
//   GET    ${SPOT_ENDPOINT}/accounts/{userAddress}/state       — account state
//   POST   ${SPOT_ENDPOINT}/trade/orders/batch                 — place order(s)
//   DELETE ${SPOT_ENDPOINT}/trade/orders/batch                 — cancel order(s)
//
// KNOWN GAP: the exact field list/order for BatchNewOrderItem (spot) was not
// available at the time this was written — only the perps field order was
// documented. This proxy forwards whatever body the client sends verbatim; it
// does not validate or reshape it. If order placement fails with a signature
// or field-order error, that's the schema mismatch to chase down first —
// pull schema.md for BatchNewOrderItem/BatchCancelOrderItem and fix the
// payload construction in index.html's prepareOrder()/signAndSubmit(), not here.

const SODEX_TESTNET = 'https://testnet-gw.sodex.dev/api/v1/spot';
const SODEX_MAINNET = 'https://mainnet-gw.sodex.dev/api/v1/spot';

function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

function authHeaders(req) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (req.headers['x-api-key']) h['X-API-Key'] = req.headers['x-api-key'];
  if (req.headers['x-api-sign']) h['X-API-Sign'] = req.headers['x-api-sign'];
  if (req.headers['x-api-nonce']) h['X-API-Nonce'] = req.headers['x-api-nonce'];
  return h;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-API-Sign, X-API-Nonce');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;
  const isTestnet = req.query.testnet === '1';
  const base = isTestnet ? SODEX_TESTNET : SODEX_MAINNET;

  try {
    // ── Account state (balances, open orders, sync metadata) ──────────────
    if (action === 'account-state') {
      const { address, accountID } = req.query;
      if (!address) return res.status(400).json({ ok: false, error: 'address required' });
      const qs = accountID ? `?accountID=${accountID}` : '';
      const r = await fetchWithTimeout(`${base}/accounts/${address}/state${qs}`, {
        headers: { 'Accept': 'application/json' }
      }, 8000);
      const j = await r.json();
      return res.status(r.status).json({ ok: r.ok && j.code === 0, data: j.data, error: j.msg || j.error });
    }

    // ── List API keys registered to this master address ────────────────────
    if (action === 'api-keys') {
      const { address, accountID, name } = req.query;
      if (!address) return res.status(400).json({ ok: false, error: 'address required' });
      const params = new URLSearchParams();
      if (accountID) params.set('accountID', accountID);
      if (name) params.set('name', name);
      const qs = params.toString() ? `?${params}` : '';
      const r = await fetchWithTimeout(`${base}/accounts/${address}/api-keys${qs}`, {
        headers: { 'Accept': 'application/json' }
      }, 8000);
      const j = await r.json();
      return res.status(r.status).json({ ok: r.ok && j.code === 0, data: j.data, error: j.msg || j.error });
    }

    // ── Query symbols (trading rules — needed to build valid orders) ───────
    if (action === 'symbols') {
      const { symbol } = req.query;
      const qs = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
      const r = await fetchWithTimeout(`${base}/markets/symbols${qs}`, {
        headers: { 'Accept': 'application/json' }
      }, 8000);
      const j = await r.json();
      return res.status(r.status).json({ ok: r.ok && j.code === 0, data: j.data, error: j.msg || j.error });
    }

    // ── Place order(s) — always a batch, even for one order ─────────────────
    // Client has already: built {type:"newOrder", params}, computed
    // payloadHash = keccak256(compact JSON), signed via EIP-712 with the
    // registered API key's private key, and sent params + the 3 auth headers.
    if (action === 'place-order' && req.method === 'POST') {
      const r = await fetchWithTimeout(`${base}/trade/orders/batch`, {
        method: 'POST',
        headers: authHeaders(req),
        body: JSON.stringify(req.body)
      }, 10000);
      const j = await r.json();
      return res.status(r.status).json({ ok: r.ok && j.code === 0, data: j.data, error: j.msg || j.error });
    }

    // ── Cancel order(s) — same batch shape, DELETE verb ─────────────────────
    if (action === 'cancel-order' && req.method === 'POST') {
      const r = await fetchWithTimeout(`${base}/trade/orders/batch`, {
        method: 'DELETE',
        headers: authHeaders(req),
        body: JSON.stringify(req.body)
      }, 10000);
      const j = await r.json();
      return res.status(r.status).json({ ok: r.ok && j.code === 0, data: j.data, error: j.msg || j.error });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  } catch (e) {
    console.error('[trade] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
