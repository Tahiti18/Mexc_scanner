// src/index.js — MEXC Futures Scanner
//  • Momentum spike alerts (EWMA z-score + floor)
//  • Advisory trailing stop (ENTRY → TRAIL ARMED → MOVE → EXIT)
//  • MA Confluence alerts (1m,3m,15m) with EMA(5/10/30) slope agreement
//  • Telegram + generic webhook outputs
//  • Efficient 1m candle builder + 3m/15m aggregation (no REST)

import 'dotenv/config';
import { WebSocket } from 'ws';

// ───────────────────────── Env helpers ─────────────────────────
const s = (name, def='') => String(process.env[name] ?? def).replace(/['"]/g,'').trim();
const flag = (name, def='false') => /^(1|true|yes)$/i.test(s(name, def));
const num = (name, def=0) => {
  const raw = s(name, String(def));
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};
const csv = (name) => s(name).split(',').map(v=>v.trim()).filter(Boolean);

// ───────────────────────── ENV (existing) ─────────────────────
const ZERO_FEE_ONLY        = flag('ZERO_FEE_ONLY', 'false');
const FALLBACK_TO_ALL      = flag('FALLBACK_TO_ALL', 'true');
const MAX_TAKER_FEE        = Number(process.env.MAX_TAKER_FEE ?? 0);

const WINDOW_SEC           = num('WINDOW_SEC', 5);      // spike engine
const MIN_ABS_PCT          = num('MIN_ABS_PCT', 0.002); // 0.20%
const Z_MULT               = num('Z_MULTIPLIER', 3.0);
const COOLDOWN_SEC         = num('COOLDOWN_SEC', 20);
const UNIVERSE_REFRESH_SEC = num('UNIVERSE_REFRESH_SEC', 600);

const TRAIL_ENABLE         = flag('TRAIL_ENABLE', 'true');
const TRAIL_START_AFTER_PCT= num('TRAIL_START_AFTER_PCT', 0.003);
const TRAIL_DISTANCE_PCT   = num('TRAIL_DISTANCE_PCT', 0.004);

const TV_WEBHOOK_URL       = s('TV_WEBHOOK_URL');
const TG_TOKEN             = s('TELEGRAM_BOT_TOKEN');
const TG_CHAT              = s('TELEGRAM_CHAT_ID');

const ZERO_FEE_WHITELIST   = new Set(csv('ZERO_FEE_WHITELIST'));

const CONTRACT_DETAIL_URL  = 'https://contract.mexc.com/api/v1/contract/detail';
const WS_URL               = 'wss://contract.mexc.com/edge';

// ───────────────────────── ENV (new for confluence) ───────────
const CONFLUENCE_ON                 = flag('CONFLUENCE_ON', 'true');
const CONFLUENCE_USE_EMA            = flag('CONFLUENCE_USE_EMA', 'true'); // EMA vs SMA (EMA default)
const CONFLUENCE_ORDERING           = flag('CONFLUENCE_ORDERING', 'true'); // MA5>MA10>MA30 (UP) or inverse (DOWN)

const CONFLUENCE_SLOPE_K_1M         = num('CONFLUENCE_SLOPE_K_1M', 3);  // slope lookback in bars
const CONFLUENCE_SLOPE_K_3M         = num('CONFLUENCE_SLOPE_K_3M', 2);
const CONFLUENCE_SLOPE_K_15M        = num('CONFLUENCE_SLOPE_K_15M', 1);

const CONFLUENCE_DEADZONE_1M        = num('CONFLUENCE_SLOPE_DEADZONE_1M', 0.0002);  // 0.02% of price
const CONFLUENCE_DEADZONE_3M        = num('CONFLUENCE_SLOPE_DEADZONE_3M', 0.00015); // 0.015%
const CONFLUENCE_DEADZONE_15M       = num('CONFLUENCE_SLOPE_DEADZONE_15M', 0.0001); // 0.01%

const CONFLUENCE_VOL_ZMIN           = num('CONFLUENCE_ZMIN', 2.0);  // 1m volume z-score min
const CONFLUENCE_DIST_MAX_PCT       = num('CONFLUENCE_DIST_MAX_PCT', 0.012); // ≤1.2% from 15m MA30
const CONFLUENCE_COOLDOWN_SEC       = num('CONFLUENCE_COOLDOWN_SEC', 180);

const CANDLE_1M_HISTORY             = num('CANDLE_1M_HISTORY', 90); // how many 1m bars to retain

// ───────────────────────── Utilities ──────────────────────────
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const pct = (a,b)=> (b>0 ? (a-b)/b : 0);

// telegram + webhook
async function postJson(url, payload){
  if (!url) return;
  try{
    await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
  }catch(e){ console.error('[WEBHOOK]', e?.message || e); }
}
async function sendTelegram(text){
  if (!TG_TOKEN || !TG_CHAT) return;
  try{
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }) });
  }catch(e){ console.error('[TG]', e?.message || e); }
}

// ───────────────────────── Spike Engine ───────────────────────
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

    const dp = pct(price, prev.p);
    const ap = Math.abs(dp);

    const a = 2/(this.win+1);
    const base = this.ewma.get(sym) ?? ap;
    const ew = a*ap + (1-a)*base;
    this.ewma.set(sym, ew);

    const dyn = Math.max(this.minPct, this.z*ew);
    if (ap < dyn) return { is:false };

    const until = this.block.get(sym) || 0;
    if (ts < until) return { is:false };

    this.block.set(sym, ts + this.cool*1000);
    return { is:true, dir:(dp>=0?'UP':'DOWN'), ap, z: ew>0 ? ap/ew : 999 };
  }
}
const spike = new SpikeEngine(WINDOW_SEC, MIN_ABS_PCT, Z_MULT, COOLDOWN_SEC);

// ───────────────────────── Advisory Trailing Stop ─────────────
const trails = new Map(); // key=SYM|L or SYM|S
const kKey = (sym,isLong)=> `${sym}|${isLong?'L':'S'}`;
function onEntry(sym,isLong,price,tsISO){
  const st = { state:'armed', entry:price, peak:price, trail:null };
  trails.set(kKey(sym,isLong), st);
  const txt = `🟢 ENTRY (${isLong?'LONG':'SHORT'}) ${sym} @ ${price}\n${tsISO}`;
  console.log('[ENTRY]', txt); sendTelegram(txt);
  postJson(TV_WEBHOOK_URL,{type:'entry',symbol:sym,side:isLong?'long':'short',price,t:tsISO});
}
function onTrailArmed(sym,isLong,st,tsISO){
  st.state='in_trail';
  st.peak = st.peak ?? st.entry;
  st.trail = isLong ? st.peak*(1-TRAIL_DISTANCE_PCT) : st.peak*(1+TRAIL_DISTANCE_PCT);
  const txt = `🔧 TRAIL ARMED ${sym} (${isLong?'LONG':'SHORT'})\nentry ${st.entry} • peak ${st.peak} • trail ${st.trail.toFixed(6)}\n${tsISO}`;
  console.log('[TRAIL]', txt); sendTelegram(txt);
  postJson(TV_WEBHOOK_URL,{type:'trail_armed',symbol:sym,side:isLong?'long':'short',entry:st.entry,peak:st.peak,trail:st.trail,t:tsISO});
}
function onTrailMoved(sym,isLong,st,tsISO){
  const txt = `⬆️ TRAIL MOVED ${sym} (${isLong?'LONG':'SHORT'})\npeak ${st.peak} • trail ${st.trail.toFixed(6)}\n${tsISO}`;
  console.log('[TRAIL]', txt); sendTelegram(txt);
  postJson(TV_WEBHOOK_URL,{type:'trail_move',symbol:sym,side:isLong?'long':'short',peak:st.peak,trail:st.trail,t:tsISO});
}
function onTrailExit(sym,isLong,st,price,tsISO){
  const pnlPct = (isLong ? (st.peak - st.entry)/st.entry : (st.entry - st.peak)/st.entry) * 100;
  const txt = `🛑 TRAIL HIT — EXIT ${sym} (${isLong?'LONG':'SHORT'}) @ ${price}\nentry ${st.entry} • peak ${st.peak} • trail ${st.trail.toFixed(6)} • pnl≈${pnlPct.toFixed(2)}%\n${tsISO}`;
  console.log('[EXIT]', txt); sendTelegram(txt);
  postJson(TV_WEBHOOK_URL,{type:'trail_exit',symbol:sym,side:isLong?'long':'short',price,entry:st.entry,peak:st.peak,trail:st.trail,pnl_pct:+pnlPct.toFixed(2),t:tsISO});
  trails.delete(kKey(sym,isLong));
}
function updateTrail(sym, dir, price, tsISO){
  if (!TRAIL_ENABLE) return;
  const isLong = (dir === 'UP');
  const key = kKey(sym,isLong);
  let st = trails.get(key);
  if (!st){ onEntry(sym,isLong,price,tsISO); return; }
  if (st.state==='armed'){
    const fav = isLong ? (price-st.entry)/st.entry : (st.entry-price)/st.entry;
    if (fav >= TRAIL_START_AFTER_PCT){
      st.peak = price; onTrailArmed(sym,isLong,st,tsISO);
    }
    return;
  }
  if (st.state==='in_trail'){
    let moved=false;
    if (isLong && price>st.peak){ st.peak=price; st.trail=st.peak*(1-TRAIL_DISTANCE_PCT); moved=true; }
    else if(!isLong && price<st.peak){ st.peak=price; st.trail=st.peak*(1+TRAIL_DISTANCE_PCT); moved=true; }
    if (moved) onTrailMoved(sym,isLong,st,tsISO);
    const hit = isLong ? (price<=st.trail) : (price>=st.trail);
    if (hit) onTrailExit(sym,isLong,st,price,tsISO);
  }
}

// ───────────────────────── Universe build ────────────────────
async function fetchUniverseRaw(){
  const r = await fetch(CONTRACT_DETAIL_URL);
  if (!r.ok) throw new Error(`contract/detail http ${r.status}`);
  const js = await r.json();
  return Array.isArray(js?.data) ? js.data : [];
}
function isZeroFeeRow(row){
  const taker = Number(row?.takerFeeRate ?? 0);
  const maker = Number(row?.makerFeeRate ?? 0);
  return Math.max(taker,maker) <= (MAX_TAKER_FEE + 1e-12);
}
async function buildUniverses(){
  const rows = await fetchUniverseRaw();
  const all=[], zf=[];
  for (const r of rows){
    const sym = r?.symbol; if (!sym) continue;
    if (r?.state !== 0) continue;
    if (r?.apiAllowed === false) continue;
    all.push(sym);
    if (ZERO_FEE_WHITELIST.has(sym) || isZeroFeeRow(r)) zf.push(sym);
  }
  const uniq = (a)=> Array.from(new Set(a));
  return { all: uniq(all), zf: uniq(zf) };
}

// ───────────────────────── Candle engine ─────────────────────
// Maintain rolling 1m candles, then aggregate 3m & 15m.
const books = new Map(); // sym -> { m1:[{t,o,h,l,c,v}], cur:{t,o,h,l,c,v} }
function getBook(sym){
  let b = books.get(sym);
  if (!b){
    b = { m1:[], cur:null };
    books.set(sym,b);
  }
  return b;
}
function roll1m(sym, price, ts){
  const b = getBook(sym);
  const m = Math.floor(ts/60000)*60000; // minute epoch
  if (!b.cur || b.cur.t !== m){
    // close previous bar
    if (b.cur){
      b.m1.push(b.cur);
      if (b.m1.length > CANDLE_1M_HISTORY) b.m1.shift();
    }
    // open new bar
    b.cur = { t:m, o:price, h:price, l:price, c:price, v:1 };
  }else{
    b.cur.h = Math.max(b.cur.h, price);
    b.cur.l = Math.min(b.cur.l, price);
    b.cur.c = price;
    b.cur.v += 1; // tick count proxy
  }
}
function aggregateN(bars, n){
  // aggregate last n of 1m bars into a single OHLCV
  if (bars.length < n) return null;
  const last = bars.slice(-n);
  const t = last[0].t;
  const o = last[0].o;
  const c = last[last.length-1].c;
  let h=o, l=o, v=0;
  for (const k of last){ h=Math.max(h,k.h); l=Math.min(l,k.l); v+=k.v; }
  return { t, o, h, l, c, v };
}

// ───────────────────────── MA / slope / stats ───────────────
function emaSeries(prev, value, len){
  if (!prev) return value;
  const a = 2/(len+1);
  return a*value + (1-a)*prev;
}
function smaSeries(windowArr, len, value){
  windowArr.push(value);
  if (windowArr.length > len) windowArr.shift();
  const sum = windowArr.reduce((a,b)=>a+b,0);
  return sum / windowArr.length;
}
function slopePct(curr, past){
  if (past === 0 || !Number.isFinite(past)) return 0;
  return (curr - past) / past;
}

// per symbol MA state
const maState = new Map(); // sym -> { tf: { len5:{last, hist:[]}, len10:{...}, len30:{...}, seq:[...] } }
function getMA(sym){
  let st = maState.get(sym);
  if (!st){
    st = { '1m':initMA(), '3m':initMA(), '15m':initMA(), vol:{arr:[], mean:0, std:0} };
    maState.set(sym, st);
  }
  return st;
}
function initMA(){
  return {
    len5:  { ema:null, smaWin:[], hist:[] }, // hist of last closes for slope lookback
    len10: { ema:null, smaWin:[], hist:[] },
    len30: { ema:null, smaWin:[], hist:[] }
  };
}
function updateMAUnit(unit, close, useEMA){
  // update EMA/SMA and record close history
  unit.hist.push(close); if (unit.hist.length > 60) unit.hist.shift();
  if (useEMA) unit.ema = emaSeries(unit.ema, close, parseInt(unit.len,10)||5); // not used here
}
function computeMA(obj, close, len, useEMA){
  // return MA value and maintain SMA window if needed
  if (useEMA){
    obj.ema = emaSeries(obj.ema, close, len);
    return obj.ema;
  }else{
    return smaSeries(obj.smaWin, len, close);
  }
}
function updateVolumeZ(st, volTick){
  const arr = st.vol.arr;
  arr.push(volTick);
  if (arr.length > 30) arr.shift();
  const mean = arr.reduce((a,b)=>a+b,0)/(arr.length||1);
  const v2 = arr.reduce((a,b)=>a+(b-mean)*(b-mean),0)/(arr.length||1);
  const std = Math.sqrt(v2);
  st.vol.mean = mean; st.vol.std = std;
  return std>0 ? (volTick-mean)/std : 0;
}

// Cooldowns
const cdSpike = new Map();       // sym -> ts
const cdConfluence = new Map();  // sym -> ts

// ───────────────────────── Main loop ─────────────────────────
async function runLoop(){
  while(true){
    // universe
    let uAll=[], uZf=[];
    try{
      const { all, zf } = await buildUniverses();
      uAll = all; uZf = zf;
      console.log(`[universe] totals all=${uAll.length} zf=${uZf.length}`);
    }catch(e){ console.error('[universe] build failed:', e?.message || e); }

    let use = new Set(uAll);
    if (ZERO_FEE_ONLY){
      if (uZf.length>0) use = new Set(uZf);
      else if (!FALLBACK_TO_ALL){ console.warn('[halt] zero-fee empty; waiting.'); await sleep(UNIVERSE_REFRESH_SEC*1000); continue; }
      else console.warn('[universe] zero-fee empty → scanning ALL.');
    }
    console.log(`[info] Universe in use = ${use.size} symbols`);

    const refreshAt = Date.now() + UNIVERSE_REFRESH_SEC*1000;

    await new Promise((resolve)=>{
      let ws; let ping=null;
      const stop=()=>{ try{ if(ping) clearInterval(ping);}catch{}; try{ws?.close();}catch{}; resolve(); };

      ws = new WebSocket(WS_URL);
      ws.on('open', ()=>{
        ws.send(JSON.stringify({ method:'sub.tickers', param:{} }));
        ping = setInterval(()=>{ try{ ws.send(JSON.stringify({method:'ping'})); }catch{} }, 15000);
      });

      ws.on('message', (buf)=>{
        if (Date.now() >= refreshAt) return stop();
        let msg; try{ msg = JSON.parse(buf.toString()); }catch{ return; }
        if (msg?.channel !== 'push.tickers' || !Array.isArray(msg?.data)) return;
        const ts = Number(msg.ts || Date.now());
        const tsISO = new Date(ts).toISOString();

        for (const x of msg.data){
          const sym = x.symbol; if (!use.has(sym)) continue;
          const price = Number(x.lastPrice || 0); if (!(price>0)) continue;

          // Spike engine (tick-based)
          const hit = spike.update(sym, price, ts);
          if (hit?.is){
            const unblock = cdSpike.get(sym) || 0;
            if (ts >= unblock){
              const pctStr = (hit.ap*100).toFixed(3);
              const line = `⚡ ${sym} ${hit.dir} ${pctStr}% (z≈${hit.z.toFixed(2)}) • ${tsISO}`;
              console.log('[ALERT]', line);
              postJson(TV_WEBHOOK_URL,{type:'spike',symbol:sym,direction:hit.dir,move_pct:+pctStr,z_score:+hit.z.toFixed(2),price,t:tsISO});
              sendTelegram(line);
              updateTrail(sym, hit.dir, price, tsISO);
              cdSpike.set(sym, ts + COOLDOWN_SEC*1000);
            }
          }

          // Candle builder for 1m, then confluence logic on 1m close
          roll1m(sym, price, ts);
          const b = books.get(sym);
          // only evaluate when a 1m bar closes (when a new bar started => b.m1 just got appended in roll1m on next minute tick)
          // We'll detect bar close by checking if current bar ts changed; we already push on new bar open above.

          // On each tick we can also attempt to compute confluence using last completed bars:
          const bars1m = b?.m1 || [];
          if (CONFLUENCE_ON && bars1m.length >= 30){ // need some history
            // Get last completed 1m bar (close)
            const last1m = bars1m[bars1m.length-1];
            const close1m = last1m.c;

            // Aggregate 3m and 15m from 1m history
            const a3 = aggregateN(bars1m, 3);
            const a15 = aggregateN(bars1m, 15);
            if (!a3 || !a15) continue;

            const st = getMA(sym);

            // Compute MA values (EMA or SMA) for 5/10/30 on each TF using close prices
            // 1m
            const ma1 = st['1m'];
            const m1_5  = computeMA(ma1.len5,  close1m, 5,  CONFLUENCE_USE_EMA);
            const m1_10 = computeMA(ma1.len10, close1m, 10, CONFLUENCE_USE_EMA);
            const m1_30 = computeMA(ma1.len30, close1m, 30, CONFLUENCE_USE_EMA);

            // 3m
            const close3m = a3.c;
            const ma3 = st['3m'];
            const m3_5  = computeMA(ma3.len5,  close3m, 5,  CONFLUENCE_USE_EMA);
            const m3_10 = computeMA(ma3.len10, close3m, 10, CONFLUENCE_USE_EMA);
            const m3_30 = computeMA(ma3.len30, close3m, 30, CONFLUENCE_USE_EMA);

            // 15m
            const close15 = a15.c;
            const ma15 = st['15m'];
            const m15_5  = computeMA(ma15.len5,  close15, 5,  CONFLUENCE_USE_EMA);
            const m15_10 = computeMA(ma15.len10, close15, 10, CONFLUENCE_USE_EMA);
            const m15_30 = computeMA(ma15.len30, close15, 30, CONFLUENCE_USE_EMA);

            // Prepare slope references (k bars back)
            const sl1m = slopePct(m1_5,  lag(ma1.len5.hist, CONFLUENCE_SLOPE_K_1M, m1_5))
                       + slopePct(m1_10, lag(ma1.len10.hist,CONFLUENCE_SLOPE_K_1M, m1_10))
                       + slopePct(m1_30, lag(ma1.len30.hist,CONFLUENCE_SLOPE_K_1M, m1_30));

            const sl3m = slopePct(m3_5,  lag(ma3.len5.hist, CONFLUENCE_SLOPE_K_3M, m3_5))
                       + slopePct(m3_10, lag(ma3.len10.hist,CONFLUENCE_SLOPE_K_3M, m3_10))
                       + slopePct(m3_30, lag(ma3.len30.hist,CONFLUENCE_SLOPE_K_3M, m3_30));

            const sl15 = slopePct(m15_5,  lag(ma15.len5.hist, CONFLUENCE_SLOPE_K_15M, m15_5))
                       + slopePct(m15_10, lag(ma15.len10.hist,CONFLUENCE_SLOPE_K_15M, m15_10))
                       + slopePct(m15_30, lag(ma15.len30.hist,CONFLUENCE_SLOPE_K_15M, m15_30));

            // Dead-zones (scaled across 3 MAs)
            const up1m   = (sl1m/3)  > CONFLUENCE_DEADZONE_1M;
            const down1m = (sl1m/3)  < -CONFLUENCE_DEADZONE_1M;
            const up3m   = (sl3m/3)  > CONFLUENCE_DEADZONE_3M;
            const down3m = (sl3m/3)  < -CONFLUENCE_DEADZONE_3M;
            const up15   = (sl15/3)  > CONFLUENCE_DEADZONE_15M;
            const down15 = (sl15/3)  < -CONFLUENCE_DEADZONE_15M;

            // Ordering check (optional)
            const ordUp   = (m1_5>m1_10 && m1_10>m1_30) && (m3_5>m3_10 && m3_10>m3_30) && (m15_5>m15_10 && m15_10>m15_30);
            const ordDown = (m1_5<m1_10 && m1_10<m1_30) && (m3_5<m3_10 && m3_10<m3_30) && (m15_5<m15_10 && m15_10<m15_30);

            // 1m volume z-score (use last1m.v as tick volume proxy)
            const volZ = updateVolumeZ(st, last1m.v);

            // Distance to 15m MA30
            const dist = Math.abs(close15 - m15_30) / (m15_30 || close15);

            // Confluence decision
            let side = null;
            if (up1m && up3m && up15) side='UP';
            else if (down1m && down3m && down15) side='DOWN';

            const orderingOK = CONFLUENCE_ORDERING ? (side==='UP'?ordUp: side==='DOWN'?ordDown:false) : true;
            const volOK = (volZ >= CONFLUENCE_VOL_ZMIN);
            const distOK = (dist <= CONFLUENCE_DIST_MAX_PCT);

            if (side && orderingOK && volOK && distOK){
              // cooldown per symbol for confluence
              const unb = cdConfluence.get(sym) || 0;
              if (ts >= unb){
                const score = Math.round(
                  100 * (
                    0.5 * normSlope(sl15/3) +   // weight longer TF more
                    0.3 * normSlope(sl3m/3) +
                    0.2 * normSlope(sl1m/3)
                  ) * clamp(1 + (volZ-2)/4, 0.8, 1.3) * clamp(1 - dist/CONFLUENCE_DIST_MAX_PCT, 0.6, 1.1)
                );

                const txt = `✅ Confluence ${side} — ${sym}\n` +
                            `1m/3m/15m MAs aligned (5/10/30)${CONFLUENCE_ORDERING?' • order OK':''}\n` +
                            `vol-z ${volZ.toFixed(2)} • dist15m30 ${(dist*100).toFixed(2)}% • score ${score}`;
                console.log('[CONFLUENCE]', txt);
                sendTelegram(txt);
                postJson(TV_WEBHOOK_URL, {
                  type:'confluence', symbol:sym, side,
                  slopes:{ m1:(sl1m/3), m3:(sl3m/3), m15:(sl15/3) },
                  ordering: !!(CONFLUENCE_ORDERING),
                  volume_z:+volZ.toFixed(2),
                  dist_15m_ma30:+(dist*100).toFixed(2),
                  score
                });
                cdConfluence.set(sym, ts + CONFLUENCE_COOLDOWN_SEC*1000);
              }
            }
          }
        }
      });

      ws.on('error', (e)=> console.error('[ws]', e?.message || e));
      ws.on('close', ()=> stop());
    });
  }
}

// Helpers for confluence normalization
function lag(histArr, k, fallback){
  if (!Array.isArray(histArr) || histArr.length <= k) return fallback;
  const idx = histArr.length - 1 - k;
  return idx >= 0 ? histArr[idx] : fallback;
}
function normSlope(x){ // normalize a small %/bar slope into ~[0..1] range
  // x is roughly 0.0001..0.001 range; scale and cap
  const y = Math.abs(x) / 0.0015; // 0.15% per bar -> ~1.0
  return Math.min(1, Math.max(0, y));
}
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

// Start
runLoop().catch(e=>{ console.error('[fatal]', e?.message || e); process.exit(1); });
