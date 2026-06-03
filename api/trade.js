// /api/trade.js
// Simulated SoDEX EIP-712 Signed Order Execution
// Shows the full signing pipeline without exposing real private keys

import { keccak256, toUtf8Bytes } from 'ethers';

const SODEX_SPOT_ENDPOINT = 'https://mainnet-gw.sodex.dev/api/v1/spot';
const SODEX_DOMAIN = {
  name: "spot",
  version: "1",
  chainId: 286623,
  verifyingContract: "0x0000000000000000000000000000000000000000"
};

// Symbol ID mapping for SoDEX
const SYMBOL_IDS = {
  'BTC': 1,   // vBTC_vUSDC
  'ETH': 2,   // vETH_vUSDC
  'SOL': 3,   // vSOL_vUSDC
  'BNB': 4,   // vBNB_vUSDC
  'SOSO': 5   // WSOSO_vUSDC
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { asset, side, size, price, accountID, apiKeyName = 'api-key-01' } = req.body;
  
  if (!asset || !side || !size) {
    return res.status(400).json({ error: 'asset, side, size required' });
  }

  const symbolID = SYMBOL_IDS[asset] || 1;
  const isLimit = !!price;
  const now = Date.now();
  const clOrdID = `oe-${asset.toLowerCase()}-${now}`;

  // Build the payload for signing
  const payload = {
    type: "newOrder",
    params: {
      accountID: accountID || 12345,
      orders: [{
        symbolID: symbolID,
        clOrdID: clOrdID,
        side: side === 'BUY' ? 1 : 2,
        type: isLimit ? 1 : 2, // 1=Limit, 2=Market
        timeInForce: 1, // GTC
        ...(isLimit ? { price: String(price) } : {}),
        quantity: String(size),
        reduceOnly: false
      }]
    }
  };

  // Compact JSON — no whitespace (critical for signature verification)
  const payloadStr = JSON.stringify(payload);
  const payloadHash = keccak256(toUtf8Bytes(payloadStr));

  // EIP-712 message
  const message = {
    payloadHash: payloadHash,
    nonce: now
  };

  // Build the full EIP-712 typed data structure
  const typedData = {
    types: {
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
    },
    domain: SODEX_DOMAIN,
    primaryType: "ExchangeAction",
    message: message
  };

  // Simulate signature (66 bytes: 0x01 + 65-byte ECDSA)
  // In production, this would be: await wallet.signTypedData(domain, types, message)
  const mockSignature = "0x01" + "0".repeat(130);

  // Build the curl command for manual execution
  const httpBody = JSON.stringify(payload.params); // HTTP body is just params, no type wrapper
  const curlCommand = `curl -X POST ${SODEX_SPOT_ENDPOINT}/trade/orders \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json' \\
  -H 'X-API-Key: ${apiKeyName}' \\
  -H 'X-API-Sign: ${mockSignature}' \\
  -H 'X-API-Nonce: ${now}' \\
  -d '${httpBody}'`;

  return res.json({
    ok: true,
    simulated: true,
    asset,
    side,
    size,
    price: price || null,
    orderType: isLimit ? 'LIMIT' : 'MARKET',
    
    // Full EIP-712 signing pipeline (transparent)
    signingPipeline: {
      step1: "Build payload JSON (compact, field order exact)",
      payload: payloadStr,
      
      step2: "Compute payloadHash = keccak256(payload)",
      payloadHash: payloadHash,
      
      step3: "Build EIP-712 typed data",
      domain: SODEX_DOMAIN,
      primaryType: "ExchangeAction",
      message: message,
      fullTypedData: typedData,
      
      step4: "Sign with API key private key (EIP-712)",
      signatureFormat: "0x01 + 65-byte ECDSA sig (66 bytes total)",
      signatureType: "EIP-712 typed signature",
      
      step5: "Send to SoDEX REST API",
      endpoint: `${SODEX_SPOT_ENDPOINT}/trade/orders`,
      headers: {
        "X-API-Key": apiKeyName,
        "X-API-Sign": "[66-byte signature]",
        "X-API-Nonce": String(now)
      }
    },
    
    // Ready-to-execute command
    curlCommand: curlCommand,
    
    // Order details
    orderDetails: {
      symbolID,
      clOrdID,
      side: side === 'BUY' ? 'BUY (1)' : 'SELL (2)',
      type: isLimit ? 'LIMIT (1)' : 'MARKET (2)',
      timeInForce: 'GTC (1)',
      quantity: String(size),
      price: price ? String(price) : null
    },
    
    // Educational notes
    notes: [
      "This is a SIMULATED execution for the hackathon demo.",
      "Real execution requires: (1) SoDEX account with API key registered, (2) API key private key for signing, (3) Sufficient USDC balance.",
      "The payloadHash uses compact JSON with exact Go struct field order.",
      "DecimalString fields (price, quantity) must be quoted strings, not numbers.",
      "The 0x01 prefix indicates EIP-712 typed signature (not raw ECDSA).",
      "SoDEX uses separate nonce counters per API key (millisecond unix timestamp)."
    ],
    
    // Next steps for real execution
    nextSteps: {
      testnet: "Use https://testnet-gw.sodex.dev/api/v1/spot with chainId 138565",
      registerAPIKey: "POST /account/api-keys with master wallet signature",
      getAccountID: "GET /accounts/{address}/state",
      goSDK: "github.com/sodex-tech/sodex-go-sdk-public"
    }
  });
}
