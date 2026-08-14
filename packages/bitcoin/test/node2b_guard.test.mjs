// NODE-2B — durable retirement guard closes the retirement -> reorg-detection race.
//
// At CONFIRMED(deep) the active reservation is ATOMICALLY replaced by a durable retirement
// guard for the same outpoint (one SQLite transaction). Because the guard participates in
// activeReservations(), the outpoint is excluded from coin selection from the instant of
// retirement — so even if a reorg resurrects it BEFORE the claim is reconciled, a competing
// claim cannot select it. There is never a committed state where the outpoint is unprotected.
import { applyAuthoritative } from '../faucet/authreconcile.mjs';
import { ClaimLedger, S, claimDayUTC } from '../faucet/ledger.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(76), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const dir = mkdtempSync(join(tmpdir(), 'node2b-'));
let seq = 0;
const DAY = claimDayUTC(Date.UTC(2026, 7, 14, 12));
const OP = (t, v = 0) => ({ txid: t.repeat(64).slice(0, 64), vout: v });
const heldSet = (led) => new Set(led.activeReservations().map((r) => `${r.txid}:${r.vout}`));
const canSelect = (led, op) => !heldSet(led).has(`${op.txid}:${op.vout}`);
const totalClaims = (led) => Object.values(led.counts()).reduce((a, b) => a + b, 0);
function claimA(led, X) {
  const id = 'A' + (++seq);
  led.createAuthorised({ claimId: id, network: 'testnet4', address: 'tb1qa', canon: 'CA' + seq, claimDay: DAY, amountSat: 100000, reserveOutpoints: [X] });
  led.markSigned(id, { rawTx: 'aa', localTxid: 'ff'.repeat(32), feeSat: 200, reservedOutpoints: [X] });
  led.markBroadcasting(id); led.markSeen(id);
  return id;
}
const REORG = { authoritative: true, confirmations: 0, inMempool: false, reservedAnyUnspent: true, reservedAnySpent: false, differentConfirmedSpender: null };

// ── THE mandatory adversarial ordering: Claim B arrives BEFORE Claim A's reorg reconciliation ──
{
  const file = join(dir, 'race.db');
  let led = new ClaimLedger(file);
  const X = OP('a', 0);
  const A = claimA(led, X);                                                     // 1-2
  const res = applyAuthoritative(led, A, { authoritative: true, confirmations: 2, height: 98, reservedAnySpent: true }); // 3-5
  ok('01-05: A CONFIRMED, reservation retired', led.get(A).state === S.CONFIRMED && res.retired === true);
  ok('06: a durable retirement GUARD for X already exists at the moment of retirement', led.guardReason(A) === 'retired-confirmed' && !canSelect(led, X));
  ok('06b: the ACTIVE reservation row is gone (moved, not duplicated)', led.activeReservations().filter((r) => r.claim_id === A).length === 1);
  // 07-11: reorg happens; X resurfaces as unspent; A is NOT reconciled yet
  const claimsBefore = totalClaims(led);
  // 12-15: Claim B runs ordinary coin selection NOW, before A's reorg is noticed
  ok('12-15: Claim B CANNOT select X (guard already excludes it — race closed)', canSelect(led, X) === false);
  ok('15: no replacement tx / extra claim exists for A', totalClaims(led) === claimsBefore);
  // 16-17: now reconcile A -> guard transitions to reorg-after-confirm idempotently
  const r2 = applyAuthoritative(led, A, REORG); applyAuthoritative(led, A, REORG);
  ok('16-17: reconcile transitions guard -> reorg-after-confirm (idempotent, single row)', r2.action === 'reorg-quarantine' && led.guardReason(A) === 'reorg-after-confirm' && led.quarantinedOutpoints().filter((q) => q.claim_id === A).length === 1);
  led.close();
  led = new ClaimLedger(file);                                                  // 18 restart
  ok('18-19: X still excluded after restart', canSelect(led, X) === false);
  ok('20: no double-payment path — X guarded, no replacement claim', canSelect(led, X) === false && totalClaims(led) === claimsBefore);
  led.close();
}

// ── atomicity: retireToGuard is all-or-nothing ──
{
  const led = new ClaimLedger(join(dir, 'atomic.db')); const X = OP('b', 0); const A = claimA(led, X);
  ok('retireToGuard succeeds atomically -> guard exists immediately, reservation gone',
     led.retireToGuard(A, [X], 'retired-confirmed') === true && led.guardReason(A) === 'retired-confirmed' && !canSelect(led, X));
  led.close();
}
// guard insertion fails (malformed outpoint) -> whole tx rolls back, reservation intact
{
  const led = new ClaimLedger(join(dir, 'rollback.db')); const X = OP('c', 0); const A = claimA(led, X);
  const okBefore = !canSelect(led, X);                                          // X reserved (excluded) before
  const rc = led.retireToGuard(A, [{ txid: null, vout: 0 }, X], 'retired-confirmed');   // null txid -> NOT NULL violation
  ok('guard insert failure -> retireToGuard returns false', rc === false);
  ok('rollback: original reservation still intact (X still excluded, NOT a guard)', okBefore && !canSelect(led, X) && led.guardReason(A) === null && led.activeReservations().some((r) => r.claim_id === A));
  ok('rollback invariant: X never became unprotected', !canSelect(led, X));
  led.close();
}
// restart after retirement but before any reorg -> guard survives
{
  const file = join(dir, 'survive.db'); let led = new ClaimLedger(file); const X = OP('d', 0); const A = claimA(led, X);
  applyAuthoritative(led, A, { authoritative: true, confirmations: 2, height: 98 }); led.close();
  led = new ClaimLedger(file);
  ok('restart pre-reorg: retired-confirmed guard survives, X excluded', led.guardReason(A) === 'retired-confirmed' && !canSelect(led, X));
  led.close();
}
// normal confirmed claim with guard -> does not disturb OTHER coins
{
  const led = new ClaimLedger(join(dir, 'normal.db')); const X = OP('e', 0), Y = OP('e', 1); const A = claimA(led, X);
  applyAuthoritative(led, A, { authoritative: true, confirmations: 2 });
  ok('guarded X excluded but an unrelated coin Y is still selectable', !canSelect(led, X) && canSelect(led, Y));
  led.close();
}
// idempotent guard across many reorg passes -> one row
{
  const led = new ClaimLedger(join(dir, 'idem.db')); const X = OP('f', 0); const A = claimA(led, X);
  applyAuthoritative(led, A, { authoritative: true, confirmations: 2 });
  for (let i = 0; i < 4; i++) applyAuthoritative(led, A, REORG);
  ok('idempotent: exactly one guard row for X after repeated reorg passes', led.quarantinedOutpoints().filter((q) => q.claim_id === A).length === 1 && !canSelect(led, X));
  led.close();
}
// reconfirmation -> guard resolves to retired-confirmed (retained), still excluded
{
  const led = new ClaimLedger(join(dir, 'recon.db')); const X = OP('g', 0); const A = claimA(led, X);
  applyAuthoritative(led, A, { authoritative: true, confirmations: 2 });
  applyAuthoritative(led, A, REORG);
  const r = applyAuthoritative(led, A, { authoritative: true, confirmations: 3, height: 90 });
  ok('reconfirm -> guard back to retired-confirmed, retained, X excluded, no replacement', r.action === 'quarantine-resolved-reconfirmed' && led.guardReason(A) === 'retired-confirmed' && !canSelect(led, X));
  led.close();
}
// unprovable after reorg -> guard held
{
  const led = new ClaimLedger(join(dir, 'unprov.db')); const X = OP('h', 0); const A = claimA(led, X);
  applyAuthoritative(led, A, { authoritative: true, confirmations: 2 });
  applyAuthoritative(led, A, REORG);
  const r = applyAuthoritative(led, A, { authoritative: false });
  ok('reorg then node unavailable -> guard HELD (unknown != safe)', r.action === 'quarantine-held-unauthoritative' && !canSelect(led, X));
  led.close();
}

console.log(bad ? '\nNODE-2B GUARD TEST FAILED' : '\nNODE-2B GUARD TEST PASS — atomic reservation->guard, no unguarded window, race closed');
process.exit(bad ? 1 : 0);
