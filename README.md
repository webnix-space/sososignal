OnchainEdge v2.1 — AI Crypto Terminal
Institutional crypto intelligence for solo traders. Real-time AI signals, EIP-712 testnet trading, WebSocket price feeds, and paper trading — all in one dashboard.

🚀 What’s New in v2.1
Feature
Before
After
Live Data
5-min cache, static fallbacks
WebSocket real-time, no cache
Crypto Stocks
Not showing
MSTR, COIN, MARA, RIOT, CLSK, HOOD
Trading
Fake demo (undefined)
Real EIP-712 on SoDEX testnet
Symbol Picker
Fixed BTC/ETH/SOL/BNB tabs
Dropdown + dynamic market selection
API Key Setup
Manual, no docs
5-step wizard in UI
Paper Trading
Not available
Virtual USDC, P&L tracking, localStorage
AI Chat
Not available
Natural language market analyst
Backtest
Not available
7/30/90 day “What If?” simulator
Signal Audit
Not available
History trail with confidence scores
Deployment
Manual Vercel CLI
GitHub Actions auto-deploy


📁 File Structure
onchainedge/
├── .github/
│   └── workflows/
│       └── deploy.yml          # CI/CD: lint → preview → prod
├── api/
│   ├── sodex.js                # Live prices (no cache, no fallbacks)
│   ├── soso.js                 # SoSoValue data (ETF, SSI, treasury, stocks)
│   ├── trade.js                # SoDEX testnet trading (prepare + submit)
│   ├── setup.js                # API Key registration wizard
│   ├── ws.js                   # WebSocket proxy (SSE real-time feed)
│   ├── signal.js               # AI signal generation (Groq)
│   ├── news.js                 # Market news
│   └── history.js              # Signal history (Redis)
├── index.html                  # Complete frontend (v2.1)
├── package.json                # Dependencies & scripts
├── vercel.json                 # Vercel routing & headers
├── .eslintrc.js               # Linting config
├── .gitignore                  # Standard ignores
└── README.md                   # This file

🛠️ Quick Start
1. Clone & Install
git clone https://github.com/webnix-space/sososignal.git
cd sososignal
npm install
2. Environment Variables
Create .env.local:
SOSO_API_KEY=your_sosovalue_api_key
GROQ_API_KEY=your_groq_api_key

# Optional (for history/backtest)
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
3. Local Development
npm run dev          # Vercel dev server
4. Deploy
# Manual
npm run deploy

# Or push to GitHub (auto-deploy via Actions)
git push origin main

🔧 GitHub Actions Setup
Required Secrets
Go to Settings → Secrets and variables → Actions and add:
Secret
How to get
VERCEL_TOKEN
vercel.com/account/tokens
VERCEL_ORG_ID
Run vercel teams list or check .vercel/project.json
VERCEL_PROJECT_ID
Check .vercel/project.json after first deploy
SLACK_WEBHOOK_URL
Slack apps (optional)

Workflow
Push to PR    → Lint → Deploy Preview → Comment URL
Push to main  → Lint → Deploy Prod → Health Check → Slack Notify

📡 API Endpoints
Market Data
Endpoint
Description
GET /api/sodex?t=123&testnet=1
Live SoDEX prices
GET /api/soso?type=prices
SoSoValue prices
GET /api/soso?type=etf-flows
ETF net flows
GET /api/soso?type=sector
SSI sector indices
GET /api/soso?type=treasury
BTC treasury holdings
GET /api/soso?type=crypto-stocks
Crypto stocks
GET /api/news
Market news

Trading
Endpoint
Description
GET /api/trade?action=account-state&address=0x...
Account details
GET /api/trade?action=markets
SoDEX market list
POST /api/trade?action=prepare-order
Generate order payload
POST /api/trade?action=submit-order
Submit signed order

API Key Setup
Endpoint
Description
GET /api/setup?action=guide
Setup guide JSON
GET /api/setup?action=account-id&address=0x...
Get account ID
POST /api/setup?action=prepare-add-key
Prepare registration
POST /api/setup?action=submit-add-key
Register API key
GET /api/setup?action=list-keys&accountID=123
List keys

WebSocket
Endpoint
Description
GET /api/ws?stream=prices
SSE real-time prices
GET /api/ws?snapshot=1
REST snapshot

AI & History
Endpoint
Description
POST /api/signal
AI signal generation
GET /api/history?action=get&asset=BTC
Signal history
POST /api/history?action=add
Save signal to audit
GET /api/simulate?asset=BTC&days=30
Backtest simulation


🔑 SoDEX Testnet Setup
Using the Built-in Wizard (Recommended)
Open the app → Click “🔑 Setup API Key”
Connect MetaMask (master wallet)
Get Account ID (fetches from blockchain)
Generate API Key (creates EVM keypair)
Prepare → Sign & Register (MetaMask popup)
Save private key securely
Close modal → fill Account ID + API Key Name in trade panel
Manual Setup
# 1. Get account ID
curl "https://your-app.vercel.app/api/setup?action=account-id&address=0xYourAddress"

# 2. Prepare addAPIKey
curl -X POST "https://your-app.vercel.app/api/setup?action=prepare-add-key" \
  -H "Content-Type: application/json" \
  -d '{"accountID":12345,"keyName":"api-key-01","keyPublicKey":"0x..."}'

# 3. Sign with master wallet (ethers.js _signTypedData)
# 4. Submit
curl -X POST "https://your-app.vercel.app/api/setup?action=submit-add-key" \
  -H "Content-Type: application/json" \
  -d '{"params":{...},"masterSign":"0x01...","masterNonce":1234567890}'

🌐 WebSocket Real-Time Feed
Connects directly to SoDEX WebSocket:
const ws = new WebSocket('wss://testnet-gw.sodex.dev/ws/spot');
ws.send(JSON.stringify({
  op: 'subscribe',
  args: ['ticker:BTC_USDC', 'ticker:ETH_USDC']
}));

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  console.log(msg.data.lastPrice); // Instant update!
};
Features: - ⚡ Instant updates — no polling delay - 🔄 Auto-reconnect — 3s delay, max 5 retries - 💓 Heartbeat — every 15s - ✨ Flash animation — on price change - 📡 Fallback to REST — if WS fails

⚡ Trading Flow
User picks symbol → Price auto-fills from WS
     ↓
Enter qty, price, API key name, account ID
     ↓
[Prepare Order] → Backend generates EIP-712 payload
     ↓
[Sign & Submit] → MetaMask signs typed data
     ↓
Backend proxies to SoDEX testnet
     ↓
Order confirmed on-chain
EIP-712 Domain (Testnet)
{
  "name": "spot",
  "version": "1",
  "chainId": 138565,
  "verifyingContract": "0x0000000000000000000000000000000000000000"
}
Critical Constraints
Constraint
Value
API key name
^[0-9a-zA-Z_-]{1,36}$, not "default"
Nonce
Unique, > previous, within (T-2d, T+1d)
Price/quantity
Strings: "0.001" not 0.001
Signature
0x01 prefix for typed signature
Max API keys
5 per account


📋 Paper Trading
Practice with virtual USDC — no real funds at risk.
Starting balance: $10,000 USDC
Positions: Track avg price, qty, unrealized P&L
History: Last 20 trades with realized P&L
Live mark-to-market: Updates every 30s via WebSocket
Persistence: localStorage (survives refresh)

🤖 AI Signal Engine
Powered by Groq Llama-3.1:
Signal: BUY / SELL / HOLD
Confidence: 0-100%
Reasoning: Natural language market analysis
Factors: ETF flows, SSI momentum, price action, fear & greed
Risk Check: Verdict + score + warnings
Targets: Stop-loss and take-profit levels
Audit Trail: Every signal saved with timestamp

🧪 Testing
# Run linter
npm run lint

# Fix linting issues
npm run lint:fix

# Run tests
npm test

# Deploy preview
npm run deploy:preview

# Deploy production
npm run deploy

🚨 Troubleshooting
Issue
Solution
“All price sources unavailable”
Check SoDEX API status, CoinGecko rate limit
“No SoDEX account found”
Deposit USDC on testnet.sodex.com
“Signature invalid”
Ensure nonce is unique, API key registered
WS not connecting
Check firewall, try REST fallback
“Redis not configured”
Optional — only affects history/backtest
Build warnings about CommonJS
Add "type": "module" to package.json
JS syntax error at load
Check for stray ; } tokens or missing braces in index.html


📚 Resources
SoDEX Trading API Docs
SoDEX Testnet
SoSoValue API Docs
Groq Console
Vercel Docs

📄 License
MIT © webnix-space
