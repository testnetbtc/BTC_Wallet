// Atomic-swap HTLC spend signer (P2WSH SHA256+CLTV HTLC) for the Olesia wallet ↔ swap hand-off.
//
// The swap engine hands the wallet an UNSIGNED PSBT with exactly one P2WSH HTLC-spend input
// (redeem or refund) and verifies the returned bytes SEMANTICALLY against an immutable intent
// before broadcast — it can only accept or fail closed, never redirect funds. The one safety
// property the wallet must preserve is that the finalized segwit txid equals the engine's intent
// txid. Segwit txids are witness-independent, so this signer builds the final tx by REUSING the
// PSBT's unsigned-tx bytes verbatim (version, inputs, outputs, locktime) and only appending a
// witness — the txid is preserved by construction. Built on the same audited @noble/@scure
// primitives and hand-rolled BIP-143 as src/p2pk_fund.js (no bitcoinjs, no new crypto stack).
//
// HTLC witnessScript (docs match the swap engine's src/bitcoin/htlc.js):
//   OP_IF  OP_SHA256 <H(32)> OP_EQUALVERIFY <redeemPub(33)> OP_CHECKSIG
//   OP_ELSE <refundHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <refundPub(33)> OP_CHECKSIG  OP_ENDIF
// Witness stacks (must match the engine's finalizers, src/bitcoin/tx.js):
//   redeem: <sig+SIGHASH_ALL> <secret(32)> <0x01>   <witnessScript>
//   refund: <sig+SIGHASH_ALL> <empty>               <witnessScript>   (nLockTime = refundHeight)
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { base64 } from '@scure/base';
import { deriveKey } from './wallet.js';

const dsha = (b) => sha256(sha256(b));
const u32le = (n) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0, true); return a; };
const leNum = (b) => { let n = 0; for (let i = 0; i < b.length; i++) n += b[i] * 2 ** (8 * i); return n; };
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function varint(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, (n >> 8) & 0xff);
  if (n <= 0xffffffff) return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  const a = new Uint8Array(9); a[0] = 0xff; let x = BigInt(n); for (let i = 0; i < 8; i++) { a[1 + i] = Number(x & 0xffn); x >>= 8n; } return a;
}
function readVarint(buf, o) {
  const f = buf[o];
  if (f < 0xfd) return { n: f, o: o + 1 };
  if (f === 0xfd) return { n: buf[o + 1] | (buf[o + 2] << 8), o: o + 3 };
  if (f === 0xfe) return { n: (buf[o + 1] | (buf[o + 2] << 8) | (buf[o + 3] << 16) | (buf[o + 4] * 0x1000000)) >>> 0, o: o + 5 };
  let n = 0; for (let i = 0; i < 8; i++) n += buf[o + 1 + i] * 2 ** (8 * i); return { n, o: o + 9 };
}

// Minimal PSBT reader — enough for a single-input HTLC-spend PSBT. Pulls the global UNSIGNED TX
// (key 0x00) and the first input's witnessUtxo (0x01), sighashType (0x03), witnessScript (0x05).
function parsePsbt(bytes) {
  const magic = [0x70, 0x73, 0x62, 0x74, 0xff];
  for (let i = 0; i < 5; i++) if (bytes[i] !== magic[i]) throw new Error('not a PSBT');
  let o = 5, unsignedTx = null;
  for (;;) {                                   // global map
    let r = readVarint(bytes, o); o = r.o; const keylen = r.n; if (keylen === 0) break;
    const keytype = bytes[o]; o += keylen;
    r = readVarint(bytes, o); o = r.o; const val = bytes.slice(o, o + r.n); o += r.n;
    if (keytype === 0x00) unsignedTx = val;
  }
  if (!unsignedTx) throw new Error('PSBT carries no unsigned transaction');
  let witnessUtxo = null, sighashType = null, witnessScript = null;
  for (;;) {                                   // first input map only (we require exactly one input)
    let r = readVarint(bytes, o); o = r.o; const keylen = r.n; if (keylen === 0) break;
    const keytype = bytes[o]; o += keylen;
    r = readVarint(bytes, o); o = r.o; const val = bytes.slice(o, o + r.n); o += r.n;
    if (keytype === 0x01) witnessUtxo = val;
    else if (keytype === 0x03) sighashType = val;
    else if (keytype === 0x05) witnessScript = val;
  }
  return { unsignedTx, witnessUtxo, sighashType, witnessScript };
}

// Parse the legacy (non-witness) unsigned tx into byte regions we can splice a witness into
// without disturbing any txid-relevant byte. Requires exactly one input.
function parseUnsignedTx(tx) {
  let o = 4;
  const ri = readVarint(tx, o); o = ri.o; if (ri.n !== 1) throw new Error('HTLC spend must have exactly one input');
  const outpoint = tx.slice(o, o + 36); o += 36;
  const rs = readVarint(tx, o); o = rs.o; o += rs.n;                 // (empty) scriptSig
  const sequence = tx.slice(o, o + 4); o += 4;
  const vinEnd = o;
  const rv = readVarint(tx, o); o = rv.o; const vout = rv.n;
  const outStart = o;
  for (let i = 0; i < vout; i++) { o += 8; const r = readVarint(tx, o); o = r.o; o += r.n; }
  const outEnd = o;
  const locktime = tx.slice(o, o + 4); o += 4;
  if (o !== tx.length) throw new Error('trailing bytes after unsigned tx');
  return {
    version: tx.slice(0, 4),
    vinSection: tx.slice(4, vinEnd),                 // varint(count=1) + the input
    voutSection: tx.slice(vinEnd, outEnd),           // varint(count) + outputs
    outputsSerialized: tx.slice(outStart, outEnd),   // outputs WITHOUT the count (for hashOutputs)
    locktime, outpoint, sequence,
  };
}

// Parse + strictly validate the HTLC witnessScript against the exact Olesia template.
export function parseHtlcScript(s) {
  if (!(s instanceof Uint8Array) || s.length < 40) throw new Error('HTLC script too short');
  if (s[0] !== 0x63 || s[1] !== 0xa8 || s[2] !== 0x20) throw new Error('not an Olesia HTLC (OP_IF/OP_SHA256/push32)');
  const hashlock = s.slice(3, 35);
  if (s[35] !== 0x88 || s[36] !== 0x21) throw new Error('bad HTLC (OP_EQUALVERIFY/push33)');
  const redeemPub = s.slice(37, 70);
  if (s[70] !== 0xac || s[71] !== 0x67) throw new Error('bad HTLC (OP_CHECKSIG/OP_ELSE)');
  const rl = s[72];
  const refundHeight = leNum(s.slice(73, 73 + rl));
  let p = 73 + rl;
  if (s[p] !== 0xb1 || s[p + 1] !== 0x75 || s[p + 2] !== 0x21) throw new Error('bad HTLC (CLTV/DROP/push33)');
  const refundPub = s.slice(p + 3, p + 3 + 33); p += 3 + 33;
  if (s[p] !== 0xac || s[p + 1] !== 0x68) throw new Error('bad HTLC (OP_CHECKSIG/OP_ENDIF)');
  if (p + 2 !== s.length) throw new Error('HTLC script has trailing bytes');
  return { hashlock, redeemPub, refundHeight, refundPub };
}

// Find the wallet private key whose compressed pubkey equals `wantPub`, scanning BIP-84
// receive (chain 0) + change (chain 1) up to `gap`. Returns { privKey, chain, index } or null.
function findWalletKey({ mnemonic, passphrase, network, wantPub, gap }) {
  for (const chain of [0, 1]) {
    for (let index = 0; index <= gap; index++) {
      const k = deriveKey(mnemonic, passphrase || '', network, index, chain);
      const pub = secp256k1.getPublicKey(k.privKey, true);
      if (eq(pub, wantPub)) return { privKey: k.privKey, chain, index };
    }
  }
  return null;
}

// Describe an HTLC-spend PSBT from FIRST PRINCIPLES (never trusting the swap's describe): what
// branch, how much, to where, whether this wallet can sign it. For the WYSIWYS review.
export function describeHtlcSpend({ psbtBase64, network, mnemonic = null, passphrase = '', gap = 50 }) {
  const { unsignedTx, witnessUtxo, sighashType, witnessScript } = parsePsbt(base64.decode(psbtBase64.trim()));
  if (!witnessScript) throw new Error('PSBT input is missing its witnessScript (not an HTLC spend)');
  if (!witnessUtxo) throw new Error('PSBT input is missing its witnessUtxo (value cannot be verified)');
  if (!sighashType || leNum(sighashType) !== 0x01) throw new Error('HTLC spend must use SIGHASH_ALL');
  const htlc = parseHtlcScript(witnessScript);
  const u = parseUnsignedTx(unsignedTx);
  // witnessUtxo = amount(8 LE) + varint(scriptLen) + scriptPubKey; verify it is P2WSH(witnessScript)
  const amount8 = witnessUtxo.slice(0, 8);
  const rs = readVarint(witnessUtxo, 8); const spk = witnessUtxo.slice(rs.o, rs.o + rs.n);
  if (!(spk.length === 34 && spk[0] === 0x00 && spk[1] === 0x20 && eq(spk.slice(2), sha256(witnessScript))))
    throw new Error('input scriptPubKey is not the P2WSH of this witnessScript');
  const lt = leNum(u.locktime), seq = leNum(u.sequence);
  let branch;
  if (lt === 0) branch = 'redeem';
  else if (lt === htlc.refundHeight && seq <= 0xfffffffe) branch = 'refund';
  else throw new Error('ambiguous branch: locktime does not match a redeem (0) or the refund height');
  const wantPub = branch === 'redeem' ? htlc.redeemPub : htlc.refundPub;
  const ours = mnemonic ? findWalletKey({ mnemonic, passphrase, network, wantPub, gap }) : null;
  // outputs, decoded minimally for display
  const outputs = [];
  let oo = 0; const rvc = readVarint(u.voutSection, oo); oo = rvc.o;
  for (let i = 0; i < rvc.n; i++) {
    const value = leNum(u.voutSection.slice(oo, oo + 8)); oo += 8;
    const r = readVarint(u.voutSection, oo); oo = r.o; const script = u.voutSection.slice(oo, oo + r.n); oo += r.n;
    outputs.push({ value, scriptHex: bytesToHex(script) });
  }
  return {
    branch, network,
    amount: leNum(amount8),
    hashlockHex: bytesToHex(htlc.hashlock),
    refundHeight: htlc.refundHeight,
    locktime: lt,
    outputs,
    intentTxid: bytesToHex(Uint8Array.from(dsha(unsignedTx)).reverse()),
    mine: !!ours, keyPath: ours ? `m/84'/coin'/0'/${ours.chain}/${ours.index}` : null,
    signerPubHex: bytesToHex(wantPub),
  };
}

// Sign a single-input HTLC-spend PSBT and return the finalized raw transaction.
// - refund: fully self-contained (no secret needed).
// - redeem: needs the 32-byte swap secret (secretHex); the contract says the swap page provides
//   it in `describe.secret` only when it is already safe to reveal. We verify sha256(secret)==H.
export function signHtlcSpend({ psbtBase64, network, mnemonic, passphrase = '', secretHex = null, gap = 50 }) {
  const bytes = base64.decode(psbtBase64.trim());
  const { unsignedTx, witnessUtxo, sighashType, witnessScript } = parsePsbt(bytes);
  if (!witnessScript || !witnessUtxo) throw new Error('PSBT input missing witnessScript/witnessUtxo');
  if (!sighashType || leNum(sighashType) !== 0x01) throw new Error('HTLC spend must use SIGHASH_ALL');
  const htlc = parseHtlcScript(witnessScript);
  const u = parseUnsignedTx(unsignedTx);
  const amount8 = witnessUtxo.slice(0, 8);
  const rs = readVarint(witnessUtxo, 8); const spk = witnessUtxo.slice(rs.o, rs.o + rs.n);
  if (!(spk.length === 34 && spk[0] === 0x00 && spk[1] === 0x20 && eq(spk.slice(2), sha256(witnessScript))))
    throw new Error('input scriptPubKey is not the P2WSH of this witnessScript');

  const lt = leNum(u.locktime), seq = leNum(u.sequence);
  let branch;
  if (lt === 0) branch = 'redeem';
  else if (lt === htlc.refundHeight && seq <= 0xfffffffe) branch = 'refund';
  else throw new Error('ambiguous branch: locktime does not match a redeem (0) or the refund height');

  const wantPub = branch === 'redeem' ? htlc.redeemPub : htlc.refundPub;
  const ours = findWalletKey({ mnemonic, passphrase, network, wantPub, gap });
  if (!ours) throw new Error(`refusing to sign: the ${branch} key for this HTLC is not in this wallet`);

  let secret = null;
  if (branch === 'redeem') {
    if (!secretHex) throw new Error('redeem requires the 32-byte swap secret (secretHex) — the swap must reveal it');
    secret = hexToBytes(String(secretHex).trim());
    if (secret.length !== 32) throw new Error('swap secret must be 32 bytes');
    if (!eq(sha256(secret), htlc.hashlock)) throw new Error('provided secret does not hash to this HTLC hashlock');
  }

  // BIP-143 sighash (single input, SIGHASH_ALL). scriptCode = the witnessScript (length-prefixed).
  const scriptCode = concatBytes(varint(witnessScript.length), witnessScript);
  const hashPrevouts = dsha(u.outpoint);
  const hashSequence = dsha(u.sequence);
  const hashOutputs = dsha(u.outputsSerialized);
  const preimage = concatBytes(u.version, hashPrevouts, hashSequence, u.outpoint, scriptCode, amount8, u.sequence, hashOutputs, u.locktime, u32le(0x01));
  const sig = secp256k1.sign(dsha(preimage), ours.privKey, { lowS: true }).toDERRawBytes();
  const sigHt = concatBytes(sig, Uint8Array.of(0x01));   // + SIGHASH_ALL

  const stack = branch === 'redeem'
    ? [sigHt, secret, Uint8Array.of(0x01), witnessScript]
    : [sigHt, new Uint8Array(0), witnessScript];
  const witness = concatBytes(varint(stack.length), ...stack.map((it) => concatBytes(varint(it.length), it)));

  // Reassemble the segwit tx by SPLICING the witness in — non-witness bytes are byte-identical to
  // the PSBT's unsigned tx, so the txid is preserved by construction.
  const finalTx = concatBytes(u.version, Uint8Array.of(0x00, 0x01), u.vinSection, u.voutSection, witness, u.locktime);
  const txid = bytesToHex(Uint8Array.from(dsha(unsignedTx)).reverse());
  return { signedTxHex: bytesToHex(finalTx), txid, branch, keyPath: `m/84'/coin'/0'/${ours.chain}/${ours.index}` };
}
