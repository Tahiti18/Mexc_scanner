// src/index.js — MEXC Futures Spike Scanner
// — zero-fee filter (with optional whitelist + fallback)
// — momentum spike detection (volume-agnostic, price-velocity based)
// — Telegram + generic webhook notifications

import 'dotenv/config';
import { WebSocket } from 'ws';

// ───────────────────────── ENV ─────────────────────────
const ZERO_FEE_ONLY        = /^(1|true|yes)$/i.test(process.env.ZERO_FEE_ONLY || '');
const MAX_TAKER_FEE        = Number(process.env.MAX_TAKER_FEE ?? 0); // e.g. 0 or 0.0005
const ZERO_FEE_WHITELIST   = String(process.env.ZERO_FEE_WHITELIST || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// If zero-fee list comes back empty and this is true → fall back to ALL futures
const FALLBACK_TO_ALL      = /^(1|true|yes)$/i.test(process.env.FALLBACK_TO_ALL || 'true');

const TV_WEBHOOK_URL       = String(process.env.TV_WEBHOOK_URL || '').trim();
const TG_TOKEN             = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_CHAT              = String(process.env.TELEGRAM_CHAT_ID || '').trim();

// Spike tuning (keep these simple & explicit)
const WINDOW_SEC           = Number(process.env.WINDOW_SEC ?? 5);      // EWMA window (sec equivalent)
const MIN_ABS_PCT          = Number(process.env.MIN_ABS_PCT ?? 0.003); // 0.30% floor
const Z_MULT               = Number(process.env.Z_MULTIPLIER ?? 4.0);  // spike = Z_MULT × EWMA(|Δ|)
const COOLDOWN_SEC         = Number(process.env.COOLDOWN_SEC ?? 45);   // per-symbol mute after alert

// Universe refresh cadence
const UNIVERSE_REFRESH_SEC = Number(process.env.UNIVERSE_REFRESH_SEC ?? 600); // 10 min

// MEXC endpoints
const CONTRACT_DETAIL_URL  = 'https://contract.mexc.com/api/v1/contract/detail';
const WS_URL               = 'wss://contract.mexc.com/edge';

// ──────────────────────── helpers ───────────────────────
function num(x, def = 0){ const n = Number(x); return Number.isFinite(n) ? n : def; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function postJson(url, payload){
  if (!url) return;
  try{
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type':'application/json' },
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
      headers: { 'content-type':'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true })
    });
  }catch(e){
    console.error('[TG]', e?.message || e);
  }
}

// ─────────────────────── spike engine ───────────────────
class SpikeEngine {
  constructor(win = 5, minPct = 0.003, z = 4.0, cooldown = 45){
    this.win = win; this.minPct = minPct; this.z = z; this.cool = cooldown;
    this.last = new Map();   // sym -> { p, t }
    this.ewma = new Map();   // sym -> ewma(|pct|)
    this.block = new Map();  // sym -> unblockTs
  }
  update(sym, price, ts){
    const prev = this.last.get(sym);
    this.last.set(sym, { p:price, t:ts });
    if (!prev || prev.p <= 0) return null;

    const pct = (price - prev.p) / prev.p;
    const ap  = Math.abs(pct);

    // EWMA(|pct|)
    const alpha = 2 / (this.win + 1);
    const base  = this.ewma.get(sym) ?? ap;
    const ew    = alpha * ap + (1 - alpha) * base;
    this.ewma.set(sym, ew);

    const dynThresh = Math.max(this.minPct, this.z * ew);
    if (ap < dynThresh) return { is:false };

    const until = this.block.get(sym) || 0;
    if (ts < until) return { is:false };

    this.block.set(sym, ts + this.cool * 1000);
    return { is:true, dir:(pct >= 0 ? 'UP' : 'DOWN'), ap, z: ew > 0 ? ap/ew : 999 };
  }
}
const spike = new SpikeEngine(WINDOW_SEC, MIN_ABS_PCT, Z_MULT, COOLDOWN_SEC);

// ─────────────────────── universe build ─────────────────
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

    if (ZERO_FEE_WHITELIST.includes(sym) || isZeroFeeContract(r)){
      zf.push(sym);
    }
  }

  // uniq
  const uniq = (arr) => Array.from(new Set(arr));
  return { all: uniq(all), zf: uniq(zf) };
}

// ───────────────────────── main loop ────────────────────
async function runLoop(){
  while(true){
    console.log(`[boot] Building universe… zeroFeeOnly=${ZERO_FEE_ONLY} maxTaker=${MAX_TAKER_FEE} wl=${ZERO_FEE_WHITELIST.length}`);

    let uAll = [], uZf = [];
    try{
      const { all, zf } = await buildUniverses();
      uAll = all; uZf = zf;
      console.log(`[universe] totals → all=${uAll.length}, zeroFee=${uZf.length}`);
    }catch(e){
      console.error('[universe] build failed:', e?.message || e);
    }

    let activeUniverse = [];
    let usingZeroFee = false;

    if (ZERO_FEE_ONLY){
      if (uZf.length > 0){
        activeUniverse = uZf;
        usingZeroFee = true;
      }else if (FALLBACK_TO_ALL){
        activeUniverse = uAll;
        usingZeroFee = false;
        console.warn('[universe] zero-fee list empty → falling back to ALL (FALLBACK_TO_ALL=true).');
      }else{
        console.warn('[halt] ZERO_FEE_ONLY=true and zero-fee list is empty; set FALLBACK_TO_ALL=true or add ZERO_FEE_WHITELIST.');
        await sleep(UNIVERSE_REFRESH_SEC * 1000);
        continue; // retry after refresh
      }
    }else{
      activeUniverse = uAll;
      usingZeroFee  = false;
    }

    const universe = new Set(activeUniverse);
    console.log(`[info] Universe in use: ${universe.size} symbols${usingZeroFee ? ' (zero-fee enforced)' : ''}`);

    // process WS until refresh time
    const refreshAt = Date.now() + UNIVERSE_REFRESH_SEC * 1000;

    await new Promise((resolve) => {
      let ws;
      let pingTimer = null;

      const stop = () => {
        try{ if (pingTimer) clearInterval(pingTimer); }catch{}
        try{ ws?.close(); }catch{}
        resolve();
      };

      ws = new WebSocket(WS_URL);

      ws.on('open', () => {
        ws.send(JSON.stringify({ method:'sub.tickers', param:{} }));
        pingTimer = setInterval(() => {
          try{ ws.send(JSON.stringify({ method:'ping' })); }catch{}
        }, 15_000);
      });

      ws.on('message', (buf) => {
        if (Date.now() >= refreshAt) return stop();

        let msg; try{ msg = JSON.parse(buf.toString()); }catch{ return; }
        if (msg?.channel !== 'push.tickers' || !Array.isArray(msg?.data)) return;

        const ts = Number(msg.ts || Date.now());

        for (const x of msg.data){
          const sym = x.symbol;
          if (!universe.has(sym)) continue;

          const price = num(x.lastPrice, 0);
          if (price <= 0) continue;

          const hit = spike.update(sym, price, ts);
          if (!hit?.is) continue;

          const payload = {
            source: 'scanner',
            t: new Date(ts).toISOString(),
            symbol: sym,
            price,
            direction: hit.dir,
            move_pct: Number((hit.ap*100).toFixed(3)),
            z_score: Number(hit.z.toFixed(2)),
            window_sec: WINDOW_SEC,
            zero_fee_mode: usingZeroFee
          };

          const line = `⚡ ${sym} ${hit.dir} ${payload.move_pct}% (z≈${payload.z_score}) • ${payload.t}${usingZeroFee ? ' • ZF' : ''}`;
          console.log('[ALERT]', line);

          postJson(TV_WEBHOOK_URL, payload);
          sendTelegram(line);
        }
      });

      ws.on('error', (e) => console.error('[ws]', e?.message || e));
      ws.on('close', () => stop());
    });

    // loop → rebuild universe & reconnect
  }
}

runLoop().catch(e => {
  console.error('[fatal]', e?.message || e);
  process.exit(1);
});
