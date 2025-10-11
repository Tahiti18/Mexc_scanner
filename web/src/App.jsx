import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * MEXC Live Dashboard — sortable + dual chart links
 * - Click headers to sort (toggles asc/desc)
 * - Filters: All / Longs / Shorts
 * - Two chart buttons per row: MEXC (native), TV (TradingView)
 */

const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");
const JSON_URL = `${API_BASE}/alerts`;
const SSE_URL = `${API_BASE}/stream`;

// Chart link config
const TV_SUFFIX = import.meta.env.VITE_TV_SUFFIX ?? ""; // e.g. ".P" or ""
const TV_BASE = "https://www.tradingview.com/chart/?symbol=";

// For MEXC PERP ui charts, this path works for symbols like NEET_USDT, BTC_USDT, etc.
const MEXC_FUTURES_BASE =
  (import.meta.env.VITE_MEXC_FUTURES_BASE || "https://futures.mexc.com/exchange").replace(
    /\/+$/,
    ""
  );

const headers = [
  { key: "symbol", label: "Symbol" },
  { key: "direction", label: "Direction" },
  { key: "move_pct", label: "% Move" },
  { key: "z_score", label: "Z-Score" },
  { key: "t", label: "Time" },
  { key: "chart", label: "Chart", isAction: true },
];

const styles = {
  chipUp: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 6,
    fontWeight: 700,
    background: "rgba(34,197,94,.15)",
    border: "1px solid rgba(34,197,94,.6)",
    color: "#22c55e",
  },
  chipDown: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 6,
    fontWeight: 700,
    background: "rgba(239,68,68,.15)",
    border: "1px solid rgba(239,68,68,.6)",
    color: "#ef4444",
  },
  tdLeft: {
    padding: "10px 14px",
    textAlign: "left",
    borderBottom: "1px solid var(--border)",
  },
  tdRight: {
    padding: "10px 14px",
    textAlign: "right",
    borderBottom: "1px solid var(--border)",
  },
  btn: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #2b3b8f",
    color: "var(--muted)",
    textDecoration: "none",
    marginLeft: 6,
  },
};

function dirChip(d) {
  const up = d === "UP";
  return <span style={up ? styles.chipUp : styles.chipDown}>{up ? "▲ LONG" : "▼ SHORT"}</span>;
}

function toNumber(v, d = -Infinity) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function timeMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

// Build links for each symbol
function makeLinks(symbol) {
  const sym = String(symbol || "");
  const tvTicker = `MEXC:${sym.replace("_", "")}${TV_SUFFIX}`; // e.g. MEXC:BTCUSDT or MEXC:BTCUSDT.P
  const tvUrl = `${TV_BASE}${encodeURIComponent(tvTicker)}`;
  const mexcUrl = `${MEXC_FUTURES_BASE}/${encodeURIComponent(sym)}`; // e.g. https://futures.mexc.com/exchange/BTC_USDT
  return { tvUrl, mexcUrl };
}

export default function App() {
  const [alerts, setAlerts] = useState([]);
  const [filter, setFilter] = useState("ALL"); // ALL | LONG | SHORT
  const [sortKey, setSortKey] = useState("t");
  const [sortDir, setSortDir] = useState("desc"); // asc | desc
  const esRef = useRef(null);

  // initial load + SSE
  useEffect(() => {
    let cancelled = false;

    fetch(JSON_URL)
      .then((r) => r.json())
      .then((arr) => {
        if (!cancelled && Array.isArray(arr)) setAlerts(arr);
      })
      .catch(() => {});

    const es = new EventSource(SSE_URL);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const a = JSON.parse(ev.data);
        setAlerts((prev) => {
          const next = [a, ...prev];
          if (next.length > 500) next.length = 500;
          return next;
        });
      } catch {}
    };
    es.onerror = () => {
      // Browser auto-retries
    };

    return () => {
      cancelled = true;
      try { es.close(); } catch {}
    };
  }, []);

  // filter + sort
  const rows = useMemo(() => {
    let r = alerts;
    if (filter === "LONG") r = r.filter((x) => x.direction === "UP");
    else if (filter === "SHORT") r = r.filter((x) => x.direction === "DOWN");

    const mul = sortDir === "asc" ? 1 : -1;

    return [...r].sort((a, b) => {
      switch (sortKey) {
        case "symbol":
          return mul * String(a.symbol).localeCompare(String(b.symbol));
        case "direction":
          return mul * String(a.direction).localeCompare(String(b.direction));
        case "move_pct":
          return mul * (toNumber(a.move_pct) - toNumber(b.move_pct));
        case "z_score":
          return mul * (toNumber(a.z_score) - toNumber(b.z_score));
        case "t":
          return mul * (timeMs(a.t) - timeMs(b.t));
        default:
          return 0;
      }
    });
  }, [alerts, filter, sortKey, sortDir]);

  function toggleSort(key) {
    if (key === "chart") return;
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "symbol" ? "asc" : "desc");
    }
  }

  function sortIcon(key) {
    if (key !== sortKey) return null;
    return <span style={{ marginLeft: 6, opacity: 0.8 }}>{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  return (
    <div style={{ padding: 16, maxWidth: 1280, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>MEXC Live Dashboard — Alerts</h2>
        <span
          title={`Data: ${JSON_URL} + live ${SSE_URL}`}
          style={{
            marginLeft: 8,
            padding: "4px 10px",
            borderRadius: 999,
            background: "var(--chip)",
            border: "1px solid var(--border)",
            color: "var(--muted)",
            fontSize: 12,
          }}
        >
          Data: {JSON_URL.replace(location.origin, "")} (SSE)
        </span>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {[
            { k: "ALL", label: "All" },
            { k: "LONG", label: "Longs" },
            { k: "SHORT", label: "Shorts" },
          ].map((x) => (
            <button
              key={x.k}
              onClick={() => setFilter(x.k)}
              style={{
                borderRadius: 8,
                padding: "6px 10px",
                border: "1px solid var(--border)",
                background: filter === x.k ? "var(--panel-2)" : "rgba(255,255,255,0.02)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
          background: "var(--panel)",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead
            style={{
              background: "linear-gradient(0deg, #0f1324, #0f1324)",
              position: "sticky",
              top: 0,
              zIndex: 1,
            }}
          >
            <tr>
              {headers.map((h) => (
                <th
                  key={h.key}
                  onClick={() => toggleSort(h.key)}
                  style={{
                    textAlign: h.key === "symbol" ? "left" : "right",
                    padding: "12px 14px",
                    cursor: h.isAction ? "default" : "pointer",
                    whiteSpace: "nowrap",
                    color: "var(--muted)",
                    userSelect: "none",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center" }}>
                    {h.label}
                    {sortIcon(h.key)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={headers.length}
                  style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}
                >
                  Waiting for alerts…
                </td>
              </tr>
            ) : (
              rows.map((a, i) => {
                const { tvUrl, mexcUrl } = makeLinks(a.symbol);
                return (
                  <tr key={`${a.t}-${a.symbol}-${i}`}>
                    <td style={styles.tdLeft}>{a.symbol}</td>
                    <td style={styles.tdRight}>{dirChip(a.direction)}</td>
                    <td style={styles.tdRight}>{Number(a.move_pct).toFixed(3)}%</td>
                    <td style={styles.tdRight}>{Number(a.z_score).toFixed(2)}</td>
                    <td style={styles.tdRight}>{new Date(a.t).toLocaleTimeString()}</td>
                    <td style={styles.tdRight}>
                      <a href={mexcUrl} target="_blank" rel="noreferrer" style={styles.btn} title="Open on MEXC">
                        MEXC
                      </a>
                      <a href={tvUrl} target="_blank" rel="noreferrer" style={styles.btn} title="Open on TradingView">
                        TV
                      </a>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div
        style={{
          marginTop: 10,
          color: "var(--muted)",
          fontSize: 12,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span>
          Data source: <code>/alerts</code> + live <code>/stream</code> (SSE).
        </span>
        <span>
          Sorting by <b>{headers.find((h) => h.key === sortKey)?.label}</b> ({sortDir}).
        </span>
        <span>Filter: {filter}.</span>
        <span>TV suffix: <code>{TV_SUFFIX || "(none)"}</code></span>
      </div>
    </div>
  );
}
