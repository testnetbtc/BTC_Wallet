// Regression tests for the Kimi-K3 independent-audit findings (2026-08-16).
// One file, one assertion per fix, so a re-audit can watch these stay green.
//   M1  honest fee when dust change is absorbed          (tx.js)
//   M4  committed raw_tx/local_txid is immutable         (ledger.transition)
//   L5  advisory reconcile capped at SEEN/UNCERTAIN      (claimflow.processClaim)
//   L6  malformed breaker latch fails CLOSED             (breaker._load)
//   L8  P2PK / recipient amount validation               (tx.assertRecipientAmount, p2pk_fund)
//   L11 vault blob structural pre-KDF validation          (vault.openSeed)
import { buildSignedTx, assertRecipientAmount } from '../src/tx.js';
import { buildFundP2PK } from '../src/p2pk_fund.js';
import { decodeRawTx } from '../src/send.js';
import { deriveKey } from '../src/wallet.js';
import { sealSeed, openSeed } from '../src/vault.js';
import { ClaimLedger, S, claimDayUTC } from '../faucet/ledger.mjs';
import { processClaim } from '../faucet/claimflow.mjs';
import { VelocityBreaker } from '../faucet/breaker.mjs';
import { base64 } from '@scure/base';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(70), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const tmp = (p) => join(mkdtempSync(join(tmpdir(), 'kimi-')), p);

// ── M1 — dust change absorbed into fee is reported HONESTLY (Σin − Σout), not understated ──
{
  const key = deriveKey(MN, '', 'testnet4', 0, 0);
  // 1 input of 10 000; send 9 700; the ~159-sat change is below dust (546) so btc-signer drops
  // it and folds it into the fee. The true fee is 10 000 − 9 700 = 300, NOT the ~110 a 1-output
  // tx would "cost". A single output confirms the change was absorbed.
  const built = buildSignedTx({
    utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 10000 }], key,
    recipients: [{ address: key.address, amount: 9700 }], feeRate: 1,
    changeAddress: key.address, networkName: 'testnet4',
  });
  const dec = decodeRawTx({ hex: built.txHex, network: 'testnet4' });
  ok('M1: dust change absorbed -> exactly one output', dec.outputs.length === 1);
  ok('M1: reported fee == Σinputs − Σoutputs (honest, not understated)', built.fee === 300);
}

// ── L8 — recipient / P2PK amount validation ──
{
  ok('L8: assertRecipientAmount rejects 0 / negative / dust / float / string',
     throws(() => assertRecipientAmount(0)) && throws(() => assertRecipientAmount(-5)) &&
     throws(() => assertRecipientAmount(500)) && throws(() => assertRecipientAmount(1.5)) &&
     throws(() => assertRecipientAmount('600')));
  ok('L8: assertRecipientAmount accepts a clean integer >= dust', assertRecipientAmount(546) === 546n && assertRecipientAmount(100000) === 100000n);
  ok('L8: buildFundP2PK refuses a 0-sat P2PK output',
     throws(() => buildFundP2PK({ utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 10000 }], privKey: new Uint8Array(32), pubkey: new Uint8Array(33), targetScript: new Uint8Array(35), changeScript: new Uint8Array(22), amount: 0 })));
}

// ── L11 — vault blob structural validation BEFORE any KDF work ──
{
  const blob = sealSeed(MN, 'pin-123456');
  ok('L11: a well-formed vault still opens', openSeed(blob, 'pin-123456') === MN);
  const inflate = (mut) => { const b = JSON.parse(blob); mut(b); return JSON.stringify(b); };
  // an attacker-inflated 16 MB salt must be rejected in O(1), NOT fed into scrypt (a multi-second DoS)
  const bigSalt = inflate((b) => { b.salt = base64.encode(new Uint8Array(16 * 1024 * 1024)); });
  const t0 = Date.now();
  const rejFast = throws(() => openSeed(bigSalt, 'pin-123456'));
  const dtMs = Date.now() - t0;
  ok('L11: inflated 16 MB salt rejected (structural)', rejFast);
  ok('L11: ...and rejected FAST (no KDF on a hostile blob, < 250 ms)', dtMs < 250);
  ok('L11: wrong nonce length rejected', throws(() => openSeed(inflate((b) => { b.nonce = base64.encode(new Uint8Array(8)); }), 'pin-123456')));
}

// ── L6 — a malformed breaker latch FAILS CLOSED (never fail-open, never crash) ──
for (const [label, content] of [['bare null', 'null'], ['empty array', '[]'], ['wrong shape', '{"foo":1}'], ['garbage', 'not json']]) {
  const f = tmp('latch.json'); writeFileSync(f, content);
  let tripped = null;
  try { tripped = new VelocityBreaker({ stateFile: f, persist: true }).tripped; } catch { tripped = 'threw'; }
  ok(`L6: malformed latch (${label}) -> starts TRIPPED (fail-closed, no crash)`, tripped === true);
}
{
  const f = tmp('latch2.json'); writeFileSync(f, JSON.stringify({ tripped: false }));
  ok('L6: a well-formed untripped latch is honoured', new VelocityBreaker({ stateFile: f, persist: true }).tripped === false);
}

// ── M4 — a committed raw_tx / local_txid can never be overwritten by a racing re-sign ──
// ── L5 — an ADVISORY (non-authoritative) chain can only reach SEEN, never a terminal state ──
{
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); };
  const signer = (w) => async ({ address, amountSat, reservedOutpoints }) => { w.n++; const txid = 'tx_' + hash(address + amountSat + w.n); return { rawTx: 'raw:' + txid, localTxid: txid, feeSat: 300, inputs: reservedOutpoints }; };
  const txidOf = (r) => (r.startsWith('raw:') ? r.slice(4) : 'x');
  const chain = (w, authoritative) => ({
    authoritative,
    async lookup(n, txid) { if (w.confirmed.has(txid)) return { found: true, confirmed: true, height: 9, blockHash: 'b' }; if (w.mempool.has(txid)) return { found: true, confirmed: false }; return { found: false }; },
    async outspend() { return { spent: false, txid: null }; },
    async broadcast(n, raw) { const t = raw.slice(4); w.mempool.add(t); if (w.autoConfirm) w.confirmed.add(t); return t; },
  });
  const DAY = claimDayUTC(Date.UTC(2026, 7, 16, 12));
  const newLedger = () => new ClaimLedger(tmp('c.db'));
  const authorise = (led, i) => led.createAuthorised({ claimId: 'c' + i, network: 'testnet4', address: 'tb1q' + i, canon: 'k' + i, claimDay: DAY, amountSat: 100000, reserveOutpoints: [{ txid: 'aa'.repeat(32), vout: i, value: 110000 }] }).claim.claim_id;

  // M4 — take a claim to SIGNED, then attempt a same-state transition with DIFFERENT bytes.
  {
    const led = newLedger(); const id = authorise(led, 1);
    led.markSigned(id, { rawTx: 'raw:txA', localTxid: 'txA', feeSat: 300, reservedOutpoints: [] });
    ok('M4: same bytes re-applied is idempotent (no throw)', (() => { try { led.transition(id, S.SIGNED, { raw_tx: 'raw:txA', local_txid: 'txA' }); return true; } catch { return false; } })());
    ok('M4: overwriting committed raw_tx with different bytes is REFUSED', throws(() => led.transition(id, S.SIGNED, { raw_tx: 'raw:txB', local_txid: 'txB' })));
    ok('M4: the original committed tx survives the attempted overwrite', led.get(id).raw_tx === 'raw:txA' && led.get(id).local_txid === 'txA');
    led.close();
  }

  // L5 — advisory chain reports the tx confirmed, but the claim must NOT go terminal CONFIRMED.
  {
    const led = newLedger(); const w = { n: 0, mempool: new Set(), confirmed: new Set(), autoConfirm: true };
    const deps = { ledger: led, signer: signer(w), chain: chain(w, false), txidOf };
    const id = authorise(led, 2);
    for (let i = 0; i < 6; i++) { const c = await processClaim(deps, id); if (!c || [S.CONFIRMED, S.CONFLICTED, S.FAILED_SAFE].includes(c.state)) break; }
    ok('L5: advisory (non-authoritative) chain caps the claim at SEEN — never CONFIRMED', led.get(id).state === S.SEEN);
    led.close();
  }
  // …but an AUTHORITATIVE source drives the very same flow to CONFIRMED.
  {
    const led = newLedger(); const w = { n: 0, mempool: new Set(), confirmed: new Set(), autoConfirm: true };
    const deps = { ledger: led, signer: signer(w), chain: chain(w, true), txidOf };
    const id = authorise(led, 3);
    for (let i = 0; i < 6; i++) { const c = await processClaim(deps, id); if (!c || [S.CONFIRMED, S.CONFLICTED, S.FAILED_SAFE].includes(c.state)) break; }
    ok('L5: an authoritative own-node source reaches CONFIRMED', led.get(id).state === S.CONFIRMED);
    led.close();
  }
}

console.log(bad ? '\nAUDIT-KIMI TEST FAILED' : '\nAUDIT-KIMI TEST PASS — M1/M4/L5/L6/L8/L11 fixes verified');
process.exit(bad ? 1 : 0);
