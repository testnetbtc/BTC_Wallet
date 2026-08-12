// Fee safety: a network fee estimate is UNTRUSTED input. Malicious/broken
// Esplora responses must never set an absurd fee, and the engine must refuse to
// BUILD a transaction with an unsafe rate regardless of where it came from.
import { getFeeRate, MAX_ESTIMATED_FEERATE } from '../src/esplora.js';
import { buildSignedTx, buildSweepTx, assertFeeRate, MAX_FEERATE } from '../src/tx.js';
import { deriveKey } from '../src/wallet.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(58), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

// ---- getFeeRate under attack: mock fetch per-case --------------------------
const realFetch = globalThis.fetch;
const mockFees = (body, status = 200) => {
  globalThis.fetch = async () => ({ ok: status === 200, status, text: async () => body });
};
const CASES = [
  ['zero',        JSON.stringify({ 6: 0 }),            (v) => v >= 1],
  ['negative',    JSON.stringify({ 6: -1 }),           (v) => v >= 1],
  ['NaN string',  JSON.stringify({ 6: 'abc' }),        (v) => v === 2],
  ['null',        JSON.stringify({ 6: null }),         (v) => Number.isFinite(v) && v >= 1],
  ['huge 1e6',    JSON.stringify({ 6: 1000000 }),      (v) => v === MAX_ESTIMATED_FEERATE],
  ['1000',        JSON.stringify({ 6: 1000 }),         (v) => v === 1000],
  ['100',         JSON.stringify({ 6: 100 }),          (v) => v === 100],
  ['normal 3.2',  JSON.stringify({ 6: 3.2 }),          (v) => v === 4],
  ['missing key', JSON.stringify({}),                  (v) => v === 2],
  ['malformed',   '<html>gateway error</html>',        (v) => v === 2],
  ['HTTP 500',    'oops',                              (v) => v === 2, 500],
];
for (const [name, body, check, status] of CASES) {
  mockFees(body, status ?? 200);
  const v = await getFeeRate('testnet4');
  ok(`estimator survives ${name} -> ${v} sat/vB`, Number.isFinite(v) && v >= 1 && v <= MAX_ESTIMATED_FEERATE && check(v));
}
globalThis.fetch = realFetch;

// ---- assertFeeRate: the engine's hard boundary -----------------------------
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
ok('assertFeeRate accepts 1',        assertFeeRate(1) === 1);
ok('assertFeeRate accepts 250.4 -> 251', assertFeeRate(250.4) === 251);
ok(`assertFeeRate accepts the cap (${MAX_FEERATE})`, assertFeeRate(MAX_FEERATE) === MAX_FEERATE);
ok('assertFeeRate rejects 0',        throws(() => assertFeeRate(0)));
ok('assertFeeRate rejects -1',       throws(() => assertFeeRate(-1)));
ok('assertFeeRate rejects NaN',      throws(() => assertFeeRate(NaN)));
ok('assertFeeRate rejects Infinity', throws(() => assertFeeRate(Infinity)));
ok('assertFeeRate rejects "undefined" string', throws(() => assertFeeRate('undefined')));
ok(`assertFeeRate rejects ${MAX_FEERATE + 1}`, throws(() => assertFeeRate(MAX_FEERATE + 1)));

// ---- the guard is actually wired into the builders -------------------------
const MN = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';
const key = deriveKey(MN, '', 'testnet4', 0);
const utxos = [{ txid: 'ab'.repeat(32), vout: 0, value: 100000 }];
const dest = key.address;
ok('buildSignedTx refuses NaN feeRate',
  throws(() => buildSignedTx({ utxos, key, recipients: [{ address: dest, amount: 10000 }], feeRate: NaN, networkName: 'testnet4' })));
ok('buildSignedTx refuses 1e6 sat/vB',
  throws(() => buildSignedTx({ utxos, key, recipients: [{ address: dest, amount: 10000 }], feeRate: 1000000, networkName: 'testnet4' })));
ok('buildSweepTx refuses Infinity feeRate',
  throws(() => buildSweepTx({ utxos, key, toAddress: dest, feeRate: Infinity, networkName: 'testnet4' })));
ok('buildSignedTx still works at a sane rate',
  !throws(() => buildSignedTx({ utxos, key, recipients: [{ address: dest, amount: 10000 }], feeRate: 2, networkName: 'testnet4' })));

console.log(bad ? '\nFEE TEST FAILED' : '\nFEE TEST PASS — malicious fee input cannot reach a signed transaction');
process.exit(bad ? 1 : 0);
