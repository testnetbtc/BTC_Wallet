// RT-10 — reorg-aware notification tests (ChainTracker + scanAddressesOnce).
//
// A scriptable fake chain drives linear growth AND reorgs. We assert: confirmation-depth
// gating (0/1/2/>2), linear progression, single- and multi-block reorgs, replacement-branch
// rescan, deterministic idempotency (same tx reappearing -> no duplicate), an orphaned tx that
// vanishes -> explicit reorg-out, and restart across a reorg (fresh tracker, same store).
//
// Depth model (minConf=2): a tx in block h is eligible once tip >= h+1 (i.e. h <= tip-1).
// Blocks are recorded (for reorg detection) only when actually scanned, so reorg tests grow
// the chain one block per pass first, then reorg a RECORDED block.
import { ChainTracker, memoryStore } from '../notify/chaintracker.mjs';
import { scanAddressesOnce } from '../notify/addrwatch.mjs';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(72), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

function makeChain() {
  const chain = [];
  return {
    chain,
    tip: () => chain.length - 1,
    getBlockHash: async (h) => { if (!chain[h]) throw new Error('no block ' + h); return chain[h].hash; },
    scanBlock: async (h, watched) => {
      const b = chain[h];
      const hits = (b.txs || []).filter((t) => watched.has(t.address)).map((t) => ({ address: t.address, txid: t.txid, direction: t.direction }));
      return { hash: b.hash, hits };
    },
    push: (hash, txs = []) => chain.push({ hash, txs }) - 1,
    reorg: (fromHeight, blocks) => { chain.length = fromHeight; for (const b of blocks) chain.push({ hash: b.hash, txs: b.txs || [] }); },
  };
}
function makeNotified() {
  const m = new Map();
  const k = (s, t, d) => `${s}|${t}|${d}`;
  return {
    has: (s, t, d) => m.has(k(s, t, d)),
    add: (s, t, d, h) => m.set(k(s, t, d), { subId: s, txid: t, dir: d, height: h }),
    remove: (s, t, d) => m.delete(k(s, t, d)),
    byHeights: (hs) => [...m.values()].filter((v) => hs.includes(v.height)),
  };
}
const ADDR = 'tb1qwatched';
const IN = (txid) => ({ txid, address: ADDR, direction: 'in' });
const idxFor = (a) => (a === ADDR ? [{ id: 1, chat_id: 99, params: JSON.stringify({ address: ADDR, network: 'testnet4' }) }] : []);
function harness(minConf = 2, store = memoryStore(), notified = makeNotified(), chain = makeChain()) {
  const tracker = new ChainTracker(store, { minConf });
  const fired = [], reorgOut = [];
  const pass = (tr = tracker) => scanAddressesOnce({
    tip: chain.tip(), getBlockHash: chain.getBlockHash, scanBlock: chain.scanBlock,
    tracker: tr, notified, watched: new Set([ADDR]), idxFor,
    emit: (s, hit, h) => fired.push({ txid: hit.txid, h }), emitReorgOut: (o) => reorgOut.push(o),
  });
  return { chain, tracker, store, notified, fired, reorgOut, pass };
}
const txids = (arr) => arr.map((f) => f.txid).join(',');

// ── confirmation-depth gating ──
{
  const H = harness(2);
  H.chain.push('g0'); await H.pass();
  H.chain.push('b1', [IN('tx1')]); await H.pass();
  ok('0/1-conf: tx at the tip is NOT notified yet (needs depth 2)', H.fired.length === 0);
  H.chain.push('b2'); await H.pass();
  ok('2-conf: tx notified once it is 2 deep', H.fired.length === 1 && H.fired[0].txid === 'tx1');
  H.chain.push('b3'); await H.pass();
  ok('>2-conf: no duplicate notification', H.fired.length === 1);
}

// ── linear progression: each qualifying block notified exactly once ──
{
  const H = harness(2);
  H.chain.push('g0'); await H.pass();
  H.chain.push('b1', [IN('a')]); await H.pass();
  H.chain.push('b2', [IN('b')]); await H.pass();
  ok('linear: a notified when 2-deep', txids(H.fired) === 'a');
  H.chain.push('b3', [IN('c')]); await H.pass();
  ok('linear: b notified next', txids(H.fired) === 'a,b');
  H.chain.push('b4'); await H.pass();
  ok('linear: c notified next, still no duplicates', txids(H.fired) === 'a,b,c');
}

// ── single-block reorg BEFORE the tx ever reached notify depth: no stale alert ──
{
  const H = harness(2);
  H.chain.push('g0'); await H.pass();
  H.chain.push('b1', [IN('orphan')]); await H.pass();     // orphan is at the tip (0 conf) -> not scanned
  ok('reorg-before-notify: nothing fired yet', H.fired.length === 0);
  H.chain.reorg(1, [{ hash: 'b1b' }, { hash: 'b2b' }]);    // replace height1 with a tx-less branch
  await H.pass();
  ok('reorg-before-notify: orphaned tx NEVER produced an alert', H.fired.length === 0 && H.reorgOut.length === 0);
}

// ── reorg AFTER notification, tx does NOT reappear -> explicit reorg-out ──
{
  const H = harness(2);
  H.chain.push('g0'); await H.pass();
  H.chain.push('b1', [IN('gone')]); await H.pass();
  H.chain.push('b2'); await H.pass();                     // gone is 2-deep -> notified (scanned h1)
  ok('setup: tx notified at depth 2', H.fired.length === 1 && H.fired[0].txid === 'gone');
  H.chain.reorg(1, [{ hash: 'x1' }, { hash: 'x2' }, { hash: 'x3' }]);   // branch without gone
  await H.pass();
  ok('reorg-out: orphaned + vanished tx yields exactly one explicit notice', H.reorgOut.length === 1 && H.reorgOut[0].txid === 'gone');
  await H.pass();
  ok('reorg-out: not repeated on the next pass', H.reorgOut.length === 1);
}

// ── reorg where the SAME tx reappears on the new branch -> NO duplicate, NO reorg-out ──
{
  const H = harness(2);
  H.chain.push('g0'); await H.pass();
  H.chain.push('b1', [IN('moved')]); await H.pass();
  H.chain.push('b2'); await H.pass();                     // moved notified from height1
  ok('setup: notified once', H.fired.length === 1);
  H.chain.reorg(1, [{ hash: 'y1' }, { hash: 'y2', txs: [IN('moved')] }, { hash: 'y3' }]);  // moved reappears at height2
  await H.pass();
  ok('reappear: same tx on the new branch does NOT double-notify', H.fired.length === 1);
  ok('reappear: no false reorg-out (it reappeared)', H.reorgOut.length === 0);
}

// ── multi-block reorg: rolled back to the correct fork, replacement branch rescanned ──
{
  const H = harness(2);
  H.chain.push('g0'); await H.pass();
  H.chain.push('c1'); await H.pass();
  H.chain.push('c2'); await H.pass();
  H.chain.push('c3'); await H.pass();                     // recorded h0..h2, lastScanned=2
  H.chain.reorg(2, [{ hash: 'd2', txs: [IN('onnew')] }, { hash: 'd3' }, { hash: 'd4' }]);  // fork at height1
  await H.pass();
  ok('multi-reorg: tx on the replacement branch is picked up', H.fired.some((f) => f.txid === 'onnew'));
  ok('multi-reorg: tracker rolled back + rescanned to safe tip', H.tracker.lastScanned === H.chain.tip() - 1);
}

// ── restart across a reorg: a FRESH tracker over the same persisted store still converges ──
{
  const store = memoryStore(), notified = makeNotified(), chain = makeChain();
  const H = harness(2, store, notified, chain);
  chain.push('g0'); await H.pass();
  chain.push('e1'); await H.pass();
  chain.push('e2'); await H.pass();                       // recorded h0,h1; lastScanned=1
  chain.reorg(2, [{ hash: 'f2', txs: [IN('z')] }, { hash: 'f3' }, { hash: 'f4' }]);   // reorg above the recorded window's edge
  const t2 = new ChainTracker(store, { minConf: 2 });     // "restart": new tracker reads lastScanned from the store
  await H.pass(t2);
  ok('restart: fresh tracker over persisted store handles the reorg and notifies z', H.fired.some((f) => f.txid === 'z'));
}

console.log(bad ? '\nRT-10 REORG TEST FAILED' : '\nRT-10 REORG TEST PASS — depth-gated, reorg-aware, deterministic, no stale/duplicate alerts');
process.exit(bad ? 1 : 0);
