// /api/_etf.js — ETF flows WITHOUT SoSoValue.
// Source: Farside Investors public tables (the standard public BTC ETF flow source).
// Stability layer: last good result cached in Redis, served flagged stale if Farside blocks us.
// Underscore prefix = Vercel does not expose this file as its own endpoint.

import { Redis } from '@upstash/redis';

const URLS = [
  'https://farside.co.uk/btc/',
  'https://farside.co.uk/bitcoin-etf-flow-all-data/'
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
};

const NAMES = {
  IBIT: 'iShares Bitcoin Trust', FBTC: 'Fidelity Wise Origin Bitcoin Fund',
  GBTC: 'Grayscale Bitcoin Trust', ARKB: 'ARK 21Shares Bitcoin ETF',
  BITB: 'Bitwise Bitcoin ETF', HODL: 'VanEck Bitcoin ETF',
  BTCO: 'Invesco Galaxy Bitcoin ETF', BTCW: 'WisdomTree Bitcoin Trust',
  BRRR: 'Valkyrie Bitcoin Fund', EZBC: 'Franklin Templeton Digital Holdings Trust',
  DEFI: 'Hashdex Bitcoin ETF', MSBT: 'Morgan Stanley Bitcoin Trust'
};

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const CACHE_KEY = 'etf:last';

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const clean = s => s
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

// "(83.1)" -> -83.1 | "-" / "" -> null | "12.4" -> 12.4
function num(s) {
  const t = String(s || '').replace(/[$,\s]/g, '');
  if (!t || t === '-' || t === '–') return null;
  const neg = /^\(.*\)$/.test(t);
  const v = parseFloat(t.replace(/[()]/g, ''));
  if (!isFinite(v)) return null;
  return neg ? -v : v;
}

// "18 Jun 2024" -> UTC ms, else null (also filters Total/Average/Max/Min/Fee rows)
function parseDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  return Date.UTC(+m[3], mon, +m[1]);
}

function parseFarside(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const tbl = tables.find(t => /IBIT/.test(t));
  if (!tbl) return null;
  const rows = (tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [])
    .map(r => (r.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map(clean));
  const hi = rows.findIndex(r => r.some(c => c.toUpperCase() === 'IBIT'));
  if (hi < 0) return null;
  const header = rows[hi].map(h => h.toUpperCase());
  const data = [];
  for (const r of rows.slice(hi + 1)) {
    const ts = parseDate(r[0]);
    if (!ts) continue;
    const flows = {};
    header.forEach((h, i) => { if (i > 0 && h) flows[h] = num(r[i]); });
    data.push({ ts, flows });
  }
  return data.length ? data : null;
}

// Newest row where at least one fund has actually reported (today's row is often all dashes)
function latestReported(data) {
  return [...data]
    .sort((a, b) => b.ts - a.ts)
    .find(d => Object.entries(d.flows).some(([k, v]) => k !== 'TOTAL' && v !== null));
}

function build(row) {
  const etfs = Object.entries(row.flows)
    .filter(([k, v]) => k !== 'TOTAL' && v !== null)
    .map(([ticker, v]) => ({ ticker, name: NAMES[ticker] || ticker, netInflow: v * 1e6 })); // US$m -> USD
  const sum = etfs.reduce((a, b) => a + b.netInflow, 0);
  const totalNet = row.flows.TOTAL != null ? row.flows.TOTAL * 1e6 : sum;
  etfs.sort((a, b) => Math.abs(b.netInflow) - Math.abs(a.netInflow));
  const nonZero = etfs.filter(e => e.netInflow !== 0);
  return {
    etfs: nonZero.length ? nonZero.slice(0, 12) : etfs.slice(0, 10),
    totalNet,
    totalAssets: 0, // Farside does not publish AUM
    date: new Date(row.ts).toISOString().slice(0, 10)
  };
}

async function fetchFarside(attempts) {
  for (const url of URLS) {
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      if (!r.ok) { attempts.push({ url, status: r.status, note: 'HTTP error (likely Cloudflare block)' }); continue; }
      const html = await r.text();
      const data = parseFarside(html);
      const row = data && latestReported(data);
      if (!row) { attempts.push({ url, status: r.status, note: `parse failed (${html.length} bytes)` }); continue; }
      attempts.push({ url, status: r.status, note: 'ok', rows: data.length });
      return build(row);
    } catch (e) {
      attempts.push({ url, status: 0, note: e.message });
    }
  }
  return null;
}

async function saveCache(payload) {
  try {
    const redis = getRedis();
    if (redis) await redis.set(CACHE_KEY, JSON.stringify({ ...payload, savedAt: Date.now() }));
  } catch (e) { console.error('ETF cache save failed:', e.message); }
}

async function loadCache() {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const v = await redis.get(CACHE_KEY);
    if (!v) return null;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (e) { console.error('ETF cache load failed:', e.message); return null; }
}

export async function etfFlows(req, res) {
  const attempts = [];
  const live = await fetchFarside(attempts);

  if (live) {
    await saveCache(live);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    return res.json({ ok: true, data: live, source: 'Farside', sosoUsed: false, stale: false });
  }

  res.setHeader('Cache-Control', 'no-store');
  const cached = await loadCache();
  if (cached?.etfs?.length) {
    return res.json({
      ok: true,
      data: { etfs: cached.etfs, totalNet: cached.totalNet, totalAssets: 0, date: cached.date },
      source: 'Farside (cached)', sosoUsed: false, stale: true, cachedAt: cached.savedAt, attempts
    });
  }

  return res.status(200).json({
    ok: false,
    error: 'ETF flow source unavailable and no cached data yet',
    attempts
  });
}
