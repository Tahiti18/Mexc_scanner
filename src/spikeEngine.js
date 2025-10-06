export class SpikeEngine {
  constructor({ windowSec = 5, minAbsPct = 0.003, zMult = 4.0, cooldownSec = 45 }) {
    this.windowSec = windowSec;
    this.minAbsPct = minAbsPct;
    this.zMult = zMult;
    this.cooldownSec = cooldownSec;
    this.last = new Map();
    this.ewmaAbs = new Map();
    this.coolUntil = new Map();
  }
  update(symbol, price, ts) {
    const prev = this.last.get(symbol);
    this.last.set(symbol, { price, ts });
    if (!prev || prev.price <= 0) return null;
    const dt = Math.max(1, Math.round((ts - prev.ts) / 1000));
    if (dt <= 0) return null;
    const pct = (price - prev.price) / prev.price;
    const absPct = Math.abs(pct);
    const alpha = 2 / (this.windowSec + 1);
    const base = this.ewmaAbs.get(symbol) ?? absPct;
    const ewma = alpha * absPct + (1 - alpha) * base;
    this.ewmaAbs.set(symbol, ewma);
    const threshold = Math.max(this.minAbsPct, this.zMult * ewma);
    const isSpike = absPct >= threshold;
    if (!isSpike) return { isSpike: false };
    const until = this.coolUntil.get(symbol) || 0;
    if (ts < until) return { isSpike: false };
    this.coolUntil.set(symbol, ts + this.cooldownSec * 1000);
    return {
      isSpike: true,
      absPct,
      zScore: ewma > 0 ? absPct / ewma : Infinity,
      direction: pct >= 0 ? 'UP' : 'DOWN'
    };
  }
}
