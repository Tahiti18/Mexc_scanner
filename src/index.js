<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>MEXC Live Dashboard — Alerts</title>
<meta name="color-scheme" content="dark" />
<style>
:root{--bg:#0b0f1a;--panel:#0f1324;--panel-2:#0f1733;--text:#dbe2ff;--muted:#9fb0ffcc;--accent:#3b82f6;--up:#22c55e;--down:#ef4444;--border:#19203a;--chip:#0f1630}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
.wrap{max-width:1100px;margin:28px auto;padding:0 16px}
.hdr{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.hdr h1{font-size:16px;margin:0 8px 0 0}
.badge{font-size:12px;color:var(--muted);background:var(--chip);border:1px solid #2b3b8f;border-radius:999px;padding:2px 8px}
.ctrls{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 12px}
.btn{border:1px solid #2b3b8f;background:transparent;color:var(--muted);padding:6px 10px;border-radius:8px;cursor:pointer}
.btn.active{color:#fff;border-color:var(--accent);box-shadow:0 0 0 1px #2563eb66 inset}
.btn.small{padding:4px 8px;font-size:12px}
.table{width:100%;border-collapse:separate;border-spacing:0 8px}
th,td{padding:10px 12px;text-align:left}
thead th{font-size:12px;letter-spacing:.03em;color:var(--muted)}
.row{background:linear-gradient(180deg,var(--panel),var(--panel-2));border:1px solid var(--border);border-radius:10px}
.sym{font-weight:600}
.dir{font-weight:700}.dir.up{color:var(--up)}.dir.down{color:var(--down)}
.meta{color:var(--muted);font-size:12px}
.chips{display:flex;gap:6px}
.linkbtn{padding:6px 10px;border:1px solid #2b3b8f;border-radius:8px;text-decoration:none;color:var(--muted)}
.linkbtn:hover{color:#fff;border-color:var(--accent)}
.flash{animation:pulse 1.8s ease-out 1}
.flash.up{box-shadow:0 0 0 2px #22c55e55}.flash.down{box-shadow:0 0 0 2px #ef444455}
@keyframes pulse{0%{transform:scale(1.005);outline:2px solid #fff0}10%{outline:2px solid #fff2}100%{transform:scale(1);outline:2px solid #fff0}}
.dot{width:8px;height:8px;border-radius:50%;background:#777}
.dot.live{background:#22c55e;box-shadow:0 0 0 3px #22c55e33}
.dot.err{background:#ef4444;box-shadow:0 0 0 3px #ef444433}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>MEXC Live Dashboard — Alerts</h1>
    <span id="source" class="badge">Data: <span id="src-text">–</span></span>
    <span class="dot" id="live-dot" title="connection status"></span>
    <button id="sound-toggle" class="btn small">🔈 Sound: Off</button>
  </div>

  <div class="ctrls">
    <button class="btn small active" data-filter="ALL">All</button>
    <button class="btn small" data-filter="LONG">Longs</button>
    <button class="btn small" data-filter="SHORT">Shorts</button>
    <span class="btn small" id="api-info" title="Click to copy API URL"></span>
  </div>

  <div class="ctrls">
    <span class="meta">Timeframe:</span>
    <button class="btn small active" data-tf="1m">1m</button>
    <button class="btn small" data-tf="5m">5m</button>
    <button class="btn small" data-tf="15m">15m</button>
  </div>

  <table class="table">
    <thead>
      <tr>
        <th>Symbol</th><th>Direction</th><th>% Move (<span id="tf-label">1m</span>)</th>
        <th>Z-Score</th><th>Time</th><th>Rank</th><th>Chart</th>
      </tr>
    </thead>
    <tbody id="rows">
      <tr class="row"><td class="meta" colspan="7" id="empty">Waiting for alerts…</td></tr>
    </tbody>
  </table>
</div>

<audio id="ping" preload="auto">
  <source src="data:audio/wav;base64,UklGRmQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABYBHQB3AAAAPwAAAC8AAABnZ2ZmZmZmZmYAAAAAAP8AAP8A/wAAAP8AAP8AAAAA/wAAAP8A" type="audio/wav">
</audio>

<script>
/* ------------ CONFIG: point to your worker here ------------- */
/* You can also override via querystring:
   ?api=https://worker-production-ad5d.up.railway.app
*/
const QS = new URLSearchParams(location.search);
const API_BASE = QS.get('api')
  || 'https://worker-production-ad5d.up.railway.app'; // <-- CHANGE if your worker URL differs
/* ------------------------------------------------------------- */

const USE_SSE_FIRST = true, POLL_MS = 8000, STRONG_1M = 0.7, STRONG_Z = 3.0;

/* state */
let alerts = [], filterDir='ALL', tf='1m', soundOn=false, sse, lastSeenId='';

/* dom */
const $rows = document.getElementById('rows');
const $tfLabel = document.getElementById('tf-label');
const $srcText = document.getElementById('src-text');
const $dot = document.getElementById('live-dot');
const $sound = document.getElementById('sound-toggle');
const $apiInfo = document.getElementById('api-info');
const ping = document.getElementById('ping');

/* helpers */
const fmtPct = v => (v==null||Number.isNaN(v)) ? '–' : (Number(v).toFixed(3)+'%');
const tvUrl  = sym => `https://www.tradingview.com/chart/?symbol=${String(sym||'').replace('_','')}:MEXC`;
const mexcUrl= sym => `https://futures.mexc.com/exchange/contract?symbol=${encodeURIComponent(sym)}`;
const getMove=(row,tf)=> tf==='5m'&&typeof row.move_5m==='number' ? row.move_5m*100
                   : tf==='15m'&&typeof row.move_15m==='number' ? row.move_15m*100
                   : typeof row.move_pct==='number' ? row.move_pct*100 : NaN;
const byStrong=(a,b)=>{const ka=getMove(a,tf),kb=getMove(b,tf);
  if(Math.abs(kb)!==Math.abs(ka))return Math.abs(kb)-Math.abs(ka);
  if((b.z_score||0)!==(a.z_score||0))return(b.z_score||0)-(a.z_score||0);
  return(new Date(b.t)-new Date(a.t));
};
function playPing(){try{soundOn&&ping.currentTime&&(ping.currentTime=0); soundOn&&ping.play();}catch{}}

/* render */
function render(){
  const list = alerts.filter(a=>filterDir==='ALL'?true:a.direction===filterDir).sort(byStrong);
  if(!list.length){$rows.innerHTML=`<tr class="row"><td class="meta" colspan="7">Waiting for alerts…</td></tr>`;return;}
  let html='';
  for(const a of list){
    const move=getMove(a,tf), strong=(Math.abs(move)>=STRONG_1M)||((a.z_score||0)>=STRONG_Z);
    const dirTxt=a.direction==='UP'?'▲ LONG':'▼ SHORT', dirCls=a.direction==='UP'?'dir up':'dir down';
    const when=new Date(a.t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const rank=a.rank!=null?a.rank: Math.round(((Math.abs(getMove(a,'1m'))||0)*2 + (Math.abs(getMove(a,'5m'))||0) + (Math.abs(getMove(a,'15m'))||0)) ) || '';
    html+=`<tr class="row ${strong?('flash '+(a.direction==='UP'?'up':'down')):''}">
      <td class="sym">${a.symbol||''}</td>
      <td class="${dirCls}">${dirTxt}</td>
      <td>${fmtPct(move)}</td>
      <td>${(a.z_score!=null)?Number(a.z_score).toFixed(2):'–'}</td>
      <td class="meta">${when}</td>
      <td class="meta">${rank}</td>
      <td><div class="chips">
        <a class="linkbtn" href="${mexcUrl(a.symbol)}" target="_blank">MEXC</a>
        <a class="linkbtn" href="${tvUrl(a.symbol)}" target="_blank">TV</a>
      </div></td></tr>`;
  }
  $rows.innerHTML=html;
}

/* push handling (SSE) */
function onPush(a){
  const id=`${a.symbol}-${a.t}`; if(id===lastSeenId)return; lastSeenId=id;
  const move=getMove(a,tf), strong=(Math.abs(move)>=STRONG_1M)||((a.z_score||0)>=STRONG_Z);
  if(strong) playPing();
}

/* UI */
document.querySelectorAll('[data-filter]').forEach(b=>{
  b.onclick=()=>{document.querySelectorAll('[data-filter]').forEach(x=>x.classList.remove('active')); b.classList.add('active'); filterDir=b.dataset.filter; render();};
});
document.querySelectorAll('[data-tf]').forEach(b=>{
  b.onclick=()=>{document.querySelectorAll('[data-tf]').forEach(x=>x.classList.remove('active')); b.classList.add('active'); tf=b.dataset.tf; $tfLabel.textContent=tf; render();};
});
$sound.onclick=()=>{soundOn=!soundOn; $sound.textContent=soundOn?'🔊 Sound: On':'🔈 Sound: Off';};

/* data */
async function fetchAlerts(){
  try{
    const r=await fetch(`${API_BASE}/alerts`,{cache:'no-store'});
    if(!r.ok) return;
    const arr=await r.json();
    if(Array.isArray(arr)){alerts=arr; render();}
  }catch{}
}
function startSSE(){
  try{sse&&sse.close();}catch{}
  const url=`${API_BASE.replace(/\/$/,'')}/stream`;
  sse=new EventSource(url);
  sse.onopen =()=>{$srcText.textContent=`${API_BASE}/stream (SSE)`;$dot.className='dot live';};
  sse.onerror=()=>{$dot.className='dot err';};
  sse.onmessage=(ev)=>{try{const a=JSON.parse(ev.data); alerts.unshift(a); if(alerts.length>500)alerts.pop(); onPush(a); render();}catch{}};
}

/* boot */
(function(){
  document.getElementById('api-info').textContent = API_BASE.replace(/^https?:\/\//,'');
  document.getElementById('api-info').onclick = async ()=>{
    try{ await navigator.clipboard.writeText(API_BASE); }catch{}
  };
  $srcText.textContent=`${API_BASE}/alerts`;
  if(USE_SSE_FIRST) startSSE();
  fetchAlerts();
  setInterval(fetchAlerts, 30000); // background refresh
})();
</script>
</body>
</html>
