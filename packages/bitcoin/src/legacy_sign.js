// Hand-rolled spending of PRE-SEGWIT single-key outputs that @scure/btc-signer does not sign:
//   · P2PKH locked to an UNCOMPRESSED public key (classic 2011–2014 paper wallets, "5…" WIFs)
//   · P2PK (bare public key, compressed or uncompressed)
// Legacy SIGHASH_ALL (the original Satoshi algorithm), @noble ECDSA with RFC-6979
// deterministic nonces and canonical low-S signatures. Construction + signing only.
//
// The legacy sighash does NOT commit to input amounts, so callers MUST pass amounts that were
// verified against the full previous transaction (see account.js verifyPrevout) — otherwise a
// lying data source could trick the wallet into overpaying the fee.
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { assertFeeRate, MIN_OUTPUT_SAT } from './tx.js';
import { varint } from './p2pk_fund.js';

const dsha = (b) => sha256(sha256(b));
const u32 = (n) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n, true); return a; };
const u64 = (n) => { const a = new Uint8Array(8); new DataView(a.buffer).setBigUint64(0, BigInt(n), true); return a; };
const revTxid = (hex) => hexToBytes(hex).slice().reverse();
const withLen = (s) => concatBytes(varint(s.length), s);
const push = (data) => {
  if (data.length > 75) throw new Error('push too large');
  return concatBytes(Uint8Array.of(data.length), data);
};
const SEQ = hexToBytes('fdffffff'); // BIP-125 opt-in RBF

// inputs:  [{ txid, vout, value, script: Uint8Array (prevout scriptPubKey), kind: 'p2pkh'|'p2pk',
//             privKey: Uint8Array(32), pubkey: Uint8Array (33 or 65 — exactly as locked) }]
// outputs: [{ script: Uint8Array, amount: bigint }]
function serialize(inputs, outputs, scriptSigs) {
  return concatBytes(
    u32(2), varint(inputs.length),
    ...inputs.map((inp, i) => concatBytes(revTxid(inp.txid), u32(inp.vout), withLen(scriptSigs[i]), SEQ)),
    varint(outputs.length),
    ...outputs.map((o) => concatBytes(u64(o.amount), withLen(o.script))),
    u32(0),
  );
}
function signAll(inputs, outputs) {
  const empty = new Uint8Array(0);
  return inputs.map((inp, i) => {
    // legacy sighash: this input carries its prevout script, every other scriptSig is empty
    const preimage = concatBytes(serialize(inputs, outputs, inputs.map((x, k) => (k === i ? x.script : empty))), u32(1));
    const sig = concatBytes(secp256k1.sign(dsha(preimage), inp.privKey, { lowS: true }).toDERRawBytes(), Uint8Array.of(0x01));
    return inp.kind === 'p2pk' ? push(sig) : concatBytes(push(sig), push(inp.pubkey));
  });
}
// worst-case size of the finished tx (73-byte signatures) for fee calculation
function maxSize(inputs, outputs) {
  const dummy = inputs.map((inp) => new Uint8Array(inp.kind === 'p2pk' ? 74 : 74 + 1 + inp.pubkey.length));
  return serialize(inputs, outputs, dummy).length;
}

// Spend ALL given legacy inputs. Either sweep everything to `destScript` (recipientAmount
// omitted), or pay `recipientAmount` to destScript and return the rest to `changeScript`.
// `dataScript` (optional) adds one zero-value OP_RETURN output carrying a message.
export function buildLegacyTx({ inputs, destScript, recipientAmount = null, changeScript = null, feeRate, dataScript = null }) {
  feeRate = assertFeeRate(feeRate);
  if (!inputs?.length) throw new Error('no coins to spend');
  for (const inp of inputs) {
    if (inp.kind !== 'p2pkh' && inp.kind !== 'p2pk') throw new Error('unsupported legacy input kind');
    if (!Number.isSafeInteger(inp.value) || inp.value <= 0) throw new Error('bad input amount');
  }
  const total = inputs.reduce((a, u) => a + BigInt(u.value), 0n);
  const data = dataScript ? [{ script: dataScript, amount: 0n }] : [];
  const feeFor = (outs) => BigInt(Math.ceil(feeRate * maxSize(inputs, outs)));
  let outputs, sent, change = 0n;
  if (recipientAmount == null) {
    const fee = feeFor([{ script: destScript, amount: 0n }, ...data]);
    sent = total - fee;
    if (sent < MIN_OUTPUT_SAT) throw new Error(`balance too small: after the ${fee}-sat fee only ${sent} sats would remain`);
    outputs = [{ script: destScript, amount: sent }, ...data];
  } else {
    sent = BigInt(recipientAmount);
    if (sent < MIN_OUTPUT_SAT) throw new Error(`amount is below the wallet minimum output of ${MIN_OUTPUT_SAT} sats`);
    if (!changeScript) throw new Error('a change script is required');
    const feeC = feeFor([{ script: destScript, amount: sent }, { script: changeScript, amount: 0n }, ...data]);
    change = total - sent - feeC;
    if (change >= MIN_OUTPUT_SAT) outputs = [{ script: destScript, amount: sent }, { script: changeScript, amount: change }, ...data];
    else {
      const feeN = feeFor([{ script: destScript, amount: sent }, ...data]);
      if (total - sent < feeN) throw new Error('insufficient funds for the amount plus the network fee');
      change = 0n;
      outputs = [{ script: destScript, amount: sent }, ...data]; // dust change is left to the fee
    }
  }
  const full = serialize(inputs, outputs, signAll(inputs, outputs));
  const outSum = outputs.reduce((a, o) => a + o.amount, 0n);
  return {
    txHex: bytesToHex(full), txid: bytesToHex(dsha(full).slice().reverse()),
    fee: Number(total - outSum), vsize: full.length, inputsUsed: inputs.length,
    sent: Number(sent), change: Number(change),
  };
}
