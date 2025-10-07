// MEXC Futures Spike Scanner — Stable HTTP + SSE (alerts + ticks) + Live page
// FULL FILE — drop-in for /src/index.js

import 'dotenv/config';
import { WebSocket } from 'ws';
import http from 'http';

/* ================= Version ================= */
const RELEASE_TAG = process.env.RELEASE_TAG || 'stable-827';
console.log(`[${RELEASE_TAG}] boot — SSE + ticks + live page`);

/* ================= ENV (scanner) ================= */
const ZERO_FEE_ONLY        = /^(1|true|yes)$/i.test(process.env.ZERO_FEE_ONLY || '');
const MAX_TAKER_FEE        = Number(process.env.MAX_TAKER_FEE ?? 0);
const ZERO_FEE_WHITELIST   = String(process.env.ZERO_FEE_WHITELIST || '').split(',').map(s=>s.trim()).filter(Boolean);
const UNIVERSE_OVERRIDE    = String(process.env.UNIVERSE_OVERRIDE || '').split(',').map(s=>s.trim()).filter(Boolean);
const FALLBACK_TO_ALL      = /^(1|true|yes)$/i.test(process.env.FALLBACK_TO_ALL || '');
const FORCE_UNIVERSE_MODE  = (process.env.FORCE_UNIVERSE_MODE || '').toUpperCase(); // "", "FULL", "DETAIL"
const MIN_UNIVERSE         = Number(process.env.MIN_UNIVERSE || 50);

const WINDOW_SEC           = Number(process.env.WINDOW_SEC ?? 5);
const MIN_ABS_PCT          = Number(process.env.MIN_ABS_PCT ?? 0.003);
const Z_MULT               = Number(process.env.Z_MULTIPLIER ?? 4.0);
const COOLDOWN_SEC         = Number(process.env.COOLDOWN_SEC ?? 45);
const UNIVERSE_REFRESH_SEC = Number(process.env.UNIVERSE_REFRESH_SEC ?? 600);

/* ================= ENV (notifications) ================= */
const TV_WEBHOOK_URL       = String(process.env.TV_WEBHOOK_URL || '').trim();
const TG_TOKEN             = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT              = String(process.env.TELEGRAM_CHAT_ID || '').trim();

/* ================= ENV (http/sse) ================= */
const RAW_PORT             = process.env.PORT;
const CORS_ORIGIN          = String(process.env.CORS_ORIGIN || '*');
const ENABLE_TICK_SSE      = /^(1|true|yes)$/i.test(process.env.ENABLE_TICK_SSE || 'true');
const TICK_SSE_SAMPLE_MS   = Number(process.env.TICK_SSE_SAMPLE_MS || 800);

/* ================= MEXC endpoints ================= */
const BASE = 'https://contract.mexc.com';
const ENDPOINTS = {
  detail : `${BASE}/api/v1/contract/detail`,
  ticker : `${BASE}/api/v1/contract/ticker`,
  symbols: `${BASE}/api/v1/contract/symbols`
};

/* ================= helpers ================= */
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const num   = (x,d=0)=>{ const n=Number(x); return Number.isFinite(n)?n:d; };
async function getJSON(url){
  const r = await fetch(url, { headers: { 'accept': 'application/json' }});
  const txt = await r.text();
  try { return { ok: r.ok, json: JSON.parse(txt) }; }
  catch { return { ok: r.ok, json: null, raw: txt }; }
}
function unique(a){ return Array.from(new Set(a)); }
function safeURL(req){
  const host  = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const base  = `${proto}://${host}`;
  return new URL(req.url || '/', base);
}

/* ================= universe builders ================= */
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
  const out = [];
  for (const r of rows){
    const sym = r?.symbol;
    if (!sym) continue;
    if (r?.state !== 0) continue;
    if (r?.apiAllowed === false) continue;
    if (ZERO_FEE_ONLY && !isZeroFeeRow(r)) continue;
    out.push(sym);
  }
  console.log(`[universe/detail] rows=${rows.length} kept=${out.length}`);
  return out;
}
async function universeFromTicker(){
  const { ok, json } = await getJSON(ENDPOINTS.ticker);
  if (!ok || !json) return [];
  const rows = Array.isArray(json?.data) ? json.data : [];
  const syms = rows.map(r=>r?.symbol).filter(Boolean);
  console.log(`[universe/ticker] rows=${rows.length} kept=${syms.length}`);
  return syms;
}
async function universeFromSymbols(){
  const { ok, json } = await getJSON(ENDPOINTS.symbols);
  if (!ok || !json) return [];
  const rows = Array.isArray(json?.data) ? json.data
            : Array.isArray(json?.symbols) ? json.symbols : [];
  const syms = rows.map(r => (typeof r==='string'? r : r?.symbol)).filter(Boolean);
  console.log(`[universe/symbols] rows=${rows.length} kept=${syms.length}`);
  return syms;
}
async function buildUniverse() {
  let merged = [];
  try {
    if (FORCE_UNIVERSE_MODE === 'DETAIL') {
      merged = await universeFromDetail();
    } else if (FORCE_UNIVERSE_MODE === 'FULL') {
      const [u1,u2,u3] = await Promise.all([universeFromDetail(), universeFromTicker(), universeFromSymbols()]);
      merged = unique([...u1, ...u2, ...u3]);
      if (ZERO_FEE_ONLY) {
        const setDetail = new Set(u1);
        merged = merged.filter(s => setDetail.has(s));
      }
    } else {
      let u1 = await universeFromDetail();
      let u2 = [];
      if (u1.length < 10) u2 = await universeFromTicker();
      let u3 = [];
      if (u1.length + u2.length < 10) u3 = await universeFromSymbols();
      merged = unique([...u1, ...u2, ...u3]);
      if (ZERO_FEE_ONLY) {
        const setDetail = new Set(u1);
        merged = merged.filter(s => setDetail.has(s));
      }
    }
  } catch(e){ console.log('[universe] error', e?.message || e); }

  if (ZERO_FEE_WHITELIST.length) merged = unique([...merged, ...ZERO_FEE_WHITELIST]);
  if (UNIVERSE_OVERRIDE.length){ merged = unique([...merged, ...UNIVERSE_OVERRIDE]); console.log(`[universe] UNIVERSE_OVERRIDE +${UNIVERSE_OVERRIDE.length}`); }

  if (merged.length === 0 && FALLBACK_TO_ALL && ZERO_FEE_WHITELIST.length){
    merged = unique([...ZERO_FEE_WHITELIST]);
    console.log('[universe] fallback → whitelist only');
  }
  if (merged.length < MIN_UNIVERSE){
    console.log(`[universe] guardrail: too small (${merged.length}) < MIN_UNIVERSE=${MIN_UNIVERSE}`);
  }

  console.log(`[universe] totals all=${merged.length} zf=${ZERO_FEE_ONLY?merged.length:0}`);
  if (merged.length) console.log(`[universe] sample: ${merged.slice(0,10).join(', ')}`);
  return merged;
}

/* ================= notifications ================= */
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
    await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }) });
  } catch(e){ console.error('[TG]', e?.message || e); }
}

/* ================= spike engine ================= */
class SpikeEngine {
  constructor(win=5,minPct=0.003,z=4.0,cooldown=45){
    this.win=win; this.minPct=minPct; this.z=z; this.cool=cooldown;
    this.last=new Map();   // sym -> {p,t}
    this.ewma=new Map();   // sym -> ewma(abs pct)
    this.block=new Map();  // sym -> untilTs
  }
  update(sym, price, ts){
    const prev = this.last.get(sym);
    this.last.set(sym, { p:price, t:ts });
    if (!prev || prev.p<=0) return null;

    const pct = (price - prev.p)/prev.p;
    const ap  = Math.abs(pct);

    const a = 2/(this.win+1);
    const base = this.ewma.get(sym) ?? ap;
    const ew = a*ap + (1-a)*base;
    this.ewma.set(sym, ew);

    const th = Math.max(this.minPct, this.z*ew);
    if (ap < th) return { is:false };

    const until = this.block.get(sym) || 0;
    if (ts < until) return { is:false };

    this.block.set(sym, ts + this.cool*1000);
    return { is:true, dir:(pct>=0?'UP':'DOWN'), ap, z: ew>0 ? ap/ew : 999 };
  }
}
const spike = new SpikeEngine(WINDOW_SEC, MIN_ABS_PCT, Z_MULT, COOLDOWN_SEC);

/* ================= in-memory alerts ================= */
const MAX_ALERTS = 300;
const recentAlerts = [];
function rememberAlert(row){
  recentAlerts.unshift(row);
  if (recentAlerts.length > MAX_ALERTS) recentAlerts.pop();
}

/* ================= SSE: alerts ================= */
const sseClients = new Set();
function sseBroadcast(obj){
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients){ try{ res.write(data); }catch{} }
}

/* ================= Tick SSE ================= */
const tickClients = new Set();
const lastTickBySym = new Map();     // sym -> {p,t}
const lastBroadcastTs = new Map();   // sym -> ts
function pushTick(sym, price, ts){
  const prev = lastTickBySym.get(sym);
  lastTickBySym.set(sym, { p: price, t: ts });
  if (!prev || prev.p <= 0) return;

  const now = ts || Date.now();
  const lastTs = lastBroadcastTs.get(sym) || 0;
  if (now - lastTs < TICK_SSE_SAMPLE_MS) return;
  lastBroadcastTs.set(sym, now);

  const pct = (price - prev.p) / prev.p;
  const payload = { type:'tick', t:new Date(now).toISOString(), symbol:sym, price, move_pct:Number((pct*100).toFixed(4)) };
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of tickClients){ try{ res.write(data); }catch{} }
}

/* ================= WS streaming loop ================= */
const WS_URL = 'wss://contract.mexc.com/edge';

async function loopOnce(){
  console.log(`[boot] building universe… zeroFee=${ZERO_FEE_ONLY} maxTaker=${MAX_TAKER_FEE} wl=${ZERO_FEE_WHITELIST.length} override=${UNIVERSE_OVERRIDE.length} force=${FORCE_UNIVERSE_MODE||'-'}`);
  const universe = await buildUniverse().catch(e=>{ console.error('[universe/fatal]', e?.message || e); return []; });

  if (!universe.length){
    console.log('[halt] universe empty — sleep & retry');
    await sleep(Math.max(30, UNIVERSE_REFRESH_SEC)*1000);
    return;
  }

  const set = new Set(universe);
  console.log(`[info] universe in use = ${set.size} symbols`);
  const untilTs = Date.now() + UNIVERSE_REFRESH_SEC*1000;

  await new Promise((resolve)=>{
    let ws, pingTimer=null;
    const stop = ()=>{ try{ if (pingTimer) clearInterval(pingTimer); }catch{} try{ ws?.close(); }catch{} resolve(); };

    ws = new WebSocket(WS_URL);

    ws.on('open', ()=>{
      try{ ws.send(JSON.stringify({ method:'sub.tickers', param:{} })); }catch{}
      pingTimer = setInterval(()=>{ try{ ws.send(JSON.stringify({ method:'ping' })); }catch{} }, 15000);
    });

    ws.on('message', (buf)=>{
      if (Date.now() >= untilTs) return stop();
      let msg; try{ msg = JSON.parse(buf.toString()); }catch{ return; }
      if (msg?.channel !== 'push.tickers' || !Array.isArray(msg?.data)) return;

      const ts = Number(msg.ts || Date.now());
      for (const x of msg.data){
        const sym = x.symbol;
        if (!sym || !set.has(sym)) continue;
        const price = num(x.lastPrice, 0);
        if (price <= 0) continue;

        if (ENABLE_TICK_SSE) { try { pushTick(sym, price, ts); } catch {} }

        const out = spike.update(sym, price, ts);
        if (!out?.is) continue;

        const payload = {
          source:'scanner', t:new Date(ts).toISOString(), symbol:sym, price,
          direction: out.dir, move_pct:Number((out.ap*100).toFixed(3)), z_score:Number(out.z.toFixed(2)),
          window_sec: WINDOW_SEC
        };
        console.log('[ALERT]', `⚡ ${sym} ${out.dir} ${payload.move_pct}% (z≈${payload.z_score}) • ${payload.t}`);

        rememberAlert(payload);
        sseBroadcast(payload);

        postJson(TV_WEBHOOK_URL, payload);
        sendTelegram(`⚡ ${sym} ${out.dir} ${payload.move_pct}% (z≈${payload.z_score}) • ${payload.t}`);
      }
    });

    ws.on('error', e => console.error('[ws]', e?.message || e));
    ws.on('close', () => stop());
  });
}

async function runLoopForever(){
  while (true){
    try { await loopOnce(); }
    catch (e){ console.error('[loop]', e?.stack || e); }
    await sleep(250);
  }
}

/* ================= Live page (simple) ================= */
const liveHtml = `<!doctype html>
<html>
<meta charset="utf-8"/>
<title>MEXC Live Alerts</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  html,body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b0f1a;color:#dbe2ff;margin:0}
  header{position:sticky;top:0;background:#0b0f1a;z-index:1;border-bottom:1px solid #19203a;padding:12px 16px}
  .row{display:flex;align-items:center;gap:10px;padding:10px 8px;border-bottom:1px solid #141a2f}
  .sym{min-width:128px;font-weight:700;color:#fff;letter-spacing:.2px}
  .dir.up{color:#5fff7d}.dir.down{color:#ff6b6b}
  .pct{min-width:90px}
  a.btn{padding:6px 10px;border:1px solid #2b3b8f;border-radius:6px;text-decoration:none;color:#9fb7ff}
  .time{opacity:.7;font-size:12px;margin-left:auto}
  .tag{font-size:12px;color:#8aa1ff;background:#0f1630;border:1px solid #1b2a6b;border-radius:999px;padding:2px 8px;margin-left:8px}
</style>
<header>
  <div><b>Live Alerts</b>
    <span class="tag">${RELEASE_TAG}</span>
    <span class="tag">window ${WINDOW_SEC}s</span>
  </div>
</header>
<div id="list"></div>
<script>
const list=document.getElementById('list');
const items=new Map();
function tvUrl(sym){ return 'https://www.tradingview.com/chart/?symbol='+'MEXC:'+sym.replace('_',''); }
function row(a){
  const d=document.createElement('div'); d.className='row';
  d.innerHTML='<div class="sym">'+a.symbol+'</div>'+
              '<div class="dir '+(a.direction==='UP'?'up':'down')+'">'+(a.direction==='UP'?'UP 🥃':'DOWN 💨')+'</div>'+
              '<div class="pct">'+(a.move_pct?.toFixed(3)??'0.000')+'%</div>'+
              '<a class="btn" target="_blank" href="'+tvUrl(a.symbol)+'">Chart</a>'+
              '<div class="time">'+new Date(a.t).toLocaleTimeString()+'</div>';
  return d;
}
function render(){
  const arr = Array.from(items.values()).sort((a,b)=> b.move_pct - a.move_pct).slice(0,400);
  list.innerHTML=''; arr.forEach(a=> list.appendChild(row(a)));
}
function upsert(a){
  const old=items.get(a.symbol)||{};
  items.set(a.symbol,{...old,...a}); render();
}
fetch('/alerts').then(r=>r.json()).then(arr=>{arr.forEach(a=>upsert(a));});
const es1=new EventSource('/stream'); es1.onmessage=(e)=> upsert(JSON.parse(e.data));
const es2=new EventSource('/ticks');  es2.onmessage=(e)=> { const a=JSON.parse(e.data); upsert({symbol:a.symbol, direction:(a.move_pct>=0?'UP':'DOWN'), move_pct:Math.abs(a.move_pct), t:a.t, price:a.price}); };
</script>
</html>`;

/* ================= HTTP server (hardened) ================= */
function handler(req, res){
  res.setHeader('access-control-allow-origin', CORS_ORIGIN);
  res.setHeader('cache-control', 'no-cache');

  let url;
  try { url = safeURL(req); }
  catch { res.writeHead(400, {'content-type':'text/plain'}); return void res.end('bad request'); }

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/live')){
      res.writeHead(200, { 'content-type':'text/html; charset=utf-8' });
      return void res.end(liveHtml);
    }
    if (req.method === 'GET' && url.pathname === '/healthz'){
      res.writeHead(200, {'content-type':'text/plain'}); return void res.end('ok');
    }
    if (req.method === 'GET' && url.pathname === '/alerts'){
      res.writeHead(200, { 'content-type':'application/json; charset=utf-8' });
      return void res.end(JSON.stringify(recentAlerts));
    }
    if (req.method === 'GET' && url.pathname === '/stream'){
      res.writeHead(200, {
        'content-type':'text/event-stream',
        'connection':'keep-alive',
        'access-control-allow-origin': CORS_ORIGIN
      });
      res.write('\n'); sseClients.add(res);
      req.on('close', ()=> sseClients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/ticks'){
      if (!ENABLE_TICK_SSE){ res.writeHead(404); return void res.end('tick sse off'); }
      res.writeHead(200, {
        'content-type':'text/event-stream',
        'connection':'keep-alive',
        'access-control-allow-origin': CORS_ORIGIN
      });
      res.write('\n'); tickClients.add(res);
      req.on('close', ()=> tickClients.delete(res));
      return;
    }
    res.writeHead(404, { 'content-type':'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e){
    console.error('[http]', e?.message || e);
    try { res.writeHead(500, {'content-type':'text/plain; charset=utf-8'}); res.end('server error'); } catch {}
  }
}

function listenOn(ports){
  const uniq = Array.from(new Set(ports.filter(p => Number.isFinite(p) && p>0)));
  uniq.forEach(p=>{
    try {
      const s = http.createServer(handler);
      s.listen(p, '0.0.0.0', ()=> console.log(`[http] listening on 0.0.0.0:${p} (CORS ${CORS_ORIGIN})`));
      s.on('error', (e)=> console.error('[http listen]', p, e?.message || e));
    } catch(e){ console.error('[http bind]', p, e?.message || e); }
  });
}

/* Bind on PORT (if provided) + fallbacks 8080 and 3000 */
const PORT_ENV = Number(RAW_PORT);
listenOn([PORT_ENV, 8080, 3000]);

/* ================= start — NEVER exit ================= */
runLoopForever().catch(e=> console.error('[fatal]', e?.stack || e));
process.on('unhandledRejection', (r)=> console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e)=> console.error('[uncaughtException]', e));
