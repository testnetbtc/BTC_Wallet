// RT-2 — durable, idempotent faucet claim ledger (node:sqlite).
//
// This is the AUTHORITATIVE record of "has this address claimed today" and "what
// exact transaction did we commit to for a claim". It replaces the in-memory
// cooldown Maps. Every DB failure is treated as a SAFETY failure: if the ledger is
// not trustworthy, the caller must stop paying out (fail closed).
//
// Invariants this module enforces:
//  - UNIQUE(network, canon, claim_day) : one entitlement per address per UTC day,
//    regardless of address formatting (canon = the output-script hex).
//  - UNIQUE(network, txid, vout) reservation : a UTXO can be reserved by at most one
//    claim, durably (survives restart), committed atomically with the claim.
//  - Controlled state transitions only (no arbitrary state writes).
//  - The exact signed raw_tx + locally-computed local_txid are persisted at SIGNED
//    and are the ONLY thing recovery may rebroadcast.
import { DatabaseSync } from 'node:sqlite';

export const S = {
  AUTHORISED: 'AUTHORISED', SIGNED: 'SIGNED', BROADCASTING: 'BROADCASTING',
  SEEN: 'SEEN', CONFIRMED: 'CONFIRMED',
  UNCERTAIN: 'UNCERTAIN', CONFLICTED: 'CONFLICTED', FAILED_SAFE: 'FAILED_SAFE',
};
// CONFIRMED = success terminal. CONFLICTED/FAILED_SAFE = terminal, need manual review.
export const TERMINAL = new Set([S.CONFIRMED, S.CONFLICTED, S.FAILED_SAFE]);
export const NON_TERMINAL = [S.AUTHORISED, S.SIGNED, S.BROADCASTING, S.SEEN, S.UNCERTAIN];
// Allowed forward/lateral transitions. Anything not listed is rejected (fail-safe).
const ALLOWED = {
  [S.AUTHORISED]: new Set([S.SIGNED, S.UNCERTAIN, S.CONFLICTED, S.FAILED_SAFE]),
  [S.SIGNED]: new Set([S.BROADCASTING, S.UNCERTAIN, S.CONFLICTED, S.FAILED_SAFE]),
  [S.BROADCASTING]: new Set([S.SEEN, S.CONFIRMED, S.UNCERTAIN, S.CONFLICTED, S.FAILED_SAFE]),
  [S.SEEN]: new Set([S.CONFIRMED, S.UNCERTAIN, S.CONFLICTED]),
  [S.UNCERTAIN]: new Set([S.SEEN, S.CONFIRMED, S.BROADCASTING, S.CONFLICTED, S.FAILED_SAFE]),
  [S.CONFIRMED]: new Set(),
  [S.CONFLICTED]: new Set(),
  [S.FAILED_SAFE]: new Set(),
};
export function transitionAllowed(from, to) { return !!(ALLOWED[from] && ALLOWED[from].has(to)); }

export const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) STRICT;
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  address TEXT NOT NULL,               -- display form
  canon TEXT NOT NULL,                 -- output-script hex (formatting-proof key)
  claim_day TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  amount_sat INTEGER NOT NULL,
  state TEXT NOT NULL,
  client_idempotency_key TEXT,
  request_fingerprint TEXT,
  reserved_outpoints TEXT,             -- JSON [{txid,vout}]
  raw_tx TEXT,
  local_txid TEXT,
  fee_sat INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  authorised_at INTEGER,
  signed_at INTEGER,
  first_broadcast_at INTEGER,
  last_broadcast_at INTEGER,
  seen_at INTEGER,
  confirmed_at INTEGER,
  broadcast_attempt_count INTEGER NOT NULL DEFAULT 0,
  confirmation_height INTEGER,
  confirmation_block_hash TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  last_reconcile_at INTEGER,
  error_code TEXT,
  error_detail_safe TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_entitlement ON claims(network, canon, claim_day);
CREATE UNIQUE INDEX IF NOT EXISTS uq_clientkey ON claims(client_idempotency_key) WHERE client_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_state ON claims(state);
CREATE INDEX IF NOT EXISTS ix_day ON claims(claim_day);
CREATE TABLE IF NOT EXISTS reservations (
  network TEXT NOT NULL,
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (network, txid, vout)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_res_claim ON reservations(claim_id);
`;

export const claimDayUTC = (ms) => new Date(ms).toISOString().slice(0, 10);   // YYYY-MM-DD UTC

export class ClaimLedger {
  constructor(file, { now = () => Date.now() } = {}) {
    this.now = now;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this._migrate();
    const h = this.health();
    if (!h.healthy) throw new Error('ledger unhealthy at open: ' + h.error);
  }

  _migrate() {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
    if (!row) { this.db.prepare('INSERT INTO meta(k,v) VALUES(?,?)').run('schema_version', String(SCHEMA_VERSION)); return; }
    const v = Number(row.v);
    if (v !== SCHEMA_VERSION) throw new Error(`unexpected schema version ${v} (want ${SCHEMA_VERSION})`);
  }

  // Integrity check + a write probe. Any failure => not healthy => caller fails closed.
  health() {
    try {
      const ic = this.db.prepare('PRAGMA integrity_check').get();
      const okv = Object.values(ic)[0];
      if (okv !== 'ok') return { healthy: false, error: 'integrity_check: ' + okv };
      // write probe (rolled back)
      this.db.exec('BEGIN'); this.db.exec('CREATE TEMP TABLE IF NOT EXISTS _probe(x)'); this.db.prepare('INSERT INTO _probe VALUES(1)').run(); this.db.exec('ROLLBACK');
      return { healthy: true };
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} return { healthy: false, error: String(e.message).slice(0, 160) }; }
  }

  // Look up an existing claim by the authoritative entitlement key.
  getByEntitlement(network, canon, claimDay) {
    return this.db.prepare('SELECT * FROM claims WHERE network=? AND canon=? AND claim_day=?').get(network, canon, claimDay) || null;
  }
  getByClientKey(key) { return key ? (this.db.prepare('SELECT * FROM claims WHERE client_idempotency_key=?').get(key) || null) : null; }
  get(claimId) { return this.db.prepare('SELECT * FROM claims WHERE claim_id=?').get(claimId) || null; }
  // durable global daily count (across all networks) for the soft daily cap
  dayCount(claimDay) { return this.db.prepare('SELECT COUNT(*) c FROM claims WHERE claim_day=?').get(claimDay).c; }

  // Atomically: create the AUTHORISED claim AND durably reserve its outpoints.
  // Returns { created:true, claim } on a brand-new claim, or { created:false, claim,
  // reason } if the entitlement already exists (idempotent replay) or a reservation
  // conflicts. NEVER creates a second entitlement for the same (network,canon,day).
  createAuthorised({ claimId, network, address, canon, claimDay, amountSat, clientKey = null, fingerprint = null, reserveOutpoints = [] }) {
    const t = this.now();
    const existing = this.getByEntitlement(network, canon, claimDay);
    if (existing) return { created: false, claim: existing, reason: 'entitlement-exists' };
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare(`INSERT INTO claims(claim_id,network,address,canon,claim_day,amount_sat,state,client_idempotency_key,request_fingerprint,reserved_outpoints,created_at,updated_at,authorised_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        claimId, network, address, canon, claimDay, amountSat, S.AUTHORISED, clientKey, fingerprint, JSON.stringify(reserveOutpoints), t, t, t);
      for (const op of reserveOutpoints) {
        this.db.prepare('INSERT INTO reservations(network,txid,vout,claim_id,created_at) VALUES(?,?,?,?,?)').run(network, op.txid, op.vout, claimId, t);
      }
      this.db.exec('COMMIT');
      return { created: true, claim: this.get(claimId) };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      // A concurrent winner took the entitlement or a reservation between our check
      // and our insert -> re-read; if it now exists, this is an idempotent replay.
      const race = this.getByEntitlement(network, canon, claimDay);
      if (race) return { created: false, claim: race, reason: 'entitlement-exists' };
      return { created: false, claim: null, reason: 'reservation-conflict', error: String(e.message).slice(0, 140) };
    }
  }

  // Controlled state transition. Rejects any move not in ALLOWED (fail-safe).
  transition(claimId, to, fields = {}) {
    const c = this.get(claimId);
    if (!c) throw new Error('transition on missing claim ' + claimId);
    if (c.state === to) { this._patch(claimId, fields); return this.get(claimId); }
    if (!transitionAllowed(c.state, to)) throw new Error(`illegal transition ${c.state} -> ${to} (claim ${claimId})`);
    const t = this.now();
    const stamps = {};
    if (to === S.SIGNED) stamps.signed_at = t;
    if (to === S.SEEN) stamps.seen_at = t;
    if (to === S.CONFIRMED) stamps.confirmed_at = t;
    this._patch(claimId, { ...fields, ...stamps, state: to, updated_at: t });
    return this.get(claimId);
  }

  _patch(claimId, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k}=?`).join(',');
    this.db.prepare(`UPDATE claims SET ${set} WHERE claim_id=?`).run(...keys.map((k) => fields[k]), claimId);
  }

  // Convenience wrappers used by the processor (all go through transition()).
  markSigned(claimId, { rawTx, localTxid, feeSat, reservedOutpoints }) {
    return this.transition(claimId, S.SIGNED, { raw_tx: rawTx, local_txid: localTxid, fee_sat: feeSat ?? null, reserved_outpoints: JSON.stringify(reservedOutpoints || []) });
  }
  markBroadcasting(claimId) {
    const c = this.get(claimId); const t = this.now();
    return this.transition(claimId, S.BROADCASTING, { broadcast_attempt_count: (c.broadcast_attempt_count || 0) + 1, first_broadcast_at: c.first_broadcast_at || t, last_broadcast_at: t });
  }
  markSeen(claimId) { return this.transition(claimId, S.SEEN, {}); }
  markConfirmed(claimId, { height = null, blockHash = null } = {}) { return this.transition(claimId, S.CONFIRMED, { confirmation_height: height, confirmation_block_hash: blockHash }); }
  markUncertain(claimId, reason) {
    const c = this.get(claimId);
    return this.transition(claimId, S.UNCERTAIN, { error_code: 'uncertain', error_detail_safe: String(reason || '').slice(0, 160), reconcile_attempts: (c.reconcile_attempts || 0) + 1, last_reconcile_at: this.now() });
  }
  markConflicted(claimId, reason) { return this.transition(claimId, S.CONFLICTED, { error_code: 'conflicted', error_detail_safe: String(reason || '').slice(0, 160) }); }
  markFailedSafe(claimId, code, reason) {
    // FAILED_SAFE reachable from any state (safety stop). Bypass the normal matrix.
    this._patch(claimId, { state: S.FAILED_SAFE, error_code: String(code).slice(0, 40), error_detail_safe: String(reason || '').slice(0, 160), updated_at: this.now() });
    return this.get(claimId);
  }
  bumpReconcile(claimId) { const c = this.get(claimId); this._patch(claimId, { reconcile_attempts: (c.reconcile_attempts || 0) + 1, last_reconcile_at: this.now() }); }

  nonTerminal() { return this.db.prepare(`SELECT * FROM claims WHERE state IN (${NON_TERMINAL.map(() => '?').join(',')})`).all(...NON_TERMINAL); }
  counts() {
    const rows = this.db.prepare('SELECT state, COUNT(*) c FROM claims GROUP BY state').all();
    const out = {}; for (const s of Object.values(S)) out[s] = 0; for (const r of rows) out[r.state] = r.c; return out;
  }
  oldestNonTerminalAgeMs() {
    const r = this.db.prepare(`SELECT MIN(created_at) m FROM claims WHERE state IN (${NON_TERMINAL.map(() => '?').join(',')})`).get(...NON_TERMINAL);
    return r && r.m ? this.now() - r.m : null;
  }
  // outpoints reserved by any NON-terminal claim (so live selection can avoid them)
  activeReservations() {
    return this.db.prepare(`SELECT r.network, r.txid, r.vout FROM reservations r JOIN claims c ON c.claim_id=r.claim_id WHERE c.state IN (${NON_TERMINAL.map(() => '?').join(',')})`).all(...NON_TERMINAL);
  }
  releaseReservations(claimId) { this.db.prepare('DELETE FROM reservations WHERE claim_id=?').run(claimId); }

  close() { try { this.db.close(); } catch {} }
}
