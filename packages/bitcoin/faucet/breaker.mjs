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

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
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

export class VelocityBreaker {
  constructor(opts = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.persist = opts.persist !== false;       // tests pass persist:false
    this.alert = opts.alert || defaultAlert;
    this.payouts = [];                            // { token, at, address, sats, utxos, fee, state }
    this.rejects = [];                            // { at, kind }
    this.pendingByToken = new Map();
    this.seq = 0;
    this.tripped = false;
    this.trip = null;                             // { reason, metric, value, threshold, at, snapshot }
    if (this.persist) this._load();               // a trip persists across restarts (no auto-resume)
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
    const cleared = this.trip;
    this.tripped = false; this.trip = null;
    this.payouts = []; this.rejects = []; this.pendingByToken.clear();
    if (this.persist) { this._save(); try { appendFileSync(TRIP_LOG, JSON.stringify({ event: 'reset', at: now, who, reason, cleared }) + '\n'); } catch {} }
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
    try {
      if (!existsSync(STATE_FILE)) return;
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      this.tripped = !!s.tripped;
      this.trip = s.tripped ? s.trip : null;
    } catch { /* unreadable state -> keep current (in-memory) view */ }
  }
  _save() { try { writeFileSync(STATE_FILE, JSON.stringify({ tripped: this.tripped, trip: this.trip }, null, 2)); } catch {} }
  _logTrip() { try { appendFileSync(TRIP_LOG, JSON.stringify({ event: 'trip', ...this.trip, recentPayouts: this.payouts.slice(-50), recentRejects: this.rejects.slice(-50) }) + '\n'); } catch {} }
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
