import React, { useEffect, useState } from "react";

export default function Dashboard({ apiBase }) {
  const [rows, setRows] = useState(new Map());
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  // Load initial alerts
  useEffect(() => {
    fetch(`${apiBase}/alerts`)
      .then((r) => r.json())
      .then((arr) => {
        const m = new Map();
        for (const a of arr) m.set(a.symbol, a);
        setRows(m);
      });
  }, [apiBase]);

  // SSE stream
  useEffect(() => {
    const es = new EventSource(`${apiBase}/stream`);
    es.onmessage = (e) => {
      try {
        const a = JSON.parse(e.data);
        setRows((prev) => {
          const m = new Map(prev);
          m.set(a.symbol, a);
          return m;
        });
      } catch {}
    };
    return () => es.close();
  }, [apiBase]);

  const filtered = Array.from(rows.values())
    .filter((a) => {
      if (filter === "longs") return a.direction === "UP";
      if (filter === "shorts") return a.direction === "DOWN";
      return true;
    })
    .filter((a) => a.symbol.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.move_pct - a.move_pct);

  return (
    <div className="min-h-screen bg-bg text-text p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">MEXC Live Dashboard</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setFilter("all")}
            className={`btn ${filter === "all" ? "btn-blue" : ""}`}
          >
            All
          </button>
          <button
            onClick={() => setFilter("longs")}
            className={`btn ${filter === "longs" ? "btn-green" : ""}`}
          >
            Longs ↑
          </button>
          <button
            onClick={() => setFilter("shorts")}
            className={`btn ${filter === "shorts" ? "btn-red" : ""}`}
          >
            Shorts ↓
          </button>
        </div>
      </div>

      <input
        placeholder="Search symbol..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full bg-panel text-text rounded p-2 mb-4 border border-accent/40"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((a) => (
          <div
            key={a.symbol}
            className="panel hover:ring-2 hover:ring-accent transition"
          >
            <div className="flex justify-between mb-2">
              <div className="font-bold">{a.symbol}</div>
              <div
                className={
                  a.direction === "UP" ? "text-green font-semibold" : "text-red font-semibold"
                }
              >
                {a.direction === "UP" ? "↑" : "↓"} {a.move_pct.toFixed(3)}%
              </div>
            </div>
            <a
              href={`https://www.tradingview.com/chart/?symbol=MEXC:${a.symbol.replace(
                "_",
                ""
              )}`}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline text-sm"
            >
              Open Chart ↗
            </a>
            <div className="text-xs mt-2 opacity-60">
              {new Date(a.t).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
