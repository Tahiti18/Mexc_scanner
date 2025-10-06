import { buildSignedHeaders } from './signing.js';

const BASE = process.env.MEXC_BASE_URL || 'https://contract.mexc.com';

async function httpGet(path, params, apiKey, apiSecret){
  const { headers, queryString } = buildSignedHeaders(apiKey, apiSecret, params, 'GET');
  const url = `${BASE}${path}${queryString ? ('?' + queryString) : ''}`;
  const res = await fetch(url, { method: 'GET', headers });
  const json = await res.json().catch(()=>({}));
  return { status: res.status, json };
}
async function httpPost(path, bodyObj, apiKey, apiSecret){
  const payload = bodyObj ? JSON.stringify(bodyObj) : "";
  const { headers, bodyString } = buildSignedHeaders(apiKey, apiSecret, payload, 'POST');
  const url = `${BASE}${path}`;
  const res = await fetch(url, { method: 'POST', headers, body: bodyString || payload });
  const json = await res.json().catch(()=>({}));
  return { status: res.status, json };
}

export function createExecutor({ apiKey, apiSecret, execute=true, leverage=20, marginMode='cross', notionalUSDT=20 }){
  async function ensurePositionMode(mode='2'){ // 1:hedge, 2:one-way
    return httpPost('/api/v1/private/position/change_position_mode', { positionMode: Number(mode) }, apiKey, apiSecret);
  }
  async function setLeverageNoPosition(symbol, positionType, lev){
    return httpPost('/api/v1/private/position/change_leverage', {
      symbol, positionType, leverage: Number(lev), openType: (marginMode === 'isolated' ? 1 : 2)
    }, apiKey, apiSecret);
  }
  async function submitMarket(symbol, side, volContracts){
    // type=5 (market), openType: 1 isolated, 2 cross; side: 1 open long, 3 open short
    const body = {
      symbol,
      price: 0, // ignored for market per docs (server uses market)
      vol: volContracts,
      leverage: leverage,
      side: side === 'long' ? 1 : 3,
      type: 5,
      openType: (marginMode === 'isolated' ? 1 : 2)
    };
    return httpPost('/api/v1/private/order/submit', body, apiKey, apiSecret);
  }
  async function closeAll(symbol){
    // cancel all open orders under contract (if supported)
    return httpPost('/api/v1/private/order/cancel_all', { symbol }, apiKey, apiSecret);
  }
  return {
    async ensureSymbolConfig(symbol, positionType){
      // one-way mode for simplicity
      await ensurePositionMode('2').catch(()=>{});
      await setLeverageNoPosition(symbol, positionType, leverage).catch(()=>{});
    },
    async entryByNotional(symbol, side, price, notional){
      // Convert USDT notional to contracts: use price as hint; MEXC contracts are coin-margined USDT perps where vol is quantity.
      const vol = Math.max(0.001, (notional / Math.max(1e-9, price))); // simplistic size
      if (!execute) return { dryRun: true, symbol, side, vol };
      const r = await submitMarket(symbol, side, vol);
      return r.json || r;
    },
    async cancelAll(symbol){
      return closeAll(symbol);
    }
  };
}
