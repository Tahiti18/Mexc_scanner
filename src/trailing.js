export class TrailingManager {
  constructor({ startPct=0.003, distancePct=0.004, stepPct=0.001 }={}) {
    this.startPct = startPct;
    this.distancePct = distancePct;
    this.stepPct = stepPct;
    this.positions = new Map(); // symbol -> { side, entry, high, low, stop }
  }
  onEntry(symbol, side, entry) {
    this.positions.set(symbol, { side, entry, high: entry, low: entry, stop: null });
  }
  onPrice(symbol, price) {
    const p = this.positions.get(symbol); if (!p) return null;
    if (p.side === 'long') {
      if (price > p.high) p.high = price;
      const gain = (p.high - p.entry) / p.entry;
      if (gain >= this.startPct) {
        const newStop = p.high * (1 - this.distancePct);
        if (!p.stop || newStop - p.stop >= p.high * this.stepPct) {
          p.stop = newStop;
          return { symbol, side: 'long', stop: p.stop };
        }
      }
    } else if (p.side === 'short') {
      if (price < p.low) p.low = price;
      const gain = (p.entry - p.low) / p.entry;
      if (gain >= this.startPct) {
        const newStop = p.low * (1 + this.distancePct);
        if (!p.stop || p.stop - newStop >= p.low * this.stepPct) {
          p.stop = newStop;
          return { symbol, side: 'short', stop: p.stop };
        }
      }
    }
    return null;
  }
  close(symbol) { this.positions.delete(symbol); }
}
