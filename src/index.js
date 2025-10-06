import 'dotenv/config';
import { MexcScanner } from './mexcScanner.js';
import { SpikeEngine } from './spikeEngine.js';
import { TrailingManager } from './trailing.js';
import { alertTelegram, alertWebhook } from './notify.js';
import { createExecutor } from './executor.js';
import { bool, num, list, nowIso } from './utils.js';

const cfg = {
  apiKey: process.env.MEXC_API_KEY || '',
  apiSecret: process.env.MEXC_API_SECRET || '',
  zeroFeeOnly: bool(process.env.ZERO_FEE_ONLY, false),
  maxTakerFee: num(process.env.MAX_TAKER_FEE, 0.0),
  symbolAllow: new Set(list(process.env.SYMBOL_ALLOWLIST)),
  windowSec: num(process.env.WINDOW_SEC, 5),
  minAbsPct: num(process.env.MIN_ABS_PCT, 0.003),
  zMult: num(process.env.Z_MULTIPLIER, 4.0),
  cooldownSec: num(process.env.COOLDOWN_SEC, 45),
  telegram: { token: process.env.TELEGRAM_BOT_TOKEN||'', chatId: process.env.TELEGRAM_CHAT_ID||'' },
  webhookUrl: process.env.WEBHOOK_URL || '',
  execute: bool(process.env.EXECUTE, true),
  autotrade: bool(process.env.AUTOTRADE, true),
  leverage: num(process.env.LEVERAGE, 50),
  marginMode: (process.env.MARGIN_MODE||'cross'),
  sideMode: (process.env.SIDE||'auto'),
  notionalUSDT: num(process.env.NOTIONAL_USDT, 20),
  trail: {
    enable: bool(process.env.TRAIL_ENABLE, true),
    startPct: num(process.env.TRAIL_START_PCT, 0.003),
    distancePct: num(process.env.TRAIL_DISTANCE_PCT, 0.004),
    stepPct: num(process.env.TRAIL_STEP_PCT, 0.001),
  },
  tradeCooldownSec: num(process.env.COOLDOWN_TRADE_SEC, 60),
};

const spikeEngine = new SpikeEngine({
  windowSec: cfg.windowSec, minAbsPct: cfg.minAbsPct, zMult: cfg.zMult, cooldownSec: cfg.cooldownSec
});

const scanner = new MexcScanner({
  zeroFeeOnly: cfg.zeroFeeOnly, maxTakerFee: cfg.maxTakerFee, symbolAllow: Array.from(cfg.symbolAllow)
});

const trailing = new TrailingManager({ startPct: cfg.trail.startPct, distancePct: cfg.trail.distancePct, stepPct: cfg.trail.stepPct });

const executor = createExecutor({
  apiKey: cfg.apiKey,
  apiSecret: cfg.apiSecret,
  execute: cfg.execute,
  leverage: cfg.leverage,
  marginMode: cfg.marginMode,
  notionalUSDT: cfg.notionalUSDT
});

const lastTradeAt = new Map(); // symbol -> ts

function canTrade(symbol, ts){
  const prev = lastTradeAt.get(symbol) || 0;
  return (ts - prev) / 1000 >= cfg.tradeCooldownSec;
}

async function onSpike(ts, r, out){
  const price = Number(r.lastPrice);
  const payload = {
    t: new Date(ts).toISOString(),
    symbol: r.symbol,
    lastPrice: price,
    absPct: out.absPct,
    zScore: out.zScore,
    direction: out.direction,
    windowSec: cfg.windowSec
  };
  const msg =
    `⚡ MEXC spike (${payload.direction})\n` +
    `• ${payload.symbol}\n` +
    `• Price: ${payload.lastPrice}\n` +
    `• 1s Δ: ${(payload.absPct * 100).toFixed(2)}%\n` +
    `• Z≈${payload.zScore.toFixed(2)} | window ${payload.windowSec}s\n` +
    `• ${payload.t}`;
  console.log(`[${nowIso()}] ALERT ${payload.symbol} ${payload.direction} ${(payload.absPct*100).toFixed(2)}%`);
  await alertTelegram(cfg.telegram.token, cfg.telegram.chatId, msg);
  await alertWebhook(cfg.webhookUrl, { type: 'mexc_spike', ...payload });

  if (!cfg.autotrade || !cfg.apiKey || !cfg.apiSecret) return;
  if (!canTrade(r.symbol, ts)) return;

  // decide side
  let side = 'long';
  if (cfg.sideMode === 'short') side = 'short';
  else if (cfg.sideMode === 'auto') side = (out.direction === 'UP' ? 'long' : 'short');
  else if (cfg.sideMode === 'long') side = 'long';

  lastTradeAt.set(r.symbol, ts);
  const positionType = (side === 'long' ? 1 : 2);
  await executor.ensureSymbolConfig(r.symbol, positionType).catch(()=>{});
  const res = await executor.entryByNotional(r.symbol, side, price, cfg.notionalUSDT).catch(e=>({ error: String(e)}));
  trailing.onEntry(r.symbol, side, price);
  await alertWebhook(cfg.webhookUrl, { type: 'entry_result', symbol: r.symbol, side, res });
}

function handleTrailing(ts, r){
  const move = trailing.onPrice(r.symbol, Number(r.lastPrice));
  if (move && cfg.trail.enable){
    // NOTE: For simplicity, trailing stop updates are emitted via webhook;
    // server-side MEXC "trailing stop" API is handled by client managing exits.
    alertWebhook(cfg.webhookUrl, { type: 'trailing_update', ...move }).catch(()=>{});
  }
}

async function main(){
  console.log(`[${nowIso()}] Boot: fetching contract metadata…`);
  await scanner.initContracts();
  console.log(`[${nowIso()}] Universe: ${scanner.activeSymbols.size} symbols${cfg.zeroFeeOnly ? ' (zero-fee filter ON)' : ''}`);
  scanner.onTickers = (batchTs, rows) => {
    for (const r of rows){
      if (!scanner.activeSymbols.has(r.symbol)) continue;
      const out = spikeEngine.update(r.symbol, Number(r.lastPrice), batchTs);
      if (out?.isSpike) onSpike(batchTs, r, out);
      handleTrailing(batchTs, r);
    }
  };
  console.log(`[${nowIso()}] Connecting WS…`);
  await scanner.connect();
}
main().catch(e=>{ console.error('FATAL', e); process.exit(1); });
