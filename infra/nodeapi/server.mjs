// Olesia node API — the backend behind api.olesia.io for the mainnet wallet.
//
// A small dependency-free HTTP service in front of the operator's OWN Bitcoin Core node:
//   GET  /status          chain tip + sync state
//   GET  /fees            fee estimates (sat/vB) from the node
//   GET  /price           BTC market price + 24h change (display only; fetched server-side)
//   POST /scan            start a UTXO-set lookup for a list of scriptPubKeys -> { id }
//   GET  /scan/<id>       job state / progress / result (coins, with mempool-spent flags)
//   POST /txout           is each outpoint still unspent (mempool included)?
//   POST /prevtx          full previous transaction for a legacy input (hash-verified)
//   POST /broadcast       testmempoolaccept + sendrawtransaction
//   /n/<network>/…        the same calls for the PRACTICE networks (testnet4, signet, testnet3).
//                         The operator runs no nodes for those: the data is relayed from a public
//                         Esplora API. Mainnet never uses that path.
//
// It holds NO keys and uses NO node wallet. It only reads public chain data and relays
// transactions. It binds to localhost; a Cloudflare Tunnel maps https://api.olesia.io here.
// Nothing a caller sends (scripts, txids) is logged or written to disk.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ApiError, RateLimiter, ScanManager, validateScripts, validateOutpoints, validateRawTx,
         btcToSats, feerateToSatVb, fetchPrevTx, txidOfRaw, PriceFeed, EsploraBackend, TEST_NETWORKS } from './lib.mjs';

const PORT = Number(process.env.OLESIA_API_PORT || 8787);
const NODE_CONF = process.env.OLESIA_NODE_CONF || '/home/faucet/gsmg-frontier/btc_mainnet_node/bitcoin.conf';
const EXPECT_CHAIN = process.env.OLESIA_CHAIN || 'main';
const MAX_BODY = 400_000;
const MAX_SCRIPTS = 8200;      // per wallet lookup (4 address types x 2 chains x up to 1000 addresses, plus slack)
const MAX_TX_BYTES = 100_000;  // standard tx weight limit is 400k WU = 100 kvB

// Browsers on these origins may read responses. 'null' is a page opened from disk (the
// downloaded, hash-verified offline copy of the wallet). The API is public, unauthenticated
// chain data, so CORS is about limiting casual third-party use, not secrecy.
const ALLOW_ORIGIN = new Set(['https://olesia.io', 'https://www.olesia.io', 'null']);   // app.olesia.io retired 2026-10-01
const ALLOW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.olesia-landing\.pages\.dev$/;
const EXTRA_ORIGINS = (process.env.OLESIA_EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const originAllowed = (o) => ALLOW_ORIGIN.has(o) || ALLOW_ORIGIN_RE.test(o) || EXTRA_ORIGINS.includes(o);

// ---- node RPC (HTTP JSON-RPC on localhost; credentials read from the node's own conf) ----
function loadRpcConfig(confPath) {
  const conf = {};
  for (const line of readFileSync(confPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([a-z0-9_.]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#')) conf[m[1]] = m[2];
  }
  const port = Number(process.env.OLESIA_NODE_RPCPORT || conf.rpcport || { main: 8332, test: 18332, testnet4: 48332, signet: 38332, regtest: 18443 }[EXPECT_CHAIN]);
  let auth;
  if (conf.rpcuser && conf.rpcpassword) auth = `${conf.rpcuser}:${conf.rpcpassword}`;
  else {
    const dir = conf.datadir || dirname(confPath);
    const sub = { main: '', test: 'testnet3', testnet4: 'testnet4', signet: 'signet', regtest: 'regtest' }[EXPECT_CHAIN];
    const cookie = join(dir, sub, '.cookie');
    if (!existsSync(cookie)) throw new Error('no rpcuser/rpcpassword in the node conf and no .cookie file found');
    auth = readFileSync(cookie, 'utf8').trim();
  }
  return { port, authHeader: 'Basic ' + Buffer.from(auth).toString('base64') };
}
const RPC = loadRpcConfig(NODE_CONF);
let rpcSeq = 0;
function rpc(method, params = [], { timeout = 30_000 } = {}) {
  const body = JSON.stringify({ jsonrpc: '1.0', id: ++rpcSeq, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: RPC.port, method: 'POST', path: '/', timeout,
      headers: { 'content-type': 'application/json', authorization: RPC.authHeader, 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error(`node RPC returned HTTP ${res.statusCode}`)); }
        if (j.error) return reject(new Error(j.error.message || 'node RPC error'));
        resolve(j.result);
      });
    });
    req.on('timeout', () => req.destroy(new Error('node RPC timed out')));
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'the Bitcoin node is not reachable' : e.message)));
    req.end(body);
  });
}

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const scans = new ScanManager({ rpc, log });
// Per-IP limits. OLESIA_RATE_SCALE exists only so the automated end-to-end tests (which fire
// dozens of calls from one address in a few seconds) are not throttled; production leaves it at 1.
const RATE_SCALE = Math.max(1, Number(process.env.OLESIA_RATE_SCALE) || 1);
const lim = (max, win) => ({ max: max * RATE_SCALE, win });
const limiter = new RateLimiter({
  status: lim(60, 60_000), fees: lim(60, 60_000), price: lim(30, 60_000),
  scan: lim(30, 10 * 60_000), poll: lim(240, 60_000),
  txout: lim(60, 60_000), prevtx: lim(40, 10 * 60_000),
  broadcast: lim(12, 60_000),
});
setInterval(() => { limiter.prune(); scans.gc(); }, 60_000).unref();

// ---- small caches for cheap public reads ----
const cached = (ttl, fn) => { let at = 0, val = null, inflight = null; return async () => {
  if (val && Date.now() - at < ttl) return val;
  if (!inflight) inflight = fn().then((v) => { val = v; at = Date.now(); return v; }).finally(() => { inflight = null; });
  return inflight;
}; };
const getStatus = cached(10_000, async () => {
  const i = await rpc('getblockchaininfo');
  return { chain: i.chain, blocks: i.blocks, headers: i.headers, ibd: i.initialblockdownload, pruned: i.pruned, time: i.time };
});
const getFees = cached(45_000, async () => {
  const [fast, normal, slow, mp] = await Promise.all([
    rpc('estimatesmartfee', [2]), rpc('estimatesmartfee', [6]), rpc('estimatesmartfee', [144]), rpc('getmempoolinfo'),
  ]);
  const min = feerateToSatVb(Math.max(Number(mp.mempoolminfee) || 0, Number(mp.minrelaytxfee) || 0)) || 1;
  const pick = (e) => Math.max(min, feerateToSatVb(e?.feerate) || 0) || null;
  return { fast: pick(fast), normal: pick(normal), slow: pick(slow), min, unit: 'sat/vB' };
});

// Market price: outbound HTTPS from this server only (8 s timeout, small JSON bodies).
// OLESIA_PRICE=off disables it; OLESIA_PRICE_FIXTURE (JSON) pins it for the automated tests.
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'olesia-nodeapi', accept: 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  if (text.length > 20_000) throw new Error('oversized price response');
  return JSON.parse(text);
}
let priceFixture = null;
try { priceFixture = process.env.OLESIA_PRICE_FIXTURE ? JSON.parse(process.env.OLESIA_PRICE_FIXTURE) : null; } catch { priceFixture = null; }
const prices = process.env.OLESIA_PRICE === 'off' ? null : new PriceFeed({ fetchJson, fixture: priceFixture, log });

// Practice networks: relayed public data (see lib.mjs). OLESIA_TESTNETS=off disables them;
// OLESIA_TEST_BASE_<NETWORK> points one at another Esplora-compatible server (used by the tests).
async function fetchText(url, { method = 'GET', body } = {}) {
  const r = await fetch(url, { method, body, headers: { 'user-agent': 'olesia-nodeapi', ...(body ? { 'content-type': 'text/plain' } : {}) }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  const text = await r.text();
  if (text.length > 2_000_000) throw new Error('oversized response');
  if (!r.ok) throw new Error(text.slice(0, 200) || 'HTTP ' + r.status);
  return text;
}
const testnets = {};
if (process.env.OLESIA_TESTNETS !== 'off') for (const [name, base] of Object.entries(TEST_NETWORKS))
  testnets[name] = new EsploraBackend({ network: name, base: process.env['OLESIA_TEST_BASE_' + name.toUpperCase()] || base, fetchText, log });
const MAX_TEST_SCRIPTS = 400;

let prevtxInflight = 0;
const clientIp = (req) => (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown');
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new ApiError(413, 'request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new ApiError(400, 'body must be JSON')); } });
    req.on('error', () => reject(new ApiError(400, 'bad request')));
  });
}

async function route(req, res) {
  const path = new URL(req.url, 'http://x').pathname;
  const ip = clientIp(req);
  const gate = (bucket) => { if (limiter.over(ip, bucket)) throw new ApiError(429, 'rate limit — slow down'); };

  // ---- practice networks: /n/<network>/<call> ----
  const tm = path.match(/^\/n\/([a-z0-9]+)\/(.+)$/);
  if (tm) {
    const be = Object.prototype.hasOwnProperty.call(testnets, tm[1]) ? testnets[tm[1]] : null, call = '/' + tm[2];
    if (!be) throw new ApiError(404, 'unknown network');
    if (req.method === 'GET' && call === '/status') { gate('status'); return send(res, 200, await be.status()); }
    if (req.method === 'GET' && call === '/fees') { gate('fees'); return send(res, 200, await be.fees()); }
    if (req.method === 'POST' && call === '/scan') {
      gate('scan');
      const job = be.submit(validateScripts((await readJson(req)).scripts, MAX_TEST_SCRIPTS));
      return send(res, 202, { id: job.id, state: job.state });
    }
    if (req.method === 'GET' && call.startsWith('/scan/')) {
      gate('poll');
      const id = call.slice(6);
      if (!/^[0-9a-f]{36}$/.test(id)) throw new ApiError(400, 'malformed scan id');
      return send(res, 200, be.view(id));
    }
    if (req.method === 'POST' && call === '/prevtx') { gate('prevtx'); return send(res, 200, { hex: await be.prevTx(String((await readJson(req)).txid || '').toLowerCase()) }); }
    if (req.method === 'POST' && call === '/broadcast') {
      gate('broadcast');
      const body = await readJson(req);
      return send(res, 200, { txid: await be.broadcast(validateRawTx(body.txHex || body.tx, MAX_TX_BYTES)) });
    }
    throw new ApiError(404, 'not found');
  }

  if (req.method === 'GET' && path === '/status') { gate('status'); return send(res, 200, await getStatus()); }
  if (req.method === 'GET' && path === '/fees') { gate('fees'); return send(res, 200, await getFees()); }
  if (req.method === 'GET' && path === '/price') { gate('price'); return send(res, 200, prices ? await prices.get() : { available: false, quotes: {}, at: null, source: null }); }

  if (req.method === 'POST' && path === '/scan') {
    gate('scan');
    const body = await readJson(req);
    const scripts = validateScripts(body.scripts, MAX_SCRIPTS);
    const job = await scans.submit(scripts, { force: body.force === true });
    return send(res, 202, { id: job.id, state: job.state });
  }
  if (req.method === 'GET' && path.startsWith('/scan/')) {
    gate('poll');
    const id = path.slice(6);
    if (!/^[0-9a-f]{36}$/.test(id)) throw new ApiError(400, 'malformed scan id');
    return send(res, 200, await scans.view(id));
  }

  if (req.method === 'POST' && path === '/txout') {
    gate('txout');
    const ops = validateOutpoints((await readJson(req)).outpoints, 50);
    const out = await Promise.all(ops.map(async (o) => {
      const r = await rpc('gettxout', [o.txid, o.vout, true]);
      return r ? { ...o, unspent: true, confirmations: r.confirmations, value: btcToSats(r.value), script: r.scriptPubKey?.hex || null }
               : { ...o, unspent: false };
    }));
    return send(res, 200, { outpoints: out });
  }

  if (req.method === 'POST' && path === '/prevtx') {
    gate('prevtx');
    const body = await readJson(req);
    if (prevtxInflight >= 4) throw new ApiError(503, 'busy — try again shortly');
    prevtxInflight++;
    try { return send(res, 200, { hex: await fetchPrevTx(rpc, { txid: String(body.txid || '').toLowerCase(), height: Number(body.height) }) }); }
    finally { prevtxInflight--; }
  }

  if (req.method === 'POST' && path === '/broadcast') {
    gate('broadcast');
    const body = await readJson(req);
    const hex = validateRawTx(body.txHex || body.tx, MAX_TX_BYTES);
    const test = await rpc('testmempoolaccept', [[hex]]);
    if (!test?.[0]?.allowed) {
      const reason = test?.[0]?.['reject-reason'] || 'not accepted by the node';
      // a transaction the node already has is success from the user's point of view
      if (/txn-already-in-mempool|txn-already-known/i.test(reason)) { scans.invalidateLive(); return send(res, 200, { txid: txidOfRaw(hex), already: true }); }
      throw new ApiError(400, 'rejected by the node: ' + reason);
    }
    const txid = await rpc('sendrawtransaction', [hex]);
    scans.invalidateLive();   // coins this tx spends must show as mempool-spent on the next poll
    log('broadcast ok');
    return send(res, 200, { txid });
  }

  throw new ApiError(404, 'not found');
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (originAllowed(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  route(req, res).catch((e) => {
    if (e instanceof ApiError) return send(res, e.status, { error: e.message });
    log('error: ' + e.message);
    send(res, 502, { error: /not reachable|timed out/.test(e.message) ? e.message : 'the node could not complete that request' });
  });
});
server.requestTimeout = 60_000; server.headersTimeout = 20_000;

// Refuse to start against the wrong chain — a mainnet wallet must never be wired to a testnet node.
rpc('getblockchaininfo').then((i) => {
  if (i.chain !== EXPECT_CHAIN) { console.error(`node is on chain "${i.chain}", expected "${EXPECT_CHAIN}" — refusing to start`); process.exit(1); }
  server.listen(PORT, '127.0.0.1', () => log(`olesia node API on 127.0.0.1:${PORT} (chain ${i.chain}, height ${i.blocks})`));
}).catch((e) => { console.error('cannot reach the Bitcoin node: ' + e.message); process.exit(1); });
