// RT-6 — durable, crash-safe dedup store for the Nostr faucet bot.
//
// The bot must record that a relay event has been consumed BEFORE it does anything
// payout-capable, so a crash between "start handling" and "durably saved" cannot let a
// re-delivered event drive a second payout. This store provides:
//   * atomic + fsync'd persistence (temp file -> fsync -> rename),
//   * markSeenDurable(id): records the id and returns true ONLY once it is on disk,
//   * fail-safe load: a corrupt/unreadable state file marks the store UNHEALTHY rather
//     than silently resetting to empty and reprocessing every old event.
// It is defence-in-depth: the RT-2 faucet claim ledger remains the authoritative
// exactly-once payout layer.
import { readFileSync, existsSync, renameSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';

export class DedupStore {
  constructor(file, { max = 4000 } = {}) {
    this.file = file;
    this.max = max;
    this.claims = {};
    this.seen = new Set();
    this.healthy = true;
    this.loadError = null;
    if (existsSync(file)) {
      try {
        const s = JSON.parse(readFileSync(file, 'utf8'));
        if (!s || typeof s !== 'object' || !Array.isArray(s.seen) || typeof s.claims !== 'object' || s.claims === null) {
          throw new Error('malformed dedup state');
        }
        this.claims = s.claims;
        this.seen = new Set(s.seen);
      } catch (e) {
        // FAIL SAFE: do NOT reset to empty and reprocess everything. Stay unhealthy so
        // the caller refuses to dispense until an operator repairs/removes the file.
        this.healthy = false;
        this.loadError = String(e.message);
      }
    }
  }

  has(id) { return this.seen.has(id); }
  getClaim(pubkey) { return this.claims[pubkey] || 0; }

  // Atomic + durable write: temp file -> fsync -> rename. Returns false on any error
  // (caller treats a failed persist as "not durably recorded").
  persist() {
    const snapshot = { claims: this.claims, seen: [...this.seen].slice(-this.max) };
    const tmp = this.file + '.tmp';
    try {
      const fd = openSync(tmp, 'w');
      try { writeSync(fd, JSON.stringify(snapshot)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.file);
      return true;
    } catch {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
      return false;
    }
  }

  // Durably record an event id as consumed BEFORE any payout-capable action. Returns
  // true only if the marker reached disk. On persist failure the id is NOT retained in
  // memory (so a future redelivery may retry) and false is returned — the caller MUST
  // NOT dispense in that case. Refuses outright if the store is unhealthy (fail closed).
  markSeenDurable(id) {
    if (!this.healthy) return false;
    this.seen.add(id);
    if (this.persist()) return true;
    this.seen.delete(id);
    return false;
  }

  // Record a per-account claim timestamp (after a successful payout) and persist.
  setClaim(pubkey, ts) { this.claims[pubkey] = ts; return this.persist(); }
}
