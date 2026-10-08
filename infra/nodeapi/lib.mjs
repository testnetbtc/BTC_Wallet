// Olesia node API — pure logic (no sockets), so it is unit-testable with a mocked RPC.
//
// The API is the ONLY backend the mainnet wallet talks to. It fronts the operator's own
// Bitcoin Core node and exposes public chain data + transaction relay. It holds NO keys and
// touches NO wallet. Everything a caller sends is treated as hostile input.
import { createHash, randomBytes } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
const dsha = (b) => sha256(sha256(b));

// ---- input validation -------------------------------------------------------------------
// Only the standard single-key output templates the wallet itself can spend are accepted.
// Anything else is rejected before it can reach the node as a descriptor.
const SCRIPT_TEMPLATES = [
  /^76a914[0-9a-f]{40}88ac$/,   // P2PKH
  /^a914[0-9a-f]{40}87$/,       // P2SH
  /^0014[0-9a-f]{40}$/,         // P2WPKH
  /^0020[0-9a-f]{64}$/,         // P2WSH
  /^5120[0-9a-f]{64}$/,         // P2TR
  /^21(02|03)[0-9a-f]{64}ac$/,  // P2PK (compressed key)
  /^4104[0-9a-f]{128}ac$/,      // P2PK (uncompressed key)
];
export const isStandardScript = (hex) => typeof hex === 'string' && SCRIPT_TEMPLATES.some((re) => re.test(hex));

export function validateScripts(list, max) {
  if (!Array.isArray(list) || !list.length) throw new ApiError(400, 'scripts must be a non-empty array');
  if (list.length > max) throw new ApiError(400, `too many scripts (max ${max})`);
  const out = new Set();
  for (const s of list) {
    const hex = typeof s === 'string' ? s.toLowerCase() : '';
    if (!isStandardScript(hex)) throw new ApiError(400, 'unsupported or malformed scriptPubKey');
    out.add(hex);
  }
  return [...out].sort();
}

export const isTxid = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
export function validateOutpoints(list, max) {
  if (!Array.isArray(list) || !list.length) throw new ApiError(400, 'outpoints must be a non-empty array');
  if (list.length > max) throw new ApiError(400, `too many outpoints (max ${max})`);
  return list.map((o) => {
    const txid = String(o?.txid || '').toLowerCase(), vout = Number(o?.vout);
    if (!isTxid(txid) || !Number.isInteger(vout) || vout < 0 || vout > 100000) throw new ApiError(400, 'malformed outpoint');
    return { txid, vout };
  });
}
export function validateRawTx(hex, maxBytes) {
  const h = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(h) || h.length % 2) throw new ApiError(400, 'invalid raw transaction hex');
  if (h.length / 2 > maxBytes) throw new ApiError(400, 'transaction too large');
  if (h.length < 120) throw new ApiError(400, 'transaction too short');
  return h;
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Bitcoin Core reports amounts as JSON decimals in BTC. Convert to integer satoshis without
// trusting float arithmetic blindly: the rounded result must be a safe non-negative integer.
export function btcToSats(amount) {
  const n = Number(amount);
  const sats = Math.round(n * 1e8);
  if (!Number.isFinite(n) || !Number.isSafeInteger(sats) || sats < 0 || sats > 21e14) throw new Error('node returned an invalid amount');
  return sats;
}
// BTC/kvB (estimatesmartfee) -> sat/vB, rounded UP so we never under-pay the estimate.
export function feerateToSatVb(btcPerKvb) {
  const n = Number(btcPerKvb);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.ceil(n * 1e5 - 1e-9));
}

// txid of a serialized transaction (strips segwit marker/flag/witness when present).
// Used to double-check a previous transaction fetched for a legacy input.
export function txidOfRaw(hex) {
  const b = Buffer.from(hex, 'hex');
  let p = 0;
  const readVarint = () => {
    const f = b[p++];
    if (f < 0xfd) return f;
    if (f === 0xfd) { const v = b.readUInt16LE(p); p += 2; return v; }
    if (f === 0xfe) { const v = b.readUInt32LE(p); p += 4; return v; }
    const v = Number(b.readBigUInt64LE(p)); p += 8; return v;
  };
  const version = b.subarray(0, 4); p = 4;
  const segwit = b[p] === 0x00 && b[p + 1] === 0x01;
  if (segwit) p += 2;
  const bodyStart = p;
  const nIn = readVarint();
  for (let i = 0; i < nIn; i++) { p += 36; const l = readVarint(); p += l + 4; }
  const nOut = readVarint();
  for (let i = 0; i < nOut; i++) { p += 8; const l = readVarint(); p += l; }
  const bodyEnd = p;
  if (segwit) for (let i = 0; i < nIn; i++) { const items = readVarint(); for (let k = 0; k < items; k++) { const l = readVarint(); p += l; } }
  const locktime = b.subarray(p, p + 4);
  if (p + 4 !== b.length) throw new Error('trailing bytes in transaction');
  const stripped = Buffer.concat([version, b.subarray(bodyStart, bodyEnd), locktime]);
  return Buffer.from(dsha(stripped)).reverse().toString('hex');
}

// ---- sliding-window rate limiter ----------------------------------------------------------
export class RateLimiter {
  constructor(limits) { this.limits = limits; this.hits = new Map(); }
  // returns true when the caller is OVER the limit for this bucket
  over(ip, bucket, now = Date.now()) {
    const lim = this.limits[bucket]; if (!lim) return false;
    const key = `${ip}|${bucket}`;
    const arr = (this.hits.get(key) || []).filter((t) => now - t < lim.win);
    arr.push(now); this.hits.set(key, arr);
    return arr.length > lim.max;
  }
  prune(now = Date.now()) {
    for (const [k, arr] of this.hits) {
      const keep = arr.filter((t) => now - t < 15 * 60_000);
      if (keep.length) this.hits.set(k, keep); else this.hits.delete(k);
    }
  }
}

// ---- UTXO-set scan manager ----------------------------------------------------------------
// Bitcoin Core's `scantxoutset` walks the ENTIRE UTXO set (minutes on mainnet) and only one
// scan can run at a time. So scans are jobs: every waiting job is merged into ONE scan over
// the union of their scripts, and the result is split back per job. Throughput is therefore
// independent of how many wallets are waiting; latency is at most ~two scan cycles.
//
// After a wallet's script set has been scanned once, it is kept up to date INCREMENTALLY by
// applying each new block (spent outpoints removed, new matching outputs added), so a refresh
// is instant instead of another multi-minute scan. A reorg drops the entry and forces a rescan.
// Nothing is written to disk: watched scripts live in memory only and expire.
const scriptsKey = (scripts) => sha256(scripts.join(',')).toString('hex');

export class ScanManager {
  constructor({ rpc, now = () => Date.now(), maxUnion = 60000, jobTtl = 30 * 60_000, entryTtl = 6 * 3600_000,
                maxJobs = 400, maxEntries = 300, maxCoins = 3000, liveTtl = 5000, statusEvery = 4000, log = () => {} }) {
    // maxCoins: a script set holding more coins than this is refused. Without a cap, asking
    // about a heavily-used public address (tens of thousands of coins) would make every poll
    // fire that many gettxout calls and return a huge body — a cheap way to load the node.
    Object.assign(this, { rpc, now, maxUnion, jobTtl, entryTtl, maxJobs, maxEntries, maxCoins, liveTtl, statusEvery, log });
    this.jobs = new Map();      // id -> job
    this.entries = new Map();   // scriptsKey -> { scripts:Set, utxos:Map(outpoint->utxo), height, bestblock, touched }
    this.queue = [];            // job ids waiting for a scan
    this.scanning = false; this.progress = 0; this.seq = 0; this.following = false;
  }

  _newJob(key, scripts) {
    if (this.jobs.size >= this.maxJobs) this.gc();
    if (this.jobs.size >= this.maxJobs) throw new ApiError(503, 'scan queue is full — try again shortly');
    const id = randomBytes(18).toString('hex'); // unguessable: the id is the only handle to a result
    const job = { id, key, scripts, state: 'queued', created: this.now(), error: null };
    this.jobs.set(id, job);
    return job;
  }

  // Submit a script set. If an up-to-date entry exists the job is done immediately.
  async submit(scripts, { force = false } = {}) {
    const key = scriptsKey(scripts);
    const job = this._newJob(key, scripts);
    const entry = this.entries.get(key);
    if (entry && !force) {
      try { await this.follow(); } catch { /* fall through to a fresh scan */ }
      if (this.entries.get(key)) { job.state = 'done'; this.entries.get(key).touched = this.now(); return job; }
    }
    this.queue.push(job.id);
    this._kick();
    return job;
  }

  _kick() { if (!this.scanning && this.queue.length) this._cycle().catch((e) => this.log('scan cycle failed: ' + e.message)); }

  async _cycle() {
    this.scanning = true; this.progress = 0;
    const batch = []; const union = new Set();
    while (this.queue.length) {
      const job = this.jobs.get(this.queue[0]);
      if (!job) { this.queue.shift(); continue; }
      if (batch.length && union.size + job.scripts.length > this.maxUnion) break;
      this.queue.shift(); batch.push(job); job.state = 'scanning';
      for (const s of job.scripts) union.add(s);
    }
    let timer = null;
    try {
      if (!batch.length) return;
      timer = setInterval(async () => {
        try { const st = await this.rpc('scantxoutset', ['status']); if (st && Number.isFinite(st.progress)) this.progress = st.progress; } catch { /* best effort */ }
      }, this.statusEvery);
      if (timer.unref) timer.unref();
      const res = await this._scanWithRetry([...union].map((s) => `raw(${s})`));
      if (!res || res.success !== true) throw new Error('the node could not complete the scan');
      const byScript = new Map();
      for (const u of res.unspents || []) {
        const script = String(u.scriptPubKey || '').toLowerCase();
        const utxo = { txid: u.txid, vout: u.vout, script, value: btcToSats(u.amount), height: u.height, coinbase: !!u.coinbase };
        if (!byScript.has(script)) byScript.set(script, []);
        byScript.get(script).push(utxo);
      }
      for (const job of batch) {
        const utxos = new Map();
        for (const s of job.scripts) for (const u of byScript.get(s) || []) utxos.set(`${u.txid}:${u.vout}`, u);
        if (utxos.size > this.maxCoins) { job.state = 'error'; job.error = `these addresses hold more than ${this.maxCoins} separate coins — too many for this service`; continue; }
        this.entries.set(job.key, { scripts: new Set(job.scripts), utxos, height: res.height, bestblock: res.bestblock, touched: this.now() });
        job.state = 'done';
      }
      this.log(`scan done: ${batch.length} job(s), ${union.size} scripts, height ${res.height}`);
    } catch (e) {
      for (const job of batch) { job.state = 'error'; job.error = 'scan failed — please try again'; }
      this.log('scan error: ' + e.message);
    } finally {
      if (timer) clearInterval(timer);
      this.scanning = false; this.progress = 0;
      this.gc();
      this._kick();
    }
  }

  // Another process may be using the node's single scan slot; wait for it rather than fail.
  async _scanWithRetry(descriptors, tries = 40) {
    for (let i = 0; ; i++) {
      try { return await this.rpc('scantxoutset', ['start', descriptors], { timeout: 20 * 60_000 }); }
      catch (e) {
        if (i < tries && /scan already in progress/i.test(e.message)) { await new Promise((r) => setTimeout(r, 15_000)); continue; }
        throw e;
      }
    }
  }

  // Bring every cached entry up to the current tip by applying new blocks. Serialized.
  async follow() {
    if (this.following) return this.following;
    this.following = this._follow().finally(() => { this.following = false; });
    return this.following;
  }
  async _follow() {
    if (!this.entries.size) return;
    const tip = await this.rpc('getbestblockhash', []);
    const stale = [...this.entries.entries()].filter(([, e]) => e.bestblock !== tip);
    if (!stale.length) return;
    const blockCache = new Map(); // height -> block (shared by every entry catching up)
    for (const [key, e] of stale) {
      try {
        const hdr = await this.rpc('getblockheader', [e.bestblock]);
        if (!hdr || hdr.confirmations < 1) throw new Error('reorg'); // entry's block left the best chain
        const tipHdr = await this.rpc('getblockheader', [tip]);
        if (tipHdr.height - e.height > 36) throw new Error('too far behind'); // cheaper to rescan
        for (let h = e.height + 1; h <= tipHdr.height; h++) {
          let blk = blockCache.get(h);
          if (!blk) { const hash = await this.rpc('getblockhash', [h]); blk = await this.rpc('getblock', [hash, 2], { timeout: 120_000 }); blockCache.set(h, blk); }
          if (blk.previousblockhash !== e.bestblock) throw new Error('chain mismatch');
          for (const tx of blk.tx) {
            for (const vin of tx.vin) if (vin.txid) e.utxos.delete(`${vin.txid}:${vin.vout}`);
            tx.vout.forEach((o) => {
              const script = String(o.scriptPubKey?.hex || '').toLowerCase();
              if (e.scripts.has(script)) e.utxos.set(`${tx.txid}:${o.n}`, { txid: tx.txid, vout: o.n, script, value: btcToSats(o.value), height: blk.height, coinbase: !tx.vin[0]?.txid });
            });
          }
          e.height = blk.height; e.bestblock = blk.hash;
          if (e.utxos.size > this.maxCoins) throw new Error('coin cap exceeded');
        }
      } catch (err) {
        this.entries.delete(key); // reorg / gap / node hiccup -> force a clean rescan next time
        this.log('entry dropped (' + err.message + ')');
      }
    }
  }

  // Public view of a job. For a finished job, each coin is annotated with whether the node's
  // MEMPOOL already spends it (so the wallet never tries to spend a coin twice).
  async view(id) {
    const job = this.jobs.get(id);
    if (!job) throw new ApiError(404, 'unknown or expired scan — start a new one');
    if (job.state === 'queued') return { id, state: 'queued', position: Math.max(1, this.queue.indexOf(id) + 1), scanning: this.scanning, progress: this.scanning ? this.progress : 0 };
    if (job.state === 'scanning') return { id, state: 'scanning', progress: this.progress };
    if (job.state === 'error') return { id, state: 'error', error: job.error };
    try { await this.follow(); } catch { /* keep serving the last known state */ }
    const entry = this.entries.get(job.key);
    if (!entry) return { id, state: 'error', error: 'scan result expired — start a new one' };
    entry.touched = this.now();
    const utxos = [...entry.utxos.values()];
    const live = await this._liveness(entry, utxos);
    const tipHeight = entry.height;
    return {
      id, state: 'done', height: entry.height, bestblock: entry.bestblock,
      utxos: utxos.map((u, i) => ({ ...u, confirmations: tipHeight - u.height + 1, spentInMempool: !live[i] }))
        .sort((a, b) => a.height - b.height || (a.txid < b.txid ? -1 : 1) || a.vout - b.vout),
    };
  }

  // Is each coin still unspent once the mempool is taken into account? Bounded concurrency,
  // and the answer is reused for a few seconds so polling cannot multiply node calls.
  async _liveness(entry, utxos) {
    const stamp = `${entry.bestblock}|${utxos.length}`;
    if (entry.live && entry.liveStamp === stamp && this.now() - entry.liveAt < this.liveTtl) return entry.live;
    const live = new Array(utxos.length);
    for (let i = 0; i < utxos.length; i += 32) {
      const part = await Promise.all(utxos.slice(i, i + 32).map((u) => this.rpc('gettxout', [u.txid, u.vout, true]).then((r) => !!r, () => true)));
      for (let k = 0; k < part.length; k++) live[i + k] = part[k];
    }
    entry.live = live; entry.liveStamp = stamp; entry.liveAt = this.now();
    return live;
  }

  // A transaction was just relayed: cached mempool answers may now be wrong, drop them.
  invalidateLive() { for (const e of this.entries.values()) e.live = null; }

  gc() {
    const now = this.now();
    for (const [id, j] of this.jobs) if (now - j.created > this.jobTtl && j.state !== 'scanning' && j.state !== 'queued') this.jobs.delete(id);
    for (const [k, e] of this.entries) if (now - e.touched > this.entryTtl) this.entries.delete(k);
    if (this.entries.size > this.maxEntries) {
      const old = [...this.entries.entries()].sort((a, b) => a[1].touched - b[1].touched).slice(0, this.entries.size - this.maxEntries);
      for (const [k] of old) this.entries.delete(k);
    }
  }
}

// ---- previous-transaction fetch for LEGACY inputs -------------------------------------------
// Signing a pre-SegWit input safely needs the full previous transaction (the legacy sighash
// does not commit to the input amount). A pruned node no longer has old blocks, so we ask a
// peer for that ONE block (`getblockfrompeer`); Core validates it against the header chain it
// already holds, so this stays trustless and never leaves the operator's own node.
export async function fetchPrevTx(rpc, { txid, height }, { wait = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 3, pollMs = 1500, polls = 24 } = {}) {
  if (!isTxid(txid)) throw new ApiError(400, 'malformed txid');
  if (!Number.isInteger(height) || height < 0) throw new ApiError(400, 'malformed height');
  const tipHeight = await rpc('getblockcount', []);
  if (height > tipHeight) throw new ApiError(400, 'height is above the chain tip');
  const blockhash = await rpc('getblockhash', [height]);
  const tryGet = async () => {
    try { return await rpc('getrawtransaction', [txid, false, blockhash]); }
    catch (e) {
      if (/No such transaction found in the provided block/i.test(e.message)) throw new ApiError(404, 'that transaction is not in the block at that height');
      return null; // block not on disk (pruned) -> fetch it
    }
  };
  let hex = await tryGet();
  for (let a = 0; !hex && a < attempts; a++) {
    const peers = (await rpc('getpeerinfo', [])).filter((p) => (p.servicesnames || []).includes('NETWORK') && p.synced_blocks >= height);
    if (!peers.length) break;
    const peer = peers[(a * 7 + height) % peers.length];
    try { await rpc('getblockfrompeer', [blockhash, peer.id]); } catch (e) { if (!/already/i.test(e.message)) continue; }
    for (let i = 0; i < polls && !hex; i++) { await wait(pollMs); hex = await tryGet(); }
  }
  if (!hex) throw new ApiError(503, 'the node could not retrieve that historical block right now — try again in a minute');
  if (txidOfRaw(hex) !== txid) throw new ApiError(502, 'node returned a transaction that does not match the requested txid');
  return hex;
}

// ---- market price (DISPLAY ONLY) ---------------------------------------------------------------
// The wallet page may talk to one host only, so the price is fetched here, server-side, and
// handed on: no user's browser ever contacts a price provider, and a provider never learns
// who uses the wallet. Nothing a user sends is forwarded. The numbers are for display; they
// are never used when a transaction is built.
//   primary  : Coinbase Exchange 24h stats (open/last per pair)
//   fallback : CoinGecko simple price (+24h change)
const PRICE_PAIRS = { usd: 'BTC-USD', gbp: 'BTC-GBP', eur: 'BTC-EUR' };
const saneQuote = (q) => q && Number.isFinite(q.price) && q.price > 0 && q.price < 1e9 && Number.isFinite(q.change24h) && Math.abs(q.change24h) < 95;
export function quoteFromCoinbase(j) {
  const open = Number(j?.open), last = Number(j?.last);
  const q = { price: last, change24h: (last - open) / open * 100 };
  return saneQuote(q) ? { price: Math.round(last * 100) / 100, change24h: Math.round(q.change24h * 100) / 100 } : null;
}
export function quotesFromCoinGecko(j) {
  const b = j?.bitcoin || {}, out = {};
  for (const c of Object.keys(PRICE_PAIRS)) {
    const q = { price: Number(b[c]), change24h: Number(b[`${c}_24h_change`]) };
    if (saneQuote(q)) out[c] = { price: Math.round(q.price * 100) / 100, change24h: Math.round(q.change24h * 100) / 100 };
  }
  return out;
}
export class PriceFeed {
  constructor({ fetchJson, now = () => Date.now(), ttl = 60_000, maxStale = 15 * 60_000, fixture = null, log = () => {} }) {
    Object.assign(this, { fetchJson, now, ttl, maxStale, fixture, log });
    this.value = null; this.at = 0; this.inflight = null;
  }
  async _fetch() {
    const quotes = {};
    await Promise.all(Object.entries(PRICE_PAIRS).map(async ([c, pair]) => {
      try { const q = quoteFromCoinbase(await this.fetchJson(`https://api.exchange.coinbase.com/products/${pair}/stats`)); if (q) quotes[c] = q; } catch { /* fall back below */ }
    }));
    const fromPrimary = Object.keys(quotes).length;
    let fromFallback = 0;
    if (fromPrimary < Object.keys(PRICE_PAIRS).length) {
      try {
        const g = quotesFromCoinGecko(await this.fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,gbp,eur&include_24hr_change=true'));
        for (const c of Object.keys(g)) if (!quotes[c]) { quotes[c] = g[c]; fromFallback++; }
      } catch { /* keep whatever we have */ }
    }
    const source = fromFallback ? (fromPrimary ? 'coinbase+coingecko' : 'coingecko') : 'coinbase';
    if (!Object.keys(quotes).length) throw new Error('no price source answered');
    return { quotes, source };
  }
  // { available, quotes: { usd: {price, change24h}, … }, at, source }
  async get() {
    if (this.fixture) return { available: true, quotes: this.fixture, at: this.now(), source: 'fixture' };
    const fresh = this.value && this.now() - this.at < this.ttl;
    if (!fresh) {
      if (!this.inflight) this.inflight = this._fetch().then((v) => { this.value = v; this.at = this.now(); }, (e) => { this.log('price fetch failed: ' + e.message); }).finally(() => { this.inflight = null; });
      await this.inflight;
    }
    if (!this.value || this.now() - this.at > this.maxStale) return { available: false, quotes: {}, at: null, source: null };
    return { available: true, quotes: this.value.quotes, at: this.at, source: this.value.source };
  }
}

// ---- practice networks (testnet4 / signet / testnet3) ---------------------------------------------
// The operator runs no nodes for these. Their chain data comes from a public Esplora API and is
// RELAYED here, so the wallet page still talks to one host only. The coins are worthless, so the
// trade-off (a third party sees which practice addresses are looked up, from this server's IP)
// is accepted for these networks ONLY — mainnet never touches this code path.
// Only fixed, validated values ever reach an outbound URL: a hex script hash computed here, a
// validated txid, or nothing. Responses are size-capped and re-validated before being passed on.
export const TEST_NETWORKS = Object.freeze({
  testnet4: 'https://mempool.space/testnet4/api',
  signet: 'https://mempool.space/signet/api',
  testnet3: 'https://mempool.space/testnet/api',
});
const scriptHashOf = (scriptHex) => sha256(Buffer.from(scriptHex, 'hex')).toString('hex');   // Esplora: plain sha256, not reversed

export class EsploraBackend {
  constructor({ network, base, fetchText, now = () => Date.now(), cacheTtl = 15_000, concurrency = 6, jobTtl = 10 * 60_000, maxJobs = 300, log = () => {} }) {
    Object.assign(this, { network, base, fetchText, now, cacheTtl, concurrency, jobTtl, maxJobs, log });
    this.cache = new Map();   // key -> { at, value }
    this.inflight = new Map();
    this.jobs = new Map();
    this.active = 0; this.waiters = [];
  }
  async _slot(fn) {            // bound the number of simultaneous outbound requests
    if (this.active >= this.concurrency) await new Promise((r) => this.waiters.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; const w = this.waiters.shift(); if (w) w(); }
  }
  async _cached(key, ttl, fn) {
    const c = this.cache.get(key);
    if (c && this.now() - c.at < ttl) return c.value;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this._slot(fn).then((value) => { this.cache.set(key, { at: this.now(), value }); return value; }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
  async _get(path) { return this.fetchText(this.base + path, { method: 'GET' }); }

  async tip() {
    return this._cached('tip', this.cacheTtl, async () => {
      const h = Number((await this._get('/blocks/tip/height')).trim());
      if (!Number.isInteger(h) || h < 0) throw new Error('bad tip height');
      return h;
    });
  }
  async status() { return { chain: this.network, blocks: await this.tip(), source: 'public-api' }; }
  async fees() {
    return this._cached('fees', 60_000, async () => {
      let f = {}; try { f = JSON.parse(await this._get('/fee-estimates')); } catch { f = {}; }
      const pick = (k, d) => { const n = Number(f[k]); return Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(1, Math.ceil(n))) : d; };
      return { fast: pick('2', 2), normal: pick('6', 1), slow: pick('144', 1), min: 1, unit: 'sat/vB' };
    });
  }
  async _utxos(script) {
    return this._cached('u:' + script, this.cacheTtl, async () => {
      const arr = JSON.parse(await this._get(`/scripthash/${scriptHashOf(script)}/utxo`));
      if (!Array.isArray(arr) || arr.length > 2000) throw new Error('unexpected utxo list');
      const out = [];
      for (const u of arr) {
        const txid = String(u?.txid || '').toLowerCase(), vout = Number(u?.vout), value = Number(u?.value);
        if (!isTxid(txid) || !Number.isInteger(vout) || vout < 0 || !Number.isSafeInteger(value) || value <= 0) continue;
        const confirmed = !!u?.status?.confirmed, height = confirmed && Number.isInteger(u.status.block_height) ? u.status.block_height : null;
        out.push({ txid, vout, script, value, height });
      }
      return out;
    });
  }
  // same job protocol as the mainnet ScanManager, so the wallet uses one client for both
  submit(scripts) {
    this.gc();
    if (this.jobs.size >= this.maxJobs) throw new ApiError(503, 'busy — try again shortly');
    const id = randomBytes(18).toString('hex');
    const job = { id, state: 'scanning', done: 0, total: scripts.length, created: this.now(), result: null, error: null };
    this.jobs.set(id, job);
    (async () => {
      try {
        const [tip, lists] = await Promise.all([this.tip(), Promise.all(scripts.map((sc) => this._utxos(sc).then((v) => { job.done++; return v; })))]);
        const utxos = lists.flat().map((u) => ({ ...u, coinbase: false, confirmations: u.height == null ? 0 : Math.max(0, tip - u.height + 1), spentInMempool: false }));
        job.result = { height: tip, bestblock: null, utxos }; job.state = 'done';
      } catch (e) { job.state = 'error'; job.error = 'the practice-network data source did not answer — try again in a moment'; this.log(`${this.network} lookup failed: ${e.message}`); }
    })();
    return job;
  }
  view(id) {
    const job = this.jobs.get(id);
    if (!job) throw new ApiError(404, 'unknown or expired scan — start a new one');
    if (job.state === 'scanning') return { id, state: 'scanning', progress: job.total ? Math.round(job.done / job.total * 100) : 0 };
    if (job.state === 'error') return { id, state: 'error', error: job.error };
    return { id, state: 'done', ...job.result };
  }
  async prevTx(txid) {
    if (!isTxid(txid)) throw new ApiError(400, 'malformed txid');
    let hex;
    try { hex = (await this._slot(() => this._get(`/tx/${txid}/hex`))).trim().toLowerCase(); } catch { throw new ApiError(503, 'the practice-network data source did not answer — try again in a moment'); }
    if (!/^[0-9a-f]+$/.test(hex) || txidOfRaw(hex) !== txid) throw new ApiError(502, 'the data source returned a transaction that does not match the requested txid');
    return hex;
  }
  async broadcast(hex) {
    let out;
    try { out = (await this._slot(() => this.fetchText(this.base + '/tx', { method: 'POST', body: hex }))).trim(); }
    catch (e) { throw new ApiError(400, 'rejected by the network: ' + String(e.message).slice(0, 160)); }
    this.cache.clear();   // balances change now
    if (!isTxid(out)) throw new ApiError(502, 'the data source returned an unexpected answer to the broadcast');
    return out;
  }
  gc() { const now = this.now(); for (const [id, j] of this.jobs) if (now - j.created > this.jobTtl) this.jobs.delete(id); if (this.cache.size > 5000) this.cache.clear(); }
}
