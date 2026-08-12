// Build + sign a P2WPKH transaction that pays recipients and/or carries an
// OP_RETURN message. Uses @scure/btc-signer (audited, RFC-6979 signing). Does NOT
// broadcast — construction and signing only, so it is unit-testable offline.
import * as btc from '@scure/btc-signer';
import { hexToBytes, bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { net } from './networks.js';

export const OP_RETURN_MAX = 80; // bytes; keep small for broad relay/mining

// Hard fee-rate cap at the signing boundary. Whatever the source of a fee rate —
// network estimate, UI field, API caller — a transaction is never BUILT with a
// non-finite, non-positive, or absurd rate. 5000 sat/vB is deliberately far above
// the UI warning thresholds: this is the engine's last line, not fee policy.
export const MAX_FEERATE = 5000;
export function assertFeeRate(feeRate) {
  const f = Number(feeRate);
  if (!Number.isFinite(f) || f < 1)
    throw new Error(`unsafe fee rate (${String(feeRate)}) — must be a finite number ≥ 1 sat/vB`);
  if (f > MAX_FEERATE)
    throw new Error(`unsafe fee rate (${f} sat/vB) — above the ${MAX_FEERATE} sat/vB hard cap`);
  return Math.ceil(f);
}

export function opReturnScript(message) {
  const data = typeof message === 'string' ? utf8ToBytes(message) : message;
  if (data.length > OP_RETURN_MAX)
    throw new Error(`OP_RETURN message is ${data.length} bytes (> ${OP_RETURN_MAX})`);
  return btc.Script.encode(['RETURN', data]);
}

// Build a PSBT input for a UTXO owned by `w` (from deriveKey or deriveScript).
// SegWit types (P2WPKH/P2SH-P2WPKH/P2TR) need only witnessUtxo; legacy types
// (P2PKH, P2PK) need the full previous transaction as nonWitnessUtxo (u.prevTxHex).
function buildInput(u, w) {
  const inp = { txid: hexToBytes(u.txid), index: u.vout, ...w.spend };
  if (w.segwit === false) {
    if (!u.prevTxHex) throw new Error(`spending a legacy input needs its previous transaction (none for ${u.txid}:${u.vout})`);
    inp.nonWitnessUtxo = hexToBytes(u.prevTxHex);
  } else {
    inp.witnessUtxo = { script: w.spend.script, amount: BigInt(u.value) };
  }
  return inp;
}

// Sweep: send the ENTIRE spendable balance (all UTXOs) to one address, minus fee.
// No change output — the recipient receives total-fee. Validates the destination.
export function buildSweepTx({ utxos, key, toAddress, feeRate = 2, networkName, message = null }) {
  const n = net(networkName);
  feeRate = assertFeeRate(feeRate);
  if (!utxos?.length) throw new Error('no UTXOs to sweep');
  btc.Address(n.btc).decode(toAddress); // throws on an invalid/wrong-network address
  const inputs = utxos.map((u) => buildInput(u, key));
  // OP_RETURN rides along if given; changeAddress = destination => rest goes there.
  const outs = message != null && String(message).length ? [{ script: opReturnScript(message), amount: 0n }] : [];
  const sel = btc.selectUTXO(inputs, outs, 'all', {
    changeAddress: toAddress, feePerByte: BigInt(feeRate), network: n.btc,
    createTx: true, dust: 546n, allowUnknownOutputs: true,
  });
  if (!sel || !sel.tx) throw new Error('sweep build failed — balance below fee?');
  const tx = sel.tx;
  tx.sign(key.privKey);
  tx.finalize();
  const total = utxos.reduce((a, u) => a + BigInt(u.value), 0n);
  return {
    txHex: bytesToHex(tx.extract()), txid: tx.id,
    fee: sel.fee != null ? Number(sel.fee) : undefined,
    vsize: tx.vsize, swept: Number(total - (sel.fee ?? 0n)), inputsUsed: inputs.length,
  };
}

// { utxos:[{txid,vout,value}], key (from deriveKey), recipients:[{address,amount}],
//   message?, changeAddress?, feeRate (sat/vB), networkName } -> { txHex, txid, fee, vsize }
export function buildSignedTx({ utxos, key, recipients = [], message = null,
                                changeAddress, feeRate = 2, networkName }) {
  const n = net(networkName);
  feeRate = assertFeeRate(feeRate);
  if (!utxos?.length) throw new Error('no UTXOs to spend');

  const outputs = [];
  for (const r of recipients) {
    if (!r.address || !(Number(r.amount) > 0)) throw new Error('recipient needs {address, amount>0}');
    outputs.push({ address: r.address, amount: BigInt(r.amount) });
  }
  if (message != null) outputs.push({ script: opReturnScript(message), amount: 0n });
  if (outputs.length === 0) throw new Error('nothing to send: no recipients and no message');

  const inputs = utxos.map((u) => buildInput(u, key));

  const sel = btc.selectUTXO(inputs, outputs, 'default', {
    changeAddress: changeAddress || key.address,
    feePerByte: BigInt(feeRate),
    network: n.btc,
    bip69: true,               // deterministic input/output ordering (BIP-69)
    createTx: true,
    allowUnknownOutputs: true, // permit the 0-value OP_RETURN output
    dust: 546n,
  });
  if (!sel || !sel.tx)
    throw new Error('coin selection failed — insufficient funds for outputs + fee?');

  const tx = sel.tx;
  tx.sign(key.privKey);
  tx.finalize();
  return {
    txHex: bytesToHex(tx.extract()),
    txid: tx.id,
    fee: sel.fee != null ? Number(sel.fee) : undefined,
    vsize: tx.vsize,
    inputsUsed: sel.inputs?.length,
    outputsCount: outputs.length + (sel.change ? 1 : 0),
  };
}
