// RT-2 crash-injection acceptance test (§18/§19/§39).
//
// For every meaningful crash boundary: run the payout engine, abort mid-flow, then
// "restart" (a fresh recovery pass over the same durable ledger) and prove the final
// result is EITHER exactly one payout of the authorised claim OR an explicit
// fail-closed unresolved state — NEVER two independent payments.
//
// The signer is DETERMINISTIC (same inputs -> same txid), mirroring real RFC-6979
// signing, so re-signing after a pre-persist crash yields the identical transaction.
import { ClaimLedger, S, claimDayUTC } from '../faucet/ledger.mjs';
import { processClaim, reconcileState, CrashInjected } from '../faucet/claimflow.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(66), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); };

// deterministic fake signer: txid is a function of (address, amount, inputs)
const fakeSigner = (world, opts = {}) => async ({ network, address, amountSat, reservedOutpoints }) => {
  world.signCalls++;
  const txid = 'tx_' + hash(address + ':' + amountSat + ':' + reservedOutpoints.map((o) => o.txid + ':' + o.vout).sort().join(','));
  const rawTx = 'raw:' + txid;
  return { rawTx, localTxid: opts.badTxid ? 'tx_LIES' : txid, feeSat: 300, inputs: reservedOutpoints.map((o) => ({ txid: o.txid, vout: o.vout })) };
};
const fakeTxidOf = (raw) => (typeof raw === 'string' && raw.startsWith('raw:') ? raw.slice(4) : 'tx_BADBYTES');

// controllable fake chain
function makeWorld(over = {}) {
  return { signCalls: 0, broadcasts: [], mempool: new Set(), confirmed: new Set(), spent: new Map(), broadcastMode: 'ok', autoConfirm: false, lookupThrows: false, ...over };
}
const fakeChain = (world) => ({
  authoritative: true,   // L5 — this fake stands in for the AUTHORITATIVE own-node source, so terminal CONFIRMED/CONFLICTED transitions are allowed
  async lookup(network, txid) {
    if (world.lookupThrows) throw new Error('node unavailable');
    if (world.confirmed.has(txid)) return { found: true, confirmed: true, height: 100, blockHash: 'bh' };
    if (world.mempool.has(txid)) return { found: true, confirmed: false };
    return { found: false };
  },
  async outspend(network, txid, vout) { const by = world.spent.get(txid + ':' + vout); return { spent: !!by, txid: by || null }; },
  async broadcast(network, rawTx) {
    const txid = rawTx.slice(4);
    world.broadcasts.push(txid);
    if (world.broadcastMode === 'reject') throw new Error('rejected: bad-txns-inputs-missingorspent');
    if (world.broadcastMode === 'already') { world.mempool.add(txid); throw new Error('txn-already-in-mempool'); }
    if (world.broadcastMode === 'ambiguous') { world.mempool.add(txid); throw new Error('timed out waiting for RPC response'); }
    world.mempool.add(txid); if (world.autoConfirm) world.confirmed.add(txid);
    return txid;
  },
});

const DAY = claimDayUTC(Date.UTC(2026, 7, 13, 12));
let seq = 0;
function freshClaim(led, resv = [{ txid: 'aa'.repeat(32), vout: 0, value: 110000 }]) {
  const id = 'c' + (++seq);
  const r = led.createAuthorised({ claimId: id, network: 'testnet4', address: 'tb1qdest', canon: 'canon' + seq, claimDay: DAY, amountSat: 100000, reserveOutpoints: resv });
  return r.claim.claim_id;
}
async function runToStable(deps, id, passes = 8) {
  let prev = null;
  for (let i = 0; i < passes; i++) {
    const c = await processClaim(deps, id);
    if (!c) break;
    if (c.state === prev) break; prev = c.state;
    if ([S.CONFIRMED, S.CONFLICTED, S.FAILED_SAFE].includes(c.state)) break;
  }
  return deps.ledger.get(id);
}
const distinctBroadcasts = (world) => new Set(world.broadcasts).size;
const newLedger = () => new ClaimLedger(join(mkdtempSync(join(tmpdir(), 'rt2-crash-')), 'c.db'));

// ── happy path ──
{
  const led = newLedger(), world = makeWorld({ autoConfirm: true });
  const deps = { ledger: led, signer: fakeSigner(world), chain: fakeChain(world), txidOf: fakeTxidOf };
  const id = freshClaim(led);
  const c = await runToStable(deps, id);
  ok('happy path -> CONFIRMED, exactly one broadcast', c.state === S.CONFIRMED && distinctBroadcasts(world) === 1);
  led.close();
}

// ── crash matrix: abort at each stage, restart, assert exactly-once ──
const STAGES = ['after-sign-before-persist', 'after-signed-persist', 'after-broadcasting-persist-before-send', 'after-broadcast-before-verify'];
for (const stage of STAGES) {
  const led = newLedger(), world = makeWorld({ autoConfirm: false });
  const chain = fakeChain(world), signer = fakeSigner(world);
  const id = freshClaim(led);
  // first pass CRASHES at `stage`
  let crashed = false;
  try { await processClaim({ ledger: led, signer, chain, txidOf: fakeTxidOf, crashAfter: (s) => { if (s === stage) throw new CrashInjected(s); } }, id); }
  catch (e) { crashed = e instanceof CrashInjected; }
  // RESTART: recovery pass, no crash hook
  const c = await runToStable({ ledger: led, signer, chain, txidOf: fakeTxidOf }, id);
  const oneTx = distinctBroadcasts(world) <= 1;
  const safe = [S.SEEN, S.CONFIRMED, S.UNCERTAIN].includes(c.state);   // never double-paid, resolvable
  ok(`crash@${stage}: crashed=${crashed} -> recovered ${c.state}, distinctTx=${distinctBroadcasts(world)}`, crashed && oneTx && safe);
  led.close();
}

// ── ambiguous broadcast (node accepted but the call threw) -> UNCERTAIN -> recovery SEEN ──
{
  const led = newLedger(), world = makeWorld({ broadcastMode: 'ambiguous' });
  const chain = fakeChain(world), signer = fakeSigner(world);
  const id = freshClaim(led);
  const deps = { ledger: led, signer, chain, txidOf: fakeTxidOf };
  let c = await processClaim(deps, id);          // ONE pass: sign -> broadcast throws -> UNCERTAIN
  ok('ambiguous broadcast -> UNCERTAIN (not optimistic success)', c.state === S.UNCERTAIN);
  // the tx is actually in mempool; recovery reconciles -> SEEN, still ONE tx
  c = await runToStable(deps, id);
  ok('recovery reconciles ambiguous -> SEEN, still exactly one broadcast tx', c.state === S.SEEN && distinctBroadcasts(world) === 1);
  led.close();
}

// ── already-in-mempool result is idempotent -> SEEN ──
{
  const led = newLedger(), world = makeWorld({ broadcastMode: 'already' });
  const deps = { ledger: led, signer: fakeSigner(world), chain: fakeChain(world), txidOf: fakeTxidOf };
  const id = freshClaim(led);
  const c = await runToStable(deps, id);
  ok('already-in-mempool -> SEEN (idempotent), one tx', c.state === S.SEEN && distinctBroadcasts(world) === 1);
  led.close();
}

// ── conflicting input (reserved coin spent by ANOTHER tx) -> CONFLICTED, no replacement ──
{
  const led = newLedger(), world = makeWorld();
  const resv = [{ txid: 'bb'.repeat(32), vout: 1, value: 110000 }];
  world.spent.set('bb'.repeat(32) + ':1', 'tx_SOMEONE_ELSE');   // input consumed by a conflicting tx
  const deps = { ledger: led, signer: fakeSigner(world), chain: fakeChain(world), txidOf: fakeTxidOf };
  const id = freshClaim(led, resv);
  // sign (AUTHORISED->SIGNED), then reconcile-before-broadcast detects the spent input.
  const c = await runToStable(deps, id);
  ok('conflicting input -> CONFLICTED, NO tx broadcast, NO replacement built', c.state === S.CONFLICTED && world.broadcasts.length === 0);
  led.close();
}

// ── signer/txid mismatch -> FAILED_SAFE (I4/I5) ──
{
  const led = newLedger(), world = makeWorld();
  const deps = { ledger: led, signer: fakeSigner(world, { badTxid: true }), chain: fakeChain(world), txidOf: fakeTxidOf };
  const id = freshClaim(led);
  const c = await runToStable(deps, id);
  ok('signer txid != bytes txid -> FAILED_SAFE, never broadcast', c.state === S.FAILED_SAFE && world.broadcasts.length === 0);
  led.close();
}

// ── reconciliation source unavailable -> UNCERTAIN (never optimistic) ──
{
  const led = newLedger(), world = makeWorld({ lookupThrows: true });
  const deps = { ledger: led, signer: fakeSigner(world), chain: fakeChain(world), txidOf: fakeTxidOf };
  const id = freshClaim(led);
  // sign -> broadcast (ok) -> post-reconcile lookup throws -> UNCERTAIN
  const c = await runToStable(deps, id);
  ok('reconcile source down after broadcast -> UNCERTAIN', c.state === S.UNCERTAIN);
  led.close();
}

// ── I2: two workers race the same entitlement -> exactly one claim, one broadcast ──
{
  const led = newLedger(), world = makeWorld({ autoConfirm: true });
  const deps = { ledger: led, signer: fakeSigner(world), chain: fakeChain(world), txidOf: fakeTxidOf };
  const attempts = Array.from({ length: 10 }, (_, i) => led.createAuthorised({ claimId: 'race' + i, network: 'testnet4', address: 'tb1qsame', canon: 'SAMECANON', claimDay: DAY, amountSat: 100000, reserveOutpoints: [] }));
  const created = attempts.filter((a) => a.created).length;
  const uniqueClaimIds = new Set(attempts.map((a) => a.claim && a.claim.claim_id)).size;
  ok('I2: 10 concurrent same-entitlement -> exactly ONE claim created', created === 1 && uniqueClaimIds === 1);
  led.close();
}

console.log(bad ? '\nRT-2 CRASH TEST FAILED' : '\nRT-2 CRASH TEST PASS — exactly-once across every crash boundary');
process.exit(bad ? 1 : 0);
