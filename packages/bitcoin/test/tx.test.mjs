// Offline correctness test for the OP_RETURN send builder.
// Proves construction+signing WITHOUT broadcasting, and cross-checks the raw tx
// with (a) a re-parse via @scure and (b) the local node's decoderawtransaction
// (an independent implementation) when available.
import * as btc from '@scure/btc-signer';
import { hexToBytes, bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { execSync } from 'node:child_process';
import { deriveKey } from '../src/wallet.js';
import { buildSignedTx, opReturnScript } from '../src/tx.js';

let bad = false;
const ok = (label, cond) => { console.log(label.padEnd(38), cond ? '✓' : '✗ FAIL'); if (!cond) bad = true; };

// Fixed test wallet (BIP-39 vector mnemonic) — testnet3, worthless.
const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const key = deriveKey(MN, '', 'testnet3', 0);
console.log('sender address   :', key.address);
ok('sender is testnet p2wpkh (tb1q)', key.address.startsWith('tb1q'));

// One mock UTXO worth 100_000 sats at a known outpoint.
const MOCK_TXID = 'a'.repeat(64);
const utxos = [{ txid: MOCK_TXID, vout: 1, value: 100_000 }];
const RECIPIENT = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'; // BIP-173 testnet vector addr
const MESSAGE = 'hello from olesia';

const res = buildSignedTx({
  utxos, key,
  recipients: [{ address: RECIPIENT, amount: 20_000 }],
  message: MESSAGE,
  feeRate: 5,
  networkName: 'testnet3',
});
console.log('built txid       :', res.txid);
console.log('fee / vsize      :', res.fee, '/', res.vsize, 'sat @5 sat/vB =>', 5 * res.vsize);
ok('fee is positive and sane (<5000)', res.fee > 0 && res.fee < 5000);
ok('fee ≈ 5 * vsize', Math.abs(res.fee - 5 * res.vsize) <= 5);

// --- re-parse with @scure (round-trip) ---
const parsed = btc.Transaction.fromRaw(hexToBytes(res.txHex), { allowUnknownOutputs: true });
ok('1 input', parsed.inputsLength === 1);
ok('input txid round-trips (endianness)', bytesToHex(parsed.getInput(0).txid) === MOCK_TXID);
ok('input is finalized (has witness)', !!parsed.getInput(0).finalScriptWitness);

// outputs: recipient (20000) + OP_RETURN (0) + change
let sawRecipient = false, sawOpReturn = false, sawChange = false;
const wantOpReturn = bytesToHex(opReturnScript(MESSAGE));
let outTotal = 0n;
for (let i = 0; i < parsed.outputsLength; i++) {
  const o = parsed.getOutput(i);
  outTotal += o.amount;
  if (bytesToHex(o.script) === wantOpReturn && o.amount === 0n) { sawOpReturn = true; continue; }
  let addr;
  try { addr = parsed.getOutputAddress(i, btc.TEST_NETWORK); } catch { addr = undefined; }
  if (o.amount === 20_000n && addr === RECIPIENT) sawRecipient = true;
  if (addr === key.address) sawChange = true;
}
ok('pays recipient 20000 sat', sawRecipient);
ok('carries exact OP_RETURN message', sawOpReturn);
ok('change returns to sender', sawChange);
ok('value conserved (in = out + fee)', 100_000n === outTotal + BigInt(res.fee));

// --- independent cross-check via the local node (if reachable) ---
try {
  const dec = JSON.parse(execSync(
    `sudo -u bitcoin /usr/local/bin/bitcoin-cli -datadir=/var/lib/bitcoind decoderawtransaction ${res.txHex}`,
    { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  const nodeTxid = dec.txid;
  const vinTxid = dec.vin[0].txid;
  const opret = dec.vout.find((v) => v.scriptPubKey.type === 'nulldata');
  const msgHex = bytesToHex(utf8ToBytes(MESSAGE));
  console.log('node decode txid :', nodeTxid);
  ok('[node] txid matches our txid', nodeTxid === res.txid);
  ok('[node] vin txid correct (not reversed)', vinTxid === MOCK_TXID);
  ok('[node] OP_RETURN asm holds our message', !!opret && opret.scriptPubKey.asm.includes(msgHex));
} catch (e) {
  console.log('node cross-check   : skipped (bitcoin-cli not reachable) —', String(e.message).slice(0, 60));
}

console.log(bad ? '\nTX TEST FAILED' : '\nTX TEST PASS');
process.exit(bad ? 1 : 0);
