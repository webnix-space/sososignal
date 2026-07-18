// /api/setup.js — API Key registration wizard with proper MetaMask flow + audit trail
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
    source: 'setup-api'
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
    // ── SETUP GUIDE ──────────────────────────────────────────────
    if (action === 'guide') {
      logAudit('setup_guide', {});
      return res.json({
        ok: true,
        guide: {
          steps: [
            {
              step: 1,
              title: 'Connect MetaMask',
              description: 'Connect your master wallet to ValueChain Testnet',
              action: 'connect_wallet',
              chainId: isTestnet ? '0x21d85' : '0x21d87', // 138565 / 286623
              rpcUrl: isTestnet ? 'https://testnet-rpc.sodex.dev' : 'https://rpc.sodex.dev',
              currencySymbol: 'USDC'
            },
            {
              step: 2,
              title: 'Get Account ID',
              description: 'Fetch your account ID from the blockchain',
              action: 'get_account_id',
              endpoint: `/api/setup?action=account-id&address=YOUR_ADDRESS`
            },
            {
              step: 3,
              title: 'Generate API Key',
              description: 'Create a new EVM keypair for trading',
              action: 'generate_key',
              note: 'Generate locally in browser using ethers.js Wallet.createRandom()'
            },
            {
              step: 4,
              title: 'Sign & Register',
              description: 'Sign the registration with MetaMask',
              action: 'sign_register',
              endpoint: 'POST /api/setup?action=prepare-add-key',
              submitEndpoint: 'POST /api/setup?action=submit-add-key'
            },
            {
              step: 5,
              title: 'Save Private Key',
              description: 'Store your API key securely',
              action: 'save_key',
              warning: 'Never share your private key. Store in environment variables or secure vault.'
            }
          ],
          constraints: {
            apiKeyName: '^[0-9a-zA-Z_-]{1,36}$',
            maxKeys: 5,
            nonceWindow: 'T-2d to T+1d',
            signaturePrefix: '0x01'
          }
        }
      });
    }

    // ── GET ACCOUNT ID ─────────────────────────────────────────
    if (action === 'account-id') {
      const { address } = req.query;
      if (!address) return res.status(400).json({ ok: false, error: 'address required' });

      logAudit('account_id_request', { address: address.slice(0, 10) + '...' });

      // Try to get account ID from SoDEX
      try {
        const r = await fetch(`${base}/accounts/${address}`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000)
        });

        if (r.ok) {
          const data = await r.json();
          const accountData = data.data || data;
          const accountID = accountData.accountID || accountData.id || accountData.account_id;

          if (accountID) {
            logAudit('account_id_success', { accountID: String(accountID).slice(0, 6) + '...' });
            return res.json({ 
              ok: true, 
              accountID: String(accountID),
              address,
              exists: true
            });
          }
        }
      } catch (e) {
        console.error('Account ID fetch error:', e.message);
      }

      // If no account found, guide user to create one
      logAudit('account_id_not_found', { address: address.slice(0, 10) + '...' });
      return res.json({
        ok: true,
        accountID: null,
        address,
        exists: false,
        message: 'No SoDEX account found for this address. Please deposit USDC on testnet.sodex.com first.',
        depositUrl: isTestnet ? 'https://testnet.sodex.com' : 'https://sodex.com'
      });
    }

    // ── PREPARE ADD KEY ────────────────────────────────────────
    if (action === 'prepare-add-key' && req.method === 'POST') {
      const body = req.body || {};
      const { accountID, keyName, keyPublicKey } = body;

      if (!accountID || !keyName || !keyPublicKey) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Missing required fields: accountID, keyName, keyPublicKey' 
        });
      }

      // Validate key name
      const nameRegex = /^[0-9a-zA-Z_-]{1,36}$/;
      if (!nameRegex.test(keyName) || keyName === 'default') {
        return res.status(400).json({ 
          ok: false, 
          error: 'Invalid key name. Must match ^[0-9a-zA-Z_-]{1,36}$ and cannot be "default"' 
        });
      }

      logAudit('prepare_add_key', { 
        accountID: String(accountID).slice(0, 6) + '...', 
        keyName: keyName.slice(0, 10) 
      });

      // EIP-712 Domain
      const domain = {
        name: "spot",
        version: "1",
        chainId: isTestnet ? 138565 : 286623,
        verifyingContract: "0x0000000000000000000000000000000000000000"
      };

      // addAPIKey type
      const ADD_KEY_TYPE = {
        addAPIKey: [
          { name: "accountID", type: "uint32" },
          { name: "keyName", type: "string" },
          { name: "keyPublicKey", type: "address" },
          { name: "nonce", type: "uint64" }
        ]
      };

      const nonce = Date.now();

      const message = {
        accountID: parseInt(accountID),
        keyName: keyName,
        keyPublicKey: keyPublicKey,
        nonce: nonce
      };

      logAudit('prepare_add_key_success', { keyName: keyName.slice(0, 10), nonce });

      return res.json({
        ok: true,
        domain,
        types: ADD_KEY_TYPE,
        primaryType: 'addAPIKey',
        message,
        eip712: true,
        instructions: 'Sign this with MetaMask using eth_signTypedData_v4. The signature must start with 0x01.',
        example: {
          method: 'eth_signTypedData_v4',
          params: [window.ethereum.selectedAddress, JSON.stringify({ domain, types: ADD_KEY_TYPE, primaryType: 'addAPIKey', message })]
        }
      });
    }

    // ── SUBMIT ADD KEY ─────────────────────────────────────────
    if (action === 'submit-add-key' && req.method === 'POST') {
      const body = req.body || {};
      const { params, masterSign, masterNonce } = body;

      if (!params || !masterSign || !masterNonce) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Missing required fields: params, masterSign, masterNonce' 
        });
      }

      // Validate signature prefix
      if (!masterSign.startsWith('0x01') && !masterSign.startsWith('0x')) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Invalid signature format. Must start with 0x01 for typed data signatures.' 
        });
      }

      logAudit('submit_add_key', { 
        accountID: params.accountID,
        keyName: params.keyName?.slice(0, 10),
        signature: masterSign.slice(0, 20) + '...'
      });

      // Submit to SoDEX
      const r = await fetch(`${base}/accounts/add-api-key`, {
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
        logAudit('submit_add_key_failed', { status: r.status }, 'error', data.error || 'Unknown');
        return res.status(r.status).json({ 
          ok: false, 
          error: data.error || `SoDEX returned ${r.status}`,
          details: data 
        });
      }

      logAudit('submit_add_key_success', { 
        accountID: params.accountID,
        keyName: params.keyName?.slice(0, 10)
      });

      return res.json({
        ok: true,
        message: 'API key registered successfully!',
        accountID: params.accountID,
        keyName: params.keyName,
        nextSteps: [
          'Save your API key private key securely',
          'Use the API key name and account ID in the trade panel',
          'Test with a small order first'
        ]
      });
    }

    // ── LIST KEYS ──────────────────────────────────────────────
    if (action === 'list-keys') {
      const { accountID } = req.query;
      if (!accountID) return res.status(400).json({ ok: false, error: 'accountID required' });

      logAudit('list_keys', { accountID: String(accountID).slice(0, 6) + '...' });

      try {
        const r = await fetch(`${base}/accounts/${accountID}/api-keys`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000)
        });

        if (r.ok) {
          const data = await r.json();
          logAudit('list_keys_success', { count: data.data?.length || 0 });
          return res.json({ ok: true, keys: data.data || [], count: data.data?.length || 0 });
        }
      } catch (e) {
        console.error('List keys error:', e.message);
      }

      return res.json({ ok: true, keys: [], count: 0, message: 'No keys found or API unavailable' });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });

  } catch (e) {
    logAudit('setup_error', { action }, 'error', e.message);
    console.error('Setup error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}
