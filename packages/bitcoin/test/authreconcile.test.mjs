// NODE-2 — authoritative reconciliation + safe reservation-retirement tests.
//
// Covers: authority establishment (wrong net / IBD / unavailable / stale), confirmation depth
// gating, mempool/absent/pruned-undeterminable, conflict by a different confirmed tx, retirement
// ONLY on CONFIRMED(deep)/CONFLICTED, UNCERTAIN/FAILED_SAFE hold their reservations, CONFIRMED is
// terminal with a reorg REVIEW FLAG (no mutation), idempotent re-runs, restart, own-node-wins,
// and NO replacement payout under any path.
import { classifyAuthoritative, isReorgAfterConfirm, gatherFacts, applyAuthoritative } from '../faucet/authreconcile.mjs';
import { ClaimLedger, S, claimDayUTC } from '../faucet/ledger.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(72), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const dir = mkdtempSync(join(tmpdir(), 'node2-'));
let seq = 0;
const DAY = claimDayUTC(Date.UTC(2026, 7, 14, 12));
const OP = (t, v = 0) => ({ txid: t.repeat(64).slice(0, 64), vout: v });
function newLedgerWithClaim(state, reserved = [OP('a', 0)]) {
  const led = new ClaimLedger(join(dir, `l${++seq}.db`));
  const id = 'c' + seq;
  led.createAuthorised({ claimId: id, network: 'testnet4', address: 'tb1qx', canon: 'canon' + seq, claimDay: DAY, amountSat: 100000, reserveOutpoints: reserved });
  if (state === S.SIGNED || state === S.SEEN || state === S.CONFIRMED) led.markSigned(id, { rawTx: 'aa', localTxid: 'ff'.repeat(32), feeSat: 200, reservedOutpoints: reserved });
  if (state === S.SEEN || state === S.CONFIRMED) { led.markBroadcasting(id); led.markSeen(id); }
  if (state === S.CONFIRMED) led.markConfirmed(id, { height: 100 });
  if (state === S.FAILED_SAFE) led.markFailedSafe(id, 'x', 'y');
  return { led, id };
}
const held = (led, op) => new Set(led.activeReservations().map((r) => `${r.txid}:${r.vout}`)).has(`${op.txid}:${op.vout}`);

// ── PURE classify: the decision matrix ──
{
  const F = (o) => ({ authoritative: true, confirmations: null, inMempool: false, reservedAnyUnspent: false, reservedAnySpent: false, differentConfirmedSpender: null, ...o });
  ok('not authoritative -> UNCERTAIN, no retire', classifyAuthoritative(F({ authoritative: false })).state === S.UNCERTAIN);
  ok('confirmed deep (2) -> CONFIRMED + retire', (() => { const r = classifyAuthoritative(F({ confirmations: 2, height: 99 })); return r.state === S.CONFIRMED && r.retire === true; })());
  ok('confirmed shallow (1) -> SEEN, HOLD (no retire)', (() => { const r = classifyAuthoritative(F({ confirmations: 1 })); return r.state === S.SEEN && r.retire === false; })());
  ok('in mempool -> SEEN, no retire', classifyAuthoritative(F({ inMempool: true })).state === S.SEEN);
  ok('different confirmed spender -> CONFLICTED + retire + review', (() => { const r = classifyAuthoritative(F({ reservedAnySpent: true, differentConfirmedSpender: 'dd'.repeat(32) })); return r.state === S.CONFLICTED && r.retire === true && r.review === true; })());
  ok('reserved all unspent -> ABSENT (rebroadcast), no retire', (() => { const r = classifyAuthoritative(F({ reservedAnyUnspent: true })); return r.state === S.ABSENT && r.retire === false; })());
  ok('reserved spent, spender undeterminable (pruned) -> UNCERTAIN held', (() => { const r = classifyAuthoritative(F({ reservedAnySpent: true })); return r.state === S.UNCERTAIN && r.retire === false; })());
  ok('custom minRetireConf=3: conf 2 -> SEEN (hold)', classifyAuthoritative(F({ confirmations: 2 }), { minRetireConf: 3 }).state === S.SEEN);
}

// ── gatherFacts: authority establishment ──
{
  const node = (over) => ({
    ready: async () => { if (over.readyThrows) throw new Error(over.readyThrows); return { blocks: over.blocks ?? 1000 }; },
    confirmationsOf: async () => over.confirmations ?? 0,
    inMempool: async () => over.inMempool ?? false,
    utxoUnspent: async () => over.unspent ?? false,
    confirmedSpenderOf: async () => over.spender ?? null,
  });
  const base = { localTxid: 'ff'.repeat(32), outVouts: [0, 1], reserved: [OP('a', 0)] };
  ok('node unreachable -> authoritative:false', (await gatherFacts(node({ readyThrows: 'ECONNREFUSED' }), base)).authoritative === false);
  ok('wrong chain / IBD / stale surfaced as ready throw -> authoritative:false', (await gatherFacts(node({ readyThrows: 'wrong chain' }), base)).authoritative === false);
  ok('healthy + confirmed=2 -> facts confirmed', (await gatherFacts(node({ confirmations: 2 }), base)).confirmations === 2);
  ok('healthy + in mempool -> facts.inMempool', (await gatherFacts(node({ inMempool: true }), base)).inMempool === true);
  ok('healthy + reserved unspent -> reservedAnyUnspent', (await gatherFacts(node({ unspent: true }), base)).reservedAnyUnspent === true);
  ok('reserved spent + no spender proof -> UNCERTAIN via classify', (() => { const r = classifyAuthoritative({ authoritative: true, confirmations: 0, inMempool: false, reservedAnyUnspent: false, reservedAnySpent: true, differentConfirmedSpender: null }); return r.state === S.UNCERTAIN; })());
}

// ── apply: retirement ONLY on CONFIRMED(deep)/CONFLICTED; others HOLD ──
{
  // CONFIRMED deep -> retire, audit kept
  {
    const op = OP('b', 1); const { led, id } = newLedgerWithClaim(S.SEEN, [op]);
    const res = applyAuthoritative(led, id, { authoritative: true, confirmations: 2, height: 98, reservedAnySpent: true });
    ok('apply CONFIRMED(2) -> claim CONFIRMED + reservation retired', led.get(id).state === S.CONFIRMED && res.retired === true && !held(led, op));
    ok('apply CONFIRMED keeps audit linkage (reserved_outpoints + local_txid)', JSON.parse(led.get(id).reserved_outpoints).length === 1 && !!led.get(id).local_txid);
    led.close();
  }
  // CONFIRMED shallow -> SEEN, reservation HELD
  {
    const op = OP('c', 0); const { led, id } = newLedgerWithClaim(S.SEEN, [op]);
    applyAuthoritative(led, id, { authoritative: true, confirmations: 1 });
    ok('apply CONFIRMED(1 shallow) -> stays SEEN, reservation HELD', led.get(id).state === S.SEEN && held(led, op));
    led.close();
  }
  // UNCERTAIN -> reservation HELD
  {
    const op = OP('d', 0); const { led, id } = newLedgerWithClaim(S.SEEN, [op]);
    applyAuthoritative(led, id, { authoritative: false });
    ok('apply not-authoritative -> UNCERTAIN, reservation HELD', led.get(id).state === S.UNCERTAIN && held(led, op));
    led.close();
  }
  // CONFLICTED -> retire lock, NO replacement, review flag
  {
    const op = OP('e', 0); const { led, id } = newLedgerWithClaim(S.SEEN, [op]);
    const before = led.counts();
    const res = applyAuthoritative(led, id, { authoritative: true, confirmations: 0, inMempool: false, reservedAnySpent: true, differentConfirmedSpender: 'ee'.repeat(32) });
    ok('apply CONFLICTED -> claim CONFLICTED + lock retired + review flag', led.get(id).state === S.CONFLICTED && res.retired === true && !held(led, op) && led.get(id).error_code === 'conflicted-manual-review');
    ok('apply CONFLICTED created NO new claim (no replacement payout)', Object.values(led.counts()).reduce((a, b) => a + b, 0) === Object.values(before).reduce((a, b) => a + b, 0));
    led.close();
  }
  // FAILED_SAFE -> terminal noop, reservation HELD
  {
    const op = OP('f', 0); const { led, id } = newLedgerWithClaim(S.FAILED_SAFE, [op]);
    const res = applyAuthoritative(led, id, { authoritative: true, confirmations: 2 });
    ok('apply on FAILED_SAFE -> noop, state unchanged, reservation HELD', res.action === 'noop-terminal' && led.get(id).state === S.FAILED_SAFE && held(led, op));
    led.close();
  }
}

// ── CONFIRMED is TERMINAL; reorg -> review FLAG, NEVER a state change ──
{
  const op = OP('g', 0); const { led, id } = newLedgerWithClaim(S.CONFIRMED, [op]);
  ok('reorg detector fires when authoritative + not-confirmed + not-mempool', isReorgAfterConfirm({ authoritative: true, confirmations: 0, inMempool: false }) === true);
  const res = applyAuthoritative(led, id, { authoritative: true, confirmations: 0, inMempool: false });
  ok('apply on reorged CONFIRMED -> review flag, state STILL CONFIRMED', res.action === 'reorg-review-flag' && led.get(id).state === S.CONFIRMED && led.get(id).error_code === 'reorg-after-confirm');
  // idempotent + no replacement
  const before = Object.values(led.counts()).reduce((a, b) => a + b, 0);
  applyAuthoritative(led, id, { authoritative: true, confirmations: 0, inMempool: false });
  ok('reorg-after-confirm never creates a replacement / extra claim', Object.values(led.counts()).reduce((a, b) => a + b, 0) === before);
  led.close();
}

// ── idempotent re-run + restart durability ──
{
  const op = OP('h', 0); const file = join(dir, 'idem.db');
  let led = new ClaimLedger(file); const id = 'idem';
  led.createAuthorised({ claimId: id, network: 'testnet4', address: 'tb1qy', canon: 'CIDEM', claimDay: DAY, amountSat: 100000, reserveOutpoints: [op] });
  led.markSigned(id, { rawTx: 'aa', localTxid: 'ff'.repeat(32), feeSat: 200, reservedOutpoints: [op] }); led.markBroadcasting(id); led.markSeen(id);
  const facts = { authoritative: true, confirmations: 3, height: 97, reservedAnySpent: true };
  applyAuthoritative(led, id, facts); applyAuthoritative(led, id, facts);   // twice
  ok('idempotent: two authoritative CONFIRMED applies -> single CONFIRMED, retired once', led.get(id).state === S.CONFIRMED && !held(led, op));
  led.close();
  led = new ClaimLedger(file);
  ok('restart: CONFIRMED + retirement survive reopen', led.get(id).state === S.CONFIRMED && !held(led, op) && JSON.parse(led.get(id).reserved_outpoints).length === 1);
  led.close();
}

// ── own-node authoritative result WINS over any external/advisory disagreement ──
{
  // even if an external explorer would say "seen", an authoritative CONFIRMED(deep) is CONFIRMED
  const op = OP('k', 0); const { led, id } = newLedgerWithClaim(S.SEEN, [op]);
  applyAuthoritative(led, id, { authoritative: true, confirmations: 6, height: 90, reservedAnySpent: true });
  ok('own-node authoritative CONFIRMED wins -> CONFIRMED + retired', led.get(id).state === S.CONFIRMED && !held(led, op));
  led.close();
}

console.log(bad ? '\nNODE-2 AUTH-RECONCILE TEST FAILED' : '\nNODE-2 AUTH-RECONCILE TEST PASS — authoritative, pruned-safe, retirement-gated, CONFIRMED-terminal, no replacement');
process.exit(bad ? 1 : 0);
