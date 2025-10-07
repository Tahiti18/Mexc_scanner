// src/index.js — MEXC Futures Scanner + Advisory Trailing Stop
// - ZERO_FEE_ONLY toggle with whitelist + fallback
// - Momentum spike detection (EWMA-based) with floor
// - Advisory trailing stop alerts (no auto-execution)
// - TV webhook + Telegram notifications
// - Robust env parsing (handles quoted values)

import 'dotenv/config';
import { WebSocket } from 'ws';

// ── Env helpers (tolerant of quoted values) ─────────────────────────
const s = (name, def='') => String(process.env[name] ?? def).replace(/['"]/g,'').trim();
const flag = (name, def='false') => /^(1|true|yes)$/i.test(s(name, def));
const num = (x, def=0) => {
  const n = Number(String(x ?? '').replace(/['"]/g,'').trim());
  return Number.isFinite(n) ? n : def;
};
const list = (name) =>
  s(name).split(',').map(v => v.trim()).filter(Boolean);

// ── ENV ─────────────────────────────────────────────────────────────
const ZERO_FEE_ONLY        = flag('ZERO_FEE_ONLY', 'false'); // you set "false" to scan ALL
const MAX_TAKER_FEE        = num(process.env.MAX_TAKER_FEE, 0);
const ZERO_FEE_WHITELIST   = list('ZERO_FEE_WHITELIST');
const FALLBACK_TO_ALL      = flag('FALLBACK_TO_ALL', 'true'); // if zero-fee empty → scan all

// Spike sensitivity (short-window momentum)
const WINDOW_SEC           = num(process.env.WINDOW_SEC, 5);
const MIN_ABS_PCT          = num(process.env.MIN_ABS_PCT, 0.002); // 0.20% default
const Z_MULT               = num(process.env.Z_MULTIPLIER, 3.0);
const COOLDOWN_SEC         = num(process.env.COOLDOWN_SEC, 20);

// Advisory trailing stop
const TRAIL_ENABLE         = flag('TRAIL_ENABLE', 'true');
const TRAIL_START_AFTER_PCT= num(process.env.TRAIL_START_AFTER_PCT, 0.003); // +0.30% in favor before arming
const TRAIL_DISTANCE_PCT   = num(process.env.TRAIL_DISTANCE_PCT, 0.004);    // 0.40% trail distance

// Universe refresh cadence
const UNIVERSE_REFRESH_SEC = num(process.env.UNIVERSE_REFRESH_SEC, 600);

// Outputs
const TV_WEBHOOK_URL       = s('TV_WEBHOOK_URL');
const TG_TOKEN             = s('TELEGRAM_BOT_TOKEN');
const TG_CHAT              = s('TELEGRAM_CHAT_ID');

// MEXC API
const CONTRACT_DETAIL_URL  = 'https://contract.mexc.com/api/v1/contract/detail';
const WS_URL               = 'wss://contract.mexc.com/edge';

// ── Utilities ───────────────────────────────────────────────────────
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

async function postJson(url, payload){
  if (!url) return;
  try{
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }catch(e){
    console.error('[WEBHOOK]', e?.message || e);
  }
}

async function sendTelegram(text){
  if (!TG_TOKEN || !TG_CHAT) return;
  try{
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text,
        disable_web_page_preview: true
      })
    });
  }catch(e){
    console.error('[TG]', e?.message || e);
  }
}

// ── Spike Engine (EWMA of |Δ|) ─────────────────────────────────────
class SpikeEngine {
  constructor(win=5, minPct=0.002, z=3.0, cooldown=20){
    this.win=win; this.minPct=minPct; this.z=z; this.cool=cooldown;
    this.last=new Map();   // sym -> {p,t}
    this.ewma=new Map();   // sym -> ewma(|pct|)
    this.block=new Map();  // sym -> unblockTs
  }
  update(sym, price, ts){
    const prev = this.last.get(sym);
    this.last.set(sym, { p:price, t:ts });
    if (!prev || prev.p <= 0) return null;

    const pct = (price - prev.p) / prev.p;
    const ap  = Math.abs(pct);

    // EWMA(|pct|)
    const a = 2 / (this.win + 1);
    const base = this.ewma.get(sym) ?? ap;
    const ew   = a*ap + (1-a)*base;
    this.ewma.set(sym, ew);

    const dyn = Math.max(this.minPct, this.z * ew);
    if (ap < dyn) return { is:false };

    const until = this.block.get(sym) || 0;
    if (ts < until) return { is:false };

    this.block.set(sym, ts + this.cool*1000);
    return { is:true, dir:(pct >= 0 ? 'UP' : 'DOWN'), ap, z: ew>0 ? ap/ew : 999 };
  }
}
const spike = new SpikeEngine(WINDOW_SEC, MIN_ABS_PCT, Z_MULT, COOLDOWN_SEC);

// ── Advisory Trailing Stop ─────────────────────────────────────────
/*
  For each symbol+side:
  state: 'armed' | 'in_trail'
  entry: entry price (at first spike)
  peak:  best price since entry (long=max, short=min)
  trail: current trailing stop
*/
const trails = new Map(); // key: "SYM|L" or "SYM|S" -> state object
const keyOf  = (sym, sideLong) => `${sym}|${sideLong?'L':'S'}`;

function onEntry(sym, isLong, price, tsISO){
  const st = { state:'armed', entry:price, peak:price, trail:null };
  trails.set(keyOf(sym, isLong), st);
  const txt = `🟢 ENTRY (${isLong?'LONG':'SHORT'}) ${sym} @ ${price}\n${tsISO}`;
  console.log('[ENTRY]', txt);
  sendTelegram(txt);
  postJson(TV_WEBHOOK_URL, { type:'entry', symbol:sym, side:isLong?'long':'short', price, t:tsISO });
}
function onTrailArmed(sym, isLong, st, tsISO){
  st.state = 'in_trail';
  st.peak  = st.peak ?? st.entry;
  st.trail = isLong ? (st.peak * (1 - TRAIL_DISTANCE_PCT))
                    : (st.peak * (1 + TRAIL_DISTANCE_PCT));
  const txt = `🔧 TRAIL ARMED ${sym} (${isLong?'LONG':'SHORT'})\nentry ${st.entry} • peak ${st.peak} • trail ${st.trail.toFixed(6)}\n${tsISO}`;
  console.log('[TRAIL]', txt);
  sendTelegram(txt);
  postJson(TV_WEBHOOK_URL, { type:'trail_armed', symbol:sym, side:isLong?'long':'short', entry:st.entry, peak:st.peak, trail:st.trail, t:tsISO });
}
function onTrailMoved(sym, isLong, st, tsISO){
  const txt = `⬆️ TRAIL MOVED ${sym} (${isLong?'LONG':'SHORT'})\npeak ${st.peak} • trail ${st.trail.toFixed(6)}\n${tsISO}`;
  console.log('[TRAIL]', txt);
  sendTelegram(txt);
  postJson(TV_WEBHOOK_URL, { type:'trail_move', symbol:sym, side:isLong?'long':'short', peak:st.peak, trail:st.trail, t:tsISO });
}
function onTrailExit(sym, isLong, st, price, tsISO){
  const pnlPct = (isLong ? (st.peak - st.entry)/st.entry : (st.entry - st.peak)/st.entry) * 100;
  const txt = `🛑 TRAIL HIT — EXIT ${sym} (${isLong?'LONG':'SHORT'}) @ ${price}\nentry ${st.entry} • peak ${st.peak} • trail ${st.trail.toFixed(6)} • pnl≈${pnlPct.toFixed(2)}%\n${tsISO}`;
  console.log('[EXIT]', txt);
  sendTelegram(txt);
  postJson(TV_WEBHOOK_URL, { type:'trail_exit', symbol:sym, side:isLong?'long':'short', price, entry:st.entry, peak:st.peak, trail:st.trail, pnl_pct:+pnlPct.toFixed(2), t:tsISO });
  trails.delete(keyOf(sym, isLong)); // reset for next run
}
function updateTrail(sym, dir, price, tsISO){
  if (!TRAIL_ENABLE) return;
  const isLong = (dir === 'UP');
  const k = keyOf(sym, isLong);
  let st = trails.get(k);

  if (!st){
    // create virtual position on first spike for this direction
    onEntry(sym, isLong, price, tsISO);
    return;
  }

  if (st.state === 'armed'){
    const favor = isLong ? (price - st.entry)/st.entry : (st.entry - price)/st.entry;
    if (favor >= TRAIL_START_AFTER_PCT){
      st.peak = price;
      onTrailArmed(sym, isLong, st, tsISO);
    }
    return;
  }

  if (st.state === 'in_trail'){
    // update peak and trail if extended
    let moved = false;
    if (isLong && price > st.peak){
      st.peak = price;
      st.trail = st.peak * (1 - TRAIL_DISTANCE_PCT);
      moved = true;
    } else if (!isLong && price < st.peak){
      st.peak = price;
      st.trail = st.peak * (1 + TRAIL_DISTANCE_PCT);
      moved = true;
    }
    if (moved) onTrailMoved(sym, isLong, st, tsISO);

    // check exit
    const hit = isLong ? (price <= st.trail) : (price >= st.trail);
    if (hit) onTrailExit(sym, isLong, st, price, tsISO);
  }
}

// ── Universe (all vs zero-fee) ──────────────────────────────────────
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
async function buildUniverses(){
  const rows = await fetchUniverseRaw();
  const all = [];
  const zf  = [];
  for (const r of rows){
    const sym = r?.symbol;
    if (!sym) continue;
    if (r?.state !== 0) continue;          // only active
    if (r?.apiAllowed === false) continue; // skip restricted
    all.push(sym);
    if (ZERO_FEE_WHITELIST.includes(sym) || isZeroFeeContract(r)) zf.push(sym);
  }
  const uniq = (a)=> Array.from(new Set(a));
  return { all: uniq(all), zf: uniq(zf) };
}

// ── Main loop ───────────────────────────────────────────────────────
async function runLoop(){
  while(true){
    console.log(`[boot] Universe build… zeroFeeOnly=${ZERO_FEE_ONLY} maxTaker=${MAX_TAKER_FEE} wl=${ZERO_FEE_WHITELIST.length}`);

    let uAll=[], uZf=[];
    try{
      const { all, zf } = await buildUniverses();
      uAll = all; uZf = zf;
      console.log(`[universe] totals all=${uAll.length} zf=${uZf.length}`);
    }catch(e){
      console.error('[universe] build failed:', e?.message || e);
    }

    let use = new Set(uAll);           // default: scan all
    let note = '';
    if (ZERO_FEE_ONLY){
      if (uZf.length > 0){
        use = new Set(uZf);
        note = ' (zero-fee enforced)';
      } else if (!FALLBACK_TO_ALL){
        console.warn('[halt] ZERO_FEE_ONLY=true but zero-fee list empty. Waiting for next refresh.');
        await sleep(UNIVERSE_REFRESH_SEC * 1000);
        continue;
      } else {
        console.warn('[universe] zero-fee empty → falling back to ALL.');
      }
    }
    console.log(`[info] Universe in use = ${use.size} symbols${note}`);

    const refreshAt = Date.now() + UNIVERSE_REFRESH_SEC * 1000;

    await new Promise((resolve)=>{
      let ws; let pingTimer = null;

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
        if (Date.now() >= refreshAt) return stop();

        let msg; try{ msg = JSON.parse(buf.toString()); }catch{ return; }
        if (msg?.channel !== 'push.tickers' || !Array.isArray(msg?.data)) return;

        const ts = Number(msg.ts || Date.now());
        const tsISO = new Date(ts).toISOString();

        for (const x of msg.data){
          const sym = x.symbol;
          if (!use.has(sym)) continue;

          const price = num(x.lastPrice, 0);
          if (price <= 0) continue;

          const hit = spike.update(sym, price, ts);
          if (!hit?.is) continue;

          const pctStr = (hit.ap*100).toFixed(3);
          const line = `⚡ ${sym} ${hit.dir} ${pctStr}% (z≈${hit.z.toFixed(2)}) • ${tsISO}`;
          console.log('[ALERT]', line);

          // spike alert
          postJson(TV_WEBHOOK_URL, {
            type: 'spike',
            symbol: sym,
            direction: hit.dir,
            move_pct: +pctStr,
            z_score: +hit.z.toFixed(2),
            price,
            t: tsISO
          });
          sendTelegram(line);

          // trailing logic (advisory)
          updateTrail(sym, hit.dir, price, tsISO);
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
