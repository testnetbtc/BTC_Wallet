// NODE-2A — reorg-after-confirm outpoint QUARANTINE (mandatory before retirement goes live).
//
// When an authoritative reorg un-confirms an already-CONFIRMED (and retired) claim, the claim
// stays CONFIRMED (terminal) but its original reserved outpoints are durably RE-LOCKED so coin
// selection cannot reuse them until authoritative resolution — never a replacement payout.
import { applyAuthoritative } from '../faucet/authreconcile.mjs';
import { ClaimLedger, S, claimDayUTC } from '../faucet/ledger.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(74), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const dir = mkdtempSync(join(tmpdir(), 'node2a-'));
let seq = 0;
const DAY = claimDayUTC(Date.UTC(2026, 7, 14, 12));
const OP = (t, v = 0) => ({ txid: t.repeat(64).slice(0, 64), vout: v });
const heldSet = (led) => new Set(led.activeReservations().map((r) => `${r.txid}:${r.vout}`));
const canSelect = (led, op) => !heldSet(led).has(`${op.txid}:${op.vout}`);
const totalClaims = (led) => Object.values(led.counts()).reduce((a, b) => a + b, 0);

// Create Claim A, drive to CONFIRMED(deep) with X retired.
function confirmedRetired(led, X) {
  const id = 'A' + (++seq);
  led.createAuthorised({ claimId: id, network: 'testnet4', address: 'tb1qa', canon: 'CA' + seq, claimDay: DAY, amountSat: 100000, reserveOutpoints: [X] });
  led.markSigned(id, { rawTx: 'aa', localTxid: 'ff'.repeat(32), feeSat: 200, reservedOutpoints: [X] });
  led.markBroadcasting(id); led.markSeen(id);
  applyAuthoritative(led, id, { authoritative: true, confirmations: 2, height: 98, reservedAnySpent: true });
  return id;
}
const REORG = { authoritative: true, confirmations: 0, inMempool: false, reservedAnyUnspent: true, reservedAnySpent: false, differentConfirmedSpender: null };

// ── THE mandatory 20-step sequence ──
{
  const file = join(dir, 'seq.db');
  let led = new ClaimLedger(file);
  const X = OP('a', 0);
  const A = confirmedRetired(led, X);                                   // 1-5
  ok('01-05: Claim A CONFIRMED and X retired (selectable pre-reorg)', led.get(A).state === S.CONFIRMED && canSelect(led, X));
  const claimsBefore = totalClaims(led);
  const res = applyAuthoritative(led, A, REORG);                       // 6-9 authoritative reorg detected
  ok('09: reorg-after-confirm detected -> quarantine action', res.action === 'reorg-quarantine');
  ok('10: Claim A remains CONFIRMED (terminal, not mutated)', led.get(A).state === S.CONFIRMED);
  ok('11: reorg-after-confirm review flag set', led.get(A).error_code === 'reorg-after-confirm');
  ok('12: X durably quarantined', led.hasQuarantine(A) === true);
  ok('13-15: Claim B coin selection CANNOT select X', canSelect(led, X) === false);
  ok('16: no replacement/second claim was constructed for A', totalClaims(led) === claimsBefore);
  led.close();
  led = new ClaimLedger(file);                                         // 17 restart
  ok('18: X is STILL quarantined after restart', led.hasQuarantine(A) === true && canSelect(led, X) === false);
  const res2 = applyAuthoritative(led, A, REORG);                     // 19 reconcile again (still unresolved)
  ok('19-20: unresolved reconcile HOLDS quarantine, no double-payment path', res2.action === 'quarantine-held' && canSelect(led, X) === false && totalClaims(led) === claimsBefore);
  led.close();
}

// ── additional cases ──
// original tx back in mempool -> quarantine remains
{
  const led = new ClaimLedger(join(dir, 'mem.db')); const X = OP('b', 0); const A = confirmedRetired(led, X);
  applyAuthoritative(led, A, REORG);
  const r = applyAuthoritative(led, A, { authoritative: true, confirmations: 0, inMempool: true });
  ok('reorg then tx back in mempool -> quarantine HELD', r.action === 'quarantine-held' && canSelect(led, X) === false);
  led.close();
}
// original tx reconfirms -> quarantine resolves (released)
{
  const led = new ClaimLedger(join(dir, 'recon.db')); const X = OP('c', 0); const A = confirmedRetired(led, X);
  applyAuthoritative(led, A, REORG);
  const r = applyAuthoritative(led, A, { authoritative: true, confirmations: 3, height: 90 });
  ok('reorg then reconfirm -> quarantine RESOLVED + released', r.action === 'quarantine-resolved-reconfirmed' && led.hasQuarantine(A) === false && canSelect(led, X) === true);
  ok('reconfirm keeps Claim A CONFIRMED, no replacement', led.get(A).state === S.CONFIRMED);
  led.close();
}
// different tx spends X -> review remains, lock retires, NO replacement
{
  const led = new ClaimLedger(join(dir, 'conf.db')); const X = OP('d', 0); const A = confirmedRetired(led, X);
  applyAuthoritative(led, A, REORG);
  const before = totalClaims(led);
  const r = applyAuthoritative(led, A, { authoritative: true, confirmations: 0, inMempool: false, reservedAnySpent: true, differentConfirmedSpender: 'ee'.repeat(32) });
  ok('reorg then X spent by different tx -> quarantine retired, review kept', r.action === 'quarantine-resolved-conflict' && led.hasQuarantine(A) === false && led.get(A).error_code === 'reorg-resolved-conflicting-spend');
  ok('conflicting-spend resolution built NO replacement payout', totalClaims(led) === before && led.get(A).state === S.CONFIRMED);
  led.close();
}
// node unavailable -> quarantine remains
{
  const led = new ClaimLedger(join(dir, 'down.db')); const X = OP('e', 0); const A = confirmedRetired(led, X);
  applyAuthoritative(led, A, REORG);
  const r = applyAuthoritative(led, A, { authoritative: false });
  ok('node unavailable -> quarantine HELD (unknown != safe)', r.action === 'quarantine-held-unauthoritative' && canSelect(led, X) === false);
  led.close();
}
// pruned/unprovable (X spent but spender undeterminable) -> quarantine remains
{
  const led = new ClaimLedger(join(dir, 'prune.db')); const X = OP('f', 0); const A = confirmedRetired(led, X);
  applyAuthoritative(led, A, REORG);
  const r = applyAuthoritative(led, A, { authoritative: true, confirmations: 0, inMempool: false, reservedAnySpent: true, differentConfirmedSpender: null });
  ok('pruned/undeterminable -> quarantine HELD, never guessed', r.action === 'quarantine-held' && canSelect(led, X) === false);
  led.close();
}
// multiple passes idempotent: no duplicate rows, no accidental release
{
  const led = new ClaimLedger(join(dir, 'idem.db')); const X = OP('g', 0); const A = confirmedRetired(led, X);
  applyAuthoritative(led, A, REORG); applyAuthoritative(led, A, REORG); applyAuthoritative(led, A, REORG);
  const rows = led.quarantinedOutpoints().filter((q) => q.claim_id === A);
  ok('idempotent quarantine: exactly one row for X, still held', rows.length === 1 && canSelect(led, X) === false);
  led.close();
}
// external explorer says confirmed but own node disagrees -> own node wins, quarantine remains
{
  const led = new ClaimLedger(join(dir, 'disagree.db')); const X = OP('h', 0); const A = confirmedRetired(led, X);
  applyAuthoritative(led, A, REORG);
  // we ONLY feed own-node facts; an external "confirmed" opinion is never passed in -> ignored
  const r = applyAuthoritative(led, A, { authoritative: true, confirmations: 0, inMempool: false, reservedAnyUnspent: true });
  ok('own-node disagreement wins -> quarantine HELD despite external "confirmed"', r.action === 'quarantine-held' && canSelect(led, X) === false);
  led.close();
}

console.log(bad ? '\nNODE-2A QUARANTINE TEST FAILED' : '\nNODE-2A QUARANTINE TEST PASS — reorg-after-confirm re-locks outpoints durably; no reuse, no replacement');
process.exit(bad ? 1 : 0);
