import React, { useEffect, useMemo, useRef, useState } from 'react';

/** 
 * MEXC Live Dashboard (React)
 * - Connects to `${apiBase}/alerts` (initial)
 * - Live updates from `${apiBase}/stream` (alerts) and `${apiBase}/ticks` (continuous deltas)
 * - Tabs: All / Long / Short
 * - Search
 * - Auto-sort (longs by largest ↑ first, shorts by largest ↓ first, All shows both blocks)
 * - Mini sparkline (last ~60 deltas)
 * - Click a row -> TradingView chart panel (MEXC:SYMBOL, dark)
 * - Arrows: 🟢 ↑ (UP) / 🔴 ↓ (DOWN) — no whiskey/clouds
 */

const Tabs = ['all', 'long', 'short'];

export default function App({ apiBase }) {
  const [mode, setMode] = useState('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(null);

  // symbol -> { symbol, direction, move_pct, z_score, t, price, spark: number[] }
  const [rows, setRows] = useState(new Map());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  /* ---------- initial history ---------- */
  useEffect(() => {
    let stop = false;
    fetch(`${apiBase}/alerts`)
      .then(r => r.ok ? r.json() : [])
      .then(arr => {
        if (stop || !Array.isArray(arr)) return;
        const map = new Map();
        for (const a of arr) {
          map.set(a.symbol, { ...a, spark: [] });
        }
        setRows(map);
      })
      .catch(() => {});
    return () => { stop = true; };
  }, [apiBase]);

  /* ---------- SSE: alerts (spikes) ---------- */
  useEffect(() => {
    const es = new EventSource(`${apiBase}/stream`);
    es.onmessage = (ev) => {
      try {
        const a = JSON.parse(ev.data);
        setRows(prev => {
          const m = new Map(prev);
          const old = m.get(a.symbol);
          m.set(a.symbol, { ...(old || {}), ...a, spark: old?.spark || [] });
          return m;
        });
      } catch {}
    };
    es.onerror = () => { /* browser auto-reconnects */ };
    return () => es.close();
  }, [apiBase]);

  /* ---------- SSE: ticks (continuous deltas) ---------- */
  useEffect(() => {
    const es = new EventSource(`${apiBase}/ticks`);
    es.onmessage = (ev) => {
      try {
        const a = JSON.parse(ev.data); // {symbol, price, move_pct, t}
        setRows(prev => {
          const m = new Map(prev);
          const old = m.get(a.symbol) || {
            symbol: a.symbol,
            direction: a.move_pct >= 0 ? 'UP' : 'DOWN',
            move_pct: Math.abs(a.move_pct),
            z_score: null,
            t: a.t,
            price: a.price,
            spark: []
          };
          const dir = a.move_pct >= 0 ? 'UP' : 'DOWN';
          const mp = Math.abs(a.move_pct);
          const sp = (old.spark || []).slice(-59);
          sp.push(mp);
          m.set(a.symbol, { ...old, direction: dir, move_pct: mp, t: a.t, price: a.price, spark: sp });
          return m;
        });
      } catch {}
    };
    es.onerror = () => { /* autoreconnect */ };
    return () => es.close();
  }, [apiBase]);

  /* ---------- derived list ---------- */
  const list = useMemo(() => {
    let arr = Array.from(rows.values());
    if (mode === 'long')  arr = arr.filter(r => r.direction === 'UP');
    if (mode === 'short') arr = arr.filter(r => r.direction === 'DOWN');
    if (q) {
      const s = q.trim().toUpperCase();
      arr = arr.filter(r => r.symbol?.toUpperCase().includes(s));
    }

    if (mode === 'long') {
      arr.sort((a, b) => b.move_pct - a.move_pct);
    } else if (mode === 'short') {
      arr.sort((a, b) => b.move_pct - a.move_pct);
    } else {
      const L = arr.filter(a => a.direction === 'UP').sort((a, b) => b.move_pct - a.move_pct);
      const S = arr.filter(a => a.direction === 'DOWN').sort((a, b) => b.move_pct - a.move_pct);
      arr = [...L, ...S];
    }
    return arr.slice(0, 400);
  }, [rows, mode, q]);

  // keep a sane default chart symbol
  const chartSym = selected || (list[0]?.symbol);

  return (
    <div className="app-wrap">
      <Header
        mode={mode}
        setMode={setMode}
        q={q}
        setQ={setQ}
      />

      <div className="layout">
        <section className="list">
          {list.map((r) => (
            <Row key={r.symbol} row={r} onClick={() => setSelected(r.symbol)} />
          ))}
          {!list.length && (
            <div className="empty">No symbols match.</div>
          )}
        </section>

        <aside className="side">
          <ChartPane symbol={chartSym} />
        </aside>
      </div>

      <Styles />
    </div>
  );
}

/* ---------------- Header ---------------- */
function Header({ mode, setMode, q, setQ }) {
  return (
    <header className="hdr">
      <div className="brand">
        <span className="title">MEXC Live</span>
        <span className="chip">Realtime</span>
      </div>

      <div className="tabs">
        {Tabs.map(t => (
          <button
            key={t}
            className={`tab ${mode === t ? 'active' : ''}`}
            onClick={() => setMode(t)}
          >
            {t === 'all' ? 'All' : t === 'long' ? 'Longs' : 'Shorts'}
          </button>
        ))}
      </div>

      <div className="spacer" />

      <input
        className="search"
        placeholder="Search symbol…"
        value={q}
        onChange={e => setQ(e.target.value)}
      />
    </header>
  );
}

/* ---------------- Row ---------------- */
function Row({ row, onClick }) {
  const isUp = row.direction === 'UP';
  const arrow = isUp ? ArrowUp : ArrowDown;

  return (
    <div className="row" onClick={onClick}>
      <div className="sym">{row.symbol}</div>
      <div className={`dir ${isUp ? 'up' : 'down'}`}>
        {isUp ? <ArrowUp /> : <ArrowDown />} {isUp ? 'UP' : 'DOWN'}
      </div>
      <div className="pct">{fmtPct(row.move_pct)}</div>
      <div className={`z ${zClass(row.z_score)}`}>{row.z_score ? `z≈${row.z_score.toFixed(2)}` : '—'}</div>
      <div className="spark"><Spark data={row.spark || []} /></div>
      <a
        className="btn"
        href={tvUrl(row.symbol)}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        Chart
      </a>
      <div className="time">{safeTime(row.t)}</div>
    </div>
  );
}

/* ---------------- Sparkline ---------------- */
function Spark({ data = [] }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const w = c.width, h = c.height;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!data.length) return;
    const max = Math.max(...data, 0.0001);
    const step = w / Math.max(1, data.length - 1);
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = i * step;
      const y = h - (data[i] / max) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#8aa1ff';
    ctx.stroke();
  }, [data]);
  return <canvas ref={ref} width={120} height={28} />;
}

/* ---------------- TradingView Panel ---------------- */
function ChartPane({ symbol }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!symbol || !ref.current) return;
    const container = ref.current;
    container.innerHTML = '';
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: `MEXC:${(symbol || 'BTCUSDT').replace('_', '')}`,
      interval: "1",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      allow_symbol_change: true,
      withdateranges: true,
      hide_legend: false,
      hide_top_toolbar: false,
      studies: []
    });
    container.appendChild(script);
  }, [symbol]);

  return (
    <div className="panel">
      <div className="panel-hdr">
        <div className="panel-title">{symbol ? `Chart — ${cleanSym(symbol)}` : 'Chart'}</div>
        {symbol && <a className="panel-link" href={tvUrl(symbol)} target="_blank" rel="noreferrer">Open on TradingView ↗</a>}
      </div>
      <div className="tv" ref={ref} />
    </div>
  );
}

/* ---------------- Icons (inline SVG) ---------------- */
function ArrowUp() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#22c55e" d="M13 5.83V20a1 1 0 1 1-2 0V5.83L7.41 9.41a1 1 0 0 1-1.41-1.41l5-5a1 1 0 0 1 1.41 0l5 5a1 1 0 1 1-1.41 1.41L13 5.83z"/>
    </svg>
  );
}
function ArrowDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#ef4444" d="M11 18.17V4a1 1 0 1 1 2 0v14.17l3.59-3.59a1 1 0 1 1 1.41 1.41l-5 5a1 1 0 0 1-1.41 0l-5-5a1 1 0 1 1 1.41-1.41L11 18.17z"/>
    </svg>
  );
}

/* ---------------- Utils & Styles ---------------- */
function fmtPct(x) {
  if (typeof x !== 'number' || !isFinite(x)) return '0.000%';
  return `${x.toFixed(3)}%`;
}
function zClass(z) {
  if (!z) return 'z z3';
  if (z >= 6) return 'z z6';
  if (z >= 4) return 'z z4';
  return 'z z3';
}
function tvUrl(sym) {
  return `https://www.tradingview.com/chart/?symbol=MEXC:${cleanSym(sym)}`;
}
function cleanSym(sym) {
  return String(sym || '').replace('_', '');
}
function safeTime(t) {
  try { return new Date(t).toLocaleTimeString(); } catch { return ''; }
}

/* ---------------- CSS-in-JSX for single-file drop-in ---------------- */
function Styles() {
  return (
    <style>{`
:root{
  --bg:#0b0f1a; --panel:#0f1426; --line:#141a2f; --text:#dbe2ff; --muted:#9fb0ffcc;
  --up:#22c55e; --down:#ef4444; --accent:#3b82f6; --chip:#0f1630;
}
.app-wrap{min-height:100vh; display:flex; flex-direction:column; background:var(--bg); color:var(--text)}
.hdr{position:sticky;top:0;z-index:10;display:flex;gap:12px;align-items:center;padding:12px 16px;background:var(--bg);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px}
.title{font-weight:700}
.chip{font-size:12px;color:#9fb7ff;background:#0f1630;border:1px solid #1b2a6b;border-radius:999px;padding:2px 8px}
.tabs{display:flex;gap:8px}
.tab{background:#0f1630;border:1px solid #243279;color:#c7d5ff;padding:6px 10px;border-radius:8px;cursor:pointer}
.tab.active{background:#142469;border-color:var(--accent);color:#fff}
.search{margin-left:auto;background:#0f1630;border:1px solid #243279;color:#cfe0ff;border-radius:8px;padding:6px 10px;min-width:220px}

.layout{display:flex;min-height:0;flex:1}
.list{flex:1;overflow:auto;padding:8px 0}
.row{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer}
.row:hover{background:#0f1426}
.sym{min-width:130px;font-weight:700}
.dir{display:flex;align-items:center;gap:6px;min-width:110px}
.dir.up{color:var(--up)}
.dir.down{color:var(--down)}
.pct{min-width:96px}
.z{font-size:12px;padding:2px 6px;border-radius:6px;border:1px solid #2a4a8a;background:#13205b;min-width:70px;text-align:center}
.z.z4{border-color:#6a4ab0;background:#2a233f}
.z.z6{border-color:#a33;background:#3a1f1f}
.spark{min-width:120px}
.btn{padding:6px 10px;border:1px solid #2b3b8f;border-radius:6px;text-decoration:none;color:#9fb7ff}
.time{margin-left:auto;opacity:.75;font-size:12px}

.side{width:44%;min-width:420px;border-left:1px solid var(--line);background:var(--panel);display:flex}
.panel{display:flex;flex-direction:column;gap:8px;flex:1;min-height:100%}
.panel-hdr{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line);background:#0c1226}
.panel-title{font-weight:700}
.panel-link{margin-left:auto;font-size:13px;color:#9fb7ff;text-decoration:none;border:1px solid #2b3b8f;border-radius:6px;padding:4px 8px}
.tv{flex:1;min-height:400px}

.empty{padding:24px;color:#9fb0ff}

@media (max-width:1100px){
  .side{display:none}
}
`}</style>
  );
}
