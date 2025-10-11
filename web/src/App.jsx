import { useEffect, useMemo, useRef, useState } from "react";

/**
 * MEXC Live Dashboard — TF selector (1m/5m/10m/15m) + burst flashing + rank sorting
 * - Top chips switch the % Move column between pct_1m / pct_5m / pct_10m / pct_15m
 * - Click headers to sort (toggles asc/desc). Default sort = Rank (desc)
 * - Filters: All / Longs / Shorts
 * - Dual chart links: MEXC + TradingView
 */

const API_BASE =
  (import.meta.env?.VITE_API_BASE || "").trim() || window.location.origin.replace(/\/$/, "");
const JSON_URL = `${API_BASE}/alerts`;
const SSE_URL = `${API_BASE}/stream`;

const TF_OPTS = [
  { key: "1m",  field: "pct_1m",  label: "1m"  },
  { key: "5m",  field: "pct_5m",  label: "5m"  },
  { key: "10m", field: "pct_10m", label: "10m" },
  { key: "15m", field: "pct_15m", label: "15m" },
];

const fmtTime = (iso) => {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso || "";
  }
};

// ---- styles (injected once) ----
const ensureStyles = () => {
  if (document.getElementById("mx-styles")) return;
  const css = `
:root{
  --bg:#0b0f1a;--panel:#0f1324;--panel2:#121733;--text:#dbe2ff;--muted:#9fb0ffcc;
  --border:#19203a;--up:#22c55e;--down:#ef4444;--chip:#0f1630;--link:#7aa2ff;
}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
.app{max-width:1200px;margin:0 auto;padding:18px}
.h1{font-weight:800;letter-spacing:.2px}
.caption{font-size:12px;color:var(--muted);padding-left:8px}
.bar{display:flex;gap:8px;align-items:center;margin:12px 0;flex-wrap:wrap}
.grp{display:flex;gap:8px;align-items:center}
.chip{font-size:12px;padding:6px 10px;border:1px solid var(--border);background:var(--chip);
      color:var(--muted);border-radius:8px;cursor:pointer;user-select:none}
.chip.active{color:var(--text);box-shadow:0 0 0 1px #2753ff66 inset}
.table{width:100%;border-collapse:separate;border-spacing:0 0;margin-top:8px}
.th,.td{padding:12px 14px;border-top:1px solid var(--border)}
.tr{background:transparent}
.tr:nth-child(even){background:rgba(255,255,255,0.02)}
.th{position:sticky;top:0;background:linear-gradient(#0b0f1a,#0b0f1a);
    font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;
    border-bottom:1px solid var(--border);cursor:pointer;user-select:none;white-space:nowrap}
.sort{opacity:.65;margin-left:6px}
.dir{font-weight:700}
.dir.up{color:var(--up)}
.dir.down{color:var(--down)}
.btnlink{font-size:12px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;
         color:var(--muted);text-decoration:none}
.btnlink:hover{color:var(--text);border-color:#2b3b8f}
.badge{font-size:11px;padding:3px 8px;border-radius:999px;margin-left:8px;border:1px solid #2b3b8f;}
.badge.b1{color:#ffd166;border-color:#ffd16644}
.badge.b2{color:#ff8fab;border-color:#ff8fab44}
.badge.b3{color:#ff4d4f;border-color:#ff4d4f44}
.flash{animation:flash 1.2s ease-in-out 6}
@keyframes flash{0%,100%{box-shadow:0 0 0 0 rgba(59,130,246,0)}
                 50%{box-shadow:0 0 0 3px rgba(59,130,246,.35)}}
.linkish{color:var(--link);text-decoration:none}
.linkish:hover{text-decoration:underline}
.empty{padding:24px;color:var(--muted);text-align:center}
  `;
  const el = document.createElement("style");
  el.id = "mx-styles";
  el.textContent = css;
  document.head.appendChild(el);
};

// ---- helpers ----
function computeRank(a) {
  if (typeof a.rank === "number") return a.rank;
  const z = Number(a.z_score ?? a.z ?? 0);
  const movePct = Number(a.move_pct ?? 0);
  const pps = Number(a.pps ?? 0); // %/s
  const sev = Number(a.severity ?? (z >= 6 ? 3 : z >= 4 ? 2 : z >= 3.5 ? 1 : 0));
  const trendBonus = a?.strategy?.aligned ? Number(a?.strategy?.bonus || 10) : 0;
  return sev * 50 + z * 6 + movePct * 4 + pps * 2 + trendBonus;
}
function burstLevel(a) {
  const z = Number(a.z_score ?? a.z ?? 0);
  const movePct = Number(a.move_pct ?? 0);
  if (a?.severity) return a.severity;
  if (z >= 6 || movePct >= 2.0) return 3;
  if (z >= 4.5 || movePct >= 1.0) return 2;
  if (z >= 3.7 || movePct >= 0.6) return 1;
  return 0;
}
function tvUrl(symbol) {
  const s = String(symbol || "").replace(/_/, "");
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${s}:MEXC`)}`;
}
function mexcUrl(symbol) {
  const s = String(symbol || "").toUpperCase().replace(/_/, "_");
  return `https://www.mexc.com/exchange/${encodeURIComponent(s)}`;
}

// ---- component ----
export default function App() {
  ensureStyles();

  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState("ALL"); // ALL | LONG | SHORT
  const [sortKey, setSortKey] = useState("rank"); // rank | symbol | direction | move | z | time
  const [sortDir, setSortDir] = useState("desc");
  const [tf, setTf] = useState("1m"); // "1m" | "5m" | "10m" | "15m"
  const [source, setSource] = useState(`${API_BASE}/alerts (SSE)`);
  const flashRef = useRef(new Map()); // symbol -> expireTs

  // initial load
  useEffect(() => {
    let aborted = false;
    fetch(JSON_URL)
      .then((r) => r.json())
      .then((arr) => {
        if (aborted) return;
        const withRank = (arr || []).map((a) => ({ ...a, rank: computeRank(a) }));
        setRows(withRank);
      })
      .catch(() => {});
    return () => {
      aborted = true;
    };
  }, []);

  // SSE
  useEffect(() => {
    let es;
    let pollTimer;

    const onMsg = (a) => {
      if (!a) return;
      const rank = computeRank(a);
      const level = burstLevel(a);
      const flashing = Boolean(a.burst) || level > 0;

      setRows((prev) => {
        const key = `${a.symbol}@${a.t || ""}`;
        const seen = new Set(prev.map((x) => `${x.symbol}@${x.t || ""}`));
        const next = seen.has(key) ? prev : [{ ...a, rank }, ...prev].slice(0, 600);
        return next.map((x) =>
          x === next[0]
            ? { ...x, __bLevel: level, __flash: flashing ? true : x.__flash }
            : x
        );
      });

      if (flashing) {
        const exp = Date.now() + 8000;
        flashRef.current.set(a.symbol, exp);
        setTimeout(() => {
          if ((flashRef.current.get(a.symbol) || 0) <= Date.now()) {
            setRows((prev) => prev.map((r) => (r.symbol === a.symbol ? { ...r, __flash: false } : r)));
          }
        }, 8500);
      }
    };

    try {
      es = new EventSource(SSE_URL);
      es.onmessage = (ev) => {
        try { onMsg(JSON.parse(ev.data)); } catch {}
      };
      es.onerror = () => {
        if (!pollTimer) {
          setSource(`${API_BASE}/alerts (poll)`);
          pollTimer = setInterval(async () => {
            try {
              const arr = await fetch(JSON_URL).then((r) => r.json());
              if (Array.isArray(arr)) {
                const withRank = arr.map((x) => ({ ...x, rank: computeRank(x) }));
                setRows(withRank);
              }
            } catch {}
          }, 3000);
        }
      };
      setSource(`${API_BASE}/alerts (SSE)`);
    } catch {}
    return () => {
      try { es && es.close(); } catch {}
      try { pollTimer && clearInterval(pollTimer); } catch {}
    };
  }, []);

  // derived list (filter + sort)
  const filtered = useMemo(() => {
    const arr =
      filter === "ALL"
        ? rows
        : rows.filter((r) =>
            filter === "LONG"
              ? String(r.direction || "").toUpperCase() === "UP"
              : String(r.direction || "").toUpperCase() === "DOWN"
          );

    const dir = sortDir === "asc" ? 1 : -1;
    const tfField = TF_OPTS.find((x) => x.key === tf)?.field || "pct_1m";

    const value = (r) => {
      switch (sortKey) {
        case "symbol": return String(r.symbol || "");
        case "direction": return String(r.direction || "");
        case "move": return Number(r[tfField] ?? r.move_pct ?? 0);
        case "z": return Number(r.z_score ?? r.z ?? 0);
        case "time": return new Date(r.t || 0).getTime();
        case "rank":
        default: return Number(r.rank ?? computeRank(r));
      }
    };

    return [...arr].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // secondary: move desc
      const ap = Number(a[tfField] ?? a.move_pct ?? 0);
      const bp = Number(b[tfField] ?? b.move_pct ?? 0);
      return dir === -1 ? bp - ap : ap - bp;
    });
  }, [rows, filter, sortKey, sortDir, tf]);

  const setSort = (key) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "symbol" || key === "time" ? "asc" : "desc");
    }
  };

  const tfField = TF_OPTS.find((x) => x.key === tf)?.field || "pct_1m";

  return (
    <div className="app">
      <div className="h1">MEXC Live Dashboard — Alerts</div>
      <div className="caption">
        Data: <a className="linkish" href={JSON_URL} target="_blank" rel="noreferrer">{source}</a>
      </div>

      {/* Controls */}
      <div className="bar">
        <div className="grp" aria-label="filter">
          <div className={`chip ${filter === "ALL" ? "active" : ""}`} onClick={() => setFilter("ALL")}>All</div>
          <div className={`chip ${filter === "LONG" ? "active" : ""}`} onClick={() => setFilter("LONG")}>Longs</div>
          <div className={`chip ${filter === "SHORT" ? "active" : ""}`} onClick={() => setFilter("SHORT")}>Shorts</div>
        </div>
        <div className="grp" aria-label="timeframe" style={{ marginLeft: 6 }}>
          {TF_OPTS.map((o) => (
            <div
              key={o.key}
              className={`chip ${tf === o.key ? "active" : ""}`}
              onClick={() => setTf(o.key)}
              title={`% Move over ${o.label} (current vs ${o.label} ago close)`}
            >
              {o.label}
            </div>
          ))}
        </div>
      </div>

      {/* Table */}
      <table className="table">
        <thead>
          <tr className="tr">
            <th className="th" onClick={() => setSort("symbol")}>
              Symbol <span className="sort">{sortKey === "symbol" ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
            </th>
            <th className="th" onClick={() => setSort("direction")}>
              Direction <span className="sort">{sortKey === "direction" ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
            </th>
            <th className="th" onClick={() => setSort("move")}>
              % Move ({tf}) <span className="sort">{sortKey === "move" ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
            </th>
            <th className="th" onClick={() => setSort("z")}>
              Z-Score <span className="sort">{sortKey === "z" ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
            </th>
            <th className="th" onClick={() => setSort("time")}>
              Time <span className="sort">{sortKey === "time" ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
            </th>
            <th className="th" onClick={() => setSort("rank")}>
              Rank <span className="sort">{sortKey === "rank" ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
            </th>
            <th className="th">Chart</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr className="tr">
              <td className="td empty" colSpan={7}>Waiting for alerts…</td>
            </tr>
          ) : (
            filtered.map((r, i) => {
              const dir = String(r.direction || "").toUpperCase() === "UP" ? "up" : "down";
              const pctSel = Number(r[tfField] ?? r.move_pct ?? 0);
              const z = Number(r.z_score ?? r.z ?? 0);
              const level = r.__bLevel ?? burstLevel(r);
              const flashing = r.__flash || false;

              return (
                <tr className={`tr ${flashing ? "flash" : ""}`} key={`${r.symbol}-${r.t}-${i}`}>
                  <td className="td" style={{ fontWeight: 700 }}>{r.symbol}</td>
                  <td className="td">
                    <span className={`dir ${dir}`}>{dir === "up" ? "▲ LONG" : "▼ SHORT"}</span>
                    {level === 1 && <span className="badge b1">Burst S1</span>}
                    {level === 2 && <span className="badge b2">Burst S2</span>}
                    {level === 3 && <span className="badge b3">Burst S3</span>}
                    {r?.strategy?.aligned && <span className="badge" title="1/3/15m aligned & MA(5/10) agree">TF✓</span>}
                  </td>
                  <td className="td">{pctSel.toFixed(3)}%</td>
                  <td className="td">{z.toFixed(2)}</td>
                  <td className="td">{fmtTime(r.t)}</td>
                  <td className="td">{Number(r.rank ?? computeRank(r)).toFixed(1)}</td>
                  <td className="td" style={{ display: "flex", gap: 8 }}>
                    <a className="btnlink" href={mexcUrl(r.symbol)} target="_blank" rel="noreferrer">MEXC</a>
                    <a className="btnlink" href={tvUrl(r.symbol)} target="_blank" rel="noreferrer">TV</a>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
