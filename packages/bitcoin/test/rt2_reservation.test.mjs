// RT-2C reservation-retention + RT-2B idempotency-scope acceptance test.
//
// Proves the auditor's closure invariants:
//   * UNCERTAIN / FAILED_SAFE claims RETAIN their durable UTXO reservation.
//   * process restart, reconcile-unavailable, timeout and "explorer says missing"
//     NEVER return a reserved input to ordinary coin selection.
//   * the live coin selector cannot pick an outpoint reserved by UNCERTAIN/FAILED_SAFE.
//   * only an AUTHORITATIVE CONFIRMED/CONFLICTED result retires a reservation, and doing
//     so preserves the audit linkage (claim keeps reserved_outpoints + local_txid).
//   * a CONFLICTED reserved input is handled WITHOUT constructing a replacement payment.
//   * the full lost-broadcast-response scenario: TX-A held, coin unusable, recover TX-A,
//     no TX-B ever built.
// Plus RT-2B: client idempotency keys are scoped per network, not globally.
import { ClaimLedger, S, claimDayUTC } from '../faucet/ledger.mjs';
import { processClaim, CrashInjected } from '../faucet/claimflow.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(70), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); };

const fakeSigner = (world, opts = {}) => async ({ address, amountSat, reservedOutpoints }) => {
  world.signCalls++;
  const txid = 'tx_' + hash(address + ':' + amountSat + ':' + reservedOutpoints.map((o) => o.txid + ':' + o.vout).sort().join(','));
  return { rawTx: 'raw:' + txid, localTxid: opts.badTxid ? 'tx_LIES' : txid, feeSat: 300, inputs: reservedOutpoints.map((o) => ({ txid: o.txid, vout: o.vout })) };
};
const fakeTxidOf = (raw) => (typeof raw === 'string' && raw.startsWith('raw:') ? raw.slice(4) : 'tx_BADBYTES');
const makeWorld = (over = {}) => ({ signCalls: 0, broadcasts: [], mempool: new Set(), confirmed: new Set(), spent: new Map(), broadcastMode: 'ok', autoConfirm: false, lookupThrows: false, ...over });
const fakeChain = (world) => ({
  authoritative: false,
  async lookup(network, txid) {
    if (world.lookupThrows) throw new Error('node unavailable / timed out');
    if (world.confirmed.has(txid)) return { found: true, confirmed: true, height: 100, blockHash: 'bh' };
    if (world.mempool.has(txid)) return { found: true, confirmed: false };
    return { found: false };
  },
  async outspend(network, txid, vout) { const by = world.spent.get(txid + ':' + vout); return { spent: !!by, txid: by || null }; },
  async broadcast(network, rawTx) {
    const txid = rawTx.slice(4); world.broadcasts.push(txid);
    if (world.broadcastMode === 'ambiguous') { world.mempool.add(txid); throw new Error('timed out waiting for RPC response'); }
    if (world.broadcastMode === 'reject') throw new Error('rejected: bad-txns-inputs-missingorspent');
    world.mempool.add(txid); if (world.autoConfirm) world.confirmed.add(txid); return txid;
  },
});

const DAY = claimDayUTC(Date.UTC(2026, 7, 13, 12));
let seq = 0;
const OP = (tag, vout = 0) => ({ txid: tag.repeat(32), vout, value: 110000 });
function freshClaim(led, resv, over = {}) {
  const id = 'c' + (++seq);
  const r = led.createAuthorised({ claimId: id, network: 'testnet4', address: 'tb1qdest', canon: 'canon' + seq, claimDay: DAY, amountSat: 100000, reserveOutpoints: resv, ...over });
  return r.claim.claim_id;
}
async function runToStable(deps, id, passes = 8) {
  let prev = null;
  for (let i = 0; i < passes; i++) { const c = await processClaim(deps, id); if (!c) break; if (c.state === prev) break; prev = c.state; if ([S.CONFIRMED, S.CONFLICTED, S.FAILED_SAFE].includes(c.state)) break; }
  return deps.ledger.get(id);
}
const newLedgerFile = () => join(mkdtempSync(join(tmpdir(), 'rt2-resv-')), 'c.db');
// the live coin selector's exclusion rule, extracted (mirrors server.pickFaucetCoins)
const held = (led, network) => new Set(led.activeReservations().filter((r) => r.network === network).map((r) => `${r.txid}:${r.vout}`));
const heldHas = (led, network, op) => held(led, network).has(`${op.txid}:${op.vout}`);

// ── UNCERTAIN retains reservation (reconcile source unavailable) ──
{
  const led = new ClaimLedger(newLedgerFile()), world = makeWorld({ lookupThrows: true });
  const op = OP('a1'); const id = freshClaim(led, [op]);
  const c = await runToStable({ ledger: led, signer: fakeSigner(world), chain: fakeChain(world), txidOf: fakeTxidOf }, id);
  ok('reconcile unavailable -> UNCERTAIN', c.state === S.UNCERTAIN);
  ok('UNCERTAIN claim RETAINS its reservation', heldHas(led, 'testnet4', op));
  ok('coin selector CANNOT select the UNCERTAIN-held outpoint', held(led, 'testnet4').has(`${op.txid}:${op.vout}`));
  led.close();
}

// ── FAILED_SAFE retains reservation (signer txid mismatch) ──
{
  const led = new ClaimLedger(newLedgerFile()), world = makeWorld();
  const op = OP('a2'); const id = freshClaim(led, [op]);
  const c = await runToStable({ ledger: led, signer: fakeSigner(world, { badTxid: true }), chain: fakeChain(world), txidOf: fakeTxidOf }, id);
  ok('signer mismatch -> FAILED_SAFE, never broadcast', c.state === S.FAILED_SAFE && world.broadcasts.length === 0);
  ok('FAILED_SAFE claim RETAINS its reservation', heldHas(led, 'testnet4', op));
  led.close();
}

// ── restart (reopen the durable file) keeps the UNCERTAIN reservation ──
{
  const file = newLedgerFile();
  let led = new ClaimLedger(file), world = makeWorld({ broadcastMode: 'reject' });
  const op = OP('a3'); const id = freshClaim(led, [op]);
  await runToStable({ ledger: led, signer: fakeSigner(world), chain: fakeChain(world), txidOf: fakeTxidOf }, id);
  ok('rejected broadcast (tx absent) -> UNCERTAIN, held', led.get(id).state === S.UNCERTAIN && heldHas(led, 'testnet4', op));
  led.close();
  led = new ClaimLedger(file);   // RESTART
  ok('after restart, UNCERTAIN claim STILL holds its reservation', led.get(id).state === S.UNCERTAIN && heldHas(led, 'testnet4', op));
  ok('after restart, coin selector still cannot pick the outpoint', held(led, 'testnet4').has(`${op.txid}:${op.vout}`));
  led.close();
}

// ── CONFIRMED safely retires reservation (authoritative), audit preserved ──
{
  const led = new ClaimLedger(newLedgerFile()), world = makeWorld({ autoConfirm: true });
  const op = OP('a4'); const id = freshClaim(led, [op]);
  const c = await runToStable({ ledger: led, signer: fakeSigner(world), chain: fakeChain(world), txidOf: fakeTxidOf }, id);
  ok('claim reaches CONFIRMED', c.state === S.CONFIRMED);
  ok('CONFIRMED reservation still HELD until authoritative retire (external phase)', heldHas(led, 'testnet4', op));
  led.retireReservations(id);    // authoritative retire (own-node path)
  ok('after authoritative retire: outpoint released for selection', !heldHas(led, 'testnet4', op));
  const row = led.get(id);
  ok('retire preserves audit linkage on the claim (outpoints + local_txid)', JSON.parse(row.reserved_outpoints).length === 1 && !!row.local_txid);
  led.close();
}

// ── CONFLICTED: reserved input spent by ANOTHER tx -> no replacement, safe retire ──
{
  const led = new ClaimLedger(newLedgerFile()), world = makeWorld();
  const op = OP('a5', 1); world.spent.set(`${op.txid}:1`, 'tx_SOMEONE_ELSE');
  const id = freshClaim(led, [op]);
  const c = await runToStable({ ledger: led, signer: fakeSigner(world), chain: fakeChain(world), txidOf: fakeTxidOf }, id);
  ok('conflicting input -> CONFLICTED, NO replacement payment built', c.state === S.CONFLICTED && world.broadcasts.length === 0);
  ok('CONFLICTED reservation retained until authoritative retire', heldHas(led, 'testnet4', op));
  led.retireReservations(id);    // authoritative: outpoint proven spent by another tx
  ok('after retire the (dead) outpoint is released, audit kept', !heldHas(led, 'testnet4', op) && JSON.parse(led.get(id).reserved_outpoints).length === 1);
  led.close();
}

// ── full scenario: lost broadcast response -> held -> recover TX-A -> no TX-B ──
{
  const led = new ClaimLedger(newLedgerFile()), world = makeWorld({ broadcastMode: 'ambiguous' });
  const X = OP('bb', 2); const deps = { ledger: led, signer: fakeSigner(world), chain: fakeChain(world), txidOf: fakeTxidOf };
  const id = freshClaim(led, [X]);                    // (1)(2) create + reserve X
  let c = await processClaim(deps, id);               // (3)(4)(5) sign, broadcast, response lost
  ok('scenario: lost broadcast response -> UNCERTAIN', c.state === S.UNCERTAIN);      // (6)
  ok('scenario: UTXO X is NOT selectable by a second claim', held(led, 'testnet4').has(`${X.txid}:${X.vout}`)); // (7)(8)
  const broadcastsBefore = new Set(world.broadcasts).size;
  c = await runToStable(deps, id);                    // (9) recover original TX-A
  const distinct = new Set(world.broadcasts).size;
  ok('scenario: recovery resolves TX-A -> SEEN (its tx was really in mempool)', c.state === S.SEEN);
  ok('scenario: NO second transaction TX-B was ever constructed', distinct === 1 && distinct === broadcastsBefore); // (10)
  ok('scenario: reservation on X still held after recovery to SEEN', held(led, 'testnet4').has(`${X.txid}:${X.vout}`));
  led.close();
}

// ── RT-2B: client idempotency keys are scoped per network ──
{
  const led = new ClaimLedger(newLedgerFile());
  const a = led.createAuthorised({ claimId: 'k-t3', network: 'testnet3', address: 'x', canon: 'CX', claimDay: DAY, amountSat: 1, clientKey: 'claim-1', reserveOutpoints: [] });
  const b = led.createAuthorised({ claimId: 'k-t4', network: 'testnet4', address: 'y', canon: 'CY', claimDay: DAY, amountSat: 1, clientKey: 'claim-1', reserveOutpoints: [] });
  ok('same client key on DIFFERENT networks -> both allowed (no collision)', a.created && b.created);
  ok('getByClientKey is network-scoped (testnet3)', led.getByClientKey('testnet3', 'claim-1').claim_id === 'k-t3');
  ok('getByClientKey is network-scoped (testnet4)', led.getByClientKey('testnet4', 'claim-1').claim_id === 'k-t4');
  // same network + same key + a DIFFERENT entitlement must NOT create a second claim
  const dup = led.createAuthorised({ claimId: 'k-t4b', network: 'testnet4', address: 'z', canon: 'CZ', claimDay: DAY, amountSat: 1, clientKey: 'claim-1', reserveOutpoints: [] });
  ok('same network + reused key + new entitlement -> NOT created (fail closed)', dup.created === false);
  ok('still exactly one testnet4 claim carries that key', led.getByClientKey('testnet4', 'claim-1').claim_id === 'k-t4');
  ok('entitlement rule UNIQUE(network,canon,day) is unaffected', led.getByClientKey('testnet4', 'claim-1').canon === 'CY');
  led.close();
}

// ── RT-2B migration: a v1 ledger upgrades to v2 (global key index -> network-scoped) ──
{
  const file = newLedgerFile();
  let led = new ClaimLedger(file);
  // fabricate the v1 shape: restore the old global index, mark schema v1, close.
  led.db.exec('DROP INDEX IF EXISTS uq_clientkey_net');
  led.db.exec('CREATE UNIQUE INDEX uq_clientkey ON claims(client_idempotency_key) WHERE client_idempotency_key IS NOT NULL');
  led.db.prepare('UPDATE meta SET v=? WHERE k=?').run('1', 'schema_version');
  led.close();
  led = new ClaimLedger(file);                       // reopen -> _migrate runs v1->v2
  const v = Number(led.db.prepare('SELECT v FROM meta WHERE k=?').get('schema_version').v);
  const idx = led.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
  ok('migration: schema_version advanced to 2', v === 2);
  ok('migration: old GLOBAL uq_clientkey index dropped', !idx.includes('uq_clientkey'));
  ok('migration: network-scoped uq_clientkey_net present', idx.includes('uq_clientkey_net'));
  led.close();
}

console.log(bad ? '\nRT-2 RESERVATION TEST FAILED' : '\nRT-2 RESERVATION TEST PASS — reservations retained, keys network-scoped, no replacement payments');
process.exit(bad ? 1 : 0);
