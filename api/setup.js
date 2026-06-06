// api/setup.js - API Key registration wizard for SoDEX
// Fixed: AbortSignal.timeout() replaced with fetchWithTimeout

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
    // Setup guide JSON
    if (action === 'guide') {
      return res.json({
        ok: true,
        steps: [
          'Connect MetaMask (master wallet)',
          'Get Account ID from blockchain',
          'Generate API Key (creates EVM keypair)',
          'Prepare registration payload',
          'Sign with MetaMask and submit'
        ]
      });
    }

    // Get account ID by address
    if (action === 'account-id') {
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

    // Prepare add API key
    if (action === 'prepare-add-key' && req.method === 'POST') {
      const body = req.body;
      const r = await fetchWithTimeout(`${base}/api-key/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      }, 10000);
      const j = await r.json();
      return res.json({ ok: r.ok, data: j.data, error: j.msg });
    }

    // Submit add API key
    if (action === 'submit-add-key' && req.method === 'POST') {
      const body = req.body;
      const r = await fetchWithTimeout(`${base}/api-key/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      }, 10000);
      const j = await r.json();
      return res.json({ ok: r.ok, data: j.data, error: j.msg });
    }

    // List API keys
    if (action === 'list-keys') {
      const { accountID } = req.query;
      if (!accountID) {
        return res.status(400).json({ ok: false, error: 'accountID required' });
      }
      const r = await fetchWithTimeout(`${base}/api-key/list?accountID=${accountID}`, {
        headers: { 'Accept': 'application/json' }
      }, 8000);
      const j = await r.json();
      return res.json({ ok: r.ok, data: j.data, error: j.msg });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  } catch (e) {
    console.error('[setup] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
