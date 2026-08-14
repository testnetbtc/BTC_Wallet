// NODE-2 PHASE B — advanceClaim routing: own-node authoritative reconciliation for configured
// networks (drives CONFIRMED + atomic retire-to-guard, reorg quarantine, hold-on-unauthoritative),
// processClaim fallback otherwise. The authoritative decision logic itself is covered by
// authreconcile/node2a/node2b; this proves the ROUTING and fail-safe hold.
import { advanceClaim } from '../faucet/advance.mjs';
import { ClaimLedger, S, claimDayUTC } from '../faucet/ledger.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(72), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const dir = mkdtempSync(join(tmpdir(), 'advance-'));
let seq = 0;
const DAY = claimDayUTC(Date.UTC(2026, 7, 14, 12));
const OP = (t, v = 0) => ({ txid: t.repeat(64).slice(0, 64), vout: v });
const held = (led, op) => new Set(led.activeReservations().map((r) => `${r.txid}:${r.vout}`)).has(`${op.txid}:${op.vout}`);

// fake own-node primitive interface (ready/confirmationsOf/inMempool/utxoUnspent/confirmedSpenderOf)
const fakeNode = (over) => ({
  ready: async () => { if (over.down) throw new Error('node down'); return { blocks: over.blocks ?? 1000 }; },
  confirmationsOf: async () => over.confirmations ?? 0,
  inMempool: async () => over.inMempool ?? false,
  utxoUnspent: async () => over.unspent ?? false,
  confirmedSpenderOf: async () => over.spender ?? null,
});
function seenClaim(led, X, network = 'testnet4') {
  const id = 'c' + (++seq);
  led.createAuthorised({ claimId: id, network, address: 'tb1qx', canon: 'C' + seq, claimDay: DAY, amountSat: 100000, reserveOutpoints: [X] });
  led.markSigned(id, { rawTx: 'aa', localTxid: 'ff'.repeat(32), feeSat: 200, reservedOutpoints: [X] });
  led.markBroadcasting(id); led.markSeen(id);
  return id;
}
const mk = () => new ClaimLedger(join(dir, `l${++seq}.db`));

// ── A: testnet4 SEEN + authoritative confirmed(>=2) -> CONFIRMED + atomic retire-to-guard ──
{
  const led = mk(); const X = OP('a', 0); const id = seenClaim(led, X);
  const deps = { ledger: led, authReconcilers: { testnet4: fakeNode({ confirmations: 2 }) }, minRetireConf: 2 };
  await advanceClaim(deps, id);
  ok('A: SEEN + node confirmed(2) -> CONFIRMED + guarded (retired-confirmed)', led.get(id).state === S.CONFIRMED && held(led, X) && led.guardReason(id) === 'retired-confirmed');
  led.close();
}
// ── B: node NOT authoritative -> claim unchanged, reservation HELD (never downgrade/release) ──
{
  const led = mk(); const X = OP('b', 0); const id = seenClaim(led, X);
  const deps = { ledger: led, authReconcilers: { testnet4: fakeNode({ down: true }) }, minRetireConf: 2 };
  await advanceClaim(deps, id);
  ok('B: node down -> claim STILL SEEN, reservation held, not guarded', led.get(id).state === S.SEEN && held(led, X) && led.guardReason(id) === null);
  led.close();
}
// ── C: confirmed but shallow (1) -> SEEN, reservation held (no retire below minRetireConf) ──
{
  const led = mk(); const X = OP('c', 0); const id = seenClaim(led, X);
  await advanceClaim({ ledger: led, authReconcilers: { testnet4: fakeNode({ confirmations: 1 }) }, minRetireConf: 2 }, id);
  ok('C: confirmed(1 shallow) -> SEEN, held (not retired)', led.get(id).state === S.SEEN && held(led, X) && led.guardReason(id) === null);
  led.close();
}
// ── D: testnet4 CONFIRMED + input resurrected -> reorg-after-confirm quarantine (guard flips) ──
{
  const led = mk(); const X = OP('d', 0); const id = seenClaim(led, X);
  await advanceClaim({ ledger: led, authReconcilers: { testnet4: fakeNode({ confirmations: 2 }) }, minRetireConf: 2 }, id);  // -> CONFIRMED + guard
  await advanceClaim({ ledger: led, authReconcilers: { testnet4: fakeNode({ confirmations: 0, unspent: true }) }, minRetireConf: 2 }, id);  // input unspent again
  ok('D: CONFIRMED then input resurrected -> reorg-after-confirm guard, still excluded, CONFIRMED', led.get(id).state === S.CONFIRMED && led.guardReason(id) === 'reorg-after-confirm' && held(led, X));
  led.close();
}
// ── D2: old CONFIRMED, unprovable, input still spent -> NO spurious reorg (noop) ──
{
  const led = mk(); const X = OP('o', 0); const id = seenClaim(led, X);
  await advanceClaim({ ledger: led, authReconcilers: { testnet4: fakeNode({ confirmations: 2 }) }, minRetireConf: 2 }, id);  // CONFIRMED + guard
  const g0 = led.guardReason(id);
  await advanceClaim({ ledger: led, authReconcilers: { testnet4: fakeNode({ confirmations: 0, unspent: false }) }, minRetireConf: 2 }, id);  // can't prove, input spent
  ok('D2: unprovable + input still spent -> guard stays retired-confirmed (no spurious reorg)', g0 === 'retired-confirmed' && led.guardReason(id) === 'retired-confirmed');
  led.close();
}

// ── E: a network WITHOUT an own-node reconciler falls back to processClaim ──
{
  const led = mk(); const X = OP('e', 0, 'signet');
  const id = 'sig' + (++seq);
  led.createAuthorised({ claimId: id, network: 'signet', address: 'tb1qs', canon: 'CS' + seq, claimDay: DAY, amountSat: 100000, reserveOutpoints: [OP('e', 0)] });
  // fake processClaim deps: build+sign then broadcast via a fake chain
  const signer = async ({ reservedOutpoints }) => ({ rawTx: 'raw:sig', localTxid: 'tx_sig', feeSat: 1, inputs: reservedOutpoints });
  const chain = { async lookup() { return { found: false }; }, async outspend() { return { spent: false }; }, async broadcast() { return 'tx_sig'; } };
  const txidOf = (raw) => (raw === 'raw:sig' ? 'tx_sig' : 'bad');
  const deps = { ledger: led, authReconcilers: { testnet4: fakeNode({ confirmations: 2 }) }, minRetireConf: 2, signer, chain, txidOf };
  const before = led.get(id).state;
  await advanceClaim(deps, id);   // signet has no reconciler -> processClaim path advances it
  ok('E: no-reconciler network uses processClaim (AUTHORISED advanced)', before === S.AUTHORISED && led.get(id).state !== S.AUTHORISED);
  led.close();
}

console.log(bad ? '\nADVANCE (PHASE B) TEST FAILED' : '\nADVANCE (PHASE B) TEST PASS — authoritative routing, fail-safe hold, processClaim fallback');
process.exit(bad ? 1 : 0);
