// Fund a P2PK output. @scure/btc-signer refuses to emit a bare `pk` output
// ("checkScript: non-wrapped pk") at both addOutput and selectUTXO, so we
// serialize a SegWit v0 transaction ourselves: spend P2WPKH input(s), pay a raw
// <pubkey> OP_CHECKSIG output plus P2WPKH change. BIP-143 sighash, @noble ECDSA
// (canonical low-S). Construction + signing only — the caller broadcasts.
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hexToBytes, bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { assertFeeRate } from './tx.js';

const dsha = (b) => sha256(sha256(b));
const hash160 = (b) => ripemd160(sha256(b));
const u32 = (n) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n, true); return a; };
const u64 = (n) => { const a = new Uint8Array(8); new DataView(a.buffer).setBigUint64(0, BigInt(n), true); return a; };
const revTxid = (hex) => hexToBytes(hex).slice().reverse();
export function varint(n) {
  n = Number(n);
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return concatBytes(Uint8Array.of(0xfd), le(n, 2));
  if (n <= 0xffffffff) return concatBytes(Uint8Array.of(0xfe), le(n, 4));
  return concatBytes(Uint8Array.of(0xff), le(n, 8));
}
function le(n, bytes) { const a = new Uint8Array(bytes); let x = BigInt(n); for (let i = 0; i < bytes; i++) { a[i] = Number(x & 0xffn); x >>= 8n; } return a; }
const withLen = (s) => concatBytes(varint(s.length), s); // length-prefixed script/item

// The raw scriptPubKey for a P2PK output: <push pubkey> OP_CHECKSIG.
export const p2pkScript = (pub) => concatBytes(Uint8Array.of(pub.length), pub, Uint8Array.of(0xac));

// utxos: [{txid, vout, value}]  (all P2WPKH, owned by pubkey/privKey)
// targetScript: raw P2PK scriptPubKey bytes to fund
// changeScript: source P2WPKH scriptPubKey bytes (change returns here)
// Coin selection for a P2PK fund. Do NOT sweep the whole address: prefer the SMALLEST single
// coin that alone covers `amount` + a 1-input fee (keeps larger coins intact, minimal tx);
// otherwise accumulate smallest-first until covered, with the fee GROWING as inputs are added.
// Returns the chosen subset, or null if even every coin together can't cover amount + fee.
// `feeFor(n)` = the fee (BigInt) for a fund tx with n inputs.
export function selectFundCoins(utxos, amount, feeFor) {
  amount = BigInt(amount);
  const need1 = amount + feeFor(1);
  let single = null;
  for (const u of utxos) {
    const v = BigInt(u.value);
    if (v >= need1 && (single === null || v < BigInt(single.value))) single = u;
  }
  if (single) return [single];
  const asc = [...utxos].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const acc = []; let sum = 0n;
  for (const u of asc) {
    acc.push(u); sum += BigInt(u.value);
    if (sum >= amount + feeFor(acc.length)) return acc;
  }
  return null;
}

export function buildFundP2PK({ utxos, privKey, pubkey, targetScript, changeScript, amount, feeRate = 2 }) {
  feeRate = assertFeeRate(feeRate);
  if (!utxos?.length) throw new Error('no UTXOs to fund from');
  amount = BigInt(amount);
  const feeFor = (n) => BigInt(Math.ceil(feeRate * (11 + 68 * n + 44 + 31))); // n inputs, P2PK out + change out
  const chosen = selectFundCoins(utxos, amount, feeFor);
  if (!chosen) throw new Error(`insufficient funds: no combination of coins covers ${amount} + fee`);
  const inTotal = chosen.reduce((a, u) => a + BigInt(u.value), 0n);
  const fee = feeFor(chosen.length);
  let change = inTotal - amount - fee;

  const outs = [{ script: targetScript, amount }];
  if (change >= 294n) outs.push({ script: changeScript, amount: change }); // else dust -> absorbed by fee
  else change = 0n;

  // BIP-143 preimage components
  const scriptCode = concatBytes(hexToBytes('1976a914'), hash160(pubkey), hexToBytes('88ac')); // self-length-prefixed
  const nSeq = hexToBytes('fdffffff');   // BIP-125 RBF opt-in (0xfffffffd, little-endian)
  const hashPrevouts = dsha(concatBytes(...chosen.map((u) => concatBytes(revTxid(u.txid), u32(u.vout)))));
  const hashSequence = dsha(concatBytes(...chosen.map(() => nSeq)));
  const hashOutputs = dsha(concatBytes(...outs.map((o) => concatBytes(u64(o.amount), withLen(o.script)))));

  const witnesses = chosen.map((u) => {
    const preimage = concatBytes(
      u32(2), hashPrevouts, hashSequence,
      revTxid(u.txid), u32(u.vout), scriptCode, u64(u.value), nSeq,
      hashOutputs, u32(0), u32(1), // locktime, SIGHASH_ALL
    );
    const sig = secp256k1.sign(dsha(preimage), privKey, { lowS: true }).toDERRawBytes();
    return [concatBytes(sig, Uint8Array.of(0x01)), pubkey];
  });

  const inputsSer = concatBytes(...chosen.map((u) => concatBytes(revTxid(u.txid), u32(u.vout), varint(0), nSeq)));
  const outputsSer = concatBytes(...outs.map((o) => concatBytes(u64(o.amount), withLen(o.script))));
  const nonWitness = concatBytes(u32(2), varint(chosen.length), inputsSer, varint(outs.length), outputsSer, u32(0));
  const witnessSer = concatBytes(...witnesses.map((w) => concatBytes(varint(w.length), ...w.map(withLen))));
  const full = concatBytes(u32(2), Uint8Array.of(0, 1), varint(chosen.length), inputsSer, varint(outs.length), outputsSer, witnessSer, u32(0));

  const weight = nonWitness.length * 3 + full.length;
  return {
    txHex: bytesToHex(full),
    txid: bytesToHex(dsha(nonWitness).slice().reverse()),
    fee: Number(inTotal - outs.reduce((a, o) => a + o.amount, 0n)),
    vsize: Math.ceil(weight / 4),
    funded: Number(amount), change: Number(change), inputsUsed: chosen.length,
  };
}

// Spend (sweep) a single P2PK output to a destination scriptPubKey, minus fee.
// P2PK is pre-SegWit: scriptSig is just <push signature>, and the legacy sighash
// uses the prevout's P2PK script as scriptCode. @noble ECDSA (low-S).
// Optional `message` adds an OP_RETURN output — writing a note while spending
// Satoshi's own script type, the closest thing to the genesis headline.
export function buildSpendP2PK({ utxo, privKey, p2pkScriptBytes, destScript, feeRate = 2, message = null }) {
  feeRate = assertFeeRate(feeRate);
  const value = BigInt(utxo.value);
  let orScript = null;
  if (message != null && String(message).length) {
    const data = utf8ToBytes(String(message));
    if (data.length > 80) throw new Error(`OP_RETURN message is ${data.length} bytes (> 80)`);
    orScript = concatBytes(Uint8Array.of(0x6a), data.length <= 75 ? Uint8Array.of(data.length) : Uint8Array.of(0x4c, data.length), data);
  }
  const orSize = orScript ? 8 + 1 + orScript.length : 0;
  const estSize = 4 + 1 + (32 + 4 + 1 + 73 + 4) + 1 + (8 + 1 + destScript.length) + orSize + 4;
  const fee = BigInt(Math.ceil(feeRate * estSize));
  const sent = value - fee;
  if (sent <= 0n) throw new Error(`P2PK balance ${value} too small to cover the fee (${fee})`);
  const outs = [concatBytes(u64(sent), withLen(destScript))];
  if (orScript) outs.push(concatBytes(u64(0), withLen(orScript)));
  const outsSer = concatBytes(varint(outs.length), ...outs);
  const nSeq = hexToBytes('fdffffff');   // BIP-125 RBF opt-in (0xfffffffd, little-endian)
  const body = (scriptSigField) => concatBytes(
    u32(2), varint(1), revTxid(utxo.txid), u32(utxo.vout), scriptSigField, nSeq,
    outsSer, u32(0),
  );
  // legacy sighash: input's scriptSig slot holds the prevout (P2PK) script, then SIGHASH_ALL
  const preimage = concatBytes(body(withLen(p2pkScriptBytes)), u32(1));
  const sig = secp256k1.sign(dsha(preimage), privKey, { lowS: true }).toDERRawBytes();
  const sigFull = concatBytes(sig, Uint8Array.of(0x01));           // + SIGHASH_ALL
  const scriptSig = concatBytes(Uint8Array.of(sigFull.length), sigFull); // OP_PUSH(sig)
  const full = body(withLen(scriptSig));
  return { txHex: bytesToHex(full), txid: bytesToHex(dsha(full).slice().reverse()), fee: Number(fee), sent: Number(sent), message: message || null };
}
