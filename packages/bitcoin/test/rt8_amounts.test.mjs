// RT-8 — recipient amount guards: real integer satoshis only, at/above the wallet output
// floor. No silent string coercion; no dust; enforced identically in BOTH recipient-paying
// builders (buildSignedTx and buildSignedTxMulti). Includes the reviewer's exact boundary set.
import { deriveKey } from '../src/wallet.js';
import { buildSignedTx, buildSignedTxMulti, assertRecipientAmount, MIN_OUTPUT_SAT } from '../src/tx.js';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(70), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const rejects = (fn) => { try { fn(); return false; } catch { return true; } };

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const key = deriveKey(MN, '', 'testnet3', 0);
const RECIPIENT = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const utxos = [{ txid: 'a'.repeat(64), vout: 1, value: 100_000 }];
const keyed = [{ ...utxos[0], key }];

// ── unit: the reviewer's exact boundary matrix on assertRecipientAmount ──
const MAX = Number.MAX_SAFE_INTEGER;
const cases = [
  [-1, false], [0, false], [1, false], [545, false], [546, true], [547, true],
  ['546', false], ['20000', false], [NaN, false], [Infinity, false], [-Infinity, false],
  [1.5, false], [MAX, true], [MAX + 1, false],
];
for (const [amt, shouldPass] of cases) {
  const passed = !rejects(() => assertRecipientAmount(amt));
  ok(`amount ${String(amt).padEnd(20)} -> ${shouldPass ? 'accept' : 'reject'}`, passed === shouldPass);
}
ok('accepted amount returns BigInt sats', assertRecipientAmount(546) === 546n && typeof assertRecipientAmount(1000) === 'bigint');
ok('MIN_OUTPUT_SAT is the 546 floor (documented as a wallet floor, not universal dust)', MIN_OUTPUT_SAT === 546n);

// ── both builders REJECT bad amounts (the amount is checked before funds are needed) ──
const bt = (amount) => buildSignedTx({ utxos, key, recipients: [{ address: RECIPIENT, amount }], feeRate: 5, networkName: 'testnet3' });
const btm = (amount) => buildSignedTxMulti({ keyedUtxos: keyed, recipients: [{ address: RECIPIENT, amount }], changeAddress: key.address, feeRate: 5, networkName: 'testnet3' });
for (const [label, amount] of [['string "20000"', '20000'], ['dust 1', 1], ['dust 545', 545], ['float 1.5', 1.5], ['NaN', NaN], ['Infinity', Infinity], ['zero', 0], ['negative', -5], ['unsafe int', MAX + 1]]) {
  ok(`buildSignedTx rejects ${label}`, rejects(() => bt(amount)));
  ok(`buildSignedTxMulti rejects ${label}`, rejects(() => btm(amount)));
}

// ── both builders ACCEPT a valid integer >= floor and actually build ──
{
  const r1 = buildSignedTx({ utxos, key, recipients: [{ address: RECIPIENT, amount: 546 }], feeRate: 5, networkName: 'testnet3' });
  ok('buildSignedTx builds a valid tx at exactly the 546 floor', !!r1.txid && r1.fee > 0);
  const r2 = buildSignedTxMulti({ keyedUtxos: keyed, recipients: [{ address: RECIPIENT, amount: 20_000 }], changeAddress: key.address, feeRate: 5, networkName: 'testnet3' });
  ok('buildSignedTxMulti builds a valid tx for a normal amount', !!r2.txid && r2.fee > 0);
}

// ── MAX_SAFE_INTEGER passes the amount guard but fails LATER on funds (not on the amount) ──
{
  let msg = '';
  try { bt(MAX); } catch (e) { msg = e.message; }
  ok('MAX_SAFE_INTEGER: amount valid, build fails on insufficient funds (not on the amount rule)',
     /insufficient funds|coin selection/i.test(msg) && !/below the wallet minimum|positive integer/i.test(msg));
}

// ── arithmetic safety: a huge but safe amount cannot exceed available inputs (no overflow) ──
{
  ok('over-budget amount is rejected by coin selection, never silently truncated', rejects(() => bt(1_000_000)));
}

console.log(bad ? '\nRT-8 AMOUNTS TEST FAILED' : '\nRT-8 AMOUNTS TEST PASS — integer-sat only, no coercion, 546 floor, both builders, funds-safe');
process.exit(bad ? 1 : 0);
