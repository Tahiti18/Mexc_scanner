// MEXC Futures Spike Scanner + Live Dashboard (SSE) + Tick SSE
// FULL FILE — drop-in replacement for /src/index.js

import 'dotenv/config';
import { WebSocket } from 'ws';
import http from 'http';
import { URL } from 'url';

// ===== Version label =====
const RELEASE_TAG = process.env.RELEASE_TAG || 'stable-827';
console.log(`[${RELEASE_TAG}] worker starting — dashboard + SSE + ticks enabled`);

// ===== ENV =====
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

const TV_WEBHOOK_URL       = String(process.env.TV_WEBHOOK_URL || '').trim();
const TG_TOKEN             = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT              = String(process.env.TELEGRAM_CHAT_ID || '').trim();

const PORT                 = Number(process.env.PORT || 3000);

// Frontend / SSE
const ENABLE_TICK_SSE      = /^(1|true|yes)$/i.test(process.env.ENABLE_TICK_SSE || 'true');
const TICK_SSE_SAMPLE_MS   = Number(process.env.TICK_SSE_SAMPLE_MS || 800);
const CORS_ORIGIN          = String(process.env.CORS_ORIGIN || '*');

// MEXC endpoints (futures / contract)
const BASE = 'https://contract.mexc.com';
const ENDPOINTS = {
  detail : `${BASE}/api/v1/contract/detail`,
  ticker : `${BASE}/api/v1/contract/ticker`,
  symbols: `${BASE}/api/v1/contract/symbols`
};

// ===== helpers =====
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const num = (x,d=0)=>{ const n=Number(x); return Number.isFinite(n)?n:d; };
async function getJSON(url){
  const r = await fetch(url, { headers: { 'accept': 'application/json' }});
  const txt = await r.text();
  try { return { ok: r.ok, json: JSON.parse(txt) }; }
  catch { return { ok: r.ok, json: null, raw: txt }; }
}
function unique(a){ return Array.from(new Set(a)); }

// ===== universe builders =====
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
    if (r?.state !== 0) continue;          // active only
    if (r?.apiAllowed === false) continue; // skip restricted
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
      // Auto
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
  if (UNIVERSE_OVERRIDE.length){ merged = unique([...merged, ...UNIVERSE_OVERRIDE]); console.log(`[universe] UNIVERSE_OVERRIDE added ${UNIVERSE_OVERRIDE.length}`); }

  if (merged.length === 0 && FALLBACK_TO_ALL && ZERO_FEE_WHITELIST.length){
    merged = unique([...ZERO_FEE_WHITELIST]);
    console.log('[universe] fallback: using whitelist only');
  }
  if (merged.length < MIN_UNIVERSE){
    console.log(`[universe] guardrail: too small (${merged.length}) < MIN_UNIVERSE=${MIN_UNIVERSE}`);
  }

  console.log(`[universe] totals all=${merged.length} zf=${ZERO_FEE_ONLY?merged.length:0}`);
  if (merged.length) console.log(`[universe] sample: ${merged.slice(0,10).join(', ')}`);
  return merged;
}

// ===== alerts: TV + Telegram =====
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

// ===== spike engine =====
class SpikeEngine {
  constructor(win=5,minPct=0.003,z=4.0,cooldown=45){
    this.win=win; this.minPct=minPct; this.z=z; this.cool=cooldown;
    this.last=new Map();
    this.ewma=new Map();
    this.block=new Map();
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

// ===== live memory (for /alerts) =====
const MAX_ALERTS = 300;
const recentAlerts = [];
function rememberAlert(row){
  recentAlerts.unshift(row);
  if (recentAlerts.length > MAX_ALERTS) recentAlerts.pop();
}

// ===== SSE: alerts (/stream) =====
const sseClients = new Set();
function sseBroadcast(obj){
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients){ try{ res.write(data); }catch{} }
}

// ===== Tick SSE: continuous % change per symbol =====
const tickClients = new Set();             // connected /ticks clients
const lastTickBySym = new Map();           // sym -> {p,t}
const lastBroadcastTs = new Map();         // sym -> last sent time

function pushTick(sym, price, ts){
  const prev = lastTickBySym.get(sym);
  lastTickBySym.set(sym, { p: price, t: ts });
  if (!prev || prev.p <= 0) return;

  const now = ts || Date.now();
  const lastTs = lastBroadcastTs.get(sym) || 0;
  if (now - lastTs < TICK_SSE_SAMPLE_MS) return; // throttle
  lastBroadcastTs.set(sym, now);

  const pct = (price - prev.p) / prev.p;
  const payload = {
    type: 'tick',
    t: new Date(now).toISOString(),
    symbol: sym,
    price,
    move_pct: Number((pct * 100).toFixed(4))
  };
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of tickClients){ try{ res.write(data); }catch{} }
}

// ===== streaming engine =====
const WS_URL = 'wss://contract.mexc.com/edge';

async function runLoop(){
  while (true){
    console.log(`[boot] Building universe… zeroFee=${ZERO_FEE_ONLY} maxTaker=${MAX_TAKER_FEE} wl=${ZERO_FEE_WHITELIST.length} override=${UNIVERSE_OVERRIDE.length} force=${FORCE_UNIVERSE_MODE||'-'}`);
    let universe = [];
    try { universe = await buildUniverse(); } catch(e){ console.error('[universe/fatal]', e?.message || e); }

    if (!universe.length){
      console.log('[halt] Universe empty. Retrying later.');
      await sleep(UNIVERSE_REFRESH_SEC*1000);
      continue;
    }

    const set = new Set(universe);
    console.log(`[info] Universe in use = ${set.size} symbols`);

    const untilTs = Date.now() + UNIVERSE_REFRESH_SEC*1000;

    await new Promise((resolve)=>{
      let ws, pingTimer=null;

      const stop = ()=>{
        try{ if (pingTimer) clearInterval(pingTimer); }catch{}
        try{ ws?.close(); }catch{}
        resolve();
      };

      ws = new WebSocket(WS_URL);

      ws.on('open', ()=>{
        ws.send(JSON.stringify({ method:'sub.tickers', param:{} }));
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

          // tick SSE (continuous deltas)
          if (ENABLE_TICK_SSE) { try { pushTick(sym, price, ts); } catch {} }

          // spike detection
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

          // remember + broadcast
          rememberAlert(payload);
          sseBroadcast(payload);

          // notify TV + Telegram
          postJson(TV_WEBHOOK_URL, payload);
          sendTelegram(line);
        }
      });

      ws.on('error', e => console.error('[ws]', e?.message || e));
      ws.on('close', () => stop());
    });
  }
}

// ===== HTTP live page (simple) =====
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
  .tabs{display:flex;gap:8px;margin-top:8px}
  .tab{cursor:pointer;font-size:13px;padding:6px 10px;border-radius:8px;border:1px solid #253066;background:#0f1630;color:#a9b7ff}
  .tab.active{border-color:#3b5bff;background:#13205b;color:#fff}
  .z{font-size:12px;border-radius:6px;padding:2px 6px}
  .z.z3{background:#1a2942;color:#bcd1ff;border:1px solid #2a4a8a}
  .z.z4{background:#2a233f;color:#e6d2ff;border:1px solid #6a4ab0}
  .z.z6{background:#3a1f1f;color:#ffd2d2;border:1px solid #a33}
  .spark{min-width:120px}
  canvas{display:block}
</style>
<header>
  <div><b>Live Alerts</b>
    <span class="tag">${RELEASE_TAG}</span>
    <span class="tag">window ${WINDOW_SEC}s</span>
  </div>
  <div class="tabs">
    <div class="tab active" data-mode="all">All</div>
    <div class="tab" data-mode="long">Longs 🥃</div>
    <div class="tab" data-mode="short">Shorts 💨</div>
  </div>
</header>
<div id="list"></div>
<script>
let MODE='all';
const list=document.getElementById('list');
const items=new Map(); // sym -> row data {symbol, direction, move_pct, z_score, t, price, spark[]}

function zClass(z){ return !z?'z3':(z>=6?'z6':(z>=4?'z4':'z3')); }
function tvUrl(sym){ return 'https://www.tradingview.com/chart/?symbol='+'MEXC:'+sym.replace('_',''); }

function spark(el,arr=[]){
  const w=120,h=28;
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const ctx=c.getContext('2d'); const max=Math.max(0.0001,...arr); const step=w/Math.max(1,arr.length-1);
  ctx.beginPath();
  for(let i=0;i<arr.length;i++){ const x=i*step; const y=h-(arr[i]/max)*h; if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y); }
  ctx.lineWidth=1.5; ctx.strokeStyle='#8aa1ff'; ctx.stroke();
  el.innerHTML=''; el.appendChild(c);
}

function rowEl(a){
  const div=document.createElement('div'); div.className='row'; div.id='row-'+a.symbol;
  div.innerHTML =
    '<div class="sym">'+a.symbol+'</div>'+
    '<div class="dir '+(a.direction==='UP'?'up':'down')+'">'+(a.direction==='UP'?'UP 🥃':'DOWN 💨')+'</div>'+
    '<div class="pct">'+(a.move_pct?.toFixed(3)??'0.000')+'%</div>'+
    '<span class="z '+zClass(a.z_score)+'">'+(a.z_score?('z≈'+a.z_score.toFixed(2)):'—')+'</span>'+
    '<span class="spark"></span>'+
    '<a class="btn" target="_blank" href="'+tvUrl(a.symbol)+'">Chart</a>'+
    '<div class="time">'+new Date(a.t).toLocaleTimeString()+'</div>';
  const sp=div.querySelector('.spark'); spark(sp,a.spark||[]);
  return div;
}

function passes(a){
  if(MODE==='all') return true;
  if(MODE==='long') return a.direction==='UP';
  if(MODE==='short') return a.direction==='DOWN';
  return true;
}

function render(){
  let arr=Array.from(items.values()).filter(passes);
  if(MODE==='long') arr.sort((a,b)=>b.move_pct-a.move_pct);
  else if(MODE==='short') arr.sort((a,b)=>b.move_pct-a.move_pct);
  else {
    const L=arr.filter(a=>a.direction==='UP').sort((a,b)=>b.move_pct-a.move_pct);
    const S=arr.filter(a=>a.direction==='DOWN').sort((a,b)=>b.move_pct-a.move_pct);
    arr=[...L,...S];
  }
  list.innerHTML='';
  for(const a of arr){ list.appendChild(rowEl(a)); }
}

function upsert(a){
  const old=items.get(a.symbol) || { symbol:a.symbol, spark:[] };
  const sp=(old.spark||[]).slice(-59);
  if(typeof a.move_pct==='number') sp.push(Math.abs(a.move_pct));
  items.set(a.symbol,{ ...old, ...a, spark:sp });
  render();
}

fetch('/alerts').then(r=>r.json()).then(arr=>{ arr.forEach(a=>upsert(a)); });

// alerts SSE
const es1=new EventSource('/stream');
es1.onmessage=(ev)=>{ const a=JSON.parse(ev.data); upsert(a); };

// ticks SSE (continuous live deltas)
const es2=new EventSource('/ticks');
es2.onmessage=(ev)=>{ const a=JSON.parse(ev.data); const dir=a.move_pct>=0?'UP':'DOWN'; upsert({ symbol:a.symbol, direction:dir, move_pct:Math.abs(a.move_pct), t:a.t, price:a.price }); };

// tabs
for(const el of document.querySelectorAll('.tab')){
  el.addEventListener('click',()=>{ for(const t of document.querySelectorAll('.tab')) t.classList.remove('active'); el.classList.add('active'); MODE=el.dataset.mode; render(); });
}
</script>
</html>`;

// ===== HTTP server =====
const server = http.createServer(async (req, res)=>{
  // CORS
  res.setHeader('access-control-allow-origin', CORS_ORIGIN);

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/' || url.pathname === '/live'){
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(liveHtml); return;
  }
  if (url.pathname === '/alerts'){
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control':'no-cache' });
    res.end(JSON.stringify(recentAlerts)); return;
  }
  if (url.pathname === '/stream'){
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': CORS_ORIGIN
    });
    res.write('\n');
    sseClients.add(res);
    req.on('close', ()=> sseClients.delete(res));
    return;
  }
  if (url.pathname === '/ticks'){
    if (!ENABLE_TICK_SSE){ res.writeHead(404); return res.end('tick sse off'); }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': CORS_ORIGIN
    });
    res.write('\n');
    tickClients.add(res);
    req.on('close', ()=> tickClients.delete(res));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, ()=> console.log(`[http] listening on :${PORT}  (CORS ${CORS_ORIGIN})`));

// ===== start main loop =====
runLoop().catch(e=>{
  console.error('[fatal]', e?.message || e);
  process.exit(1);
});
