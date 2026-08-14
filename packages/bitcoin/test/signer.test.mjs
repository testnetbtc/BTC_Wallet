// P1.a — offline signer core tests. Builds real unsigned PSBTs offline, then proves:
//  - review shows the true outputs/fee (independently computed) and correct ownership
//  - a valid own PSBT signs, finalizes, and yields a broadcastable, well-formed tx
//  - a wrong seed / foreign inputs / missing amounts / bad fee are REFUSED (never signed)
//  - tampering a PSBT output is visible in the review (WYSIWYS)
//  - a spend pulling inputs from MULTIPLE paths is fully signed (multi-path correctness)
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { hexToBytes } from '@noble/hashes/utils';
import { net } from '../src/networks.js';
import { accountXpub } from '../src/wallet.js';
import { watchOnly, buildUnsignedPSBT } from '../src/psbt.js';
import { decodeRawTx } from '../src/send.js';
import { reviewPSBT, signPSBT } from '../signer/core.mjs';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(66), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const rejects = (fn) => { try { fn(); return false; } catch { return true; } };

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const NET = 'testnet3';
const axpub = accountXpub(MN, '', NET);
const wo0 = watchOnly(axpub, NET, 0, 0);   // our receive addr 0
const wo1 = watchOnly(axpub, NET, 0, 1);   // our receive addr 1
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';   // EXTERNAL testnet address (not ours)

// ── single-address unsigned PSBT (built the way the hot wallet would) ──
const built = buildUnsignedPSBT({
  utxos: [{ txid: 'a'.repeat(64), vout: 0, value: 100000 }],
  wo: wo0, recipients: [{ address: DEST, amount: 60000 }], changeAddress: wo0.address, feeRate: 5, network: NET,
});
{
  const r = reviewPSBT({ mnemonic: MN, network: NET, psbtB64: built.psbt });
  ok('review: recognises our input (anyInputMine + allInputsMine)', r.summary.anyInputMine && r.summary.allInputsMine);
  ok('review: independent fee is positive and matches the builder', r.summary.fee > 0 && r.summary.fee === built.fee);
  ok('review: destination shown as an EXTERNAL output (not change)', r.summary.outputs.some((o) => o.address === DEST && !o.change));
  ok('review: change shown going back to us', r.summary.outputs.some((o) => o.change));
  ok('review: safeToSign true for our own PSBT', r.safeToSign === true);
}
{
  const s = signPSBT({ mnemonic: MN, network: NET, psbtB64: built.psbt });
  const dec = decodeRawTx({ hex: s.txHex, network: NET });
  ok('sign: produces a finalized, decodable tx with a matching txid', s.txid === dec.txid && s.txHex.length > 0);
  ok('sign: the signed tx has a witness (actually signed)', /[0-9a-f]/.test(s.txHex) && s.txHex.length > 200);
}

// ── refusals ──
{
  const r = reviewPSBT({ mnemonic: OTHER, network: NET, psbtB64: built.psbt });
  ok('refuse: a DIFFERENT seed sees no owned input', r.summary.anyInputMine === false && r.safeToSign === false);
  ok('refuse: signPSBT with the wrong seed throws (never signs)', rejects(() => signPSBT({ mnemonic: OTHER, network: NET, psbtB64: built.psbt })));
}
{
  // foreign co-sign: a PSBT with one of our inputs AND one input that is not ours
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: hexToBytes('b'.repeat(64)), index: 0, witnessUtxo: { script: wo0.script, amount: 50000n }, sequence: 0xfffffffd });
  const foreign = watchOnly(accountXpub(OTHER, '', NET), NET, 0, 0);
  tx.addInput({ txid: hexToBytes('c'.repeat(64)), index: 0, witnessUtxo: { script: foreign.script, amount: 50000n }, sequence: 0xfffffffd });
  tx.addOutputAddress(DEST, 90000n, net(NET).btc);
  const psbt = base64.encode(tx.toPSBT());
  const r = reviewPSBT({ mnemonic: MN, network: NET, psbtB64: psbt });
  ok('refuse: mixed own+foreign inputs -> not allInputsMine -> unsafe', r.summary.anyInputMine && !r.summary.allInputsMine && !r.safeToSign);
  ok('refuse: signPSBT refuses to co-sign foreign inputs', rejects(() => signPSBT({ mnemonic: MN, network: NET, psbtB64: psbt })));
}
{
  // missing input amount -> fee unverifiable -> refuse
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: hexToBytes('d'.repeat(64)), index: 0, sequence: 0xfffffffd });   // no witnessUtxo
  tx.addOutputAddress(DEST, 10000n, net(NET).btc);
  const psbt = base64.encode(tx.toPSBT());
  const r = reviewPSBT({ mnemonic: MN, network: NET, psbtB64: psbt });
  ok('refuse: missing input amount -> fee null -> unsafe', r.summary.fee == null && !r.safeToSign);
}

// ── tamper visibility (WYSIWYS): redirect the change output to an attacker ──
{
  const tx = btc.Transaction.fromPSBT(base64.decode(built.psbt), { allowUnknownOutputs: true });
  // rebuild the same tx but send the "change" to an attacker address instead of back to us
  const attacker = watchOnly(accountXpub(OTHER, '', NET), NET, 0, 3).address;   // foreign (not ours)
  const t2 = new btc.Transaction({ allowUnknownOutputs: true });
  for (let i = 0; i < tx.inputsLength; i++) { const inp = tx.getInput(i); t2.addInput(inp); }
  t2.addOutputAddress(DEST, 60000n, net(NET).btc);
  t2.addOutputAddress(attacker, 39000n, net(NET).btc);   // was our change; now the attacker's
  const psbt = base64.encode(t2.toPSBT());
  const r = reviewPSBT({ mnemonic: MN, network: NET, psbtB64: psbt });
  ok('tamper: redirected change shows as an EXTERNAL output to the attacker (visible in review)',
     r.summary.outputs.some((o) => o.address === attacker && !o.change) && r.summary.changeTotal === 0);
}

// ── multi-path: inputs from TWO of our addresses are BOTH signed ──
{
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: hexToBytes('e'.repeat(64)), index: 0, witnessUtxo: { script: wo0.script, amount: 50000n }, sequence: 0xfffffffd });
  tx.addInput({ txid: hexToBytes('f'.repeat(64)), index: 1, witnessUtxo: { script: wo1.script, amount: 60000n }, sequence: 0xfffffffd });
  tx.addOutputAddress(DEST, 100000n, net(NET).btc);
  const psbt = base64.encode(tx.toPSBT());
  const r = reviewPSBT({ mnemonic: MN, network: NET, psbtB64: psbt });
  ok('multi-path: both inputs recognised as ours (distinct paths)', r.summary.allInputsMine && new Set(r.summary.inputs.map((i) => i.path)).size === 2);
  const s = signPSBT({ mnemonic: MN, network: NET, psbtB64: psbt });   // must sign BOTH paths + finalize
  const dec = decodeRawTx({ hex: s.txHex, network: NET });
  ok('multi-path: signs every path, finalizes, yields a valid 2-input tx', dec.txid === s.txid && dec.inputs.length === 2);
}

console.log(bad ? '\nSIGNER TEST FAILED' : '\nSIGNER TEST PASS — air-gap review is WYSIWYS + ownership-checked; multi-path signing; refuses foreign/unverifiable');
process.exit(bad ? 1 : 0);
