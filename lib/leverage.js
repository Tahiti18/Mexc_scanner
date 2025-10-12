// lib/leverage.js
// Lazily fetch & cache MEXC USDT-M Perpetual max leverage per symbol.
// Non-blocking: returns cached value (or null) immediately; updates cache in background.

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h (adjust if you like)
const levCache = new Map(); // SYMBOL -> { lev: number, ts: ms }

// Normalize symbols to 'BASE_USDT' uppercase
function normSymbol(raw) {
  if (!raw) return null;
  const s = String(raw).toUpperCase().replace(/[^A-Z0-9_]/g, '');
  if (s.includes('_')) return s;
  // If someone sent 'BTCUSDT', convert to 'BTC_USDT'
  const m = s.match(/^([A-Z0-9]+)(USDT)$/);
  if (m) return `${m[1]}_${m[2]}`;
  return s;
}

// hit MEXC contract (futures) detail endpoint; returns integer or null
async function fetchLeverage(sym) {
  const symbol = normSymbol(sym);
  if (!symbol) return null;

  const url = `https://contract.mexc.com/api/v1/contract/detail?symbol=${encodeURIComponent(symbol)}`;

  try {
    const r = await fetch(url, { timeout: 8000 });
    if (!r.ok) return null;
    const j = await r.json();

    // MEXC tends to return { code: 0, data: { ... } }
    const data = j?.data || j;
    // Try a few likely keys
    const lev =
      data?.maxLeverage ??
      data?.max_leverage ??
      data?.max_lever ??
      null;

    if (lev == null) return null;

    const levNum = Number(lev);
    if (!Number.isFinite(levNum) || levNum <= 0) return null;

    return Math.round(levNum);
  } catch (e) {
    return null;
  }
}

// Public: quick read (sync) + opportunistic refresh
function peek(symbol) {
  const k = normSymbol(symbol);
  if (!k) return null;
  const rec = levCache.get(k);
  if (!rec) return null;
  return rec.lev;
}

// Public: ensure cache for a symbol (async, background)
async function ensure(symbol) {
  const k = normSymbol(symbol);
  if (!k) return null;

  const now = Date.now();
  const rec = levCache.get(k);
  if (rec && (now - rec.ts) < CACHE_TTL_MS) return rec.lev;

  const lev = await fetchLeverage(k);
  if (lev != null) levCache.set(k, { lev, ts: now });
  return lev ?? null;
}

// Helper: attach (non-blocking). Returns a shallow copy with max_lev if cached.
function attachSync(alert) {
  try {
    const a = { ...alert };
    const lev = peek(a.symbol);
    if (lev != null) a.max_lev = lev; // add only if known
    // Trigger background refresh without awaiting
    ensure(a.symbol);
    return a;
  } catch {
    return alert;
  }
}

// Batch attach for arrays (non-blocking)
function attachSyncMany(arr) {
  return Array.isArray(arr) ? arr.map(attachSync) : arr;
}

module.exports = {
  attachSync,
  attachSyncMany,
  ensure,   // exported in case you want to prewarm
  peek,     // quick read
};
