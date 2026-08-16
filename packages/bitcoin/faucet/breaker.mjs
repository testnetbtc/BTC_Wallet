// Faucet velocity circuit-breaker — an INDEPENDENT, aggregate safety control.
//
// It sits BESIDE (not inside) the per-Turnstile / per-IP / per-address / global
// rate limits. Those cap individual claimants; this watches WHOLE-FAUCET behaviour
// over a rolling window and FAILS CLOSED — it stops authorising payouts entirely —
// the moment any aggregate threshold is breached. It never auto-resumes: recovery
// requires an explicit admin reset (CLI + service reload/restart).
//
// CONCURRENCY MODEL (the important part). Node runs one thread; the event loop runs
// JS to completion between awaits. `authorize()` performs its whole check-AND-reserve
// synchronously, with NO await inside, and callers MUST invoke it before any await in
// the request handler. Therefore a burst of simultaneous requests is serialised by the
// event loop: each request's authorize() runs start-to-finish before the next begins,
// so requests are counted one-at-a-time and the (threshold+1)th trips the breaker. No
// two requests can both read "under the limit" and then both proceed — there is no
// read-then-write gap to race. The adversarial tests in test/breaker.test.mjs prove
// this empirically with thousands of interleaved requests.
//
// Metrics watched over the window: claims, sats dispensed, distinct destination
// addresses, UTXOs consumed, fee spent, and the failed/rejected-claim rate.

import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRETS = join(HERE, '..', '.secrets');
const STATE_FILE = join(SECRETS, 'breaker-state.json');
const TRIP_LOG = join(SECRETS, 'breaker-trips.log');

// Defaults are generous vs. legitimate use (normal load is well under 1 claim/min
// through Turnstile + caps) but catch a runaway loop, key compromise, or drain.
// Override any of these via .secrets/breaker.json.
export const DEFAULT_LIMITS = {
  windowMs: 60_000,
  maxClaimsPerMin: 30,
  maxSatsPerMin: 3_000_000,      // 30 × 0.001 BTC
  maxDistinctAddrPerMin: 30,
  maxUtxosPerMin: 60,
  maxFeePerMin: 200_000,         // sat
  maxFailuresPerMin: 60,         // rejected/failed claims — probe/attack signal
};

// RT-1: every limit must be a finite positive INTEGER. A value that coerces to
// NaN/Infinity (string, object, NaN, Infinity, …) would make `metric > limit`
// always false and silently DISABLE that metric — a fail-open safety hole. This
// returns the list of offending "key=value" entries (empty = all valid).
export function validateLimits(limits) {
  const bad = [];
  for (const [k, v] of Object.entries(limits || {})) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) bad.push(`${k}=${JSON.stringify(v)}`);
  }
  return bad;
}

export class VelocityBreaker {
  constructor(opts = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.persist = opts.persist !== false;       // tests pass persist:false
    this.stateFile = opts.stateFile || STATE_FILE;   // injectable for tests
    this.tripLog = opts.tripLog || TRIP_LOG;
    // RT-7: bound the trip log. At/over this size it rotates once (current -> .1) so a
    // single generation of history is kept. Injectable for tests. Rotation is OPERATIONAL
    // evidence only — every logging/rotation error is swallowed and NEVER affects whether
    // the breaker trips or stays latched (see _appendTripLog).
    this.tripLogMaxBytes = opts.tripLogMaxBytes || 1024 * 1024;   // ~1 MiB
    this.alert = opts.alert || defaultAlert;
    this.payouts = [];                            // { token, at, address, sats, utxos, fee, state }
    this.rejects = [];                            // { at, kind }
    this.pendingByToken = new Map();
    this.seq = 0;
    this.tripped = false;
    this.trip = null;                             // { reason, metric, value, threshold, at, snapshot }
    if (this.persist) this._load();               // a trip persists across restarts (no auto-resume)
    // RT-1: fail CLOSED on a malformed configuration — start TRIPPED rather than
    // silently run with a disabled metric. Cleared only by fixing the config.
    this._badConfig = validateLimits(this.limits);
    if (this._badConfig.length) this._tripConfig();
  }

  _tripConfig() {
    this.tripped = true;
    this.trip = { reason: 'invalid breaker configuration — failing closed', metric: 'config',
      value: this._badConfig.join(', '), threshold: 'each limit must be a finite positive integer', at: Date.now() };
    console.error(`\n🛑 BREAKER CONFIG INVALID (${this._badConfig.join(', ')}) — starting TRIPPED (fail-closed). Fix .secrets/breaker.json.\n`);
  }

  _prune(now) {
    const cut = now - this.limits.windowMs;
    while (this.payouts.length && this.payouts[0].at < cut) this.payouts.shift();
    while (this.rejects.length && this.rejects[0].at < cut) this.rejects.shift();
  }

  // Aggregate metrics over the current window. `extra` optionally folds in a
  // hypothetical payout being considered (used by authorize for the projection).
  metrics(now = Date.now(), extra = null) {
    this._prune(now);
    let claims = this.payouts.length, sats = 0, utxos = 0, fee = 0;
    const addrs = new Set();
    for (const p of this.payouts) {
      if (p.state !== 'failed') { sats += p.sats; utxos += p.utxos; fee += p.fee; }
      addrs.add(p.address);
    }
    if (extra) { claims += 1; sats += extra.sats; utxos += extra.utxos; fee += extra.fee; addrs.add(extra.address); }
    return { claims, sats, utxos, fee, distinctAddrs: addrs.size, failures: this.rejects.length };
  }

  // ── ATOMIC decision: fully synchronous check + reserve (no await inside) ──
  authorize({ address, sats, utxos, fee }, now = Date.now()) {
    this._prune(now);
    if (this.tripped) return { ok: false, reason: 'breaker-tripped', trip: this.trip };
    const m = this.metrics(now, { address, sats, utxos, fee });
    const L = this.limits;
    const breach =
      m.claims > L.maxClaimsPerMin ? ['claimsPerMin', m.claims, L.maxClaimsPerMin]
      : m.sats > L.maxSatsPerMin ? ['satsPerMin', m.sats, L.maxSatsPerMin]
      : m.distinctAddrs > L.maxDistinctAddrPerMin ? ['distinctAddrPerMin', m.distinctAddrs, L.maxDistinctAddrPerMin]
      : m.utxos > L.maxUtxosPerMin ? ['utxosPerMin', m.utxos, L.maxUtxosPerMin]
      : m.fee > L.maxFeePerMin ? ['feePerMin', m.fee, L.maxFeePerMin]
      : null;
    if (breach) { this._doTrip(breach, now); return { ok: false, reason: 'breaker-tripped', trip: this.trip }; }
    const token = ++this.seq;
    const p = { token, at: now, address, sats, utxos, fee, state: 'pending' };
    this.payouts.push(p); this.pendingByToken.set(token, p);
    return { ok: true, token };
  }

  // Broadcast succeeded — replace the reservation estimates with actuals.
  settle(token, { sats, utxos, fee } = {}) {
    const p = this.pendingByToken.get(token); if (!p) return;
    if (sats != null) p.sats = sats; if (utxos != null) p.utxos = utxos; if (fee != null) p.fee = fee;
    p.state = 'ok'; this.pendingByToken.delete(token);
  }

  // Broadcast failed — dispensed nothing, but it counts toward the failure rate.
  fail(token, reason = '', now = Date.now()) {
    const p = this.pendingByToken.get(token);
    if (p) { p.state = 'failed'; p.sats = 0; p.utxos = 0; p.fee = 0; this.pendingByToken.delete(token); }
    this.recordReject('broadcast-failed:' + reason, now);
  }

  // Pre-authorise rejections (bad address/network, rate-limited, human-check) and
  // broadcast failures. A spike here trips the breaker independently of payouts.
  // NOTE: the breaker's OWN 503 denials must NOT be recorded here (feedback loop).
  recordReject(kind, now = Date.now()) {
    this._prune(now);
    this.rejects.push({ at: now, kind });
    if (!this.tripped && this.rejects.length > this.limits.maxFailuresPerMin)
      this._doTrip(['failuresPerMin', this.rejects.length, this.limits.maxFailuresPerMin], now);
  }

  _doTrip([metric, value, threshold], now) {
    this.tripped = true;
    this.trip = { reason: `${metric} exceeded`, metric, value, threshold, at: now, snapshot: this.metrics(now) };
    if (this.persist) { this._save(); this._logTrip(); }
    try { this.alert(this.trip); } catch { /* alerting is best-effort */ }
    console.error(`\n🛑 FAUCET CIRCUIT BREAKER TRIPPED — ${metric}=${value} > ${threshold}. Payouts HALTED. Manual reset required.\n`);
  }

  status(now = Date.now()) { return { tripped: this.tripped, trip: this.trip, limits: this.limits, metrics: this.metrics(now) }; }

  // Explicit admin action ONLY — never called automatically. Clears the latch and
  // the window so the faucet starts from a clean slate.
  reset(reason = '', who = 'admin', now = Date.now()) {
    // RT-1: never resume while the configuration is still invalid.
    if (this._badConfig && this._badConfig.length) { this._tripConfig(); return false; }
    const cleared = this.trip;
    this.tripped = false; this.trip = null;
    this.payouts = []; this.rejects = []; this.pendingByToken.clear();
    if (this.persist) { this._save(); this._appendTripLog({ event: 'reset', at: now, who, reason, cleared }); }
    return true;
  }

  // SIGHUP handler entry point: the admin `reset` CLI writes the state file; the
  // running process re-reads it and drops the latch (or adopts a trip written
  // out-of-band). Failing closed longer than necessary is always safe.
  reloadState() {
    const wasTripped = this.tripped;
    this._load();
    if (wasTripped && !this.tripped) { this.payouts = []; this.rejects = []; this.pendingByToken.clear(); }
  }

  _load() {
    // No file yet -> a clean first start (untripped is correct). A file that EXISTS
    // but cannot be read/parsed (partial write from a crash, corruption) -> FAIL
    // CLOSED: assume tripped until an admin clears it (RT-4).
    if (!existsSync(this.stateFile)) return;
    let s;
    try { s = JSON.parse(readFileSync(this.stateFile, 'utf8')); }
    catch { s = undefined; }
    // L6 — accept ONLY a well-shaped latch object { tripped: boolean, ... }. Anything else —
    // unreadable/partial JSON, a bare null (JSON.parse('null')), an array, or a wrong-shape
    // object — FAILS CLOSED (assume tripped). Previously `!!s.tripped` read []/{} as untripped
    // (fail-open) and threw on null (crashing startup); both are unsafe.
    if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.tripped !== 'boolean') {
      this.tripped = true;
      this.trip = { reason: 'unreadable or malformed breaker latch — failing closed', metric: 'latch', value: 'corrupt/partial/wrong-shape', threshold: 'valid {tripped:boolean} state', at: Date.now() };
      console.error('\n🛑 BREAKER LATCH UNREADABLE/MALFORMED — starting TRIPPED (fail-closed). Investigate + reset.\n');
      return;
    }
    this.tripped = s.tripped;
    this.trip = s.tripped ? s.trip : null;
  }
  // Atomic write: a concurrent reader (or a crash) never sees a half-written latch.
  _save() {
    try {
      const tmp = this.stateFile + '.tmp';
      writeFileSync(tmp, JSON.stringify({ tripped: this.tripped, trip: this.trip }, null, 2));
      renameSync(tmp, this.stateFile);
    } catch { /* best-effort */ }
  }
  _logTrip() { this._appendTripLog({ event: 'trip', ...this.trip, recentPayouts: this.payouts.slice(-50), recentRejects: this.rejects.slice(-50) }); }

  // RT-7: append one JSON line to the trip log, rotating once at the size cap. This is
  // deliberately fail-soft in TWO layers: a rotation error (statSync/rename — no file yet,
  // dir unavailable, permission) still lets the append attempt proceed, and ANY append
  // error is swallowed. By the time this runs the breaker is already tripped/reset and the
  // safety latch already persisted via _save(); logging can never block or unwind that.
  _appendTripLog(entry) {
    try {
      try { if (statSync(this.tripLog).size >= this.tripLogMaxBytes) renameSync(this.tripLog, this.tripLog + '.1'); }
      catch { /* no file yet, or rotation failed -> just append; logging must never gate a trip */ }
      appendFileSync(this.tripLog, JSON.stringify(entry) + '\n');
    } catch { /* operational evidence only — not the safety mechanism */ }
  }
}

// Best-effort alert. If .secrets/telegram.json carries an `adminChatId`, DM it;
// otherwise the console.error + breaker-trips.log (captured by journald) is the
// alert channel. Never throws into the breaker.
function defaultAlert(trip) {
  try {
    const cfgPath = join(SECRETS, 'telegram.json');
    if (!existsSync(cfgPath)) return;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (!cfg.token || !cfg.adminChatId) return;
    const text = `🛑 Faucet circuit breaker TRIPPED\n${trip.metric} = ${trip.value} (> ${trip.threshold})\nat ${new Date(trip.at).toISOString()}\nPayouts halted; manual reset required.`;
    fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.adminChatId, text }),
    }).catch(() => {});
  } catch { /* ignore */ }
}

// ── CLI: node breaker.mjs status | reset "<reason>" ──
if (process.argv[1] && process.argv[1].endsWith('breaker.mjs')) {
  const b = new VelocityBreaker();
  const cmd = process.argv[2];
  if (cmd === 'status') console.log(JSON.stringify(b.status(), null, 2));
  else if (cmd === 'reset') {
    b.reset(process.argv[3] || '(no reason given)', process.env.USER || 'admin');
    console.log('✓ breaker latch cleared. Apply to the running faucet with:\n    sudo systemctl reload olesia-faucet    # (SIGHUP; or: restart)');
  } else console.log('usage: node breaker.mjs [status | reset "<reason>"]');
}
