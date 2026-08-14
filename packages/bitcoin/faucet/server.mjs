// Olesia faucet — dispenses small amounts of testnet3/testnet4/signet coins to
// learners. Funded from the operator's own testnet stash (worthless coins).
// Localhost-only; a Cloudflare Tunnel maps https://faucet.olesia.io -> here.
//
// RT-2: every claim is a DURABLE, idempotent, crash-safe record in a SQLite ledger.
// The in-memory per-address/day + global/day cooldown Maps are gone; the ledger is
// the authority (UNIQUE(network,canon,day) + durable UTXO reservations). A crash /
// restart / RPC timeout can never produce a second independent payment — recovery
// resumes the original claim. Mainnet PAYOUT EXECUTION IS HARD-DISABLED.
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { statusFor, walletAddress, decodeRawTx } from '../src/send.js';
import { getUTXOs } from '../src/esplora.js';
import { net } from '../src/networks.js';
import { VelocityBreaker } from './breaker.mjs';
import { ClaimLedger, S, claimDayUTC, TERMINAL } from './ledger.mjs';
import { processClaim, realChain, realSigner } from './claimflow.mjs';
import { recoverAll, startRecoveryWorker } from './recovery.mjs';
import { cookieRpc, makeNodeBroadcaster } from './nodebroadcast.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const secret = (f) => JSON.parse(readFileSync(join(HERE, '..', '.secrets', f), 'utf8'));
const MNEMONIC = secret('faucet.json').mnemonic;
const INTERNAL_TOKEN = existsSync(join(HERE, '..', '.secrets', 'internal.json')) ? secret('internal.json').faucetInternalToken : '';
const PORT = 8790;
const DRIP = 100_000;
const NETWORKS = new Set(['testnet3', 'testnet4', 'signet']);   // NOTE: no 'mainnet' — payouts hard-disabled
const MAINNET_EXECUTION_ENABLED = false;                         // RT-2 §3: never spend mainnet funds
const GLOBAL_DAILY_CAP = 500;
const DRIP_FEERATE = { testnet3: 2, testnet4: 2, signet: 8 };
const ALLOW_ORIGIN = new Set(['https://faucet.olesia.io', 'https://olesia.io', 'https://app.olesia.io']);
const TURNSTILE_SECRET = (existsSync(join(HERE, '..', '.secrets', 'turnstile.json')) ? secret('turnstile.json').secret : '') || process.env.TURNSTILE_SECRET || '';
const MAX_BODY = 4000;
const CLAIMS_DB = join(HERE, '..', '.secrets', 'faucet-claims.db');

// ── circuit breaker (RT-1/RT-4) ──
const breakerLimits = existsSync(join(HERE, '..', '.secrets', 'breaker.json')) ? secret('breaker.json') : {};
const breaker = new VelocityBreaker({ limits: breakerLimits });
process.on('SIGHUP', () => { breaker.reloadState(); console.log('SIGHUP: breaker reloaded — tripped =', breaker.tripped); });

const FAUCET_ADDRS = Object.fromEntries([...NETWORKS].map((n) => [n, walletAddress(MNEMONIC, n, 'p2wpkh')]));
const canonOf = (network, address) => bytesToHex(btc.OutScript.encode(btc.Address(net(network).btc).decode(address)));
const fingerprintOf = (network, canon, amount) => bytesToHex(sha256(utf8ToBytes(`v1|${network}|${canon}|${amount}`))).slice(0, 32);
const feeRateFor = (n) => DRIP_FEERATE[n] || 2;

// ── claim ledger (RT-2) — opened at startup; payouts fail closed if unhealthy ──
let ledger = null, ledgerHealthy = false, worker = null;
const signer = realSigner(MNEMONIC, feeRateFor);

// ── NODE-1: own-node broadcast (fail-closed, NO external fallback) ──
// Only networks listed here broadcast through our OWN Bitcoin Core node; every other network
// keeps using esplora until its node is wired. This is BROADCAST ONLY — reconciliation
// (lookup/outspend) stays on esplora as ADVISORY until NODE-2, so `chain.authoritative` is
// false and reservation retirement stays disabled. There is deliberately no try/catch around
// the own-node broadcast: if our node is unavailable/wrong-chain/IBD/ambiguous it THROWS and
// the claim stays UNCERTAIN — it NEVER silently falls back to mempool.space or any explorer.
const OWN_NODE_BROADCAST = existsSync(join(HERE, '..', '.secrets', 'own-nodes.json'))
  ? secret('own-nodes.json')
  : { testnet4: { url: 'http://127.0.0.1:48332/', cookiePath: '/var/lib/bitcoind-testnet4/testnet4/.cookie', chain: 'testnet4' } };
const nodeBroadcasters = {};
for (const [nw, cfg] of Object.entries(OWN_NODE_BROADCAST)) {
  nodeBroadcasters[nw] = makeNodeBroadcaster({ rpc: cookieRpc({ url: cfg.url, cookiePath: cfg.cookiePath }), expectedChain: cfg.chain });
}
let ownNodeBroadcasts = 0, esploraBroadcasts = 0;
const esploraChain = realChain();
const chain = {
  authoritative: false,                                       // NODE-1 is broadcast-only; recon stays advisory
  lookup: (network, txid) => esploraChain.lookup(network, txid),
  outspend: (network, txid, vout) => esploraChain.outspend(network, txid, vout),
  async broadcast(network, rawTx, expectedTxid) {
    const nb = nodeBroadcasters[network];
    if (nb) { const txid = await nb.broadcast(network, rawTx, expectedTxid); ownNodeBroadcasts++; console.log(`broadcast via OWN ${network} node -> ${txid}`); return txid; }
    esploraBroadcasts++;
    return esploraChain.broadcast(network, rawTx);             // networks without an own node yet
  },
};
const depsFor = () => ({ ledger, signer, chain, txidOf: (raw) => decodeRawTx({ hex: raw, network: 'testnet4' }).txid });

// coin selection avoids DURABLY-reserved outpoints (the ledger is the authority);
// reservation itself happens atomically inside ledger.createAuthorised().
const FEE_HEADROOM = 2000, SMALL_COIN_MAX = DRIP * 20;
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function pickFaucetCoins(network) {
  const active = new Set(ledger.activeReservations().filter((r) => r.network === network).map((r) => `${r.txid}:${r.vout}`));
  const confirmed = (await getUTXOs(FAUCET_ADDRS[network], network)).filter((u) => u.confirmed && !active.has(`${u.txid}:${u.vout}`));
  if (!confirmed.length) return null;
  const need = DRIP + FEE_HEADROOM;
  const bank = confirmed.filter((u) => u.value <= SMALL_COIN_MAX);
  const singles = shuffle(bank.filter((u) => u.value >= need));
  if (singles.length) return [singles[0]];
  const acc = []; let sum = 0;
  for (const u of shuffle(bank)) { acc.push(u); sum += u.value; if (sum >= need) return acc; }
  const big = confirmed.filter((u) => u.value >= need).sort((a, b) => a.value - b.value)[0];
  return big ? [big] : null;
}
// Create a brand-new AUTHORISED claim + durably reserve its coins, retrying with
// fresh coins if a reservation races another claim.
async function createClaim({ network, address, canon, day, clientKey, fp }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const coins = await pickFaucetCoins(network).catch(() => null);
    const reserveOutpoints = (coins || []).map((c) => ({ txid: c.txid, vout: c.vout, value: c.value }));
    const r = ledger.createAuthorised({ claimId: randomUUID(), network, address, canon, claimDay: day, amountSat: DRIP, clientKey, fingerprint: fp, reserveOutpoints });
    if (r.created) return r;
    if (r.reason === 'entitlement-exists') return r;
    if (r.reason === 'reservation-conflict') continue;   // retry with fresh coins
    return r;
  }
  return { created: false, reason: 'reservation-exhausted', claim: null };
}

// ── telemetry snapshot for the dashboard (RT-3 atomic write) ──
const STARTED_AT = Date.now();
let lastPayoutAt = null;
const recentPayouts = [], recentRejects = [];
const ring = (arr, item, cap = 25) => { arr.push(item); if (arr.length > cap) arr.shift(); };
const TELEMETRY_FILE = join(HERE, '..', '.secrets', 'faucet-telemetry.json');
function writeTelemetry() {
  try {
    let ledgerBlock = { healthy: false };
    if (ledger) { const h = ledgerHealthy ? ledger.health() : { healthy: false, error: 'not-open' }; ledgerBlock = { healthy: !!h.healthy, error: h.error || null, counts: ledger.counts(), oldestNonTerminalAgeMs: ledger.oldestNonTerminalAgeMs() }; }
    const body = JSON.stringify({
      t: Date.now(), startedAt: STARTED_AT, lastPayoutAt, drip: DRIP,
      networks: [...NETWORKS], faucetAddresses: FAUCET_ADDRS,
      reservedUtxos: ledger ? ledger.activeReservations().length : 0,
      breaker: breaker.status(), ledger: ledgerBlock, recoveryHealthy: !!worker,
      recentPayouts, recentRejects,
    });
    writeFileSync(TELEMETRY_FILE + '.tmp', body); renameSync(TELEMETRY_FILE + '.tmp', TELEMETRY_FILE);
  } catch { /* best-effort */ }
}
setInterval(writeTelemetry, 3000).unref();

// ── per-IP short-horizon throttle stays in-memory (source-based, not an entitlement) ──
const RL = { ip: { max: 3, win: 3_600_000 } };
const ipHits = new Map();
function ipLimited(key, now) { const arr = (ipHits.get(key) || []).filter((t) => now - t < RL.ip.win); if (arr.length >= RL.ip.max) { ipHits.set(key, arr); return true; } arr.push(now); ipHits.set(key, arr); return false; }
setInterval(() => { const now = Date.now(); for (const [k, a] of ipHits) { const keep = a.filter((t) => now - t < RL.ip.win); keep.length ? ipHits.set(k, keep) : ipHits.delete(k); } }, 300_000).unref();

const clientIp = (req) => (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown');
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(obj)); };
async function turnstileOk(token, ip) {
  if (!TURNSTILE_SECRET) return true;
  try { const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }) }); return !!(await r.json()).success; } catch { return false; }
}

// Map a claim's durable state to an HTTP response (RT-2 §34/§35).
function claimResponse(res, claim, { fresh = false } = {}) {
  const txid = claim.local_txid || null;
  const base = { claimId: claim.claim_id, state: claim.state, amount: claim.amount_sat, txid, explorer: txid ? net(claim.network).explorer + txid : null };
  if (claim.state === S.SEEN || claim.state === S.CONFIRMED) return json(res, 200, base);
  if (claim.state === S.CONFLICTED || claim.state === S.FAILED_SAFE) return json(res, 200, { ...base, note: 'claim requires manual review' });
  // AUTHORISED / SIGNED / BROADCASTING / UNCERTAIN -> still processing/pending
  return json(res, 202, base);
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOW_ORIGIN.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, idempotency-key');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const path = new URL(req.url, 'http://x').pathname;

  if (req.method === 'GET' && path === '/info') {
    Promise.all([...NETWORKS].map((n) => statusFor(MNEMONIC, n, 'p2wpkh').then((s) => [n, s.balance.confirmed]).catch(() => [n, null])))
      .then((bals) => json(res, 200, { drip: DRIP, networks: [...NETWORKS], balances: Object.fromEntries(bals), paused: breaker.tripped, ledgerHealthy }))
      .catch((e) => json(res, 502, { error: e.message }));
    return;
  }

  if (req.method === 'POST' && path === '/claim') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', async () => {
      const rej = (code, err, kind) => { breaker.recordReject(kind); ring(recentRejects, { at: Date.now(), kind }); writeTelemetry(); return json(res, code, { error: err }); };
      let o; try { o = JSON.parse(body); } catch { return rej(400, 'bad request', 'bad-json'); }
      const network = String(o.network || '');
      const address = String(o.address || '').trim();
      if (!NETWORKS.has(network)) return rej(400, `network must be one of: ${[...NETWORKS].join(', ')}`, 'bad-network');
      if (network === 'mainnet' && !MAINNET_EXECUTION_ENABLED) return rej(403, 'mainnet payouts are hard-disabled', 'mainnet-disabled');   // defense-in-depth
      let canon; try { btc.Address(net(network).btc).decode(address); canon = canonOf(network, address); } catch { return rej(400, `invalid ${network} address`, 'bad-address'); }
      const internal = INTERNAL_TOKEN && req.headers['x-faucet-internal'] === INTERNAL_TOKEN;
      if (!internal && !(await turnstileOk(o.token, clientIp(req)))) return rej(403, 'human check failed', 'turnstile');
      const now = Date.now();
      if (!internal && ipLimited(clientIp(req), now)) return rej(429, 'rate limit — one claim per IP per hour (max 3)', 'cap-ip');

      // RT-2 §2/§37: no payouts unless the ledger is trustworthy.
      if (!ledger || !ledgerHealthy) return json(res, 503, { error: 'faucet claim ledger unavailable — payouts paused' });
      const day = claimDayUTC(now);
      const fp = fingerprintOf(network, canon, DRIP);
      const clientKey = (req.headers['idempotency-key'] || o.idempotencyKey || null);

      try {
        // 1) client idempotency-key replay/conflict (RT-2 §5/§6)
        if (clientKey) {
          const byKey = ledger.getByClientKey(network, String(clientKey).slice(0, 200));
          if (byKey) {
            if (byKey.request_fingerprint !== fp) return json(res, 409, { error: 'idempotency-key reused with a different request', claimId: byKey.claim_id });
            return claimResponse(res, byKey);       // idempotent replay -> recover/return the same claim
          }
        }
        // 2) authoritative address/day entitlement — a duplicate RETURNS the existing
        //    claim (never a second payout, never a blind 429) (RT-2 §6).
        const existing = ledger.getByEntitlement(network, canon, day);
        if (existing) { if (!TERMINAL.has(existing.state)) { try { await processClaim(depsFor(), existing.claim_id); } catch {} } return claimResponse(res, ledger.get(existing.claim_id)); }
        // 3) brand-new claim: global daily cap (durable) is a genuine rate limit -> 429
        if (ledger.dayCount ? ledger.dayCount(day) >= GLOBAL_DAILY_CAP : false) return rej(429, 'faucet daily cap reached — try tomorrow', 'cap-global');

        // 4) aggregate velocity breaker (only for a NEW payout)
        const auth = breaker.authorize({ address, sats: DRIP, utxos: 2, fee: feeRateFor(network) * 250 }, now);
        if (!auth.ok) return json(res, 503, { error: 'faucet temporarily paused — safety limit reached, try later' });

        // 5) durably create AUTHORISED + reserve coins, then drive the state machine
        const created = await createClaim({ network, address, canon, day, clientKey: clientKey ? String(clientKey).slice(0, 200) : null, fp });
        if (!created.created) {
          if (created.reason === 'entitlement-exists' && created.claim) { breaker.fail(auth.token, 'entitlement-race'); return claimResponse(res, created.claim); }
          breaker.fail(auth.token, created.reason || 'create-failed');
          return json(res, 503, { error: 'could not reserve funding — try again shortly' });
        }
        let claim = created.claim;
        try { claim = await processClaim(depsFor(), claim.claim_id); } catch (e) { /* durable; recovery will finish */ }
        breaker.settle(auth.token, { sats: DRIP, utxos: JSON.parse(claim.reserved_outpoints || '[]').length || 1, fee: claim.fee_sat || feeRateFor(network) * 250 });
        if (claim.local_txid && (claim.state === S.SEEN || claim.state === S.CONFIRMED)) { lastPayoutAt = Date.now(); ring(recentPayouts, { at: lastPayoutAt, network, address, sats: DRIP, state: claim.state }); }
        writeTelemetry();
        return claimResponse(res, claim, { fresh: true });
      } catch (e) {
        // A ledger/DB failure at any point -> fail closed (RT-2 §2/§25).
        ledgerHealthy = false;
        console.error('🛑 claim path DB failure -> ledger marked unhealthy:', String(e.message).slice(0, 160));
        return json(res, 503, { error: 'faucet claim ledger error — payouts paused' });
      }
    });
    return;
  }
  json(res, 404, { error: 'not found' });
});

// ── fail-closed startup: open ledger -> verify -> recover -> worker -> listen ──
async function init() {
  try {
    ledger = new ClaimLedger(CLAIMS_DB);
    ledgerHealthy = ledger.health().healthy;
    if (!ledgerHealthy) throw new Error('ledger health check failed');
    const rec = await recoverAll(depsFor(), { log: (m) => console.log('startup-recover:', m) });
    console.log('startup recovery:', JSON.stringify(rec));
    worker = startRecoveryWorker(depsFor(), { intervalMs: 30_000, log: (m) => console.log('recovery:', m) });
  } catch (e) {
    ledgerHealthy = false;
    console.error('🛑 CLAIM LEDGER UNAVAILABLE — payouts DISABLED (fail closed):', String(e.message).slice(0, 160));
  }
  server.listen(PORT, '127.0.0.1', () => console.log(`olesia faucet on 127.0.0.1:${PORT} (ledger ${ledgerHealthy ? 'ok' : 'UNAVAILABLE→payouts disabled'})`));
}
init();
