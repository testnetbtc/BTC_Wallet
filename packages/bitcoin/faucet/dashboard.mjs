// Read-only operational/security dashboard for the faucet + surrounding services.
// Binds to 127.0.0.1 only (reach it via SSH tunnel). It performs NO actions: only
// GET, a read-only RPC allowlist, and a defensive redaction pass. See
// docs/FAUCET_DASHBOARD.md.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getUTXOs } from '../src/esplora.js';
import { redact, breakerView, heartbeatStatus, READONLY_RPC } from './telemetry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRETS = join(HERE, '..', '.secrets');
const PORT = 8793;
const TELEMETRY_FILE = join(SECRETS, 'faucet-telemetry.json');
const TRIPS_LOG = join(SECRETS, 'breaker-trips.log');
const NODE_CFG = existsSync(join(SECRETS, 'notify-node.json')) ? JSON.parse(readFileSync(join(SECRETS, 'notify-node.json'), 'utf8')) : null;
const BANK_COIN = 110_000;

const HB_FILES = [
  { key: 'nostr', label: 'Nostr bot', file: join(SECRETS, 'nostr-heartbeat.json'), staleMs: 5 * 60e3 },
  { key: 'notify', label: 'Telegram bot', file: join(SECRETS, 'notify-heartbeat.json'), staleMs: 5 * 60e3 },
  { key: 'paper', label: 'Paper trading', file: '/home/faucet/trading/paper/heartbeat.json', staleMs: 2 * 3600e3 },
  { key: 'hl', label: 'HL X-ray', file: '/home/faucet/trading/data/hl/heartbeat.json', staleMs: 5 * 60e3 },
];

// ── read-only node RPC (allowlisted methods only; credentials never surfaced) ──
async function nodeRpc(method, params = []) {
  if (!READONLY_RPC.has(method)) throw new Error('method not allowed');
  if (!NODE_CFG) throw new Error('no node config');
  const auth = 'Basic ' + Buffer.from(`${NODE_CFG.rpcUser}:${NODE_CFG.rpcPassword}`).toString('base64');
  const r = await fetch(NODE_CFG.rpcUrl, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'dash', method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function nodeHealth() {
  try {
    const [chain, net, mp] = await Promise.all([nodeRpc('getblockchaininfo'), nodeRpc('getnetworkinfo'), nodeRpc('getmempoolinfo')]);
    return {
      ok: true, chain: chain.chain, blocks: chain.blocks, headers: chain.headers,
      synced: chain.blocks === chain.headers, progress: +(chain.verificationprogress * 100).toFixed(3),
      pruned: !!chain.pruned, peers: net.connections, peersIn: net.connections_in, peersOut: net.connections_out,
      version: net.subversion, mempoolTxs: mp.size, mempoolMB: +(mp.bytes / 1e6).toFixed(1),
    };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 120) }; }
}

// ── faucet liquidity (testnet UTXO data comes from mempool.space — node is mainnet).
// Cached 30 s so a 5 s dashboard refresh doesn't hammer the explorer. ──
let bankCache = { at: 0, data: {} };
async function bankData(addrs, networks, now) {
  if (now - bankCache.at < 30_000) return bankCache.data;
  const out = {};
  await Promise.all(networks.map(async (n) => {
    try {
      const u = await getUTXOs(addrs[n], n);
      const conf = u.filter((x) => x.confirmed);
      out[n] = { balanceSat: conf.reduce((a, x) => a + x.value, 0), confirmedUtxos: conf.length, unconfirmedUtxos: u.length - conf.length, bankCoins: conf.filter((x) => x.value === BANK_COIN).length };
    } catch (e) { out[n] = { error: String(e.message).slice(0, 80) }; }
  }));
  bankCache = { at: now, data: out };
  return out;
}

function readTrips(n = 8) {
  try {
    const lines = readFileSync(TRIPS_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) { try { const e = JSON.parse(line); if (e.event === 'trip') out.push({ at: e.at, metric: e.metric, value: e.value, threshold: e.threshold, reason: e.reason }); } catch {} }
    return out.slice(-n).reverse();
  } catch { return []; }
}

async function apiPayload() {
  const now = Date.now();
  let tel = {}; try { tel = JSON.parse(readFileSync(TELEMETRY_FILE, 'utf8')); } catch {}
  const beats = { faucet: { label: 'Faucet', ...heartbeatStatus({ t: tel.t }, 15_000, now) } };
  for (const hb of HB_FILES) {
    let b = null;
    try { b = JSON.parse(readFileSync(hb.file, 'utf8')); } catch { try { b = { t: statSync(hb.file).mtimeMs }; } catch {} }
    beats[hb.key] = { label: hb.label, ...heartbeatStatus(b, hb.staleMs, now) };
  }
  const [node, balances] = await Promise.all([nodeHealth(), bankData(tel.faucetAddresses || {}, tel.networks || [], now)]);
  return redact({
    now,
    breaker: breakerView(tel.breaker),
    reservedUtxos: tel.reservedUtxos ?? null,
    lastPayoutAt: tel.lastPayoutAt ?? null,
    startedAt: tel.startedAt ?? null,
    telemetryAgeMs: tel.t ? now - tel.t : null,
    drip: tel.drip ?? null,
    networks: tel.networks || [],
    balances,
    recentPayouts: (tel.recentPayouts || []).slice(-20).reverse(),
    recentRejects: (tel.recentRejects || []).slice(-20).reverse(),
    trips: readTrips(8),
    node, beats,
  });
}

function secHeaders(ct, nonce) {
  const h = { 'content-type': ct, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-frame-options': 'DENY' };
  if (ct.startsWith('text/html')) h['content-security-policy'] = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return h;
}

export const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET') { res.writeHead(405, { 'content-type': 'text/plain', 'allow': 'GET' }); return res.end('read-only dashboard: GET only'); }
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (path === '/api') {
    try { res.writeHead(200, secHeaders('application/json')); return res.end(JSON.stringify(await apiPayload())); }
    catch { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'telemetry unavailable' })); }
  }
  if (path === '/' || path === '/index.html') {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, secHeaders('text/html; charset=utf-8', nonce));
    return res.end(PAGE(nonce));
  }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
});

// only listen when run directly (tests import `server`/`apiPayload` without binding)
if (process.argv[1] && process.argv[1].endsWith('dashboard.mjs')) {
  server.listen(PORT, '127.0.0.1', () => console.log(`faucet dashboard (read-only) on http://127.0.0.1:${PORT}`));
}
export { apiPayload, PAGE };

// ── self-contained page: strict nonce-CSP, no external resources, no chart libs.
// ALL dynamic values are rendered via textContent/createElement — never innerHTML
// with data — so hostile addresses / reasons / kinds are inert text. ──
function PAGE(nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Olesia Faucet — Ops Dashboard</title>
<style>
:root{--bg:#0b0e12;--panel:#141a21;--line:#232c36;--txt:#e6edf3;--mut:#93a1b0;--faint:#66727e;--good:#57c98a;--warn:#e8c34a;--near:#ef9d3a;--bad:#ef5f6b;--mono:ui-monospace,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 system-ui,-apple-system,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:18px 16px 60px}
header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:6px}
h1{font-size:18px;margin:0;letter-spacing:-.01em}
.pill{font-weight:800;font-size:13px;padding:5px 12px;border-radius:999px}
.pill.RUNNING{background:#10331d;color:var(--good);border:1px solid #1c5c34}
.pill.PAUSED{background:#3a1416;color:var(--bad);border:1px solid #7a2327}
.upd{color:var(--faint);font-size:12px;margin-left:auto}
h2{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--mut);margin:22px 0 8px;font-weight:700}
.grid{display:grid;gap:10px}.g2{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.g3{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 14px}
.metric{display:flex;flex-direction:column;gap:6px}
.metric .top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.metric .lbl{color:var(--mut);font-size:12.5px}.metric .val{font-variant-numeric:tabular-nums;font-weight:700}.metric .val small{color:var(--faint);font-weight:400}
.bar{height:7px;border-radius:5px;background:#0b1016;border:1px solid var(--line);overflow:hidden}
.bar>i{display:block;height:100%;width:0;transition:width .3s}
.lvl-normal>i{background:var(--good)}.lvl-elevated>i{background:var(--warn)}.lvl-near>i{background:var(--near)}.lvl-over>i,.lvl-tripped>i{background:var(--bad)}
.kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0}.kv b{font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:middle}
.dot.ok{background:var(--good)}.dot.stale{background:var(--bad)}.dot.miss{background:var(--faint)}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
td.mono,.mono{font-family:var(--mono);font-size:12px}td.r,.r{text-align:right;font-variant-numeric:tabular-nums}
.tag{font-size:11px;padding:1px 7px;border-radius:6px;background:#0b1016;border:1px solid var(--line);color:var(--mut)}
.tag.ok{color:var(--good)}.tag.bad{color:var(--bad)}
.scroll{overflow-x:auto}.empty{color:var(--faint);padding:8px 0}
footer{color:var(--faint);font-size:12px;margin-top:26px;border-top:1px solid var(--line);padding-top:12px;display:flex;gap:20px;flex-wrap:wrap}
</style></head><body><div class="wrap">
<header><h1>Olesia Faucet · Ops Dashboard</h1><span id="state" class="pill RUNNING">—</span><span id="upd" class="upd">connecting…</span></header>
<div id="triprow"></div>
<h2>Breaker metrics — rolling 60s vs limit</h2><div id="metrics" class="grid g2"></div>
<h2>Faucet liquidity</h2><div id="liq" class="grid g3"></div>
<h2>Bitcoin node (mainnet, own)</h2><div class="card" id="node"></div>
<h2>Service heartbeats</h2><div id="beats" class="grid g3"></div>
<div class="grid g2"><div><h2>Recent payouts</h2><div class="card scroll" id="payouts"></div></div><div><h2>Recent rejected claims</h2><div class="card scroll" id="rejects"></div></div></div>
<h2>Recent breaker trips</h2><div class="card scroll" id="trips"></div>
<footer id="foot"></footer>
</div>
<script nonce="${nonce}">
const $=(s)=>document.querySelector(s);
const el=(t,props,...kids)=>{const e=document.createElement(t);if(props)for(const k in props){if(k==='class')e.className=props[k];else if(k==='text')e.textContent=props[k];else e.setAttribute(k,props[k]);}for(const c of kids)if(c!=null)e.append(c);return e;};
const age=(ms)=>{if(ms==null)return '—';let s=Math.round(ms/1000);if(s<60)return s+'s';let m=Math.round(s/60);if(m<60)return m+'m';let h=Math.round(m/60);if(h<48)return h+'h';return Math.round(h/24)+'d';};
const sat=(n)=>n==null?'—':(n/1e8).toFixed(8).replace(/0{3}$/,'');
const num=(n)=>n==null?'—':n.toLocaleString();
function bar(value,limit,level){const pct=limit>0?Math.min(100,Math.round(value/limit*100)):0;const b=el('div',{class:'bar lvl-'+level});const i=el('i');i.style.width=pct+'%';b.append(i);return b;}
function metricCard(m){const c=el('div',{class:'card metric'});
  const top=el('div',{class:'top'});top.append(el('span',{class:'lbl',text:m.label}));
  const v=el('span',{class:'val'});v.append(document.createTextNode(num(m.value)+' '));v.append(el('small',{text:'/ '+num(m.limit)}));top.append(v);
  c.append(top,bar(m.value,m.limit,m.level));return c;}
function beatCard(k,b){const c=el('div',{class:'card'});const st=!b.present?'miss':b.stale?'stale':'ok';
  c.append(el('div',null,el('span',{class:'dot '+st}),el('b',{text:b.label})));
  c.append(el('div',{class:'kv'},el('span',{class:'lbl',text:'last beat'}),el('b',{text:b.present?age(b.ageMs)+' ago':'—'})));return c;}
function tbl(cols,rows,cell){const t=el('table');const hr=el('tr');cols.forEach(c=>hr.append(el('th',{text:c})));t.append(el('thead',null,hr));const tb=el('tbody');rows.forEach(r=>tb.append(cell(r)));t.append(tb);return t;}
function fill(node,child){node.textContent='';if(child)node.append(child);}
function emptyMsg(t){return el('div',{class:'empty',text:t});}
async function tick(){
  let d;try{d=await (await fetch('/api',{cache:'no-store'})).json();}catch(e){$('#upd').textContent='fetch failed';return;}
  const st=$('#state');st.textContent=d.breaker.state;st.className='pill '+d.breaker.state;
  $('#upd').textContent='updated '+new Date(d.now).toLocaleTimeString()+' · telemetry '+age(d.telemetryAgeMs)+' old';
  // trip banner
  const tr=$('#triprow');tr.textContent='';
  if(d.breaker.tripped&&d.breaker.trip){const t=d.breaker.trip;tr.append(el('div',{class:'card',style:'border-color:#7a2327'},el('b',{text:'PAUSED — breaker tripped: '}),el('span',{text:t.metric+' = '+num(t.value)+' (> '+num(t.threshold)+')'})));}
  fill($('#metrics'),(()=>{const g=document.createDocumentFragment();d.breaker.metrics.forEach(m=>g.append(metricCard(m)));return g;})());
  // liquidity
  const liq=document.createDocumentFragment();
  (d.networks||[]).forEach(n=>{const b=(d.balances||{})[n]||{};const c=el('div',{class:'card'});c.append(el('div',null,el('b',{text:n})));
    if(b.error){c.append(el('div',{class:'kv'},el('span',{class:'lbl',text:'error'}),el('span',{class:'mono',text:b.error})));}
    else{c.append(el('div',{class:'kv'},el('span',{class:'lbl',text:'balance'}),el('b',{text:sat(b.balanceSat)})));
      c.append(el('div',{class:'kv'},el('span',{class:'lbl',text:'confirmed UTXOs'}),el('b',{text:num(b.confirmedUtxos)})));
      c.append(el('div',{class:'kv'},el('span',{class:'lbl',text:'drip-size bank coins'}),el('b',{text:num(b.bankCoins)})));
      c.append(el('div',{class:'kv'},el('span',{class:'lbl',text:'unconfirmed'}),el('b',{text:num(b.unconfirmedUtxos)})));}
    liq.append(c);});
  const rc=el('div',{class:'card'});rc.append(el('div',null,el('b',{text:'reserved (in-flight)'})));rc.append(el('div',{class:'kv'},el('span',{class:'lbl',text:'UTXOs reserved'}),el('b',{text:num(d.reservedUtxos)})));liq.append(rc);
  fill($('#liq'),liq);
  // node
  const nd=$('#node');nd.textContent='';const n=d.node||{};
  if(!n.ok){nd.append(el('div',null,el('span',{class:'dot stale'}),el('span',{text:'node unreachable: '+(n.error||'')})));}
  else{const kv=(l,v)=>el('div',{class:'kv'},el('span',{class:'lbl',text:l}),el('b',{text:v}));
    nd.append(el('div',null,el('span',{class:'dot '+(n.synced?'ok':'stale')}),el('b',{text:n.chain+' · '+n.version})));
    const g=el('div',{class:'grid g3',style:'margin-top:8px'});
    g.append(kv('blocks',num(n.blocks)),kv('headers',num(n.headers)),kv('sync %',n.progress+''),kv('peers',n.peers+' ('+n.peersOut+'↗ '+n.peersIn+'↘)'),kv('mempool',num(n.mempoolTxs)+' tx · '+n.mempoolMB+' MB'),kv('pruned',n.pruned?'yes':'no'));nd.append(g);}
  // beats
  fill($('#beats'),(()=>{const g=document.createDocumentFragment();for(const k in d.beats)g.append(beatCard(k,d.beats[k]));return g;})());
  // payouts
  const P=d.recentPayouts||[];fill($('#payouts'),P.length?tbl(['time','net','destination','sats','state'],P,r=>el('tr',null,
    el('td',{text:new Date(r.at).toLocaleTimeString()}),el('td',{text:r.network}),el('td',{class:'mono',text:r.address}),el('td',{class:'r',text:num(r.sats)}),el('td',null,el('span',{class:'tag ok',text:r.state})))):emptyMsg('no payouts in buffer'));
  // rejects
  const R=d.recentRejects||[];fill($('#rejects'),R.length?tbl(['time','kind'],R,r=>el('tr',null,
    el('td',{text:new Date(r.at).toLocaleTimeString()}),el('td',null,el('span',{class:'tag bad',text:r.kind})))):emptyMsg('no rejections in buffer'));
  // trips
  const T=d.trips||[];fill($('#trips'),T.length?tbl(['time','metric','value','limit','reason'],T,r=>el('tr',null,
    el('td',{text:new Date(r.at).toLocaleString()}),el('td',{text:r.metric}),el('td',{class:'r',text:num(r.value)}),el('td',{class:'r',text:num(r.threshold)}),el('td',{text:r.reason}))):emptyMsg('no trips recorded'));
  // footer
  const f=$('#foot');f.textContent='';
  f.append(el('span',{text:'last payout: '+(d.lastPayoutAt?age(d.now-d.lastPayoutAt)+' ago':'—')}));
  f.append(el('span',{text:'uptime: '+(d.startedAt?age(d.now-d.startedAt):'—')}));
  f.append(el('span',{text:'drip: '+sat(d.drip)}));
}
tick();setInterval(tick,5000);
</script></body></html>`;
}
