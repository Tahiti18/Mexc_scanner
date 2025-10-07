import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Advanced Live Dashboard (no Tailwind; zero extra deps)
 * - Initial snapshot from /alerts
 * - Live updates via Server-Sent Events from /stream
 * - Sortable columns, search, and direction filter (All / Long / Short)
 * - Auto-resort on new data
 * - Live row updates without page reload
 * - TradingView “Chart” button (MEXC:<symbol-without-underscore>)
 *
 * API base:
 *  - If you deploy the web app *separately* from the worker, set VITE_API_BASE in Railway to:
 *      https://worker-production-ad5d.up.railway.app
 *  - Otherwise it will use the same host the app was served from.
 */

const API_BASE =
  (import.meta && import.meta.env && import.meta.env.VITE_API_BASE) ||
  window.location.origin;

const ENDPOINTS = {
  ALERTS: `${API_BASE}/alerts`,
  STREAM: `${API_BASE}/stream`,
};

const DIR = {
  UP: "UP",
  DOWN: "DOWN",
};

const headerStyle = {
  background: "#0b1220",
  borderBottom: "1px solid #19203a",
  color: "#a8c1ff",
  padding: "14px 16px",
  fontWeight: 600,
  position: "sticky",
  top: 0,
  zIndex: 2,
};

const cellStyle = {
  padding: "10px 14px",
  borderBottom: "1px dashed #1a2342",
  whiteSpace: "nowrap",
};

const badge = (txt, bg) => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  background: bg,
  color: "#e7f0ff",
});

const btn = {
  padding: "6px 10px",
  border: "1px solid #2b3b7a",
  borderRadius: 8,
  background: "transparent",
  color: "#cfe0ff",
  cursor: "pointer",
  fontWeight: 600,
};

const toggleBtn = (active) => ({
  ...btn,
  background: active ? "#1c2d66" : "transparent",
});

const formatPct = (n) => `${n.toFixed(3)}%`;
const formatTime = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour12: false });

function upColor(v) {
  // Map bigger Z to brighter green; smaller to dim
  const clamp = Math.min(6, Math.max(1.5, v || 0));
  const pct = (clamp - 1.5) / (6 - 1.5); // 0..1
  const g = Math.round(160 + pct * 80); // 160..240
  return `rgb(60, ${g}, 120)`;
}
function downColor(v) {
  const clamp = Math.min(6, Math.max(1.5, v || 0));
  const pct = (clamp - 1.5) / (6 - 1.5);
  const r = Math.round(180 + pct * 60); // 180..240
  return `rgb(${r}, 70, 90)`;
}

function tvUrl(symbolUnderscore) {
  // open TradingView with explicit exchange: "MEXC:<symbol-without-underscore>"
  const s = String(symbolUnderscore || "").replace("_", "");
  return `https://www.tradingview.com/chart/?symbol=MEXC:${s}`;
}

function useSSE(onEvent) {
  const esRef = useRef(null);
  useEffect(() => {
    let es;
    try {
      es = new EventSource(ENDPOINTS.STREAM, { withCredentials: false });
      esRef.current = es;

      es.onmessage = (ev) => {
        // We support plain data or stringified JSON array/object
        try {
          const payload = JSON.parse(ev.data);
          onEvent(payload);
        } catch {
          // Fallback: try to parse line-per-event or ignore
        }
      };
      es.onerror = () => {
        // Browser will auto-reconnect; no action needed.
      };
    } catch {
      /* ignore */
    }
    return () => {
      try {
        esRef.current && esRef.current.close();
      } catch {}
    };
  }, [onEvent]);
}

export default function App() {
  const [rows, setRows] = useState([]); // [{symbol, direction, move_pct, z_score, t, price}]
  const [search, setSearch] = useState("");
  const [dirFilter, setDirFilter] = useState("ALL"); // ALL | UP | DOWN
  const [sortBy, setSortBy] = useState("z"); // z | pct | symbol | time
  const [sortDesc, setSortDesc] = useState(true);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(ENDPOINTS.ALERTS, { headers: { accept: "application/json" } });
        const js = await r.json();
        if (cancelled) return;
        const arr = Array.isArray(js) ? js : Array.isArray(js?.alerts) ? js.alerts : [];
        // Normalize + sort newest first by z
        setRows(
          arr
            .map(n => ({
              symbol: n.symbol,
              direction: n.direction || (n.dir || "").toUpperCase(),
              move_pct: Number(n.move_pct ?? n.pct ?? 0),
              z_score: Number(n.z_score ?? n.z ?? 0),
              t: n.t || n.time || n.ts || new Date().toISOString(),
              price: Number(n.price ?? 0),
            }))
            .filter(x => x.symbol)
        );
      } catch {
        /* ignore initial failures; SSE will still fill in */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live SSE
  useSSE((payload) => {
    // Accept single object or array
    const list = Array.isArray(payload) ? payload : [payload];
    setRows((prev) => {
      const map = new Map(prev.map((r) => [r.symbol, r]));
      for (const n of list) {
        if (!n || !n.symbol) continue;
        const symbol = n.symbol;
        const next = {
          symbol,
          direction: (n.direction || n.dir || "").toUpperCase(),
          move_pct: Number(n.move_pct ?? n.pct ?? 0),
          z_score: Number(n.z_score ?? n.z ?? 0),
          t: n.t || n.time || n.ts || new Date().toISOString(),
          price: Number(n.price ?? map.get(symbol)?.price ?? 0),
        };
        // Only keep if it's an alert (has direction + non-zero %), but still allow soft updates
        map.set(symbol, { ...(map.get(symbol) || {}), ...next });
      }
      return Array.from(map.values());
    });
  });

  // Filtering + sorting
  const view = useMemo(() => {
    const q = search.trim().toUpperCase();
    let out = rows.filter((r) => (dirFilter === "ALL" ? true : r.direction === dirFilter));
    if (q) out = out.filter((r) => r.symbol?.toUpperCase().includes(q));

    const cmp = (a, b) => {
      const m = sortDesc ? -1 : 1;
      switch (sortBy) {
        case "symbol": return a.symbol.localeCompare(b.symbol) * m;
        case "pct": return (a.move_pct - b.move_pct) * m;
        case "time": return (new Date(a.t) - new Date(b.t)) * m;
        case "z":
        default: return (a.z_score - b.z_score) * m;
      }
    };
    out.sort(cmp);
    return out;
  }, [rows, search, dirFilter, sortBy, sortDesc]);

  const header = (label, key) => (
    <th
      style={{ ...headerStyle, cursor: "pointer" }}
      onClick={() => {
        if (sortBy === key) setSortDesc((d) => !d);
        else {
          setSortBy(key);
          setSortDesc(true);
        }
      }}
    >
      {label}{" "}
      <span style={{ fontSize: 12, opacity: sortBy === key ? 0.9 : 0.3 }}>
        {sortBy === key ? (sortDesc ? "▼" : "▲") : "⇅"}
      </span>
    </th>
  );

  return (
    <div style={{ background: "#070d1a", minHeight: "100vh", color: "#cfe0ff" }}>
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 3,
          background: "#0a1328",
          borderBottom: "1px solid #142250",
          padding: "14px 18px",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 800, color: "#d4e3ff", letterSpacing: 0.25 }}>
          MEXC Live Dashboard — Alerts
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            style={toggleBtn(dirFilter === "ALL")}
            onClick={() => setDirFilter("ALL")}
            title="Show all"
          >
            All
          </button>
          <button
            style={toggleBtn(dirFilter === DIR.UP)}
            onClick={() => setDirFilter(DIR.UP)}
            title="Show potential longs"
          >
            Longs ▲
          </button>
          <button
            style={toggleBtn(dirFilter === DIR.DOWN)}
            onClick={() => setDirFilter(DIR.DOWN)}
            title="Show potential shorts"
          >
            Shorts ▼
          </button>
          <input
            placeholder="Search symbol…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: "#0c1736",
              border: "1px solid #1b2f6a",
              color: "#d8e6ff",
              padding: "8px 10px",
              borderRadius: 8,
              minWidth: 160,
              outline: "none",
            }}
          />
        </div>
      </div>

      <div style={{ padding: "10px 14px" }}>
        <div
          style={{
            border: "1px solid #16224a",
            borderRadius: 10,
            overflow: "hidden",
            background: "#0b1226",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "separate",
              borderSpacing: 0,
              fontSize: 14,
            }}
          >
            <thead>
              <tr>
                {header("Symbol", "symbol")}
                {header("Direction", "dir")}
                {header("% Move", "pct")}
                {header("Z-Score", "z")}
                {header("Time", "time")}
                <th style={headerStyle}>Chart</th>
              </tr>
            </thead>
            <tbody>
              {view.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ ...cellStyle, textAlign: "center", padding: 30 }}>
                    Waiting for alerts…
                  </td>
                </tr>
              ) : (
                view.map((r) => {
                  const up = r.direction === DIR.UP;
                  const dirChip = up ? (
                    <span style={badge("UP ▲", upColor(r.z_score))} />
                  ) : (
                    <span style={badge("DOWN ▼", downColor(r.z_score))} />
                  );
                  return (
                    <tr key={r.symbol}>
                      <td style={{ ...cellStyle, fontWeight: 700 }}>{r.symbol}</td>
                      <td style={{ ...cellStyle }}>{dirChip}</td>
                      <td style={{ ...cellStyle, color: up ? "#7af6bd" : "#ff9da4" }}>
                        {formatPct(r.move_pct || 0)}
                      </td>
                      <td style={{ ...cellStyle, color: up ? upColor(r.z_score) : downColor(r.z_score) }}>
                        {Number(r.z_score || 0).toFixed(2)}
                      </td>
                      <td style={{ ...cellStyle, opacity: 0.85 }}>{formatTime(r.t)}</td>
                      <td style={{ ...cellStyle }}>
                        <a
                          href={tvUrl(r.symbol)}
                          target="_blank"
                          rel="noreferrer"
                          style={{ ...btn, textDecoration: "none" }}
                        >
                          Chart
                        </a>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div style={{ opacity: 0.65, fontSize: 12, marginTop: 10 }}>
          Data source: <code>/alerts</code> + live <code>/stream</code> (SSE). Sorting by{" "}
          <strong>{sortBy}</strong> {sortDesc ? "(desc)" : "(asc)"}. Filter:{" "}
          <strong>{dirFilter}</strong>.
        </div>
      </div>
    </div>
  );
}
