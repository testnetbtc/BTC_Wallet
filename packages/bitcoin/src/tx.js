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

// RT-8 — conservative WALLET OUTPUT FLOOR (not a claim about universal network dust: true
// dust depends on script/output type and relay policy). This wallet simply refuses to build a
// recipient output below this amount, which is safely at/above every standard output type's
// dust so the tx is always relayable. Applied identically in both recipient-paying builders.
export const MIN_OUTPUT_SAT = 546n;
// Validate ONE recipient amount and return it as BigInt sats. Requires a real JS number that
// is a positive safe integer at/above the wallet floor. Coercible strings ("20000"), floats,
// NaN, ±Infinity, zero, negatives and unsafe integers are all rejected — no silent coercion.
export function assertRecipientAmount(amount) {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0)
    throw new Error(`recipient amount must be a positive integer number of satoshis (got ${typeof amount} ${String(amount)})`);
  const sat = BigInt(amount);
  if (sat < MIN_OUTPUT_SAT)
    throw new Error(`recipient amount ${amount} sats is below the wallet minimum output of ${MIN_OUTPUT_SAT} sats`);
  return sat;
}

// Reject an address that does not belong to `networkName` with a CLEAR message,
// before it can ever become a transaction output. A mainnet address on testnet
// (or vice-versa) is a classic way to burn funds — the network is validated at
// build time, for every recipient and every sweep destination.
export function assertAddressNetwork(address, networkName) {
  const n = net(networkName);
  const a = (address || '').trim();
  if (!a) throw new Error('missing destination address');
  try { btc.Address(n.btc).decode(a); }
  catch { throw new Error(`"${a.slice(0, 16)}…" is not a valid ${networkName} address — you may be on the wrong network`); }
  return a;
}

export function opReturnScript(message) {
  const data = typeof message === 'string' ? utf8ToBytes(message) : message;
  if (data.length > OP_RETURN_MAX)
    throw new Error(`OP_RETURN message is ${data.length} bytes (> ${OP_RETURN_MAX})`);
  return btc.Script.encode(['RETURN', data]);
}

// Opt in to BIP-125 Replace-By-Fee on every input (sequence < 0xfffffffe), so a
// stuck transaction can always be fee-bumped — across all script types and both
// the receive and change chains.
const RBF_SEQUENCE = 0xfffffffd;

// M1 — the HONEST fee actually paid = Σ(input values) − Σ(output values) of the built
// transaction. @scure/btc-signer's reported `sel.fee` can UNDERSTATE this: when it drops a
// dust change output it silently folds that value into the miner fee, but still reports the fee
// as if the change existed. Recompute from the finalized tx so the number the wallet shows and
// signs always matches what the chain takes. Returns null if any input value is unavailable
// (then callers fall back to sel.fee rather than fabricating a number).
function actualFee(tx) {
  let inSum = 0n, outSum = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    if (inp.witnessUtxo) inSum += inp.witnessUtxo.amount;
    else if (inp.nonWitnessUtxo?.outputs && inp.nonWitnessUtxo.outputs[inp.index]) inSum += inp.nonWitnessUtxo.outputs[inp.index].amount;
    else return null;
  }
  for (let i = 0; i < tx.outputsLength; i++) outSum += tx.getOutput(i).amount;
  return inSum - outSum;
}

// Build a PSBT input for a UTXO owned by `w` (from deriveKey or deriveScript).
// SegWit types (P2WPKH/P2SH-P2WPKH/P2TR) need only witnessUtxo; legacy types
// (P2PKH, P2PK) need the full previous transaction as nonWitnessUtxo (u.prevTxHex).
function buildInput(u, w) {
  const inp = { txid: hexToBytes(u.txid), index: u.vout, ...w.spend, sequence: RBF_SEQUENCE };
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
  assertAddressNetwork(toAddress, networkName); // clear wrong-network rejection
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
  const paidFee = actualFee(tx);
  return {
    txHex: bytesToHex(tx.extract()), txid: tx.id,
    fee: paidFee != null ? Number(paidFee) : (sel.fee != null ? Number(sel.fee) : undefined),
    vsize: tx.vsize, swept: Number(total - (paidFee ?? sel.fee ?? 0n)), inputsUsed: inputs.length,
  };
}

// Sign a tx whose inputs may belong to DIFFERENT keys (HD account spends coins
// across receive + change addresses). Each keyed UTXO is {txid,vout,value,key,
// prevTxHex?}. Change goes to `changeAddress` (the next unused CHANGE address).
export function buildSignedTxMulti({ keyedUtxos, recipients = [], message = null, changeAddress, feeRate = 2, networkName }) {
  const n = net(networkName);
  feeRate = assertFeeRate(feeRate);
  if (!keyedUtxos?.length) throw new Error('no UTXOs to spend');
  const outputs = [];
  for (const r of recipients) {
    if (!r.address) throw new Error('recipient needs {address, amount}');
    const amount = assertRecipientAmount(r.amount);          // RT-8: strict integer sats >= floor
    assertAddressNetwork(r.address, networkName);
    outputs.push({ address: r.address, amount });
  }
  if (message != null) outputs.push({ script: opReturnScript(message), amount: 0n });
  if (!outputs.length) throw new Error('nothing to send');
  const inputs = keyedUtxos.map((u) => buildInput(u, u.key));
  const sel = btc.selectUTXO(inputs, outputs, 'default', {
    changeAddress: changeAddress || keyedUtxos[0].key.address,
    feePerByte: BigInt(feeRate), network: n.btc, bip69: true, createTx: true, allowUnknownOutputs: true, dust: 546n,
  });
  if (!sel || !sel.tx) throw new Error('coin selection failed — insufficient funds for outputs + fee?');
  const tx = sel.tx;
  // sign with each DISTINCT key; a key matching no selected input is a no-op we skip
  const seen = new Set();
  for (const u of keyedUtxos) {
    const h = bytesToHex(u.key.privKey);
    if (seen.has(h)) continue; seen.add(h);
    try { tx.sign(u.key.privKey); } catch { /* key not among the selected inputs */ }
  }
  tx.finalize();
  const paidFee = actualFee(tx);
  return { txHex: bytesToHex(tx.extract()), txid: tx.id, fee: paidFee != null ? Number(paidFee) : (sel.fee != null ? Number(sel.fee) : undefined), vsize: tx.vsize, inputsUsed: sel.inputs?.length };
}

// Sweep an entire HD account (all keyed UTXOs) to one address, minus fee, no change.
export function buildSweepTxMulti({ keyedUtxos, toAddress, feeRate = 2, networkName, message = null }) {
  const n = net(networkName);
  feeRate = assertFeeRate(feeRate);
  if (!keyedUtxos?.length) throw new Error('no UTXOs to sweep');
  assertAddressNetwork(toAddress, networkName);
  const inputs = keyedUtxos.map((u) => buildInput(u, u.key));
  const outs = message != null && String(message).length ? [{ script: opReturnScript(message), amount: 0n }] : [];
  const sel = btc.selectUTXO(inputs, outs, 'all', { changeAddress: toAddress, feePerByte: BigInt(feeRate), network: n.btc, createTx: true, dust: 546n, allowUnknownOutputs: true });
  if (!sel || !sel.tx) throw new Error('sweep build failed — balance below fee?');
  const tx = sel.tx;
  const seen = new Set();
  for (const u of keyedUtxos) { const h = bytesToHex(u.key.privKey); if (seen.has(h)) continue; seen.add(h); try { tx.sign(u.key.privKey); } catch { /* not selected */ } }
  tx.finalize();
  const total = keyedUtxos.reduce((a, u) => a + BigInt(u.value), 0n);
  const paidFee = actualFee(tx);
  return { txHex: bytesToHex(tx.extract()), txid: tx.id, fee: paidFee != null ? Number(paidFee) : (sel.fee != null ? Number(sel.fee) : undefined), vsize: tx.vsize, swept: Number(total - (paidFee ?? sel.fee ?? 0n)) };
}

// Pay a RAW scriptPubKey (the wallet's own bare P2PK) from keyed UTXOs. @scure/btc-signer's coin
// selector refuses a bare `pk` output, so selection is done here: largest coins first until the
// amount and the fee are covered; change to `changeAddress`; the fee is settled by rebuilding once
// with the real size. Same inputs, signing and RBF as the other builders.
const INPUT_VB = { p2wpkh: 68, p2tr: 58, 'p2sh-p2wpkh': 91, p2pkh: 148, p2pk: 114 };
export function buildRawScriptTx({ keyedUtxos, script, amount, changeAddress, feeRate = 2, networkName, message = null }) {
  const n = net(networkName);
  feeRate = assertFeeRate(feeRate);
  amount = assertRecipientAmount(amount);
  if (!keyedUtxos?.length) throw new Error('no UTXOs to spend');
  if (!(script instanceof Uint8Array) || !script.length) throw new Error('a destination script is required');
  assertAddressNetwork(changeAddress, networkName);
  const changeVb = 9 + btc.OutScript.encode(btc.Address(n.btc).decode(changeAddress)).length;
  const sorted = [...keyedUtxos].sort((a, b) => b.value - a.value);
  const build = (count, fee) => {
    const tx = new btc.Transaction({ allowUnknownOutputs: true, disableScriptCheck: true });   // the library refuses a bare-pk output by default; the final bytes are audited anyway
    const chosen = sorted.slice(0, count);
    for (const u of chosen) tx.addInput(buildInput(u, u.key));
    tx.addOutput({ script, amount: BigInt(amount) });
    if (message != null && String(message).length) tx.addOutput({ script: opReturnScript(message), amount: 0n });
    const inSum = chosen.reduce((a, u) => a + BigInt(u.value), 0n);
    const change = inSum - BigInt(amount) - BigInt(fee);
    if (change < 0n) return null;
    if (change >= MIN_OUTPUT_SAT) tx.addOutputAddress(changeAddress, change, n.btc);
    const seen = new Set();
    for (const u of chosen) { const h = bytesToHex(u.key.privKey); if (seen.has(h)) continue; seen.add(h); tx.sign(u.key.privKey); }
    tx.finalize();
    return tx;
  };
  for (let count = 1; count <= sorted.length; count++) {
    const est = 11 + sorted.slice(0, count).reduce((a, u) => a + (INPUT_VB[u.key.type] || 148), 0) + 9 + script.length + (message ? 9 + utf8ToBytes(String(message)).length : 0) + changeVb;
    let fee = Math.ceil(est * feeRate), tx = build(count, fee);
    if (!tx) continue;
    for (let i = 0; i < 2 && tx; i++) {   // settle on the real size (a dropped change output changes it)
      const want = Math.ceil(tx.vsize * feeRate);
      const paid = Number(actualFee(tx));
      if (paid >= want && paid - want <= Number(MIN_OUTPUT_SAT) + feeRate * 2) break;
      fee = want; tx = build(count, fee);
    }
    if (!tx) continue;
    const paidFee = actualFee(tx);
    return { txHex: bytesToHex(tx.extract()), txid: tx.id, fee: Number(paidFee), vsize: tx.vsize, inputsUsed: count };
  }
  throw new Error('coin selection failed — insufficient funds for outputs + fee?');
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
    if (!r.address) throw new Error('recipient needs {address, amount}');
    const amount = assertRecipientAmount(r.amount);          // RT-8: strict integer sats >= floor
    assertAddressNetwork(r.address, networkName);
    outputs.push({ address: r.address, amount });
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
  const paidFee = actualFee(tx);
  return {
    txHex: bytesToHex(tx.extract()),
    txid: tx.id,
    fee: paidFee != null ? Number(paidFee) : (sel.fee != null ? Number(sel.fee) : undefined),
    vsize: tx.vsize,
    inputsUsed: sel.inputs?.length,
    outputsCount: outputs.length + (sel.change ? 1 : 0),
  };
}
