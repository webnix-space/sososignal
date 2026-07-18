// SoDEX API Key Setup Helper
// Guides users through EIP-712 addAPIKey signing

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    // Return setup instructions and required fields
    return res.json({
      ok: true,
      instructions: {
        step1: 'Connect your MetaMask wallet to ValueChain',
        step2: 'Get your accountID from /accounts/{address}/state',
        step3: 'Generate a new EVM keypair for your API key',
        step4: 'Sign addAPIKey with your master wallet (EIP-712)',
        step5: 'Use the API key name in X-API-Key header for all trading'
      },
      chainIds: {
        mainnet: 286623,
        testnet: 138565
      },
      endpoints: {
        spot_mainnet: 'https://mainnet-gw.sodex.dev/api/v1/spot',
        spot_testnet: 'https://testnet-gw.sodex.dev/api/v1/spot',
        ws_mainnet: 'wss://mainnet-gw.sodex.dev/ws/spot',
        ws_testnet: 'wss://testnet-gw.sodex.dev/ws/spot'
      },
      eip712Domain: {
        name: 'universal',
        version: '1',
        verifyingContract: '0x0000000000000000000000000000000000000000'
      },
      addAPIKeyTypes: {
        UserSignedAddAPIKeyAction: [
          { name: 'chainID', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
          { name: 'accountID', type: 'uint64' },
          { name: 'name', type: 'string' },
          { name: 'keyType', type: 'uint8' },
          { name: 'publicKey', type: 'bytes' },
          { name: 'expiresAt', type: 'uint64' }
        ]
      }
    });
  }

  if (req.method === 'POST') {
    // Proxy addAPIKey request to SoDEX
    const { chainId, endpoint, signedPayload } = req.body;

    if (!chainId || !endpoint || !signedPayload) {
      return res.status(400).json({ ok: false, error: 'Missing chainId, endpoint, or signedPayload' });
    }

    try {
      const r = await fetch(`${endpoint}/accounts/addAPIKey`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-Chain': String(chainId)
        },
        body: JSON.stringify(signedPayload),
        signal: AbortSignal.timeout(15000)
      });

      const data = await r.json();
      return res.status(r.status).json({ ok: r.ok, data });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'GET or POST only' });
}
