// Build + sign a P2WPKH transaction that pays recipients and/or carries an
// OP_RETURN message. Uses @scure/btc-signer (audited, RFC-6979 signing). Does NOT
// broadcast — construction and signing only, so it is unit-testable offline.
import * as btc from '@scure/btc-signer';
import { hexToBytes, bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { net } from './networks.js';

export const OP_RETURN_MAX = 80; // bytes; keep small for broad relay/mining

export function opReturnScript(message) {
  const data = typeof message === 'string' ? utf8ToBytes(message) : message;
  if (data.length > OP_RETURN_MAX)
    throw new Error(`OP_RETURN message is ${data.length} bytes (> ${OP_RETURN_MAX})`);
  return btc.Script.encode(['RETURN', data]);
}

// { utxos:[{txid,vout,value}], key (from deriveKey), recipients:[{address,amount}],
//   message?, changeAddress?, feeRate (sat/vB), networkName } -> { txHex, txid, fee, vsize }
export function buildSignedTx({ utxos, key, recipients = [], message = null,
                                changeAddress, feeRate = 2, networkName }) {
  const n = net(networkName);
  if (!utxos?.length) throw new Error('no UTXOs to spend');

  const outputs = [];
  for (const r of recipients) {
    if (!r.address || !(Number(r.amount) > 0)) throw new Error('recipient needs {address, amount>0}');
    outputs.push({ address: r.address, amount: BigInt(r.amount) });
  }
  if (message != null) outputs.push({ script: opReturnScript(message), amount: 0n });
  if (outputs.length === 0) throw new Error('nothing to send: no recipients and no message');

  const inputs = utxos.map((u) => ({
    txid: hexToBytes(u.txid),
    index: u.vout,
    witnessUtxo: { script: key.spend.script, amount: BigInt(u.value) },
    ...key.spend, // P2WPKH spend info so the signer knows the input type
  }));

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
