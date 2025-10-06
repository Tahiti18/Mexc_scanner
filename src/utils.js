export const sleep = (ms)=> new Promise(r=> setTimeout(r, ms));
export function nowIso(){ return new Date().toISOString(); }
export function bool(v, d=false){ if (v===undefined) return d; const s=String(v).toLowerCase(); return s==='1'||s==='true'||s==='yes'; }
export function num(v, d){ const n=Number(v); return Number.isFinite(n)?n:d; }
export function list(v){ return (v||'').split(',').map(s=>s.trim()).filter(Boolean); }
