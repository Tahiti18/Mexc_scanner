MEXC Futures Spike Scanner + ACTIVE Executor (Trailing Stop)

WARNING: EXECUTE=true and AUTOTRADE=true by default. This will place real orders if you set API keys.

What it does
- Scans all MEXC USDT perpetuals via WebSocket (sub.tickers) ~1 Hz.
- Detects momentum spikes (EWMA vs 1s price-velocity).
- Enters in spike direction with your configured notional and leverage.
- Manages a client-side trailing stop and emits updates.
- Uses official Futures REST endpoints (submit order, cancel, change leverage/position mode).

Quick start
1) Copy .env.example → .env and add your API key/secret.
2) Deploy/run: npm i && npm start (Node 18+).

Safety
- If you want paper-only, set EXECUTE=false.
- Use tiny NOTIONAL_USDT first and test on low-risk symbols.
