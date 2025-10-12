// MEXC Futures Spike Scanner + Multi-window moves (1m/5m/15m) + Live SSE + /live page
// Single-file worker. Start with: `node worker.js`
//
// Environment (Railway/Render/etc):
// ZERO_FEE_ONLY, MAX_TAKER_FEE, ZERO_FEE_WHITELIST, UNIVERSE_OVERRIDE,
// FALLBACK_TO_ALL, WINDOW_SEC, MIN_ABS_PCT, Z_MULTIPLIER, COOLDOWN_SEC,
// UNIVERSE_REFRESH_SEC, TV_WEBHOOK_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, PORT, RELEASE_TAG

import 'dotenv/config';
import { WebSocket } from 'ws';
import http from 'http';
import { URL } from 'url';

// ===== Version label =====
const RELEASE_TAG = process.env.RELEASE_TAG || 'stable-827';
console.log(`[${RELEASE_TAG}] worker starting → scanner + SSE + /live page`);

// ===== ENV =====
const ZERO_FEE_ONLY        = /^(1|true|yes)$/i.test(process.env.ZERO_FEE_ONLY || '');
const MAX_TAKER_FEE        = Number(process.env.MAX_TAKER_FEE ?? 0);
const ZERO_FEE_WHITELIST   = String(process.env.ZERO_FEE_WHITELIST || '').split(',').map(s=>s.trim()).filter(Boolean);
const UNIVERSE_OVERRIDE    = String(process.env.UNIVERSE_OVERRIDE || '').split(',').map(s=>s.trim()).filter(Boolean);
const FALLBACK_TO_ALL      = /^(1|true|yes)$/i.test(process.env.FALLBACK_TO_ALL || '');
const WINDOW_SEC           = Number(process.env.WINDOW_SEC ?? 5);      // spike window (seconds)
const MIN_ABS_PCT          = Number(process.env.MIN_ABS_PCT ?? 0.003); // fraction, 0.003=0.3%
const Z_MULT               = Number(process.env.Z_MULTIPLIER ?? 3.0);  // z threshold for engine
const COOLDOWN_SEC         = Number(process.env.COOLDOWN_SEC ?? 20);
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
  catch { return { ok:r.ok, json:null }; }
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
    const sym = r?.symbol;
    if (!sym) continue;
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

// ===== alerts: TV + Telegram (optional) =====
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

// ===== spike detector =====
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
const spike = new SpikeEngine(WINDOW_SEC, MIN_ABS_PCT, Z_MULT, COOLDOWN_SEC);

// ===== state for HTTP/SSE =====
const recent = [];           // recent alerts ring buffer
const MAX_RECENT = 800;
const clients = new Set();   // SSE clients

function pushAlert(a){
  recent.unshift(a); if (recent.length > MAX_RECENT) recent.pop();
  const line = `data: ${JSON.stringify(a)}\n\n`;
  for (const res of clients){
    try { res.write(line); } catch {}
  }
}

// ===== multi-window price history for 1m/5m/15m moves =====
const priceHist = new Map(); // sym -> array [{t,p}]
const MAX_AGE_MS = 15*60*1000 + 5000;

function pushPrice(sym, ts, price){
  let arr = priceHist.get(sym);
  if (!arr) { arr = []; priceHist.set(sym, arr); }
  arr.push({ t: ts, p: price });
  const cutoff = ts - MAX_AGE_MS;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}
function pctFrom(arr, ts, ms){
  const fromTs = ts - ms;
  if (!arr.length) return null;
  let base = null;
  for (let i=0;i<arr.length;i++){
    if (arr[i].t >= fromTs) { base = arr[i]; break; }
  }
  if (!base) return null;
  const last = arr[arr.length-1];
  if (!last || base.p <= 0) return null;
  return ((last.p - base.p) / base.p) * 100; // percent
}

// ===== streaming loop =====
const WS_URL = 'wss://contract.mexc.com/edge';

async function runLoop(){
  while (true){
    console.log(`[init] config ▶ win=${WINDOW_SEC}s  z≈${Z_MULT}  fee=${MAX_TAKER_FEE}  cooldown=${COOLDOWN_SEC}s`);
    let universe = [];
    try { universe = await buildUniverse(); } catch(e){ console.error('[universe/fatal]', e?.message||e); }
    if (!universe.length){ await sleep(UNIVERSE_REFRESH_SEC*1000); continue; }

    const set = new Set(universe);
    console.log(`[info] Universe in use = ${set.size} symbols`);

    const untilTs = Date.now() + UNIVERSE_REFRESH_SEC*1000;

    await new Promise((resolve)=>{
      let ws, pingTimer=null;
      const stop = ()=>{ try{ clearInterval(pingTimer); }catch{} try{ ws?.close(); }catch{} resolve(); };

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
          const price = num(x.lastPrice, 0); if (price <= 0) continue;

          // track price history for 1m/5m/15m
          pushPrice(sym, ts, price);
          const arr = priceHist.get(sym) || [];
          const mv1  = pctFrom(arr, ts, 60*1000);
          const mv5  = pctFrom(arr, ts, 5*60*1000);
          const mv15 = pctFrom(arr, ts, 15*60*1000);

          // spike engine for near-realtime bursts (WINDOW_SEC seconds)
          const out = spike.update(sym, price, ts);
          if (!out?.is) continue;

          const payload = {
            source: 'scanner',
            t: new Date(ts).toISOString(),
            symbol: sym,
            price,
            direction: out.dir,
            // legacy (short window)
            move_pct: Number((out.ap*100).toFixed(3)),
            z_score: Number(out.z.toFixed(2)),
            window_sec: WINDOW_SEC,
            // multi-window moves
            move_1m:  mv1  != null ? Number(mv1.toFixed(3))  : null,
            move_5m:  mv5  != null ? Number(mv5.toFixed(3))  : null,
            move_15m: mv15 != null ? Number(mv15.toFixed(3)) : null
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
runLoop().catch(e=>{ console.error('[fatal]', e?.message||e); process.exit(1); });

// ===== simple HTTP (SSE + /live + /alerts) =====
const LIVE_HTML = (tag='')=>`<!doctype html>
<html lang="en"><meta charset="utf-8"/><title>MEXC Live Alerts</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
:root{--bg:#0b0f1a;--panel:#0f1733;--text:#dbe2ff;--muted:#9fb7ff;--up:#20d080;--dn:#ff6b6b;--chip:#223061;--b:#19203a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px system-ui,Segoe UI,Roboto,Helvetica,Arial}
header{position:sticky;top:0;background:#0b0f1ad9;border-bottom:1px solid var(--b);padding:12px 16px;display:flex;gap:10px;align-items:center}
.tag{font-size:12px;color:var(--muted);background:var(--chip);border:1px solid #2b3b8f;border-radius:999px;padding:2px 8px}
.btn{padding:6px 10px;border:1px solid #2b3b8f;border-radius:6px;text-decoration:none;color:var(--muted)}
main{max-width:1200px;margin:0 auto;padding:12px}
.row{display:flex;align-items:center;padding:10px 8px;border-bottom:1px solid #131b3a}
.sym{width:180px;font-weight:600}
.dir{width:90px;font-weight:700}.dir.up{color:var(--up)}.dir.down{color:var(--dn)}
.pct{width:120px}.time{margin-left:auto;font-size:12px;color:var(--muted)}
</style>
<header> <div style="font-weight:700">Live Alerts</div>
  <span class="tag">${tag||''}</span>
  <a class="btn" href="/alerts" target="_blank">JSON</a>
  <a class="btn" href="/sse-viewer" target="_blank">Raw SSE</a>
</header>
<main id="list"><small style="color:var(--muted)">Waiting for stream…</small></main>
<script>
const list = document.getElementById('list');
const row = (a)=>{
  const tv = "https://www.tradingview.com/chart/?symbol=" + (a.symbol||'').replace('_','') + ":MEXC";
  const mex="https://www.mexc.com/exchange/"+(a.symbol||'').replace('_','-');
  const div = document.createElement('div'); div.className='row';
  const mv = a.move_1m ?? a.move_pct ?? 0;
  div.innerHTML =
    '<div class="sym">'+a.symbol+'</div>'+
    '<div class="dir '+((a.direction||'UP')==='UP'?'up':'down')+'">'+(((a.direction||'UP')==='UP')?'▲ LONG':'▼ SHORT')+'</div>'+
    '<div class="pct">'+Number(mv).toFixed(3)+'%</div>'+
    '<a class="btn" target="_blank" href="'+mex+'">MEXC</a>'+
    '<a class="btn" target="_blank" href="'+tv+'">TV</a>'+
    '<div class="time">'+new Date(a.t).toLocaleTimeString()+'</div>';
  return div;
};
fetch('/alerts').then(r=>r.json()).then(arr=>{ list.innerHTML=''; arr.forEach(a=>list.appendChild(row(a))); });
const es = new EventSource('/stream');
es.onmessage = (ev)=>{ try{ const a=JSON.parse(ev.data); list.prepend(row(a)); if (list.children.length>500) list.lastChild?.remove(); }catch{} };
</script>
`;

const sseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*'
};
const jsonHeaders = { 'content-type':'application/json', 'Access-Control-Allow-Origin':'*' };
const htmlHeaders = { 'content-type':'text/html; charset=utf-8', 'Access-Control-Allow-Origin':'*' };

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
  if (path === '/sse-viewer'){
    res.writeHead(200, htmlHeaders);
    res.end(`<!doctype html><meta charset="utf-8"/><title>SSE Viewer</title>
      <pre id="o" style="white-space:pre-wrap;font:12px ui-monospace,Menlo,Consolas"></pre>
      <script>
      const o=document.getElementById('o'); const es=new EventSource('/stream');
      es.onmessage=(e)=>{o.textContent=e.data+'\\n\\n'+o.textContent.slice(0,20000);}
      </script>`);
    return;
  }
  if (path === '/stream'){
    res.writeHead(200, sseHeaders);
    res.write(':ok\n\n');
    clients.add(res);
    const hb = setInterval(()=>{ try{ res.write(':hb\n\n'); }catch{} }, 15000);
    req.on('close', ()=>{ clearInterval(hb); clients.delete(res); });
    return;
  }
  res.writeHead(404, { 'content-type':'text/plain', 'Access-Control-Allow-Origin':'*' });
  res.end('Not found');
});
server.listen(PORT, ()=> console.log(`[http] listening on :${PORT} (CORS + *)`));
