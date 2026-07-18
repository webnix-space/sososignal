// /api/setup.js
// API Key registration wizard
// FIXED: Returns ValueChain Testnet config for wallet_addEthereumChain.

const SODEX_TESTNET_RPC = 'https://testnet-v2.valuechain.xyz';
const SODEX_TESTNET_CHAIN_ID = 138565;
const SODEX_MAINNET_CHAIN_ID = 286623;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── GET: Setup guide with network config ───────────────────────
  if (req.method === 'GET' && action === 'guide') {
    return res.json({
      ok: true,
      steps: [
        'Connect MetaMask (master wallet)',
        'Get Account ID (fetches from blockchain)',
        'Generate API Key (creates EVM keypair)',
        'Prepare → Sign & Register (MetaMask popup)',
        'Save private key securely'
      ],
      networks: {
        testnet: {
          chainId: SODEX_TESTNET_CHAIN_ID,
          chainIdHex: '0x' + SODEX_TESTNET_CHAIN_ID.toString(16),
          name: 'ValueChain Testnet',
          rpcUrls: [SODEX_TESTNET_RPC],
          nativeCurrency: { name: 'SOSO', symbol: 'SOSO', decimals: 18 },
          blockExplorerUrls: ['https://test-scan.valuechain.xyz']
        },
        mainnet: {
          chainId: SODEX_MAINNET_CHAIN_ID,
          chainIdHex: '0x' + SODEX_MAINNET_CHAIN_ID.toString(16),
          name: 'ValueChain Mainnet',
          rpcUrls: ['https://mainnet.valuechain.xyz'],
          nativeCurrency: { name: 'SOSO', symbol: 'SOSO', decimals: 18 },
          blockExplorerUrls: ['https://main-scan.valuechain.xyz']
        }
      }
    });
  }

  // ── GET: Account ID from address ───────────────────────────────
  if (req.method === 'GET' && action === 'account-id') {
    const { address } = req.query;
    if (!address) return res.status(400).json({ ok: false, error: 'address required' });

    try {
      const r = await fetch(`${SODEX_TESTNET_RPC}/api/v1/account-id?address=${address}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      const data = await r.json();
      return res.json({ ok: r.ok, accountID: data?.accountID || null, data });
    } catch (e) {
      return res.status(503).json({ ok: false, error: e.message });
    }
  }

  // ── GET: List API keys ─────────────────────────────────────────
  if (req.method === 'GET' && action === 'list-keys') {
    const { accountID } = req.query;
    if (!accountID) return res.status(400).json({ ok: false, error: 'accountID required' });

    try {
      const r = await fetch(`${SODEX_TESTNET_RPC}/api/v1/keys?accountID=${accountID}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      const data = await r.json();
      return res.json({ ok: r.ok, keys: data?.keys || [], data });
    } catch (e) {
      return res.status(503).json({ ok: false, error: e.message });
    }
  }

  // ── POST: Prepare add-key ──────────────────────────────────────
  if (req.method === 'POST' && action === 'prepare-add-key') {
    const { accountID, keyName, keyPublicKey } = req.body || {};
    if (!accountID || !keyName || !keyPublicKey) {
      return res.status(400).json({ ok: false, error: 'accountID, keyName, keyPublicKey required' });
    }

    try {
      const r = await fetch(`${SODEX_TESTNET_RPC}/api/v1/keys/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountID, keyName, keyPublicKey }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await r.json();
      return res.json({ ok: r.ok, data });
    } catch (e) {
      return res.status(503).json({ ok: false, error: e.message });
    }
  }

  // ── POST: Submit add-key ───────────────────────────────────────
  if (req.method === 'POST' && action === 'submit-add-key') {
    const { params, masterSign, masterNonce } = req.body || {};
    if (!params || !masterSign) {
      return res.status(400).json({ ok: false, error: 'params and masterSign required' });
    }

    try {
      const r = await fetch(`${SODEX_TESTNET_RPC}/api/v1/keys/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params, masterSign, masterNonce }),
        signal: AbortSignal.timeout(10000)
      });
      const data = await r.json();
      return res.json({ ok: r.ok, data });
    } catch (e) {
      return res.status(503).json({ ok: false, error: e.message });
    }
  }

  return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
}
