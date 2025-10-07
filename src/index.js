// src/index.js — MEXC Futures Spike Scanner + MA Alignment (ALL TFs must agree: 1m/3m/15m)
// - Spike alerts unchanged
// - MA alert only fires when 1m, 3m and 15m all slope/ordered in the SAME direction

import 'dotenv/config';
import { WebSocket } from 'ws';

// ======================= ENV (existing) =======================
const ZERO_FEE_ONLY   = /^(1|true|yes)$/i.test(process.env.ZERO_FEE_ONLY || '');
const MAX_TAKER_FEE   = Number(process.env.MAX_TAKER_FEE ?? 0);
const ZERO_FEE_WHITELIST = String(process.env.ZERO_FEE_WHITELIST || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const TV_WEBHOOK_URL  = String(process.env.TV_WEBHOOK_URL || '').trim();
const TG_TOKEN        = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT         = String(process.env.TELEGRAM_CHAT_ID || '').trim();

const WINDOW_SEC      = Number(process.env.WINDOW_SEC ?? 5);
const MIN_ABS_PCT     = Number(process.env.MIN_ABS_PCT ?? 0.003);
const Z_MULT          = Number(process.env.Z_MULTIPLIER ?? 4.0);
const COOLDOWN_SEC    = Number(process.env.COOLDOWN_SEC ?? 45);

const UNIVERSE_REFRESH_SEC = Number(process.env.UNIVERSE_REFRESH_SEC ?? 600);

// ======================= ENV (MA feature) =======================
const MA_ALIGN_ENABLE       = /^(1|true|yes)$/i.test(process.env.MA_ALIGN_ENABLE || 'false');
const MA_ALIGN_LIMIT        = Math.max(20, Number(process.env.MA_ALIGN_LIMIT ?? 150));
const MA_ALIGN_COOLDOWN_SEC = Math.max(30, Number(process.env.MA_ALIGN_COOLDOWN_SEC ?? 120));

// ======================= Endpoints =======================
const CONTRACT_DETAIL_URL = 'https://contract.mexc.com/api/v1/contract/detail';
const WS_URL = 'wss://contract.mexc.com/edge';

// ======================= utils =======================
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
  } catch (e) { console.error('[WEBHOOK]', e?.message || e); }
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
  } catch (e) { console.error('[TG]', e?.message || e); }
}

// ======================= Spike Engine (unchanged) =======================
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

// ======================= Universe =======================
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
    const sym = r?.symbol; if (!sym) continue;
    if (r?.state !== 0) continue;
    if (r?.apiAllowed === false) continue;
    if (ZERO_FEE_ONLY){
      if (!(ZERO_FEE_WHITELIST.includes(sym) || isZeroFeeContract(r))) continue;
    }
    out.push(sym);
  }
  return Array.from(new Set(out));
}

// ======================= MA Alignment (ALL TFs agree) =======================
// Build 1m bars from ticks, also build 3m & 15m bars; compute EMA(5/10/30) per TF.
// Only alert when 1m, 3m, and 15m are ALL aligned (slopes + ordered) in the SAME direction.

function emaNext(prev, value, period){
  const k = 2/(period+1);
  return prev == null ? value : (value - prev)*k + prev;
}

class BarAgg {
  constructor(frameSec){ this.frame = frameSec; this.map = new Map(); } // sym -> {start, close, lastClosed}
  onTick(sym, price, ts){
    const start = Math.floor(ts/1000/this.frame)*this.frame*1000;
    const rec = this.map.get(sym);
    if (!rec || rec.start !== start){
      // closing previous bar (if exists)
      const closed = rec ? { close: rec.close, ts: rec.start + this.frame*1000 } : null;
      this.map.set(sym, { start, close: price });
      return closed; // may be null for first bar
    } else {
      rec.close = price;
      return null;
    }
  }
}

class MAAllFrames {
  constructor(limit=150, cooldownSec=120){
    this.limit = limit;
    this.cool = cooldownSec;
    this.tracked = new Set();
    this.frames = [
      { name:'1m',  agg: new BarAgg(60)  },
      { name:'3m',  agg: new BarAgg(180) },
      { name:'15m', agg: new BarAgg(900) },
    ];
    this.periods = [5,10,30];

    // emaStore: emaStore[sym][tf][period] = { val, prev }
    this.emaStore = new Map();
    // slope store per TF after each close: slopeStore[sym][tf] = { dir:'UP'|'DOWN'|null, ordered:true/false, ready:boolean }
    this.slopeStore = new Map();
    // last alert time per symbol
    this.lastAlert = new Map();
  }

  setUniverse(universe){
    const sorted = [...universe].sort();
    this.tracked = new Set(sorted.slice(0, this.limit));
  }

  _getSymTf(sym, tf){
    if (!this.emaStore.has(sym)) this.emaStore.set(sym, new Map());
    const tfMap = this.emaStore.get(sym);
    if (!tfMap.has(tf)) tfMap.set(tf, new Map());
    return tfMap.get(tf);
  }
  _setSlope(sym, tf, obj){
    if (!this.slopeStore.has(sym)) this.slopeStore.set(sym, new Map());
    this.slopeStore.get(sym).set(tf, obj);
  }

  _updateEMAs(sym, tf, close){
    const tfMap = this._getSymTf(sym, tf);
    const snaps = [];
    let prevVal = null;
    let orderedUp = true, orderedDown = true;
    for (const p of this.periods){
      const rec = tfMap.get(p) || { val:null, prev:null };
      const next = emaNext(rec.val, close, p);
      const slopeUp   = rec.val != null ? next > rec.val : null;
      const slopeDown = rec.val != null ? next < rec.val : null;
      tfMap.set(p, { val: next, prev: rec.val });

      snaps.push({ p, val: next, slopeUp, slopeDown });

      if (prevVal != null){
        if (!(next > prevVal)) orderedUp = false;
        if (!(next < prevVal)) orderedDown = false;
      }
      prevVal = next;
    }
    const haveSlopes = snaps.every(s => s.slopeUp !== null);
    let dir = null;
    if (haveSlopes){
      const allUp   = snaps.every(s => s.slopeUp === true)   && orderedUp;
      const allDown = snaps.every(s => s.slopeDown === true) && orderedDown;
      dir = allUp ? 'UP' : (allDown ? 'DOWN' : null);
    }
    this._setSlope(sym, tf, { ready: haveSlopes, dir, ordered: dir!=null });
  }

  _allFramesAgree(sym){
    const s = this.slopeStore.get(sym);
    if (!s) return { ok:false };
    const need = ['1m','3m','15m'];
    for (const tf of need){
      const rec = s.get(tf);
      if (!rec || !rec.ready || !rec.ordered || !rec.dir) return { ok:false };
    }
    const d1 = s.get('1m').dir, d3 = s.get('3m').dir, d15 = s.get('15m').dir;
    const same = (d1 === d3) && (d3 === d15);
    return { ok: same, dir: same ? d1 : null };
  }

  onTick(sym, price, ts, onAgree){
    if (this.tracked.size && !this.tracked.has(sym)) return;

    // Update each frame; on any CLOSED bar, recompute EMAs & slopes
    let changed = false;
    for (const f of this.frames){
      const closed = f.agg.onTick(sym, price, ts);
      if (closed){ this._updateEMAs(sym, f.name, num(closed.close)); changed = true; }
    }
    if (!changed) return;

    // Check cross-frame agreement
    const { ok, dir } = this._allFramesAgree(sym);
    if (!ok) return;

    const last = this.lastAlert.get(sym) || 0;
    if (ts < last + this.cool*1000) return;
    this.lastAlert.set(sym, ts);

    onAgree(sym, dir, ts);
  }
}

const maAll = new MAAllFrames(MA_ALIGN_LIMIT, MA_ALIGN_COOLDOWN_SEC);

// ======================= Main Loop =======================
async function runLoop(){
  while (true){
    console.log(`[boot] Building universe… zeroFee=${ZERO_FEE_ONLY} maxTaker=${MAX_TAKER_FEE} wl=${ZERO_FEE_WHITELIST.length}`);
    let universe = [];
    try { universe = await buildUniverse(); }
    catch(e){ console.error('[universe]', e?.message || e); }

    if (ZERO_FEE_ONLY && universe.length === 0){
      console.log('[halt] ZERO_FEE_ONLY is ON but universe is empty.');
      console.log('       Add ZERO_FEE_WHITELIST or loosen MAX_TAKER_FEE, or set ZERO_FEE_ONLY=false to test.');
      await sleep(UNIVERSE_REFRESH_SEC * 1000);
      continue;
    }

    console.log(`[info] Universe in use = ${universe.length} symbols${ZERO_FEE_ONLY ? ' (zero-fee filter ON)' : ''}`);

    if (MA_ALIGN_ENABLE){
      maAll.setUniverse(universe);
      console.log(`[info] MA alignment enabled (1m&3m&15m must agree). Tracking up to ${MA_ALIGN_LIMIT} symbols.`);
    } else {
      console.log('[info] MA alignment disabled.');
    }

    const set = new Set(universe);
    const untilTs = Date.now() + UNIVERSE_REFRESH_SEC*1000;

    await new Promise((resolve)=>{
      let ws; let pingTimer=null;
      const stop = ()=>{ try{clearInterval(pingTimer);}catch{} try{ws?.close();}catch{} resolve(); };

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
          if (set.size && !set.has(sym)) continue;
          const price = num(x.lastPrice, 0);
          if (price <= 0) continue;

          // ---- Spike (unchanged) ----
          const out = spike.update(sym, price, ts);
          if (out?.is){
            const payload = {
              type: 'spike',
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

          // ---- MA Alignment: ALL TFs agree ----
          if (MA_ALIGN_ENABLE){
            maAll.onTick(sym, price, ts, (s, dir, when)=>{
              const payload = {
                type: 'ma_align_all',
                symbol: s,
                direction: dir,           // 'UP' or 'DOWN'
                frames: ['1m','3m','15m'],
                t: new Date(when).toISOString()
              };
              const line = `📊 MA ALIGN (ALL TF) ${s} ${dir} • 1m=3m=15m aligned & ordered • ${payload.t}`;
              console.log('[MA]', line);
              postJson(TV_WEBHOOK_URL, payload);
              sendTelegram(line);
            });
          }
        }
      });

      ws.on('error', (e)=> console.error('[ws]', e?.message || e));
      ws.on('close', ()=> stop());
    });
  }
}

runLoop().catch(e=>{
  console.error('[fatal]', e?.message || e);
  process.exit(1);
});
