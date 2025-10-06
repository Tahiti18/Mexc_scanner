// src/index.js — MEXC Futures Spike Scanner (zero-fee aware + whitelist)
// Sends alerts to Telegram and optionally to a TV webhook.

import 'dotenv/config';
import { WebSocket } from 'ws';

// ========= ENV =========
const ZERO_FEE_ONLY   = /^(1|true|yes)$/i.test(process.env.ZERO_FEE_ONLY || '');
const MAX_TAKER_FEE   = Number(process.env.MAX_TAKER_FEE ?? 0); // e.g., 0.0
const ZERO_FEE_WHITELIST = String(process.env.ZERO_FEE_WHITELIST || '')
  .split(',').map(s => s.trim()).filter(Boolean);               // e.g., "ASTERUSDT,SUIUSDT,..."

const TV_WEBHOOK_URL  = String(process.env.TV_WEBHOOK_URL || '').trim(); // optional, POST alerts here
const TG_TOKEN        = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT         = String(process.env.TELEGRAM_CHAT_ID || '').trim();

// Spike settings (tweak via env if needed)
const WINDOW_SEC      = Number(process.env.WINDOW_SEC ?? 5);     // EWMA window
const MIN_ABS_PCT     = Number(process.env.MIN_ABS_PCT ?? 0.003);// floor, 0.30%
const Z_MULT          = Number(process.env.Z_MULTIPLIER ?? 4.0); // surprise factor
const COOLDOWN_SEC    = Number(process.env.COOLDOWN_SEC ?? 45);  // per-symbol cooldown

// MEXC endpoints
const CONTRACT_DETAIL_URL = 'https://contract.mexc.com/api/v1/contract/detail';
const WS_URL = 'wss://contract.mexc.com/edge';

// ========= Helpers =========
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

async function postJson(url, payload){
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('[WEBHOOK]', e?.message || e);
  }
}

async function sendTelegram(text){
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true })
    });
  } catch (e) {
    console.error('[TG]', e?.message || e);
  }
}

function num(x, def=0){ const n = Number(x); return Number.isFinite(n) ? n : def; }

// ========= Spike Engine =========
class SpikeEngine {
  constructor(win=5, minPct=0.003, z=4.0, cooldown=45){
    this.win=win; this.minPct=minPct; this.z=z; this.cool=cooldown;
    this.last=new Map();   // sym -> {p,t}
    this.ewma=new Map();   // sym -> ewma(|pct|)
    this.block=new Map();  // sym -> unblockTs
  }
  update(sym, price, ts){
    const prev = this.last.get(sym);
    this.last.set(sym, { p:price, t:ts });
    if (!prev || prev.p <= 0) return null;

    const pct = (price - prev.p)/prev.p;
    const ap  = Math.abs(pct);

    // EWMA of absolute percent moves
    const a = 2/(this.win+1);
    const base = this.ewma.get(sym) ?? ap;
    const ew = a*ap + (1-a)*base;
    this.ewma.set(sym, ew);

    const th = Math.max(this.minPct, this.z * ew);
    if (ap < th) return { is:false };

    const until = this.block.get(sym) || 0;
    if (ts < until) return { is:false };

    this.block.set(sym, ts + this.cool*1000);
    return { is:true, dir: (pct>=0?'UP':'DOWN'), ap, z: ew>0 ? ap/ew : 999 };
  }
}
const spike = new SpikeEngine(WINDOW_SEC, MIN_ABS_PCT, Z_MULT, COOLDOWN_SEC);

// ========= Universe (robust zero-fee handling + whitelist) =========
async function fetchUniverseRaw(){
  const res = await fetch(CONTRACT_DETAIL_URL);
  if (!res.ok) throw new Error(`contract/detail http ${res.status}`);
  const js = await res.json();
  return Array.isArray(js?.data) ? js.data : [];
}

function isZeroFeeContract(row){
  // MEXC fields can be strings: "0", null, or numbers.
  const taker = num(row?.takerFeeRate, 0);
  const maker = num(row?.makerFeeRate, 0);
  // treat "zero" within tolerance as free
  const maxFee = Math.max(taker, maker);
  return maxFee <= (MAX_TAKER_FEE + 1e-12);
}

async function buildUniverse(){
  const rows = await fetchUniverseRaw();
  const out = [];
  for (const r of rows){
    const sym = r?.symbol;
    if (!sym) continue;
    if (r?.state !== 0) continue;            // only active
    if (r?.apiAllowed === false) continue;   // skip disabled for API
    if (ZERO_FEE_ONLY) {
      if (!(ZERO_FEE_WHITELIST.includes(sym) || isZeroFeeContract(r))) continue;
    }
    out.push(sym);
  }
  // Deduplicate
  return Array.from(new Set(out));
}

// ========= Scanner =========
async function run(){
  console.log(`[boot] Building universe… zeroFee=${ZERO_FEE_ONLY} maxTaker=${MAX_TAKER_FEE} wl=${ZERO_FEE_WHITELIST.length}`);
  let universe = [];
  try {
    universe = await buildUniverse();
  } catch (e) {
    console.error('[universe]', e?.message || e);
  }
  console.log(`[info] Universe: ${universe.length} symbols${ZERO_FEE_ONLY ? ' (zero-fee filter ON)' : ''}`);
  if (ZERO_FEE_ONLY && universe.length === 0) {
    console.log('[warn] Zero-fee filter yielded 0. Add ZERO_FEE_WHITELIST or set ZERO_FEE_ONLY=false to test.');
  }

  let ws;
  const connect = ()=> new Promise((resolve)=>{
    ws = new WebSocket(WS_URL);
    let pingTimer = null;

    ws.on('open', ()=>{
      ws.send(JSON.stringify({ method: 'sub.tickers', param: {} }));
      pingTimer = setInterval(()=>{ try{ ws.send(JSON.stringify({ method:'ping' })); }catch{} }, 15000);
      resolve();
    });

    ws.on('message', (buf)=>{
      let msg; try{ msg = JSON.parse(buf.toString()); }catch{ return; }
      if (msg?.channel !== 'push.tickers' || !Array.isArray(msg?.data)) return;

      const ts = Number(msg.ts || Date.now());
      for (const x of msg.data){
        const sym = x.symbol;
        if (universe.length && !universe.includes(sym)) continue;
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

        postJson(TV_WEBHOOK_URL, payload);
        sendTelegram(line);
      }
    });

    ws.on('error', (e)=> console.error('[ws]', e?.message || e));
    ws.on('close', ()=>{
      console.log('[ws] closed, reconnecting…');
      if (pingTimer) clearInterval(pingTimer);
      setTimeout(()=> connect(), 2000);
    });
  });

  await connect();
}

run().catch(e=>{
  console.error('[fatal]', e?.message || e);
  process.exit(1);
});
