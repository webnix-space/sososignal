// api/setup.js — SoDEX API key registration, proxied to the REAL API.
//
// Previous version called /account/{address}, /api-key/prepare, /api-key/submit
// — none of those exist. Corrected:
//   GET  ${SPOT_ENDPOINT}/accounts/{userAddress}/state     — confirmed real,
//        account ID is the `aid` field in the response (also documented under
//        the perps equivalent — same shape applies to spot).
//   GET  ${SPOT_ENDPOINT}/accounts/{userAddress}/api-keys  — confirmed real,
//        lists currently-registered keys.
//   POST .../api-keys (add)                                — NOT CONFIRMED.
//        The docs describe HOW addAPIKey is signed (master wallet, EIP-712,
//        same X-API-Key/X-API-Sign/X-API-Nonce headers as trading actions —
//        except X-API-Key here would be the *master* address, not a key name,
//        since no API key exists yet to name) but the exact POST path was
//        never given in what's been pulled from the docs. This handler proxies
//        to a best-guess path (`${base}/accounts/api-keys`) mirroring the GET
//        route. TEST THIS ON TESTNET FIRST. If it 404s, the real path needs to
//        be pulled from add-api-key.md before this works — don't assume this
//        guess is correct just because it compiles.

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-API-Sign, X-API-Nonce');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;
  const isTestnet = req.query.testnet === '1';
  const base = isTestnet ? SODEX_TESTNET : SODEX_MAINNET;

  try {
    if (action === 'guide') {
      return res.json({
        ok: true,
        steps: [
          'Connect MetaMask (master wallet)',
          'Fetch account state — extract accountID (the "aid" field)',
          'Generate a dedicated API keypair locally (never sent to server)',
          'Build {type:"addAPIKey", params:{...}} payload, sign with MASTER wallet via EIP-712',
          'Submit signed registration — key is now usable for X-API-Key/X-API-Sign on future trades'
        ]
      });
    }

    // ── Account state → accountID (the `aid` field) ─────────────────────────
    if (action === 'account-id') {
      const { address } = req.query;
      if (!address) return res.status(400).json({ ok: false, error: 'address required' });
      const r = await fetchWithTimeout(`${base}/accounts/${address}/state`, {
        headers: { 'Accept': 'application/json' }
      }, 8000);
      const j = await r.json();
      if (!r.ok || j.code !== 0) {
        return res.json({ ok: false, error: j.msg || 'No account state found. Deposit assets first.' });
      }
      return res.json({ ok: true, accountID: j.data?.aid, data: j.data });
    }

    // ── List registered API keys ────────────────────────────────────────────
    if (action === 'list-keys') {
      const { address, accountID } = req.query;
      if (!address) return res.status(400).json({ ok: false, error: 'address required' });
      const qs = accountID ? `?accountID=${accountID}` : '';
      const r = await fetchWithTimeout(`${base}/accounts/${address}/api-keys${qs}`, {
        headers: { 'Accept': 'application/json' }
      }, 8000);
      const j = await r.json();
      return res.status(r.status).json({ ok: r.ok && j.code === 0, data: j.data, error: j.msg || j.error });
    }

    // ── Register a new API key — UNCONFIRMED PATH, see file header ─────────
    // Client has built {type:"addAPIKey", params:{accountID, name, publicKey}},
    // signed with the MASTER wallet's private key via EIP-712, and sends
    // params + auth headers (X-API-Key here = master address per docs' note
    // that addAPIKey/revokeAPIKey use the master wallet's own signing flow).
    if (action === 'add-key' && req.method === 'POST') {
      const r = await fetchWithTimeout(`${base}/accounts/api-keys`, {
        method: 'POST',
        headers: authHeaders(req),
        body: JSON.stringify(req.body)
      }, 10000);
      const j = await r.json();
      return res.status(r.status).json({
        ok: r.ok && j.code === 0,
        data: j.data,
        error: j.msg || j.error,
        _unconfirmedEndpoint: true // remove once verified against testnet
      });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  } catch (e) {
    console.error('[setup] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
