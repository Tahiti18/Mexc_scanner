// web/src/App.jsx
import { useEffect, useMemo, useRef, useState } from "react";

// ---- API base resolution (runtime > env > hardcoded worker) ----
const urlApi = new URLSearchParams(location.search).get("api")?.trim();
const envApi = import.meta.env.VITE_API_BASE?.trim();
const API = (urlApi || envApi || "https://worker-production-ad5d.up.railway.app").replace(/\/+$/, "");

// ---- UI helpers ----
const fmtPct = (p) => (Number.isFinite(p) ? p.toFixed(3) + "%" : "");
const DirChip = ({ dir }) => (
  <span
    style={{
      padding: "2px 6px",
      borderRadius: 6,
      fontWeight: 600,
      background: dir === "UP" ? "#0f2d1f" : "#2d1616",
      color: dir === "UP" ? "#22c55e" : "#ef4444",
      border: "1px solid " + (dir === "UP" ? "#14532d" : "#7f1d1d"),
    }}
  >
    {dir === "UP" ? "▲ LONG" : "▼ SHORT"}
  </span>
);

function Row({ a }) {
  const tv = "https://www.tradingview.com/chart/?symbol=" + String(a.symbol || "").replace("_", "") + ":MEXC";
  return (
    <tr>
      <td style={{ fontWeight: 700 }}>{a.symbol}</td>
      <td><DirChip dir={a.direction} /></td>
      <td>{fmtPct(a.move_pct)}</td>
      <td>{Number(a.z_score).toFixed(2)}</td>
      <td>{new Date(a.t).toLocaleTimeString()}</td>
      <td>
        <a href={tv} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "#9fb0ff" }}>
          Chart
        </a>
      </td>
    </tr>
  );
}

export default function App() {
  const [alerts, setAlerts] = useState([]);
  const [only, setOnly] = useState("ALL"); // ALL | LONGS | SHORTS
  const esRef = useRef(null);

  // initial load
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const r = await fetch(`${API}/alerts`, { headers: { accept: "application/json" } });
        const arr = (await r.json()) ?? [];
        if (!cancelled) setAlerts(arr);
      } catch {
        // ignore
      }

      // SSE
      try {
        const es = new EventSource(`${API}/stream`, { withCredentials: false });
        esRef.current = es;
        es.onmessage = (ev) => {
          try {
            const a = JSON.parse(ev.data);
            setAlerts((prev) => [a, ...prev].slice(0, 500));
          } catch {}
        };
        es.onerror = () => {
          // auto-reconnect: recreate after a short delay
          try { es.close(); } catch {}
          setTimeout(boot, 1500);
        };
      } catch {
        // retry later
        setTimeout(boot, 1500);
      }
    }

    boot();
    return () => {
      cancelled = true;
      try { esRef.current?.close(); } catch {}
    };
  }, []);

  const filtered = useMemo(() => {
    if (only === "LONGS") return alerts.filter((a) => a.direction === "UP");
    if (only === "SHORTS") return alerts.filter((a) => a.direction === "DOWN");
    return alerts;
  }, [alerts, only]);

  return (
    <div style={{ minHeight: "100vh", background: "#0b0f1a", color: "#dbe2ff", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" }}>
      <header style={{ position: "sticky", top: 0, background: "#0b0f1ad9", borderBottom: "1px solid #19203a", padding: "12px 16px", display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ fontWeight: 800 }}>MEXC Live Dashboard — Alerts</div>
        <span style={{ fontSize: 12, color: "#9fb0ffcc", background: "#0f1630", border: "1px solid #2b3b8f", borderRadius: 999, padding: "2px 8px" }}>
          Data: {API}/(alerts|stream)
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button onClick={() => setOnly("ALL")}    style={btn(only === "ALL")}>All</button>
          <button onClick={() => setOnly("LONGS")}  style={btn(only === "LONGS")}>Longs</button>
          <button onClick={() => setOnly("SHORTS")} style={btn(only === "SHORTS")}>Shorts</button>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: 16 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ color: "#9fb0ffcc" }}>
            <tr>
              <th style={th}>Symbol</th>
              <th style={th}>Direction</th>
              <th style={th}>% Move</th>
              <th style={th}>Z-Score</th>
              <th style={th}>Time</th>
              <th style={th}>Chart</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 16, color: "#9fb0ffcc", textAlign: "center" }}>
                  Waiting for alerts…
                </td>
              </tr>
            ) : (
              filtered.map((a, i) => <Row key={i + a.symbol + a.t} a={a} />)
            )}
          </tbody>
        </table>

        <div style={{ marginTop: 10, fontSize: 12, color: "#9fb0ffcc" }}>
          Data source: <code>/alerts</code> + live <code>/stream</code> (SSE). Sorting by most recent first.
          &nbsp;Filter: {only}.
        </div>
      </main>
    </div>
  );
}

const th = { textAlign: "left", padding: "10px 8px", borderBottom: "1px solid #19203a" };
const btn = (active) => ({
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid #2b3b8f",
  background: active ? "#0f1733" : "transparent",
  color: "#9fb0ffcc",
  cursor: "pointer",
});
