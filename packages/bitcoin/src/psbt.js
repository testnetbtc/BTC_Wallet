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
import { opReturnScript, assertFeeRate } from './tx.js';
import { deriveKey, parseExtendedKey } from './wallet.js';

// Watch-only: derive a receive script/address from an ACCOUNT xpub (m/84'/coin'/0').
export function watchOnly(accountXpub, network, chain = 0, index = 0) {
  const n = net(network);
  const node = parseExtendedKey(accountXpub, network).deriveChild(chain).deriveChild(index);
  const spend = btc.p2wpkh(node.publicKey, n.btc);
  return { pubkey: node.publicKey, script: spend.script, address: spend.address };
}

// ONLINE (no seed): build an unsigned PSBT. All UTXOs assumed to belong to `wo`
// (single-address wallet at index 0).
export function buildUnsignedPSBT({ utxos, wo, recipients = [], message = null,
                                    changeAddress, feeRate = 2, network }) {
  const n = net(network);
  feeRate = assertFeeRate(feeRate);
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

// SECURITY INVARIANT: the offline signer treats the PSBT and the machine that
// built it as UNTRUSTED. Before signing it must independently establish what the
// transaction spends and where every satoshi goes. describePSBT does that from
// first principles: it derives the wallet's own receive (chain 0) and change
// (chain 1) scripts from the ACCOUNT xpub and compares raw scripts — it never
// trusts bip32Derivation or any other metadata the PSBT creator supplied.
export function describePSBT(psbtB64, { accountXpub, network, gap = 20 }) {
  const n = net(network);
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64), { allowUnknownOutputs: true });
  const coin = n.coin ?? (n.btc.bech32 === 'bc' ? 0 : 1);

  // ownership set: every script this wallet would produce on either chain
  const acct = parseExtendedKey(accountXpub, network);
  const own = new Map(); // scriptHex -> { chain, index, address, path }
  for (const chain of [0, 1]) {
    const branch = acct.deriveChild(chain);
    for (let i = 0; i <= gap; i++) {
      const node = branch.deriveChild(i);
      const p = btc.p2wpkh(node.publicKey, n.btc);
      own.set(bytesToHex(p.script), { chain, index: i, address: p.address, path: `m/84'/${coin}'/0'/${chain}/${i}` });
    }
  }

  const inputs = [];
  let inTotal = 0, unknownAmounts = false;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    let script = inp.witnessUtxo?.script ?? null;
    let amount = inp.witnessUtxo ? Number(inp.witnessUtxo.amount) : null;
    if (!script && inp.nonWitnessUtxo?.outputs) {
      const prevOut = inp.nonWitnessUtxo.outputs[inp.index];
      if (prevOut) { script = prevOut.script; amount = Number(prevOut.amount); }
    }
    const o = script ? own.get(bytesToHex(script)) : null;
    if (amount == null) unknownAmounts = true; else inTotal += amount;
    inputs.push({
      txid: inp.txid ? bytesToHex(inp.txid) : null, vout: inp.index,
      amount, mine: !!o, path: o?.path ?? null, address: o?.address ?? null,
    });
  }

  const outputs = [];
  let outTotal = 0;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    const amount = Number(o.amount);
    outTotal += amount;
    if (o.script && o.script[0] === 0x6a) { // OP_RETURN
      let text = '';
      try { const dec = btc.Script.decode(o.script); const data = dec.find((x) => x instanceof Uint8Array); text = data ? new TextDecoder().decode(data) : ''; } catch { /* opaque */ }
      outputs.push({ vout: i, type: 'op_return', address: null, amount, opReturn: text, change: false, path: null });
      continue;
    }
    let address = null, type = 'unknown';
    try { const d = btc.OutScript.decode(o.script); type = d.type; address = btc.Address(n.btc).encode(d); } catch { /* unknown script — shown as such */ }
    const mineOut = o.script ? own.get(bytesToHex(o.script)) : null;
    outputs.push({ vout: i, type, address, amount, opReturn: null, change: !!mineOut, path: mineOut?.path ?? null });
  }

  // independent fee: inputs - outputs (never PSBT metadata). Unknowable => null.
  const fee = unknownAmounts ? null : inTotal - outTotal;
  const estVsize = Math.ceil(10.5 + 68 * tx.inputsLength + 31 * tx.outputsLength); // p2wpkh 1-sig estimate
  return {
    network, inputs, outputs,
    inTotal: unknownAmounts ? null : inTotal, outTotal, fee,
    feeRate: fee != null && fee >= 0 ? Number((fee / estVsize).toFixed(1)) : null, estVsize,
    anyInputMine: inputs.some((x) => x.mine),
    allInputsMine: inputs.length > 0 && inputs.every((x) => x.mine),
    externalTotal: outputs.filter((x) => !x.change && x.type !== 'op_return').reduce((a, x) => a + x.amount, 0),
    changeTotal: outputs.filter((x) => x.change).reduce((a, x) => a + x.amount, 0),
  };
}

// OFFLINE (seed present, air-gapped): sign + finalize a PSBT.
// NOTE: callers should verify first — send.js signUnsigned() enforces
// describePSBT-based checks and is the only path the app exposes.
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
