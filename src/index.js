// src/index.js — MEXC Futures Spike Scanner (zero-fee strict + whitelist + halt-if-empty)

import 'dotenv/config';
import { WebSocket } from 'ws';

// =============== ENV ==================
const ZERO_FEE_ONLY   = /^(1|true|yes)$/i.test(process.env.ZERO_FEE_ONLY || '');
const MAX_TAKER_FEE   = Number(process.env.MAX_TAKER_FEE ?? 0);
const ZERO_FEE_WHITELIST = String(process.env.ZERO_FEE_WHITELIST || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const TV_WEBHOOK_URL  = String(process.env.TV_WEBHOOK_URL || '').trim();
const TG_TOKEN        = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT         = String(process.env.TELEGRAM_CHAT_ID || '').trim();

// spike tuning
const WINDOW_SEC      = Number(process.env.WINDOW_SEC ?? 5);
const MIN_ABS_PCT     = Number(process.env.MIN_ABS_PCT ?? 0.003); // 0.30%
const Z_MULT          = Number(process.env.Z_MULTIPLIER ?? 4.0);
const COOLDOWN_SEC    = Number(process.env.COOLDOWN_SEC ?? 45);

// universe refresh
const UNIVERSE_REFRESH_SEC = Number(process.env.UNIVERSE_REFRESH_SEC ?? 600); // 10 min

// MEXC endpoints
const CONTRACT_DETAIL_URL = 'https://contract.mexc.com/api/v1/contract/detail';
const WS_URL = 'wss://contract.mexc.com/edge';

// =============== helpers ==================
function num(x, def=0){ const n = Number(x); return Number.isFinite(n) ? n : def; }
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

// =============== spike engine ==================
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

    // EWMA(|pct|)
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

// =============== universe ==================
async function fetchUniverseRaw(){
  const r = await fetch(CONTRACT_DETAIL_URL);
  if (!r.ok) throw new Error(`contract/detail http ${r.status}`);
  const js = await r.json();
  return Array.isArray(js?.data) ? js.data : [];
}
function isZeroFeeContract(row){
  const taker = num(row?.takerFeeRate, 0);
  const maker = num(row?.makerFeeRate, 0);
  return Math.max(taker, maker) <= (MAX_TAKER_FEE + 1e-12);
}
async function buildUniverse(){
  const rows = await fetchUniverseRaw();
  const out = [];
  for (const r of rows){
    const sym = r?.symbol;
    if (!sym) continue;
    if (r?.state !== 0) continue;              // active only
    if (r?.apiAllowed === false) continue;     // skip restricted
    if (ZERO_FEE_ONLY) {
      if (!(ZERO_FEE_WHITELIST.includes(sym) || isZeroFeeContract(r))) continue;
    }
    out.push(sym);
  }
  return Array.from(new Set(out));
}

// =============== main ==================
async function runLoop(){
  while (true){
    // rebuild universe periodically
    console.log(`[boot] Building universe… zeroFee=${ZERO_FEE_ONLY} maxTaker=${MAX_TAKER_FEE} wl=${ZERO_FEE_WHITELIST.length}`);
    let universe = [];
    try { universe = await buildUniverse(); }
    catch(e){ console.error('[universe]', e?.message || e); }

    if (ZERO_FEE_ONLY && universe.length === 0){
      console.log('[halt] ZERO_FEE_ONLY is ON but universe is empty.');
      console.log('       Add ZERO_FEE_WHITELIST or loosen MAX_TAKER_FEE, or set ZERO_FEE_ONLY=false to test.');
      await sleep(UNIVERSE_REFRESH_SEC * 1000);
      continue; // retry universe build; do not connect or process ticks
    }

    const set = new Set(universe);
    console.log(`[info] Universe: ${universe.length} symbols${ZERO_FEE_ONLY ? ' (zero-fee filter ON)' : ''}`);

    // connect WS and process until disconnected or refresh due
    const untilTs = Date.now() + UNIVERSE_REFRESH_SEC*1000;
    await new Promise((resolve)=>{
      let ws;
      let pingTimer = null;

      function stop(){
        try{ if (pingTimer) clearInterval(pingTimer); }catch{}
        try{ ws?.close(); }catch{}
        resolve();
      }

      ws = new WebSocket(WS_URL);

      ws.on('open', ()=>{
        ws.send(JSON.stringify({ method:'sub.tickers', param:{} }));
        pingTimer = setInterval(()=>{ try{ ws.send(JSON.stringify({ method:'ping' })); }catch{} }, 15000);
      });

      ws.on('message', (buf)=>{
        if (Date.now() >= untilTs) return stop(); // time to refresh universe
        let msg; try{ msg = JSON.parse(buf.toString()); }catch{ return; }
        if (msg?.channel !== 'push.tickers' || !Array.isArray(msg?.data)) return;

        const ts = Number(msg.ts || Date.now());
        for (const x of msg.data){
          const sym = x.symbol;
          // STRICT filter: only symbols in current universe
          if (set.size && !set.has(sym)) continue;

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
      ws.on('close', ()=> stop());
    });
    // loop continues → rebuild universe and reconnect
  }
}

runLoop().catch(e=>{
  console.error('[fatal]', e?.message || e);
  process.exit(1);
});
