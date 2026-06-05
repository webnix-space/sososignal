// SoDEX Account Setup — Register API Key with master wallet signature
// One-time setup: connect wallet → get account state → register API key

const TESTNET_SPOT = 'https://testnet-gw.sodex.dev/api/v1/spot';
const TESTNET_PERPS = 'https://testnet-gw.sodex.dev/api/v1/perps';

// EIP-712 Domain for testnet
const SPOT_DOMAIN = {
  name: "spot",
  version: "1",
  chainId: 138565,
  verifyingContract: "0x0000000000000000000000000000000000000000"
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── STEP 1: GET ACCOUNT STATE ─────────────────────────────────
  // Returns account ID, balances, positions for a wallet address
  if (action === 'account-state' && req.method === 'GET') {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });

    try {
      const r = await fetch(`${TESTNET_SPOT}/accounts/${address}/state`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      const data = await r.json();

      return res.json({
        ok: r.ok,
        status: r.status,
        data: data?.data || data,
        // Extract key fields for convenience
        accountID: data?.data?.aid || data?.aid || null,
        balances: data?.data?.balances || data?.balances || [],
        positions: data?.data?.positions || data?.positions || [],
        margin: data?.data?.margin || data?.margin || {},
        raw: data
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── STEP 2: GET ACCOUNT ID ONLY ───────────────────────────────
  if (action === 'account-id' && req.method === 'GET') {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });

    try {
      const r = await fetch(`${TESTNET_SPOT}/accounts/${address}/state`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      const data = await r.json();
      const aid = data?.data?.aid || data?.aid;

      if (!aid) {
        return res.status(404).json({
          ok: false,
          error: 'No SoDEX account found for this address. You need to deposit first.',
          hint: 'Go to https://testnet.sodex.com and deposit USDC to create your account.'
        });
      }

      return res.json({ ok: true, accountID: aid, address });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── STEP 3: PREPARE ADD API KEY ───────────────────────────────
  // Returns the exact payload the master wallet must sign
  if (action === 'prepare-add-key' && req.method === 'POST') {
    const { accountID, keyName, keyPublicKey } = req.body || {};
    if (!accountID || !keyName || !keyPublicKey) {
      return res.status(400).json({
        error: 'accountID, keyName, keyPublicKey required',
        example: {
          accountID: 12345,
          keyName: "api-key-01",
          keyPublicKey: "0x3d4595c8742d0a58173a9963c05755b59a8f8256"
        }
      });
    }

    // Validate key name format
    if (!/^[0-9a-zA-Z_-]{1,36}$/.test(keyName) || keyName === 'default') {
      return res.status(400).json({ error: 'keyName must match ^[0-9a-zA-Z_-]{1,36}$ and cannot be "default"' });
    }

    // Validate EVM address
    if (!/^0x[a-fA-F0-9]{40}$/.test(keyPublicKey)) {
      return res.status(400).json({ error: 'keyPublicKey must be a valid EVM address (0x + 40 hex chars)' });
    }

    const nonce = Date.now();

    const payload = {
      type: "addAPIKey",
      params: {
        accountID: parseInt(accountID),
        name: keyName,
        publicKey: keyPublicKey.toLowerCase()
      }
    };

    // Compact JSON for hashing (Go struct order)
    const compactPayload = JSON.stringify(payload);

    // EIP-712 typed data for master wallet to sign
    const domain = SPOT_DOMAIN;
    const types = {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" }
      ],
      ExchangeAction: [
        { name: "payloadHash", type: "bytes32" },
        { name: "nonce", type: "uint64" }
      ]
    };

    return res.json({
      ok: true,
      payload,
      compactPayload,
      nonce,
      domain,
      types,
      message: {
        payloadHash: "<compute keccak256(compactPayload) on client>",
        nonce: nonce
      },
      instructions: {
        step1: "Generate a new EVM keypair for the API key (or use existing)",
        step2: "Compute payloadHash = keccak256(compactPayload) using ethers.js",
        step3: "Sign EIP-712 typed data with MASTER WALLET (not API key)",
        step4: "Prepend 0x01 to signature for X-API-Sign",
        step5: "POST to /api/setup?action=submit-add-key with X-API-Sign header"
      },
      warnings: [
        "This action MUST be signed by the MASTER WALLET (the one that deposited funds)",
        "The API key private key should be stored securely — it signs ALL future trades",
        "You can have up to 5 API keys per account"
      ]
    });
  }

  // ── STEP 4: SUBMIT ADD API KEY ────────────────────────────────
  // Proxies the signed addAPIKey to SoDEX
  if (action === 'submit-add-key' && req.method === 'POST') {
    const { params, masterSign, masterNonce } = req.body || {};
    if (!params || !masterSign || !masterNonce) {
      return res.status(400).json({ error: 'params, masterSign, masterNonce required' });
    }

    try {
      const r = await fetch(`${TESTNET_SPOT}/account/api-keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-Sign': masterSign,
          'X-API-Nonce': String(masterNonce)
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000)
      });

      const data = await r.json().catch(() => null);
      const text = data || await r.text();

      return res.json({
        ok: r.ok,
        status: r.status,
        data: text,
        message: r.ok
          ? 'API key registered successfully! Save the private key securely.'
          : 'Registration failed. Check error details.'
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── STEP 5: LIST API KEYS ─────────────────────────────────────
  if (action === 'list-keys' && req.method === 'GET') {
    const { accountID } = req.query;
    if (!accountID) return res.status(400).json({ error: 'accountID required' });

    try {
      const r = await fetch(`${TESTNET_SPOT}/accounts/${accountID}/api-keys`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      const data = await r.json();
      return res.json({ ok: r.ok, status: r.status, data: data?.data || data });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── STEP 6: REVOKE API KEY ────────────────────────────────────
  if (action === 'revoke-key' && req.method === 'POST') {
    const { params, masterSign, masterNonce } = req.body || {};
    if (!params || !masterSign || !masterNonce) {
      return res.status(400).json({ error: 'params, masterSign, masterNonce required' });
    }

    try {
      const r = await fetch(`${TESTNET_SPOT}/account/api-keys/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-Sign': masterSign,
          'X-API-Nonce': String(masterNonce)
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000)
      });

      const data = await r.json().catch(() => null);
      return res.json({ ok: r.ok, status: r.status, data });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── STEP 7: COMPLETE SETUP GUIDE ──────────────────────────────
  if (action === 'guide' && req.method === 'GET') {
    return res.json({
      ok: true,
      title: "SoDEX Testnet Setup Guide",
      steps: [
        {
          step: 1,
          title: "Connect Wallet & Deposit",
          description: "Go to https://testnet.sodex.com, connect MetaMask, deposit testnet USDC",
          url: "https://testnet.sodex.com"
        },
        {
          step: 2,
          title: "Get Account ID",
          description: "Call GET /api/setup?action=account-id&address=0x...",
          api: "/api/setup?action=account-id&address={walletAddress}"
        },
        {
          step: 3,
          title: "Generate API Key Pair",
          description: "Generate a new EVM keypair. The public key will be registered, private key signs trades.",
          code: "const wallet = ethers.Wallet.createRandom(); // publicKey = wallet.address, privateKey = wallet.privateKey"
        },
        {
          step: 4,
          title: "Prepare addAPIKey",
          description: "Call POST /api/setup?action=prepare-add-key to get the signing payload",
          api: "POST /api/setup?action=prepare-add-key",
          body: { accountID: "number", keyName: "string", keyPublicKey: "0x..." }
        },
        {
          step: 5,
          title: "Sign with Master Wallet",
          description: "Use ethers.js _signTypedData with the payloadHash and nonce from step 4",
          code: "const sig = await masterSigner._signTypedData(domain, {ExchangeAction:[...]}, {payloadHash, nonce}); const typedSig = '0x01' + sig.slice(2);"
        },
        {
          step: 6,
          title: "Submit to SoDEX",
          description: "Call POST /api/setup?action=submit-add-key with the signature",
          api: "POST /api/setup?action=submit-add-key",
          body: { params: "{accountID, name, publicKey}", masterSign: "0x01...", masterNonce: "number" }
        },
        {
          step: 7,
          title: "Start Trading",
          description: "Use the API key name and private key to sign orders via /api/trade",
          api: "/api/trade?action=prepare-order"
        }
      ],
      endpoints: {
        accountState: "GET /api/setup?action=account-state&address=0x...",
        accountID: "GET /api/setup?action=account-id&address=0x...",
        prepareAddKey: "POST /api/setup?action=prepare-add-key",
        submitAddKey: "POST /api/setup?action=submit-add-key",
        listKeys: "GET /api/setup?action=list-keys&accountID=12345",
        revokeKey: "POST /api/setup?action=revoke-key"
      }
    });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}
