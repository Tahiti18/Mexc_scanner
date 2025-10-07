// MEXC Futures Spike Scanner — resilient universe + safeguards
// Drop-in replacement for src/index.js

import 'dotenv/config';
import { WebSocket } from 'ws';

// ===== Version label (shows in Railway logs) =====
const RELEASE_TAG = process.env.RELEASE_TAG || 'stable-827';
console.log(`[${RELEASE_TAG}] worker starting — universe guard enabled`);

// ===== ENV =====
const ZERO_FEE_ONLY        = /^(1|true|yes)$/i.test(process.env.ZERO_FEE_ONLY || '');
const MAX_TAKER_FEE        = Number(process.env.MAX_TAKER_FEE ?? 0);
const ZERO_FEE_WHITELIST   = String(process.env.ZERO_FEE_WHITELIST || '').split(',').map(s=>s.trim()).filter(Boolean);
const UNIVERSE_OVERRIDE    = String(process.env.UNIVERSE_OVERRIDE || '').split(',').map(s=>s.trim()).filter(Boolean);
const FALLBACK_TO_ALL      = /^(1|true|yes)$/i.test(process.env.FALLBACK_TO_ALL || '');
const FORCE_UNIVERSE_MODE  = (process.env.FORCE_UNIVERSE_MODE || '').toUpperCase(); // "", "FULL", "DETAIL"
const MIN_UNIVERSE         = Number(process.env.MIN_UNIVERSE || 50);                // guardrail

const WINDOW_SEC           = Number(process.env.WINDOW_SEC ?? 5);
const MIN_ABS_PCT          = Number(process.env.MIN_ABS_PCT ?? 0.003);
const Z_MULT               = Number(process.env.Z_MULTIPLIER ?? 4.0);
const COOLDOWN_SEC         = Number(process.env.COOLDOWN_SEC ?? 45);
const UNIVERSE_REFRESH_SEC = Number(process.env.UNIVERSE_REFRESH_SEC ?? 600);

const TV_WEBHOOK_URL       = String(process.env.TV_WEBHOOK_URL || '').trim();
const TG_TOKEN             = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT              = String(process.env.TELEGRAM_CHAT_ID || '').trim();

// MEXC endpoints (USDT-Margined Perps / contract)
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

function dumpEnv() {
  const view = {
    ZERO_FEE_ONLY,
    MAX_TAKER_FEE,
    wl_len: ZERO_FEE_WHITELIST.length,
    override_len: UNIVERSE_OVERRIDE.length,
    FALLBACK_TO_ALL,
    FORCE_UNIVERSE_MODE,
    MIN_UNIVERSE,
    WINDOW_SEC,
    MIN_ABS_PCT,
    Z_MULT,
    COOLDOWN_SEC,
    UNIVERSE_REFRESH_SEC
  };
  console.log('[env]', JSON.stringify(view));
}

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
  // Force modes first
  if (FORCE_UNIVERSE_MODE === 'FULL') {
    const u = unique([...(await universeFromSymbols()), ...(await universeFromTicker())]);
    console.log(`[universe] FORCE_UNIVERSE_MODE=FULL -> ${u.length}`);
    return finalize(u);
  }
  if (FORCE_UNIVERSE_MODE === 'DETAIL') {
    const u = await universeFromDetail();
    console.log(`[universe] FORCE_UNIVERSE_MODE=DETAIL -> ${u.length}`);
    return finalize(u);
  }

  // Normal merge path
  let u1 = []; try { u1 = await universeFromDetail(); } catch(e){ console.log('[detail] err', e?.message || e); }
  let u2 = []; if (u1.length < 10) { try { u2 = await universeFromTicker(); } catch(e){ console.log('[ticker] err', e?.message || e); } }
  let u3 = []; if (u1.length + u2.length < 10) { try { u3 = await universeFromSymbols(); } catch(e){ console.log('[symbols] err', e?.message || e); } }

  return finalize(unique([...u1, ...u2, ...u3]));
}

function finalize(list) {
  let merged = list;

  if (ZERO_FEE_ONLY) {
    // When ZERO_FEE_ONLY is on, we trust detail() list to have fee info.
    // If detail() wasn't part of the merge, keep what we have (safe).
    console.log('[universe] ZERO_FEE_ONLY is ON');
  }

  if (ZERO_FEE_WHITELIST.length) merged = unique([...merged, ...ZERO_FEE_WHITELIST]);
  if (UNIVERSE_OVERRIDE.length) {
    merged = unique([...merged, ...UNIVERSE_OVERRIDE]);
    console.log(`[universe] UNIVERSE_OVERRIDE added ${UNIVERSE_OVERRIDE.length}`);
  }

  if (merged.length === 0 && FALLBACK_TO_ALL) {
    merged = ZERO_FEE_WHITELIST.length ? unique([...ZERO_FEE_WHITELIST]) : [];
    console.log('[universe] fallback: using whitelist only (FALLBACK_TO_ALL=on)');
  }

  console.log(`[universe] totals all=${merged.length} zf=${ZERO_FEE_ONLY ? merged.length : 0}`);
  if (merged.length) console.log(`[universe] sample: ${merged.slice(0, 10).join(', ')}`);
  return merged;
}

// ===== TV + Telegram =====
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

// ===== Spike engine =====
class SpikeEngine {
  constructor(win=5, minPct=0.003, z=4.0, cooldown=45){
    this.win=win; this.minPct=minPct; this.z=z; this.cool=cooldown;
    this.last=new Map(); this.ewma=new Map(); this.block=new Map();
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

// ===== Streaming & main loop =====
const WS_URL = 'wss://contract.mexc.com/edge';

async function runLoop(){
  dumpEnv();

  while (true){
    console.log(`[boot] Building universe… zeroFee=${ZERO_FEE_ONLY} maxTaker=${MAX_TAKER_FEE} wl=${ZERO_FEE_WHITELIST.length} override=${UNIVERSE_OVERRIDE.length} force=${FORCE_UNIVERSE_MODE||'none'}`);
    let universe = [];
    try { universe = await buildUniverse(); }
    catch(e){ console.error('[universe/fatal]', e?.message || e); }

    if (!universe.length) {
      console.error('[halt] Universe is empty — guard sleeping before retry.');
      await sleep(UNIVERSE_REFRESH_SEC*1000);
      continue;
    }

    const set = new Set(universe);
    console.log(`[info] Universe in use = ${set.size} symbols`);
    if (set.size < MIN_UNIVERSE) {
      console.error(`[guard] Universe below MIN_UNIVERSE=${MIN_UNIVERSE}. Exiting with code 2.`);
      process.exit(2); // Railway will restart; logs will make the cause obvious
    }

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
