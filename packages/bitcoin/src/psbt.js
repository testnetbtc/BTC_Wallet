// Air-gap PSBT primitives for the mainnet-safe flow:
//   online (watch-only, xpub)  -> build UNSIGNED psbt
//   offline (seed)             -> sign psbt        [never online for mainnet]
//   online                     -> extract + broadcast
// The seed never touches the online side. Built on @scure/btc-signer.
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { base64 } from '@scure/base';
import { net } from './networks.js';
import { opReturnScript } from './tx.js';
import { deriveKey } from './wallet.js';

// Watch-only: derive a receive script/address from an ACCOUNT xpub (m/84'/coin'/0').
export function watchOnly(accountXpub, network, chain = 0, index = 0) {
  const n = net(network);
  const node = HDKey.fromExtendedKey(accountXpub).deriveChild(chain).deriveChild(index);
  const spend = btc.p2wpkh(node.publicKey, n.btc);
  return { pubkey: node.publicKey, script: spend.script, address: spend.address };
}

// ONLINE (no seed): build an unsigned PSBT. All UTXOs assumed to belong to `wo`
// (single-address wallet at index 0).
export function buildUnsignedPSBT({ utxos, wo, recipients = [], message = null,
                                    changeAddress, feeRate = 2, network }) {
  const n = net(network);
  const outputs = [];
  for (const r of recipients) outputs.push({ address: r.address, amount: BigInt(r.amount) });
  if (message != null) outputs.push({ script: opReturnScript(message), amount: 0n });
  if (!outputs.length) throw new Error('nothing to send');
  const inputs = utxos.map((u) => ({
    txid: hexToBytes(u.txid), index: u.vout,
    witnessUtxo: { script: wo.script, amount: BigInt(u.value) },
  }));
  const sel = btc.selectUTXO(inputs, outputs, 'default', {
    changeAddress: changeAddress || wo.address, feePerByte: BigInt(feeRate),
    network: n.btc, bip69: true, createTx: true, allowUnknownOutputs: true, dust: 546n,
  });
  if (!sel || !sel.tx) throw new Error('unsigned PSBT build failed — insufficient funds?');
  // vsize is unavailable on an unfinalized tx; estimate from the selector's weight.
  return { psbt: base64.encode(sel.tx.toPSBT()), fee: Number(sel.fee),
           vsize: sel.weight ? Math.ceil(sel.weight / 4) : undefined };
}

// OFFLINE (seed present, air-gapped): sign + finalize a PSBT.
export function signPSBTOffline(psbtB64, mnemonic, passphrase, network, index = 0) {
  const key = deriveKey(mnemonic, passphrase, network, index);
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64), { allowUnknownOutputs: true });
  tx.sign(key.privKey);
  tx.finalize();
  return { psbt: base64.encode(tx.toPSBT()), txid: tx.id, txHex: bytesToHex(tx.extract()) };
}

// ONLINE: extract the broadcastable raw tx from a finalized PSBT.
export function extractTx(psbtB64) {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64), { allowUnknownOutputs: true });
  if (!tx.isFinal) tx.finalize();
  return { txid: tx.id, txHex: bytesToHex(tx.extract()) };
}
