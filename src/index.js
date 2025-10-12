// MEXC Futures Scanner — Spike alerts + LIVE % updates (1m/5m/15m) via SSE
// Drop-in replacement for your worker service.
// Endpoints: /stream (SSE), /alerts (JSON recent alerts), /live (minimal viewer)
//
// Real-time changes:
// - Continuously computes rolling % moves from tick data for 1m/5m/15m
// - Broadcasts "update" rows every ~2s for top movers (no Telegram/TV)
// - Spike "alert" logic unchanged (Telegram/TV + SSE)

import 'dotenv/config';
import { WebSocket } from 'ws';
import http from 'http';
import { URL } from 'url';

// ===== Version label =====
const RELEASE_TAG = process.env.RELEASE_TAG || 'rt-deltas-1';

// ===== ENV =====
const ZERO_FEE_ONLY        = /^(1|true|yes)$/i.test(process.env.ZERO_FEE_ONLY || '');
const MAX_TAKER_FEE        = Number(process.env.MAX_TAKER_FEE ?? 0);
const ZERO_FEE_WHITELIST   = String(process.env.ZERO_FEE_WHITELIST || '').split(',').map(s=>s.trim()).filter(Boolean);
const UNIVERSE_OVERRIDE    = String(process.env.UNIVERSE_OVERRIDE || '').split(',').map(s=>s.trim()).filter(Boolean);
const FALLBACK_TO_ALL      = /^(1|true|yes)$/i.test(process.env.FALLBACK_TO_ALL || '');

const WINDOW_SEC_ALERT     = Number(process.env.WINDOW_SEC ?? 5); // for spike engine only
const MIN_ABS_PCT_ALERT    = Number(process.env.MIN_ABS_PCT ?? 0.003);
const Z_MULT_ALERT         = Number(process.env.Z_MULTIPLIER ?? 3.0);
const COOLDOWN_SEC_ALERT   = Number(process.env.COOLDOWN_SEC ?? 20);

const UNIVERSE_REFRESH_SEC = Number(process.env.UNIVERSE_REFRESH_SEC ?? 600);
const TV_WEBHOOK_URL       = String(process.env.TV_WEBHOOK_URL || '').trim();
const TG_TOKEN             = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT              = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const PORT                 = Number(process.env.PORT || 3000);

// ===== MEXC endpoints =====
const BASE = 'https://contract.mexc.com';
const ENDPOINTS = {
  detail : `${BASE}/api/v1/contract/detail`,
  ticker : `${BASE}/api/v1/contract/ticker`,
  symbols: `${BASE}/api/v1/contract/symbols`
};

// ===== helpers =====
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const num = (x, d=0)=> { const n = Number(x); return Number.isFinite(n) ? n : d; };
const unique = (a)=> Array.from(new Set(a));
async function getJSON(url){
  const r = await fetch(url, { headers: { 'accept':'application/json' }});
  const t = await r.text();
  try { return { ok:r.ok, json: JSON.parse(t) }; }
  catch { return { ok:r.ok, json:null, raw:t }; }
}
function isZeroFeeRow(row){
  const taker = num(row?.takerFeeRate, NaN);
  const maker = num(row?.makerFeeRate, NaN);
  if (!Number.isFinite(taker) || !Number.isFinite(maker)) return false;
  return Math.max(taker, maker) <= (MAX_TAKER_FEE + 1e-12);
}

// ===== universe builders =====
async function universeFromDetail(){
  const { ok, json } = await getJSON(ENDPOINTS.detail);
  if (!ok || !json) return [];
  const rows = Array.isArray(json?.data) ? json.data : [];
  const keep = [];
  for (const r of rows){
    const sym = r?.symbol; if (!sym) continue;
    if (r?.state !== 0) continue;
    if (r?.apiAllowed === false) continue;
    if (ZERO_FEE_ONLY && !isZeroFeeRow(r)) continue;
    keep.push(sym);
  }
  console.log(`[universe/detail] rows=${rows.length} kept=${keep.length}`);
  return keep;
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
  const syms = rows.map(r => (typeof r === 'string' ? r : r?.symbol)).filter(Boolean);
  console.log(`[universe/symbols] rows=${rows.length} kept=${syms.length}`);
  return syms;
}
async function buildUniverse(){
  let u1=[], u2=[], u3=[];
  try { u1 = await universeFromDetail(); } catch(e){ console.log('[detail] err', e?.message||e); }
  if (u1.length < 10) { try { u2 = await universeFromTicker(); } catch(e){} }
  if (u1.length + u2.length < 10) { try { u3 = await universeFromSymbols(); } catch(e){} }

  let merged = unique([...u1, ...u2, ...u3]);
  if (ZERO_FEE_ONLY) merged = merged.filter(s => u1.includes(s));
  if (ZERO_FEE_WHITELIST.length) merged = unique([...merged, ...ZERO_FEE_WHITELIST]);
  if (UNIVERSE_OVERRIDE.length){ merged = unique([...merged, ...UNIVERSE_OVERRIDE]); }

  if (merged.length === 0 && FALLBACK_TO_ALL && ZERO_FEE_WHITELIST.length){
    merged = unique([...ZERO_FEE_WHITELIST]);
    console.log('[universe] fallback to whitelist');
  }
  console.log(`[universe] totals all=${merged.length} zf=${ZERO_FEE_ONLY ? merged.length : 0}`);
  if (merged.length) console.log(`[universe] sample: ${merged.slice(0,10).join(', ')}`);
  return merged;
}

// ===== alerts: TV + Telegram =====
async function postJson(url, payload){
  if (!url) return;
  try {
    await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
  } catch(e){ console.log('[WEBHOOK]', e?.message||e); }
}
async function sendTelegram(text){
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview:true })
    });
  } catch(e){ console.log('[TG]', e?.message||e); }
}

// ===== Spike detector (same as before) =====
class SpikeEngine {
  constructor(win=5, minPct=0.003, z=3.0, cooldown=20){
    this.win=win; this.minPct=minPct; this.z=z; this.cool=cooldown;
    this.last=new Map(); this.ewma=new Map(); this.block=new Map();
  }
  update(sym, price, ts){
    const prev = this.last.get(sym); this.last.set(sym, { p:price, t:ts });
    if (!prev || prev.p <= 0) return null;
    const pct = (price - prev.p)/prev.p, ap = Math.abs(pct);
    const a = 2/(this.win+1), base = this.ewma.get(sym) ?? ap, ew = a*ap + (1-a)*base;
    this.ewma.set(sym, ew);
    const th = Math.max(this.minPct, this.z*ew);
    if (ap < th) return { is:false };
    const until = this.block.get(sym) || 0;
    if (ts < until) return { is:false };
    this.block.set(sym, ts + this.cool*1000);
    return { is:true, dir:(pct>=0?'UP':'DOWN'), ap, z: ew>0 ? ap/ew : 999 };
  }
}
const spike = new SpikeEngine(WINDOW_SEC_ALERT, MIN_ABS_PCT_ALERT, Z_MULT_ALERT, COOLDOWN_SEC_ALERT);

// ===== State for HTTP/SSE =====
const recent = [];           // recent spike alerts
const MAX_RECENT = 500;
const clients = new Set();   // SSE clients

function sseBroadcast(obj){
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients){
    try { res.write(line); } catch {}
  }
}
function pushAlert(a){
  recent.unshift(a); if (recent.length > MAX_RECENT) recent.pop();
  sseBroadcast(a);
}

// ===== Rolling windows for LIVE % =====
// For each symbol keep a time-series queue {t, p}. We prune to last 15m.
const book = new Map(); // sym -> { price:number, q:Array<{t:number,p:number}>, lastPush:{m1:number} }
const W1  = 60*1000;
const W5  = 5*60*1000;
const W15 = 15*60*1000;

function pushTick(sym, price, ts){
  let s = book.get(sym);
  if (!s){ s = { price:price, q:[], lastPush:{m1:NaN} }; book.set(sym, s); }
  s.price = price;
  s.q.push({ t: ts, p: price });
  // prune older than 15m
  const cutoff = ts - W15 - 2000;
  while (s.q.length && s.q[0].t < cutoff) s.q.shift();
}

function pctFromWindow(q, ts, winMs){
  // find earliest point >= ts - winMs
  const t0 = ts - winMs;
  // Walk from start to the first with t >= t0 (q is already pruned/small)
  let base = null;
  for (let i=0;i<q.length;i++){
    if (q[i].t >= t0){ base = q[i].p; break; }
  }
  const last = q.length ? q[q.length-1].p : null;
  if (base==null || !last || base<=0) return null;
  return (last - base)/base * 100; // percentage
}

function computeMoves(sym){
  const s = book.get(sym); if (!s) return null;
  const ts = Date.now();
  const m1  = pctFromWindow(s.q, ts, W1);
  const m5  = pctFromWindow(s.q, ts, W5);
  const m15 = pctFromWindow(s.q, ts, W15);
  if (m1==null && m5==null && m15==null) return null;
  return { symbol:sym, t: new Date(ts).toISOString(), price: s.price, move_1m:m1, move_5m:m5, move_15m:m15 };
}

// periodic broadcaster (every ~2s)
const PUSH_INTERVAL_MS = 2000;
const TOP_N = 80;                // limit updates to top movers to keep bandwidth sane
const MIN_CHANGE_M1 = 0.02;      // only re-broadcast if |Δ 1m| changed by >= 0.02% since last push

function broadcastTopMovers(){
  const ts = Date.now();
  // build list
  const rows = [];
  for (const [sym] of book){
    const mv = computeMoves(sym);
    if (!mv) continue;
    rows.push(mv);
  }
  if (!rows.length) return;

  // rank by absolute 1m move, then 5m
  rows.sort((a,b)=>{
    const A = Math.abs(a.move_1m ?? -1e9), B = Math.abs(b.move_1m ?? -1e9);
    if (A !== B) return B - A;
    const A5 = Math.abs(a.move_5m ?? -1e9), B5 = Math.abs(b.move_5m ?? -1e9);
    return B5 - A5;
  });

  let sent = 0;
  for (const mv of rows.slice(0, TOP_N)){
    const s = book.get(mv.symbol);
    const lastM1 = s?.lastPush?.m1;
    const curM1 = Number(mv.move_1m ?? NaN);
    const changed = Number.isFinite(curM1) && (!Number.isFinite(lastM1) || Math.abs(curM1 - lastM1) >= MIN_CHANGE_M1);
    if (!changed) continue;

    const dir = curM1 >= 0 ? 'UP' : 'DOWN';
    const payload = {
      source: 'update',
      is_update: true,
      t: mv.t,
      symbol: mv.symbol,
      price: mv.price,
      direction: dir,
      move_1m: mv.move_1m != null ? +mv.move_1m.toFixed(3) : null,
      move_5m: mv.move_5m != null ? +mv.move_5m.toFixed(3) : null,
      move_15m: mv.move_15m != null ? +mv.move_15m.toFixed(3) : null
      // note: no z_score here (updates shouldn't trigger TV/TG)
    };
    sseBroadcast(payload);
    if (s) s.lastPush = { m1: curM1 };
    sent++;
  }
  if (sent) console.log(`[push] updates sent=${sent}`);
}

// ===== streaming loop =====
const WS_URL = 'wss://contract.mexc.com/edge';

async function runLoop(){
  while (true){
    console.log(`[init ${RELEASE_TAG}] win=${WINDOW_SEC_ALERT}s  z≈${Z_MULT_ALERT}  fee=${MAX_TAKER_FEE}  cooldown=${COOLDOWN_SEC_ALERT}s`);
    let universe = [];
    try { universe = await buildUniverse(); } catch(e){ console.error('[universe/fatal]', e?.message||e); }
    if (!universe.length){ await sleep(UNIVERSE_REFRESH_SEC*1000); continue; }

    const set = new Set(universe);
    console.log(`[info] Universe in use = ${set.size} symbols`);

    const untilTs = Date.now() + UNIVERSE_REFRESH_SEC*1000;

    await new Promise((resolve)=>{
      let ws, pingTimer=null, pushTimer=null;

      const stop = ()=> {
        try { if (pingTimer) clearInterval(pingTimer); } catch {}
        try { if (pushTimer) clearInterval(pushTimer); } catch {}
        try { ws?.close(); } catch {}
        resolve();
      };

      ws = new WebSocket(WS_URL);

      ws.on('open', ()=>{
        ws.send(JSON.stringify({ method:'sub.tickers', param:{} }));
        pingTimer = setInterval(()=>{ try{ ws.send(JSON.stringify({ method:'ping' })); }catch{} }, 15000);
        pushTimer = setInterval(broadcastTopMovers, PUSH_INTERVAL_MS);
      });

      ws.on('message', (buf)=>{
        if (Date.now() >= untilTs) return stop();
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg?.channel !== 'push.tickers' || !Array.isArray(msg?.data)) return;
        const ts = Number(msg.ts || Date.now());

        for (const x of msg.data){
          const sym = x.symbol;
          if (!sym || !set.has(sym)) continue;
          const price = num(x.lastPrice, 0); if (price <= 0) continue;

          // feed rolling book for live % updates
          pushTick(sym, price, ts);

          // spike engine (unchanged behavior)
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
            window_sec: WINDOW_SEC_ALERT
          };

          const line = `⚡ ${sym} ${out.dir} ${payload.move_pct}% (z≈${payload.z_score}) • ${payload.t}`;
          console.log('[ALERT]', line);

          pushAlert(payload);                // SSE (alert)
          postJson(TV_WEBHOOK_URL, payload); // TV webhook
          sendTelegram(line);                // Telegram
        }
      });

      ws.on('error', e => console.error('[ws]', e?.message || e));
      ws.on('close', () => stop());
    });
  }
}
runLoop().catch(e=>{ console.error('[fatal]', e?.message||e); process.exit(1); });

// ===== simple HTTP (SSE + /live) =====
const LIVE_HTML = (tag='')=>`<!doctype html>
<html lang="en"><meta charset="utf-8"/><title>MEXC Live Alerts</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
:root{--bg:#0b0f1a;--panel:#0f1733;--text:#dbe2ff;--muted:#9fb7ff;--up:#20d080;--dn:#ff6b6b;--chip:#223061;--b:#19203a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px system-ui,Segoe UI,Roboto,Helvetica,Arial}
header{position:sticky;top:0;background:#0b0f1ad9;border-bottom:1px solid var(--b);padding:12px 16px;display:flex;gap:10px;align-items:center}
.tag{font-size:12px;color:var(--muted);background:var(--chip);border:1px solid #2b3b8f;border-radius:999px;padding:2px 8px}
.btn{padding:6px 10px;border:1px solid #2b3b8f;border-radius:6px;text-decoration:none;color:var(--muted)}
main{max-width:1100px;margin:0 auto;padding:12px}
.row{display:flex;align-items:center;padding:10px 8px;border-bottom:1px solid #131b3a}
.sym{width:180px;font-weight:600}
.dir{width:90px;font-weight:700}.dir.up{color:var(--up)}.dir.down{color:var(--dn)}
.pct{width:260px;font-variant-numeric:tabular-nums}
.time{margin-left:auto;font-size:12px;color:var(--muted)}
</style>
<header> <div style="font-weight:700">Live Stream</div>
  <span class="tag">${tag||''}</span>
  <a class="btn" href="/alerts" target="_blank">/alerts JSON</a>
</header>
<main id="list"><small style="color:var(--muted)">Waiting for stream…</small></main>
<script>
const list = document.getElementById('list');
function row(a){
  const div=document.createElement('div'); div.className='row';
  const dir=(a.direction||'').toUpperCase()==='DOWN'?'DOWN':'UP';
  const pct=(x)=>x==null?'—':Number(x).toFixed(3)+'%';
  div.innerHTML =
    '<div class="sym">'+a.symbol+'</div>'+
    '<div class="dir '+(dir==='UP'?'up':'down')+'">'+dir+'</div>'+
    '<div class="pct">'+
      (a.move_pct!=null? ('|Δ5s| '+pct(a.move_pct)) :
       (a.move_1m!=null || a.move_5m!=null || a.move_15m!=null ?
        ('1m '+pct(a.move_1m)+' • 5m '+pct(a.move_5m)+' • 15m '+pct(a.move_15m)) : '—')
      )+
    '</div>'+
    '<div class="time">'+new Date(a.t).toLocaleTimeString()+'</div>';
  return div;
}
const es = new EventSource('/stream');
es.onmessage = (ev)=>{ try{ const a=JSON.parse(ev.data); list.prepend(row(a)); if (list.children.length>600) list.lastChild?.remove(); }catch{} };
</script>
`;

const sseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*'
};
const jsonHeaders = { 'content-type':'application/json', 'Access-Control-Allow-Origin': '*' };
const htmlHeaders = { 'content-type':'text/html; charset=utf-8' };

const server = http.createServer((req, res)=>{
  if (req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const u = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname;

  if (path === '/' || path === '/live'){
    res.writeHead(200, htmlHeaders);
    res.end(LIVE_HTML(RELEASE_TAG));
    return;
  }

  if (path === '/alerts'){
    res.writeHead(200, jsonHeaders);
    res.end(JSON.stringify(recent));
    return;
  }

  if (path === '/stream'){
    res.writeHead(200, sseHeaders);
    res.write(':ok\n\n'); // kick
    clients.add(res);
    const hb = setInterval(()=>{ try{ res.write(':hb\n\n'); }catch{} }, 15000);
    req.on('close', ()=>{ clearInterval(hb); clients.delete(res); });
    return;
  }

  res.writeHead(404, { 'content-type':'text/plain' });
  res.end('Not found');
});

server.listen(PORT, ()=> console.log(`[http] listening on :${PORT} • ${RELEASE_TAG}`));
