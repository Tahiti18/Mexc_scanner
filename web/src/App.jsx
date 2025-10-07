import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Live Alerts Dashboard (no Tailwind, no extra deps)
 * - Pulls initial list from `${API_BASE}/alerts`
 * - Subscribes to `${API_BASE}/stream` via SSE
 * - API_BASE comes from Vite env VITE_API_BASE or falls back to
 *   the same origin (useful when the web is reverse-proxied through the worker)
 */

const API_BASE =
  (import.meta.env && import.meta.env.VITE_API_BASE) ||
  `${window.location.protocol}//${window.location.host}`;

const fmtTime = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
};

const styles = `
:root{
  --bg:#0b0f1a;--panel:#0f1733;--text:#dbe2ff;--muted:#9fb7ff;
  --up:#20d080;--dn:#ff6b6b;--chip:#223061;--border:#19203a
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial}
header{position:sticky;top:0;background:#0b0f1ad9;border-bottom:1px solid var(--border);padding:10px 16px;display:flex;gap:10px;align-items:center}
main{max-width:1100px;margin:0 auto;padding:14px}
.tag{font-size:12px;color:var(--muted);background:var(--chip);border:1px solid #2b3b8f;border-radius:999px;padding:2px 8px}
.btn{padding:6px 10px;border:1px solid #2b3b8f;border-radius:6px;text-decoration:none;color:var(--muted)}
.row{display:flex;align-items:center;padding:10px 8px;border-bottom:1px solid #131b3a}
.sym{width:180px;font-weight:600}
.dir{width:90px;font-weight:700}
.dir.up{color:var(--up)} .dir.down{color:var(--dn)}
.pct{width:120px}
.time{margin-left:auto;font-size:12px;color:var(--muted)}
small{color:var(--muted)}
`;

function Arrow({ dir }) {
  // Green ▲ for UP, Red ▼ for DOWN (no whiskey/clouds)
  if (dir === "UP") return <span style={{ color: "var(--up)" }}>▲</span>;
  return <span style={{ color: "var(--dn)" }}>▼</span>;
}

function Row({ a }) {
  // TradingView with explicit exchange (MEXC) and symbol (underscore removed)
  const tv = useMemo(() => {
    const tvSym = (a.symbol || "").replace("_", "");
    return `https://www.tradingview.com/chart/?symbol=${tvSym}:MEXC`;
  }, [a.symbol]);

  return (
    <div className="row">
      <div className="sym">{a.symbol}</div>
      <div className={`dir ${a.direction === "UP" ? "up" : "down"}`}>
        <Arrow dir={a.direction} /> {a.direction}
      </div>
      <div className="pct">{Number(a.move_pct).toFixed(3)}%</div>
      <a className="btn" href={tv} target="_blank" rel="noreferrer">
        Chart
      </a>
      <div className="time">{fmtTime(a.t)}</div>
    </div>
  );
}

export default function App() {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("connecting");
  const esRef = useRef(null);

  // Initial load
  useEffect(() => {
    let aborted = false;
    fetch(`${API_BASE}/alerts`)
      .then((r) => r.json())
      .then((arr) => {
        if (!aborted) setItems(Array.isArray(arr) ? arr : []);
      })
      .catch(() => {});
    return () => {
      aborted = true;
    };
  }, []);

  // SSE subscription
  useEffect(() => {
    // Close any previous connection
    try {
      esRef.current?.close();
    } catch {}
    const es = new EventSource(`${API_BASE}/stream`, { withCredentials: false });
    esRef.current = es;

    es.onopen = () => setStatus("live");
    es.onerror = () => setStatus("error");
    es.onmessage = (ev) => {
      try {
        const a = JSON.parse(ev.data);
        setItems((prev) => [a, ...prev].slice(0, 500));
      } catch {}
    };

    return () => {
      try {
        es.close();
      } catch {}
    };
  }, []);

  return (
    <>
      <style>{styles}</style>
      <header>
        <div style={{ fontWeight: 700 }}>Live Alerts</div>
        <span className="tag">API {API_BASE}</span>
        <span className="tag">
          SSE: {status === "live" ? "connected" : status}
        </span>
        <a className="btn" href={`${API_BASE}/sse-viewer`} target="_blank" rel="noreferrer">
          Raw SSE
        </a>
        <a className="btn" href={`${API_BASE}/alerts`} target="_blank" rel="noreferrer">
          JSON
        </a>
      </header>

      <main>
        {items.length === 0 ? (
          <small>No alerts yet… waiting for stream.</small>
        ) : (
          items.map((a, i) => <Row key={`${a.t}-${a.symbol}-${i}`} a={a} />)
        )}
      </main>
    </>
  );
}
