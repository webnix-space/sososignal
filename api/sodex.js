// SoDEX API — fixed with correct endpoints & field names from whitepaper
const SPOT_BASE = 'https://mainnet-gw.sodex.dev/api/v1/spot';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Try SoDEX first (primary source)
  const endpoints = [
    `${SPOT_BASE}/markets/tickers`,    // 24hr rolling window stats
    `${SPOT_BASE}/markets/coins`,      // all coin info
    `${SPOT_BASE}/markets/symbols`,    // trading rules
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: { 
          'Accept': 'application/json', 
          'User-Agent': 'OnchainEdge/2.0' 
        },
        signal: AbortSignal.timeout(8000)
      });
      
      if (!r.ok) { 
        console.error(`SoDEX ${url}: HTTP ${r.status}`); 
        continue; 
      }

      const raw = await r.json();
      
      // SoDEX returns { code: 0, timestamp, data: [...] }
      const items = raw?.data || raw?.tickers || raw?.result || [];
      if (!items.length) continue;

      // Map SoDEX symbols to display names
      const symbolMap = {
        'vBTC_vUSDC':  'BTC/USDC',
        'vETH_vUSDC':  'ETH/USDC',
        'vSOL_vUSDC':  'SOL/USDC',
        'vBNB_vUSDC':  'BNB/USDC',
        'WSOSO_vUSDC': 'SOSO/USDC',
      };

      const parsed = items
        .filter(t => symbolMap[t.symbol]) // Only keep symbols we care about
        .map(t => {
          // SoDEX field names from real API response
          const priceRaw = t.lastPx ?? t.lastPrice ?? t.price ?? t.close ?? null;
          const price = parseFloat(priceRaw);
          
          if (priceRaw === null || priceRaw === undefined || !isFinite(price) || price <= 0) {
            console.error('SoDEX item missing price:', JSON.stringify(t).slice(0, 100));
            return null;
          }

          const changePct = t.changePct ?? t.priceChangePercent ?? t.changePercent ?? 0;
          const vol = t.volume ?? t.baseVolume ?? t.base_volume ?? t.vol ?? 0;
          const qVol = t.quoteVolume ?? t.quote_volume ?? t.quoteVol ?? 0;

          return {
            symbol:      symbolMap[t.symbol] || t.symbol,
            lastPrice:   String(price),
            priceChange: String((parseFloat(changePct) || 0).toFixed(2)),
            volume:      String(Math.round(parseFloat(vol) || 0)),
            quoteVolume: String(Math.round(parseFloat(qVol) || 0)),
            source:      'sodex-live'
          };
        })
        .filter(x => x && x.symbol);

      if (parsed.length > 0) {
        return res.json({ ok: true, data: parsed, source: 'sodex-live' });
      }
    } catch (e) {
      console.error(`SoDEX endpoint ${url}:`, e.message);
    }
  }

  // CoinGecko fallback when SoDEX fails
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true',
      { signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const d = await r.json();
      const pairs = [
        { id: 'bitcoin',     sym: 'BTC/USDC' },
        { id: 'ethereum',    sym: 'ETH/USDC' },
        { id: 'solana',      sym: 'SOL/USDC' },
        { id: 'binancecoin', sym: 'BNB/USDC' },
      ].filter(x => d[x.id]?.usd > 0).map(x => ({
        symbol:      x.sym,
        lastPrice:   String(d[x.id].usd),
        priceChange: String((d[x.id].usd_24h_change || 0).toFixed(2)),
        volume:      String(Math.round(d[x.id].usd_24h_vol || 0)),
        quoteVolume: String(Math.round(d[x.id].usd_24h_vol || 0)),
        source:      'coingecko'
      }));

      // SOSO from SoDEX static (last known good price)
      pairs.push({
        symbol:      'SOSO/USDC',
        lastPrice:   '0.3839',
        priceChange: '-2.88',
        volume:      '3306932',
        quoteVolume: '1289408',
        source:      'coingecko'
      });

      return res.json({ ok: true, data: pairs, source: 'coingecko' });
    }
  } catch (e) { 
    console.error('CoinGecko fallback:', e.message); 
  }

  // Last resort static fallback
  return res.json({
    ok: true,
    source: 'static',
    data: [
      { symbol: 'BTC/USDC',  lastPrice: '80860',   priceChange: '-0.43',  volume: '1',       quoteVolume: '146204',  source: 'static' },
      { symbol: 'ETH/USDC',  lastPrice: '2288.9',  priceChange: '-1.76',  volume: '15',      quoteVolume: '36943',   source: 'static' },
      { symbol: 'SOL/USDC',  lastPrice: '95.22',   priceChange: '0.44',   volume: '402',     quoteVolume: '38797',   source: 'static' },
      { symbol: 'BNB/USDC',  lastPrice: '661.2',   priceChange: '0.99',   volume: '30',      quoteVolume: '20427',   source: 'static' },
      { symbol: 'SOSO/USDC', lastPrice: '0.3839',  priceChange: '-2.88',  volume: '3306932', quoteVolume: '1289408', source: 'static' },
    ]
  });
}
