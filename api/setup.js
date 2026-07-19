// /api/setup.js — API Key registration wizard
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
              chainId: isTestnet ? '0x21D45' : '0x45F5F',
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
            signaturePrefix: '0x02'
          }
        }
      });
    }

    if (action === 'account-id') {
      const { address } = req.query;
      if (!address) return res.status(400).json({ ok: false, error: 'address required' });

      logAudit('account_id_request', { address: address.slice(0, 10) + '...' });

      try {
        const r = await fetch(`${base}/accounts/${address}/state`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000)
        });

        if (r.ok) {
          const data = await r.json();
          const accountData = data.data || data;
          const accountID = accountData.aid || accountData.accountID || accountData.id || accountData.account_id;

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

      logAudit('account_id_not_found', { address: address.slice(0, 10) + '...' });
      return res.json({
        ok: true,
        accountID: null,
        address,
        exists: false,
        message: 'No SoDEX account found. Please deposit USDC first.',
        depositUrl: isTestnet ? 'https://testnet.sodex.com' : 'https://sodex.com'
      });
    }

    if (action === 'prepare-add-key' && req.method === 'POST') {
      const body = req.body || {};
      const { accountID, keyName, keyPublicKey } = body;

      if (!accountID || !keyName || !keyPublicKey) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Missing accountID, keyName, or keyPublicKey' 
        });
      }

      logAudit('prepare_add_key', { 
        accountID: String(accountID).slice(0, 6) + '...', 
        keyName: keyName.slice(0, 10) 
      });

      const domain = {
        name: "universal",
        version: "1",
        chainId: isTestnet ? 138565 : 286623,
        verifyingContract: "0x0000000000000000000000000000000000000000"
      };

      const nonce = Date.now();

      const message = {
        chainID: isTestnet ? 138565 : 286623,
        nonce: nonce,
        accountID: parseInt(accountID),
        name: keyName,
        keyType: 1,
        publicKey: keyPublicKey,
        expiresAt: 0
      };

      logAudit('prepare_add_key_success', { keyName: keyName.slice(0, 10), nonce });

      return res.json({
        ok: true,
        domain,
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" }
          ],
          UserSignedAddAPIKeyAction: [
            { name: 'chainID', type: 'uint64' },
            { name: 'nonce', type: 'uint64' },
            { name: 'accountID', type: 'uint64' },
            { name: 'name', type: 'string' },
            { name: 'keyType', type: 'uint8' },
            { name: 'publicKey', type: 'bytes' },
            { name: 'expiresAt', type: 'uint64' }
          ]
        },
        primaryType: 'UserSignedAddAPIKeyAction',
        message,
        nonce,
        instructions: 'Sign with master wallet using eth_signTypedData_v4. Prepend 0x02 to signature bytes.'
      });
    }

    if (action === 'submit-add-key' && req.method === 'POST') {
      const body = req.body || {};
      const { accountID, keyName, keyPublicKey, masterSign, masterNonce } = body;

      if (!accountID || !keyName || !keyPublicKey || !masterSign || !masterNonce) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Missing accountID, keyName, keyPublicKey, masterSign, or masterNonce' 
        });
      }

      logAudit('submit_add_key', { 
        keyName: keyName.slice(0, 10),
        signature: masterSign.slice(0, 20) + '...'
      });

      const r = await fetch(`${base}/trade/addAPIKey`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          accountID: parseInt(accountID),
          name: keyName,
          type: 1,
          publicKey: keyPublicKey,
          expiresAt: 0,
          masterSign: masterSign,
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

      logAudit('submit_add_key_success', { keyName: keyName.slice(0, 10) });

      return res.json({
        ok: true,
        key: data.data || data,
        message: 'API key registered successfully. Save your private key securely.'
      });
    }

    if (action === 'list-keys') {
      const { accountID } = req.query;
      if (!accountID) return res.status(400).json({ ok: false, error: 'accountID required' });

      logAudit('list_keys', { accountID: String(accountID).slice(0, 6) + '...' });

      return res.json({
        ok: true,
        keys: [],
        message: 'Key listing requires on-chain query. Use account state endpoint.'
      });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });

  } catch (e) {
    logAudit('setup_error', { action }, 'error', e.message);
    console.error('Setup error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}
