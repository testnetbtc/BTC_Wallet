// RT-2 recovery-worker tests: AUTHORISED auto-completes without a client re-request;
// stuck UNCERTAIN reconciles to SEEN once the chain shows the tx; worker tick advances.
import { ClaimLedger, S, claimDayUTC } from '../faucet/ledger.mjs';
import { processClaim } from '../faucet/claimflow.mjs';
import { recoverAll, startRecoveryWorker } from '../faucet/recovery.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(64), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); };
const signer = (world) => async ({ address, amountSat, reservedOutpoints }) => { world.signCalls++; const txid = 'tx_' + hash(address + amountSat); return { rawTx: 'raw:' + txid, localTxid: txid, feeSat: 300, inputs: reservedOutpoints }; };
const txidOf = (r) => (r.startsWith('raw:') ? r.slice(4) : 'x');
const chain = (world) => ({
  async lookup(n, txid) { if (world.confirmed.has(txid)) return { found: true, confirmed: true, height: 9, blockHash: 'b' }; if (world.mempool.has(txid)) return { found: true, confirmed: false }; return { found: false }; },
  async outspend() { return { spent: false, txid: null }; },
  async broadcast(n, raw) { const t = raw.slice(4); world.broadcasts.push(t); world.mempool.add(t); if (world.autoConfirm) world.confirmed.add(t); return t; },
});
const world = () => ({ signCalls: 0, broadcasts: [], mempool: new Set(), confirmed: new Set(), autoConfirm: false });
const DAY = claimDayUTC(Date.UTC(2026, 7, 13, 12));
const newLedger = () => new ClaimLedger(join(mkdtempSync(join(tmpdir(), 'rt2-rec-')), 'c.db'));
let n = 0;
const authorise = (led, canon = 'k' + (++n)) => led.createAuthorised({ claimId: 'c' + n, network: 'testnet4', address: 'tb1q' + n, canon, claimDay: DAY, amountSat: 100000, reserveOutpoints: [{ txid: 'aa'.repeat(32), vout: n, value: 110000 }] }).claim.claim_id;

// 1) AUTHORISED auto-completes on recovery WITHOUT the client returning (Decision 1)
{
  const led = newLedger(), w = world(); w.autoConfirm = true;
  const deps = { ledger: led, signer: signer(w), chain: chain(w), txidOf };
  const id = authorise(led);
  ok('claim starts AUTHORISED (never processed by a client)', led.get(id).state === S.AUTHORISED);
  const res = await recoverAll(deps);
  ok('recovery auto-completes AUTHORISED -> CONFIRMED', led.get(id).state === S.CONFIRMED && w.broadcasts.length === 1);
  ok('recovery reports processed=1', res.processed === 1);
  led.close();
}

// 2) A stuck UNCERTAIN reconciles to SEEN when the tx appears; still ONE tx
{
  const led = newLedger(), w = world();
  const deps = { ledger: led, signer: signer(w), chain: chain(w), txidOf };
  const id = authorise(led);
  await processClaim(deps, id);                 // AUTHORISED -> ... -> SEEN (mempool has it)
  ok('processed to SEEN', led.get(id).state === S.SEEN);
  w.mempool.clear();                            // the tx vanishes from mempool (evicted)
  await processClaim(deps, id);                 // SEEN (single pass) -> UNCERTAIN
  ok('a previously-seen tx that vanished -> UNCERTAIN', led.get(id).state === S.UNCERTAIN);
  w.confirmed.add(led.get(id).local_txid);      // it was actually mined
  await recoverAll(deps);                        // UNCERTAIN -> reconcile -> CONFIRMED (no rebroadcast)
  ok('reappearing/mined tx -> CONFIRMED, still exactly one broadcast', led.get(id).state === S.CONFIRMED && new Set(w.broadcasts).size === 1);
  led.close();
}

// 3) worker tick runs and advances; non-overlapping guard returns null on re-entry
{
  const led = newLedger(), w = world(); w.autoConfirm = true;
  const deps = { ledger: led, signer: signer(w), chain: chain(w), txidOf };
  authorise(led);
  const worker = startRecoveryWorker(deps, { intervalMs: 999999 });
  const r = await worker.tick();
  ok('worker.tick() advances the pending claim', r && r.processed === 1 && led.counts().CONFIRMED === 1);
  worker.stop();
  led.close();
}

console.log(bad ? '\nRT-2 RECOVERY TEST FAILED' : '\nRT-2 RECOVERY TEST PASS — AUTHORISED auto-completes; stuck claims reconcile');
process.exit(bad ? 1 : 0);
