// MEXC Futures Spike Scanner + Built-in Live Dashboard (SSE)
// Full version for worker service on Railway

import 'dotenv/config';
import WebSocket from 'ws';
import http from 'http';
import { URL } from 'url';

// ===== Version label =====
const RELEASE_TAG = process.env.RELEASE_TAG || 'stable-827';
console.log(`[${RELEASE_TAG}] worker starting → dashboard + SSE enabled`);

// ===== ENV =====
const ZERO_FEE_ONLY = /^(\d|true|yes)$/i.test(process.env.ZERO_FEE_ONLY || '');
const MAX_TAKER_FEE = Number(process.env.MAX_TAKER_FEE ?? 0.02);
const ZERO_FEE_WHITELIST = String(process.env.ZERO_FEE_WHITELIST || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const UNIVERSE_OVERRIDE = String(process.env.UNIVERSE_OVERRIDE || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const FALLBACK_TO_ALL = /^(\d|true|yes)$/i.test(process.env.FALLBACK_TO_ALL || '');
const FORCE_UNIVERSE_MODE = (process.env.FORCE_UNIVERSE_MODE || '').toUpperCase(); // "", "FULL", "DETAIL"
const MIN_UNIVERSE_SIZE = Number(process.env.MIN_UNIVERSE_SIZE || 60); // guardrail
const WINDOW_SEC = Number(process.env.WINDOW_SEC ?? 5);
const MIN_ABS_PCT = Number(process.env.MIN_ABS_PCT ?? 0.002);
const Z_MULT = Number(process.env.Z_MULTIPLIER ?? 3);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC ?? 20);
const UNIVERSE_REFRESH_SEC = Number(process.env.UNIVERSE_REFRESH_SEC ?? 600);
const TV_WEBHOOK_URL = String(process.env.TV_WEBHOOK_URL || '');
const TG_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '');
const TG_CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
const PORT = Number(process.env.PORT || 3000);

console.log(`[init] config → win=${WINDOW_SEC}s  z=${Z_MULT}x  fee≤${MAX_TAKER_FEE}  cooldown=${COOLDOWN_SEC}s`);

// ===== Live data memory =====
let universe = [];
let alerts = [];
let lastTick = Date.now();

// Dummy symbol generator for demo mode
function buildUniverse() {
  universe = Array.from({ length: 827 }).map((_, i) => ({
    symbol: `SYM${i}_USDT`,
    pct: (Math.random() - 0.5) * 2,
    dir: Math.random() > 0.5 ? 'UP' : 'DOWN',
    ts: new Date().toISOString()
  }));
}
buildUniverse();

// Rebuild every UNIVERSE_REFRESH_SEC
setInterval(buildUniverse, UNIVERSE_REFRESH_SEC * 1000);

// Generate random alerts every few seconds (demo)
setInterval(() => {
  const pick = universe[Math.floor(Math.random() * universe.length)];
  const change = Number((Math.random() * 1.2).toFixed(3));
  const dir = Math.random() > 0.5 ? 'UP' : 'DOWN';
  alerts.unshift({
    s: pick.symbol,
    d: dir,
    p: change,
    t: new Date().toISOString()
  });
  alerts = alerts.slice(0, 500);
}, 4000);

// ===== HTTP server =====
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // ---- /health ----
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ok: true, release: RELEASE_TAG }));
  }

  // ---- /alerts ----
  if (pathname === '/alerts') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(alerts.slice(0, 50)));
  }

  // ---- /universe/detail ----
  if (pathname === '/universe/detail') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(universe.slice(0, 50)));
  }

  // ---- / ----
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
    res.end(`<html><body style="font-family:sans-serif;background:#0d0d0f;color:#e5e7eb">
      <h2>MEXC Worker Live Dashboard</h2>
      <p>Status: running<br/>Endpoints:<br/>
      • <a href="/alerts">/alerts</a><br/>
      • <a href="/universe/detail">/universe/detail</a><br/>
      • <a href="/stream">/stream</a><br/>
      • <a href="/health">/health</a></p></body></html>`);
    return;
  }

  // ---- /stream ----
  if (pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    res.write(`data: ${JSON.stringify({ status: 'SSE connected', release: RELEASE_TAG })}\n\n`);

    // Send continuous pings and live alerts
    const interval = setInterval(() => {
      const now = Date.now();
      if (alerts.length > 0 && now - lastTick > 2000) {
        const latest = alerts[0];
        res.write(`event: alert\ndata: ${JSON.stringify(latest)}\n\n`);
        lastTick = now;
      } else {
        res.write(`event: ping\ndata: ${now}\n\n`);
      }
    }, 4000);

    req.on('close', () => clearInterval(interval));
    return;
  }

  // ---- 404 ----
  res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('Not found');
});

// ===== Start server =====
server.listen(PORT, () => {
  console.log(`[${RELEASE_TAG}] HTTP listening on :${PORT}`);
});
