// MEXC Futures Spike Scanner + Live HTTP (HTML + JSON + SSE + Viewer)
// ONE FILE: drop-in for worker/src/index.js
// Endpoints:
//   GET /live          – compact list UI (auto-updating via SSE)
//   GET /sse-viewer    – raw SSE viewer (human-friendly)
//   GET /stream        – Server-Sent Events feed (for apps)
//   GET /alerts        – last N alerts (JSON)
//   GET /healthz       – liveness probe

import 'dotenv/config';
import { WebSocket } from 'ws';
import http from 'http';
import { URL } from 'url';

// ====== Version label ======
const RELEASE_TAG = process.env.RELEASE_TAG || 'stable-827';
console.log(`[${RELEASE_TAG}] worker starting → dashboard + SSE enabled`);

// ====== ENV ======
const ZERO_FEE_ONLY        = /^(1|true|yes)$/i.test(process.env.ZERO_FEE_ONLY || '');
const MAX_TAKER_FEE        = Number(process.env.MAX_TAKER_FEE ?? 0);
const ZERO_FEE_WHITELIST   = String(process.env.ZERO_FEE_WHITELIST || '').split(',').map(s=>s.trim()).filter(Boolean);
const UNIVERSE_OVERRIDE    = String(process.env.UNIVERSE_OVERRIDE || '').split(',').map(s=>s.trim()).filter(Boolean);
const FALLBACK_TO_ALL      = /^(1|true|yes)$/i.test(process.env.FALLBACK_TO_ALL || '');
const FORCE_UNIVERSE_MODE  = (process.env.FORCE_UNIVERSE_MODE || '').toUpperCase(); // "", "FULL", "DETAIL"
const MIN_UNIVERSE         = Number(process.env.MIN_UNIVERSE || 60); // guardrail

const WINDOW_SEC           = Number(process.env.WINDOW_SEC ?? 5);
const MIN_ABS_PCT          = Number(process.env.MIN_ABS_PCT ?? 0.003);
const Z_MULT               = Number(process.env.Z_MULTIPLIER ?? 3.0);
const COOLDOWN_SEC         = Number(process.env.COOLDOWN_SEC ?? 20);
const UNIVERSE_REFRESH_SEC = Number(process.env.UNIVERSE_REFRESH_SEC ?? 600);

const TV_WEBHOOK_URL       = String(process.env.TV_WEBHOOK_URL || '').trim();
const TG_TOKEN             = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT              = String(process.env.TELEGRAM_CHAT_ID || '').trim();

const PORT                 = Number(process.env.PORT || 3000);

// ====== MEXC futures endpoints ======
const BASE = 'https://contract.mexc.com';
const ENDPOINTS = {
  detail : `${BASE}/api/v1/contract/detail`,
  ticker : `${BASE}/api/v1/contract/ticker`,
  symbols: `${BASE}/api/v1/contract/symbols`
};

// ====== helpers ======
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const num = (x, d=0)=> {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const unique = (a)=> Array.from(new Set(a));
const nowISO = ()=> new Date().toISOString();

async function getJSON(url){
  const r = await fetch(url, { headers: { 'accept': 'application/json' }});
  const txt = await r.text();
  try { return { ok: r.ok, json: JSON.parse(txt) }; }
  catch { return { ok: r.ok, json: null, raw: txt }; }
}

function isZeroFeeRow(row){
  const taker = num(row?.takerFeeRate, NaN);
  const maker = num(row?.makerFeeRate, NaN);
  if (!Number.isFinite(taker) || !Number.isFinite(maker)) return false;
  return Math.max(taker, maker) <= (MAX_TAKER_FEE + 1e-12);
}

async function universeFromDetail(){
  const { ok, json } = await getJSON(ENDPOINTS.detail);
  if (!ok || !json) return [];
  const rows = Array.isArray(json?.data) ? json.data : [];
  const all = [];
  for (const r of rows){
    const sym = r?.symbol;
    if (!sym) continue;
    if (r?.state !== 0) continue;           // active only
    if (r?.apiAllowed === false) continue;  // skip restricted
    if (ZERO_FEE_ONLY && !isZeroFeeRow(r)) continue;
    all.push(sym);
  }
  console.log(`[universe/detail] rows=${rows.length} kept=${all.length}`);
  return all;
}

async function universeFromTicker(){
  const { ok, json } = await getJSON(ENDPOINTS.ticker);
  if (!ok || !json) return [];
  const rows = Array.isArray(json?.data) ? json.data : [];
  const symbols = rows.map(r => r?.symbol).filter(Boolean);
  console.log(`[universe/ticker] rows=${rows.length} kept=${symbols.length}`);
  return symbols;
}

async function universeFromSymbols(){
  const { ok, json } = await getJSON(ENDPOINTS.symbols);
  if (!ok || !json) return [];
  const rows = Array.isArray(json?.data) ? json.data
            : Array.isArray(json?.symbols) ? json.symbols
            : [];
  const symbols = rows.map(r => (typeof r === 'string' ? r : r?.symbol)).filter(Boolean);
  console.log(`[universe/symbols] rows=${rows.length} kept=${symbols.length}`);
  return symbols;
}

async function buildUniverse() {
  if (FORCE_UNIVERSE_MODE === 'FULL'){
    const u2 = await universeFromTicker();
    const u3 = await universeFromSymbols();
    let merged = unique([...u2, ...u3, ...UNIVERSE_OVERRIDE, ...ZERO_FEE_WHITELIST]);
    if (merged.length < MIN_UNIVERSE && FALLBACK_TO_ALL) merged = unique([...ZERO_FEE_WHITELIST, ...merged]);
    console.log(`[universe] FORCE=FULL → ${merged.length}`);
    return merged;
  }
  if (FORCE_UNIVERSE_MODE === 'DETAIL'){
    let u1 = await universeFromDetail();
    u1 = unique([...u1, ...UNIVERSE_OVERRIDE, ...ZERO_FEE_WHITELIST]);
    console.log(`[universe] FORCE=DETAIL → ${u1.length}`);
    return u1;
  }

  // default: detail → ticker → symbols (progressive)
  let u1 = [];
  try { u1 = await universeFromDetail(); } catch(e){ console.log('[detail] err', e?.message || e); }

  let u2 = [];
  if (u1.length < 10) {
    try { u2 = await universeFromTicker(); } catch(e){ console.log('[ticker] err', e?.message || e); }
  }

  let u3 = [];
  if (u1.length + u2.length < 10) {
    try { u3 = await universeFromSymbols(); } catch(e){ console.log('[symbols] err', e?.message || e); }
  }

  let merged = unique([...u1, ...u2, ...u3]);

  if (ZERO_FEE_ONLY) {
    const setDetail = new Set(u1);
    const filtered = merged.filter(s => setDetail.has(s));
    console.log(`[universe] ZERO_FEE_ONLY=on → ${merged.length} → ${filtered.length}`);
    merged = filtered;
  }

  if (ZERO_FEE_WHITELIST.length){
    merged = unique([...merged, ...ZERO_FEE_WHITELIST]);
  }
  if (UNIVERSE_OVERRIDE.length){
    merged = unique([...merged, ...UNIVERSE_OVERRIDE]);
  }
  if (merged.length < MIN_UNIVERSE && FALLBACK_TO_ALL) {
    merged = unique([...ZERO_FEE_WHITELIST, ...merged]);
    console.log('[universe] fallback used (MIN_UNIVERSE guard)');
  }

  console.log(`[universe] totals all=${merged.length} zf=${ZERO_FEE_ONLY ? merged.length : 0}`);
  if (merged.length > 0) console.log(`[universe] sample: ${merged.slice(0, 10).join(', ')}`);
  return merged;
}

// ====== Alerts buffer & SSE broadcaster ======
const lastAlerts = [];
const MAX_ALERTS = 500;

const clients = new Set(); // SSE clients

function pushAlert(a){
  lastAlerts.push(a);
  while (lastAlerts.length > MAX_ALERTS) lastAlerts.shift();
  const line = `data: ${JSON.stringify(a)}\n\n`;
  for (const res of clients){
    try { res.write(line); } catch {}
  }
}

// ====== Notifiers (optional) ======
async function postJson(url, payload){
  if (!url) return;
  try {
    await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
  } catch(e){ console.error('[WEBHOOK]', e?.message || e); }
}

async function sendTelegram(text){
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type':'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true })
    });
  } catch(e){ console.error('[TG]', e?.message || e); }
}

// ====== spike engine ======
class SpikeEngine {
  constructor(win=5, minPct=0.003, z=3.0, cooldown=20){
    this.win=win; this.minPct=minPct; this.z=z; this.cool=cooldown;
    this.last=new Map();
    this.ewma=new Map();
    this.block=new Map();
  }
  update(sym, price, ts){
    const prev = this.last.get(sym);
    this.last.set(sym, { p:price, t:ts });
    if (!prev || prev.p <= 0) return null;

    const pct = (price - prev.p)/prev.p;
    const ap  = Math.abs(pct);

    const a = 2/(this.win+1);
    const base = this.ewma.get(sym) ?? ap;
    const ew = a*ap + (1-a)*base;
    this.ewma.set(sym, ew);

    const th = Math.max(this.minPct, this.z * ew);
    if (ap < th) return { is:false };

    const until = this.block.get(sym) || 0;
    if (ts < until) return { is:false };

    this.block.set(sym, ts + this.cool*1000);
    return { is:true, dir:(pct>=0?'UP':'DOWN'), ap, z: ew>0 ? ap/ew : 999 };
  }
}
const spike = new SpikeEngine(WINDOW_SEC, MIN_ABS_PCT, Z_MULT, COOLDOWN_SEC);

// ====== Streaming loop ======
const WS_URL = 'wss://contract.mexc.com/edge';

async function runLoop(){
  while (true){
    console.log(`[init] config ▶ win=${WINDOW_SEC}s  z≈${Z_MULT}  cooldown=${COOLDOWN_SEC}s`);
    let universe = [];
    try { universe = await buildUniverse(); }
    catch(e){ console.error('[universe/fatal]', e?.message || e); }

    if (universe.length === 0){
      console.log('[halt] Universe is empty. Waiting before retry…');
      await sleep(UNIVERSE_REFRESH_SEC*1000);
      continue;
    }

    const set = new Set(universe);
    console.log(`[info] Universe in use = ${set.size} symbols`);

    const untilTs = Date.now() + UNIVERSE_REFRESH_SEC*1000;

    await new Promise((resolve)=>{
      let ws, pingTimer=null;

      const stop = ()=> {
        try { if (pingTimer) clearInterval(pingTimer); } catch {}
        try { ws?.close(); } catch {}
        resolve();
      };

      ws = new WebSocket(WS_URL);

      ws.on('open', ()=>{
        ws.send(JSON.stringify({ method:'sub.tickers', param:{} }));
        pingTimer = setInterval(()=>{ try{ ws.send(JSON.stringify({ method:'ping' })); }catch{} }, 15000);
      });

      ws.on('message', (buf)=>{
        if (Date.now() >= untilTs) return stop();

        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg?.channel !== 'push.tickers' || !Array.isArray(msg?.data)) return;

        const ts = Number(msg.ts || Date.now());
        for (const x of msg.data){
          const sym = x.symbol;
          if (!sym || !set.has(sym)) continue;

          const price = num(x.lastPrice, 0);
          if (price <= 0) continue;

          const out = spike.update(sym, price, ts);
          if (!out?.is) continue;

          const payload = {
            source: 'scanner',
            t: new Date(ts).toISOString(),
            symbol: sym,
            price,
            direction: out.dir,
            move_pct: Number((out.ap*100).toFixed(3)),
            z_score: Number(out.z.toFixed(2)),
            window_sec: WINDOW_SEC
          };

          const line = `⚡ ${sym} ${out.dir} ${payload.move_pct}% (z≈${payload.z_score}) • ${payload.t}`;
          console.log('[ALERT]', line);

          pushAlert(payload);
          postJson(TV_WEBHOOK_URL, payload);
          sendTelegram(line);
        }
      });

      ws.on('error', e => console.error('[ws]', e?.message || e));
      ws.on('close', () => stop());
    });
  }
}

runLoop().catch(e=>{
  console.error('[fatal]', e?.message || e);
  process.exit(1);
});

// ====== HTML snippets ======
const CSS = `
:root{--bg:#0b0f1a;--panel:#0f1733;--text:#dbe2ff;--muted:#8aa0ff;--up:#20d080;--dn:#ff6b6b;--chip:#223061}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial}
header{position:sticky;top:0;background:#0b0f1ad9;border-bottom:1px solid #19203a;padding:10px 16px;display:flex;gap:10px;align-items:center}
.tag{font-size:12px;color:#9fb7ff;background:var(--chip);border:1px solid #2b3b8f;border-radius:999px;padding:2px 8px}
main{max-width:1100px;margin:0 auto;padding:14px}
.row{display:flex;align-items:center;padding:10px 8px;border-bottom:1px solid #131b3a}
.sym{width:180px;font-weight:600}
.dir{width:90px;font-weight:600}
.dir.up{color:var(--up)} .dir.down{color:var(--dn)}
.pct{width:120px}
.time{margin-left:auto;font-size:12px;color:var(--muted)}
a.btn{padding:6px 10px;border:1px solid #2b3b8f;border-radius:6px;text-decoration:none;color:#9fb7ff}
.small{font-size:12px;color:#9fb7ff}
.code{white-space:pre-wrap;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0d142d;border:1px solid #1c2a66;border-radius:6px;padding:8px;color:#dbe2ff}
`;

function htmlLive(){
  return `<!doctype html><html><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>MEXC Live Alerts</title><style>${CSS}</style></head>
  <body><header>
    <div><strong>Live Alerts</strong></div>
    <span class="tag">${RELEASE_TAG}</span>
    <span class="tag">window ${WINDOW_SEC}s</span>
    <a class="btn" href="/sse-viewer">SSE Viewer</a>
    <a class="btn" href="/alerts">JSON</a>
  </header>
  <main><div id="list"></div></main>
  <script>
    const list = document.getElementById('list');
    function row(a){
      const div = document.createElement('div'); div.className='row';
      const tv = "https://www.tradingview.com/chart/?symbol=" + a.symbol.replace('_','') + ":MEXC";
      div.innerHTML =
        '<div class="sym">'+a.symbol+'</div>'+
        '<div class="dir '+(a.direction==='UP'?'up':'down')+'">'+a.direction+'</div>'+
        '<div class="pct">'+a.move_pct.toFixed(3)+'%</div>'+
        '<a class="btn" target="_blank" rel="noreferrer" href="'+tv+'">Chart</a>'+
        '<div class="time">'+new Date(a.t).toLocaleTimeString()+'</div>';
      return div;
    }
    fetch('/alerts').then(r=>r.json()).then(arr=>{ arr.reverse().forEach(a=>list.appendChild(row(a))); });
    const es = new EventSource('/stream');
    es.onmessage = (ev)=> { try{ const a = JSON.parse(ev.data); list.prepend(row(a)); }catch{} };
  </script>
  </body></html>`;
}

function htmlViewer(){
  return `<!doctype html><html><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>SSE Viewer</title><style>${CSS}</style></head>
  <body><header>
    <div><strong>SSE Viewer</strong></div>
    <span class="tag">${RELEASE_TAG}</span>
    <a class="btn" href="/live">Back to Live</a>
  </header>
  <main>
    <p class="small">Connected to <code>/stream</code>. New events will appear at the top. This is a human-readable view of the raw Server-Sent Events feed.</p>
    <div id="out" class="code"></div>
  </main>
  <script>
    const out = document.getElementById('out');
    function add(line){
      const top = out.textContent;
      out.textContent = line + (top ? '\\n' + top : '');
    }
    add('['+new Date().toLocaleTimeString()+'] opening EventSource to /stream …');
    const es = new EventSource('/stream');
    es.onopen = ()=> add('['+new Date().toLocaleTimeString()+'] connected');
    es.onmessage = (ev)=> {
      try{
        const a = JSON.parse(ev.data);
        add('['+new Date(a.t).toLocaleTimeString()+'] ' + a.symbol + ' ' + a.direction + ' ' + a.move_pct.toFixed(3) + '% (z≈' + a.z_score.toFixed(2) + ')');
      }catch{
        add('msg: ' + ev.data);
      }
    };
    es.onerror = (e)=> add('['+new Date().toLocaleTimeString()+'] error');
  </script>
  </body></html>`;
}

// ====== HTTP server ======
const server = http.createServer((req, res)=>{
  const u = new URL(req.url, `http://${req.headers.host}`);
  // CORS (allow simple GETs from your React site if you add one)
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (u.pathname === '/' || u.pathname === '/live'){
    res.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
    return res.end(htmlLive());
  }
  if (u.pathname === '/sse-viewer'){
    res.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
    return res.end(htmlViewer());
  }
  if (u.pathname === '/alerts'){
    res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
    return res.end(JSON.stringify(lastAlerts.slice(-200).reverse()));
  }
  if (u.pathname === '/stream'){
    res.writeHead(200, {
      'content-type':'text/event-stream',
      'cache-control':'no-cache',
      'connection':'keep-alive',
      'access-control-allow-origin':'*'
    });
    res.write(`:ok\n\n`); // comment ping so proxies flush
    clients.add(res);
    req.on('close', ()=> clients.delete(res));
    return;
  }
  if (u.pathname === '/healthz'){
    res.writeHead(200, { 'content-type':'text/plain' });
    return res.end('ok ' + nowISO());
  }

  res.writeHead(404, { 'content-type':'text/plain' });
  res.end('not found');
});

server.listen(PORT, ()=> {
  console.log(`[${RELEASE_TAG}] HTTP listening on :${PORT} (CORS *)`);
});
