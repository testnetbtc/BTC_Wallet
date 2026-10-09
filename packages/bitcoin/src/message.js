// Signed messages: prove that whoever holds an address's key wrote a given text — "proof of
// ownership" for an exchange, a landlord, an auditor, a proof of reserves.
//
// Two formats, chosen by the address type so the result is verifiable by the widest set of
// other software:
//   * Legacy `1…` (p2pkh): the original "Bitcoin Signed Message" recoverable-ECDSA format that
//     Bitcoin Core's `signmessage` / `verifymessage` and every wallet since 2011 understand.
//   * SegWit `bc1q…` (p2wpkh): BIP-322 "simple" — the signature is the witness of a virtual
//     transaction (to_sign) that spends a virtual output (to_spend) committing to the message.
//     Sparrow, BlueWallet, Ledger, bip322-js and others verify it; Bitcoin Core cannot yet.
//
// Verification accepts both of the above, plus the BIP-137 variants (Electrum/Trezor sign a
// bc1q address with the legacy recoverable format under header bytes 35–42) and the BIP-322
// "full" encoding (the whole to_sign transaction). It never trusts the header byte: it recovers
// the public key and checks that it really produces the stated address.
//
// All arithmetic is @noble/curves; transaction serialisation and the BIP-143 sighash are
// @scure/btc-signer, exactly as the wallet's spends use them.
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { utf8ToBytes, concatBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { base64 } from '@scure/base';
import { net } from './networks.js';

export const MESSAGE_MAX = 4096;   // bytes; a proof is a sentence, not a document

const hash160 = (b) => ripemd160(sha256(b));
const dsha = (b) => sha256(sha256(b));
const varint = (n) => {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
};
const varstr = (b) => concatBytes(varint(b.length), b);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function messageBytes(message) {
  if (typeof message !== 'string') throw new Error('the message must be text');
  const b = utf8ToBytes(message);
  if (b.length > MESSAGE_MAX) throw new Error(`the message is too long (${b.length} bytes; the limit is ${MESSAGE_MAX})`);
  return b;
}

// Decode an address into { type, hash/program } for the given network; throws on anything else.
export function decodeAddress(address, network = 'mainnet') {
  const n = net(network).btc;
  let d;
  try { d = btc.Address(n).decode(String(address || '').trim()); } catch { throw new Error(`that is not a valid ${network} address`); }
  if (d.type === 'pkh') return { type: 'p2pkh', hash: d.hash };
  if (d.type === 'wpkh') return { type: 'p2wpkh', hash: d.hash };
  if (d.type === 'sh') return { type: 'p2sh', hash: d.hash };
  if (d.type === 'tr') return { type: 'p2tr', hash: d.pubkey };
  return { type: d.type, hash: null };
}
function scriptOf(address, network) { return btc.OutScript.encode(btc.Address(net(network).btc).decode(String(address).trim())); }

// Does this public key produce this address? (p2pkh, p2wpkh, p2sh-p2wpkh)
function pubkeyMatches(pub, dec) {
  if (dec.type === 'p2pkh' || dec.type === 'p2wpkh') return eq(hash160(pub), dec.hash);
  if (dec.type === 'p2sh') { if (pub.length !== 33) return false; const redeem = concatBytes(Uint8Array.of(0x00, 0x14), hash160(pub)); return eq(hash160(redeem), dec.hash); }
  return false;
}

// ------------------------------------------------------------------ legacy "Bitcoin Signed Message"
const MAGIC = utf8ToBytes('Bitcoin Signed Message:\n');
export function legacyMessageHash(message) { return dsha(concatBytes(varstr(MAGIC), varstr(messageBytes(message)))); }

export function signLegacy({ privKey, compressed = true, message }) {
  const sig = secp256k1.sign(legacyMessageHash(message), privKey, { lowS: true });
  const header = 27 + sig.recovery + (compressed ? 4 : 0);
  return base64.encode(concatBytes(Uint8Array.of(header), sig.toCompactRawBytes()));
}

function verifyLegacyBytes(raw, message, dec) {
  if (raw.length !== 65) return { ok: false, reason: 'a legacy signature is 65 bytes' };
  const header = raw[0];
  if (header < 27 || header > 42) return { ok: false, reason: `unknown header byte ${header}` };
  const recovery = (header - 27) & 3, compressed = header >= 31;
  const hash = legacyMessageHash(message);
  let pub;
  try {
    const sig = secp256k1.Signature.fromCompact(raw.slice(1)).addRecoveryBit(recovery);
    pub = sig.recoverPublicKey(hash).toRawBytes(compressed);
    if (!secp256k1.verify(sig, hash, pub)) return { ok: false, reason: 'the signature does not verify' };
  } catch (e) { return { ok: false, reason: 'the signature is malformed (' + (e.message || e) + ')' }; }
  if (!pubkeyMatches(pub, dec)) return { ok: false, reason: 'the signature was made by a different key — it does not belong to this address' };
  const variant = header >= 39 ? 'BIP-137 (segwit header)' : header >= 35 ? 'BIP-137 (p2sh-segwit header)' : 'legacy';
  return { ok: true, format: variant, pubkey: bytesToHex(pub) };
}

// ------------------------------------------------------------------ BIP-322
const TAG = sha256(utf8ToBytes('BIP0322-signed-message'));
export function bip322MessageHash(message) { return sha256(concatBytes(TAG, TAG, messageBytes(message))); }

// to_spend: a virtual transaction whose one input commits to the message and whose one output
// is the address's script. to_sign spends it to OP_RETURN. Neither is ever valid on-chain.
function toSpend(message, scriptPubKey) {
  return btc.RawTx.encode({
    version: 0, lockTime: 0, segwitFlag: false,
    inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: concatBytes(Uint8Array.of(0x00, 0x20), bip322MessageHash(message)), sequence: 0 }],
    outputs: [{ amount: 0n, script: scriptPubKey }],
  });
}
function toSign(toSpendBytes, scriptPubKey) {
  const spendId = dsha(toSpendBytes).slice().reverse();   // txid as displayed (big-endian)
  const tx = new btc.Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });   // plain RFC-6979: byte-identical to the BIP-322 reference vectors
  tx.addInput({ txid: bytesToHex(spendId), index: 0, sequence: 0, witnessUtxo: { amount: 0n, script: scriptPubKey } });
  tx.addOutput({ amount: 0n, script: Uint8Array.of(0x6a) });
  return { tx, spendId };
}

export function signBip322({ privKey, address, message, network = 'mainnet' }) {
  const dec = decodeAddress(address, network);
  if (dec.type !== 'p2wpkh') throw new Error('BIP-322 signing here is for bc1q (p2wpkh) addresses');
  const pub = secp256k1.getPublicKey(privKey, true);
  if (!pubkeyMatches(pub, dec)) throw new Error('that key does not belong to this address');
  const spk = scriptOf(address, network);
  const { tx } = toSign(toSpend(message, spk), spk);
  tx.signIdx(privKey, 0, [btc.SigHash.ALL]);
  tx.finalizeIdx(0);
  const witness = tx.inputs[0].finalScriptWitness;
  if (!witness || witness.length !== 2) throw new Error('unexpected witness');
  return base64.encode(btc.RawWitness.encode(witness));
}

// Verify a BIP-322 simple (witness stack) or full (whole to_sign tx) signature for p2wpkh.
function verifyBip322Bytes(raw, message, address, network, dec) {
  if (dec.type !== 'p2wpkh') return { ok: false, reason: 'BIP-322 verification here covers bc1q (p2wpkh) addresses' };
  let witness = null, format = 'BIP-322 simple';
  try { witness = btc.RawWitness.decode(raw); } catch { /* maybe the full form */ }
  if (!witness) {
    try { const full = btc.RawTx.decode(raw); if (full.witnesses && full.witnesses.length === 1) { witness = full.witnesses[0]; format = 'BIP-322 full'; } }
    catch { return { ok: false, reason: 'this is neither a legacy signature nor a BIP-322 one' }; }
  }
  if (!witness || witness.length !== 2) return { ok: false, reason: 'a p2wpkh BIP-322 witness has two items (signature, public key)' };
  const [sigAll, pub] = witness;
  if (pub.length !== 33) return { ok: false, reason: 'the public key in the signature is not compressed' };
  if (!pubkeyMatches(pub, dec)) return { ok: false, reason: 'the signature was made by a different key — it does not belong to this address' };
  if (sigAll.length < 9 || sigAll[sigAll.length - 1] !== 0x01) return { ok: false, reason: 'the signature must use SIGHASH_ALL' };
  const spk = scriptOf(address, network);
  const { tx } = toSign(toSpend(message, spk), spk);
  const scriptCode = btc.OutScript.encode({ type: 'pkh', hash: hash160(pub) });
  const hash = tx.preimageWitnessV0(0, scriptCode, btc.SigHash.ALL, 0n);
  let ok = false;
  try { ok = secp256k1.verify(secp256k1.Signature.fromDER(sigAll.slice(0, -1)), hash, pub); } catch { ok = false; }
  return ok ? { ok: true, format, pubkey: bytesToHex(pub) } : { ok: false, reason: 'the signature does not verify for this message' };
}

// ------------------------------------------------------------------ public API
// Sign with the key of `address`. Picks the format from the address type.
export function signMessage({ privKey, compressed = true, address, message, network = 'mainnet' }) {
  const dec = decodeAddress(address, network);
  const pub = secp256k1.getPublicKey(privKey, compressed);
  if (!pubkeyMatches(pub, dec)) throw new Error('that key does not belong to this address');
  if (dec.type === 'p2pkh') return { signature: signLegacy({ privKey, compressed, message }), format: 'legacy' };
  if (dec.type === 'p2wpkh') return { signature: signBip322({ privKey, address, message, network }), format: 'BIP-322 simple' };
  throw new Error('signing is available for 1… and bc1q… addresses');
}

// Verify any supported signature for (address, message). Never throws for bad input: returns
// { ok:false, reason }. Returns { ok:true, format, pubkey } on success.
export function verifyMessage({ address, message, signature, network = 'mainnet' }) {
  let dec;
  try { dec = decodeAddress(address, network); messageBytes(message); } catch (e) { return { ok: false, reason: e.message }; }
  if (dec.type === 'p2tr') return { ok: false, reason: 'Taproot (bc1p…) signatures are not supported here' };
  let raw;
  // the 2025 revision of BIP-322 prefixes signatures with "smp" (simple) or "ful" (full); both are accepted
  let text = String(signature || '').replace(/\s+/g, '');
  const prefixed = /^(smp|ful)/.test(text); if (prefixed) text = text.slice(3);
  try { raw = base64.decode(text); } catch { return { ok: false, reason: 'the signature is not valid base64' }; }
  if (!raw.length) return { ok: false, reason: 'the signature is empty' };
  if (raw.length === 65 && raw[0] >= 27 && raw[0] <= 42) return verifyLegacyBytes(raw, message, dec);
  if (dec.type === 'p2pkh' || dec.type === 'p2sh') return { ok: false, reason: 'for this address type the signature must be the 65-byte legacy format' };
  return verifyBip322Bytes(raw, message, address, network, dec);
}

// The command a sceptic can run against their own Bitcoin Core node (legacy format only).
export function coreVerifyCommand({ address, message, signature, format }) {
  if (format !== 'legacy') return null;
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return `bitcoin-cli verifymessage ${q(address)} ${q(signature)} ${q(message)}`;
}

export { hexToBytes };
