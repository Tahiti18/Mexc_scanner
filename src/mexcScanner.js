import { WebSocket } from 'ws';

const WS_URL = 'wss://contract.mexc.com/edge';
const CONTRACT_DETAIL_URL = 'https://contract.mexc.com/api/v1/contract/detail';

export class MexcScanner {
  constructor({ zeroFeeOnly = false, maxTakerFee = 0.0, symbolAllow = [] } = {}) {
    this.zeroFeeOnly = zeroFeeOnly;
    this.maxTakerFee = maxTakerFee;
    this.symbolAllow = new Set(symbolAllow);
    this.activeSymbols = new Set();
    this.ws = null;
    this.onTickers = null;
  }
  async initContracts() {
    const res = await fetch(CONTRACT_DETAIL_URL);
    if (!res.ok) throw new Error(`contract/detail http ${res.status}`);
    const json = await res.json();
    const rows = Array.isArray(json?.data) ? json.data : [];
    const pass = [];
    for (const r of rows) {
      if (r?.state !== 0) continue;
      if (r?.apiAllowed === false) continue;
      if (this.symbolAllow.size && !this.symbolAllow.has(r.symbol)) continue;
      if (this.zeroFeeOnly) {
        const taker = Number(r.takerFeeRate ?? 0);
        const maker = Number(r.makerFeeRate ?? 0);
        if (Math.max(taker, maker) > this.maxTakerFee) continue;
      }
      pass.push(r.symbol);
    }
    this.activeSymbols = new Set(pass);
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      let pingTimer = null;
      const sendPing = () => { try { this.ws?.send(JSON.stringify({ method: 'ping' })); } catch {} };
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ method: 'sub.tickers', param: {} }));
        pingTimer = setInterval(sendPing, 15000);
        resolve();
      });
      this.ws.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg?.channel === 'push.tickers' && Array.isArray(msg.data)) {
          const ts = Number(msg.ts || Date.now());
          const rows = msg.data.map(x => ({
            symbol: x.symbol,
            lastPrice: x.lastPrice,
            fairPrice: x.fairPrice,
            riseFallRate: x.riseFallRate,
            volume24: x.volume24
          }));
          if (this.onTickers) this.onTickers(ts, rows);
        }
      });
      this.ws.on('error', (e) => console.error('WS error', e?.message || e));
      this.ws.on('close', () => {
        if (pingTimer) clearInterval(pingTimer);
        setTimeout(() => this.connect().catch(()=>{}), 2000);
      });
    });
  }
}
