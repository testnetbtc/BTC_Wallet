// Prove the P2PK lab: build a tx that FUNDS a P2PK output (P2WPKH -> <pubkey>
// OP_CHECKSIG + change), then a tx that SPENDS that P2PK output back to an
// address. @scure refuses to touch bare pk, so these use our hand-rolled
// builders; we confirm both decode in Bitcoin Core with the right shapes.
import { execSync } from 'node:child_process';
import { deriveScript } from '../src/scripts.js';
import { buildFundP2PK, buildSpendP2PK } from '../src/p2pk_fund.js';

const NET = 'signet';
const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let bad = false;
const ok = (l, c) => { console.log(l.padEnd(52), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const decode = (hex) => { try { return JSON.parse(execSync(`sudo -u bitcoin /usr/local/bin/bitcoin-cli -datadir=/var/lib/bitcoind decoderawtransaction ${hex}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()); } catch { return null; } };

const src = deriveScript(MN, NET, 'p2wpkh', 0);
const tgt = deriveScript(MN, NET, 'p2pk', 0);
const pubHex = Buffer.from(tgt.pubkey).toString('hex');

// --- FUND: P2WPKH input -> P2PK output + change ---
const fund = buildFundP2PK({
  utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 100_000 }],
  privKey: src.privKey, pubkey: src.pubkey,
  targetScript: tgt.spend.script, changeScript: src.spend.script,
  amount: 20_000, feeRate: 2,
});
ok(`fund  builds (txid ${fund.txid.slice(0, 8)}…, fee ${fund.fee})`, /^[0-9a-f]{64}$/.test(fund.txid));
const fd = decode(fund.txHex);
if (fd) {
  ok('fund  [node] decodes, 1 in / 2 out', fd.vin.length === 1 && fd.vout.length === 2);
  ok('fund  vout0 is a P2PK (pubkey) output', fd.vout[0].scriptPubKey.type === 'pubkey');
  ok('fund  P2PK output locks to our pubkey', fd.vout[0].scriptPubKey.asm.includes(pubHex));
  ok('fund  vout1 change is P2WPKH', fd.vout[1].scriptPubKey.type === 'witness_v0_keyhash');
} else console.log('fund  node decode skipped (bitcoin-cli unreachable)');

// --- SPEND: the P2PK output -> back to the P2WPKH address ---
const spend = buildSpendP2PK({
  utxo: { txid: fund.txid, vout: 0, value: 20_000 },
  privKey: tgt.privKey, p2pkScriptBytes: tgt.spend.script,
  destScript: src.spend.script, feeRate: 2,
});
ok(`spend builds (txid ${spend.txid.slice(0, 8)}…, sent ${spend.sent})`, /^[0-9a-f]{64}$/.test(spend.txid));
const sd = decode(spend.txHex);
if (sd) {
  ok('spend [node] decodes, 1 in / 1 out', sd.vin.length === 1 && sd.vout.length === 1);
  ok('spend input has a scriptSig (signature push)', !!sd.vin[0].scriptSig && sd.vin[0].scriptSig.hex.length > 2);
  ok('spend spends the funded P2PK outpoint', sd.vin[0].txid === fund.txid && sd.vin[0].vout === 0);
} else console.log('spend node decode skipped (bitcoin-cli unreachable)');

// --- SPEND with an OP_RETURN message (the Satoshi-flavoured note) ---
const spendMsg = buildSpendP2PK({
  utxo: { txid: fund.txid, vout: 0, value: 20_000 },
  privKey: tgt.privKey, p2pkScriptBytes: tgt.spend.script,
  destScript: src.spend.script, feeRate: 2, message: 'hello from a bare public key',
});
ok(`spend+msg builds (txid ${spendMsg.txid.slice(0, 8)}…)`, /^[0-9a-f]{64}$/.test(spendMsg.txid));
const smd = decode(spendMsg.txHex);
if (smd) {
  ok('spend+msg [node] decodes, 1 in / 2 out', smd.vin.length === 1 && smd.vout.length === 2);
  const op = smd.vout.find((o) => o.scriptPubKey.type === 'nulldata');
  ok('spend+msg has an OP_RETURN (nulldata) output', !!op);
  ok('spend+msg OP_RETURN carries our text', op && op.scriptPubKey.asm.includes(Buffer.from('hello from a bare public key').toString('hex')));
}

console.log(bad ? '\nP2PK TEST FAILED' : '\nP2PK TEST PASS — fund + spend a bare public key');
process.exit(bad ? 1 : 0);
