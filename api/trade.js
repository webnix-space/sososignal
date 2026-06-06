// api/trade.js - SoDEX testnet trading (prepare + submit)
const SODEX_TESTNET = 'https://testnet-gw.sodex.dev/api/v1/spot';
const SODEX_MAINNET = 'https://mainnet-gw.sodex.dev/api/v1/spot';

function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;
  const isTestnet = req.query.testnet === '1';
  const base = isTestnet ? SODEX_TESTNET : SODEX_MAINNET;

  try {
    // Get account state
    if (action === 'account-state') {
      const { address } = req.query;
      if (!address) {
        return res.status(400).json({ ok: false, error: 'address required' });
      }
      const r = await fetchWithTimeout(`${base}/account/${address}`, {
        headers: { 'Accept': 'application/json' }
      }, 8000);
      const j = await r.json();
      return res.json({ ok: r.ok, data: j.data, error: j.msg });
    }

    // Get markets list
    if (action === 'markets') {
      const r = await fetchWithTimeout(`${base}/markets`, {
        headers: { 'Accept': 'application/json' }
      }, 8000);
      const j = await r.json();
      return res.json({ ok: r.ok, data: j.data, error: j.msg });
    }

    // Prepare order (generate EIP-712 payload)
    if (action === 'prepare-order' && req.method === 'POST') {
      const body = req.body;
      const r = await fetchWithTimeout(`${base}/order/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      }, 10000);
      const j = await r.json();
      return res.json({ ok: r.ok, data: j.data, error: j.msg });
    }

    // Submit signed order
    if (action === 'submit-order' && req.method === 'POST') {
      const body = req.body;
      const r = await fetchWithTimeout(`${base}/order/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      }, 10000);
      const j = await r.json();
      return res.json({ ok: r.ok, data: j.data, error: j.msg });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  } catch (e) {
    console.error('[trade] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
