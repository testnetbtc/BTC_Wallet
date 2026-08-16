// Encrypted on-device seed vault. Lets the wallet persist between visits the
// honest way: the seed is encrypted under a user PIN/passphrase with
// scrypt (key stretching) + XChaCha20-Poly1305 (authenticated encryption) —
// the same audited primitives as the cold generator's backup files. Only the
// ciphertext blob is ever handed to storage; plaintext exists in memory only,
// after a successful unlock. Wrong PIN = authentication failure, not garbage.
import { scrypt } from '@noble/hashes/scrypt';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/hashes/utils';
import { utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils';
import { base64 } from '@scure/base';
import { wordlist } from '@scure/bip39/wordlists/english';

// scrypt cost: N=2^15 keeps unlock ~0.5s on a phone while still making a
// short-PIN brute force expensive; the salt is per-vault so no rainbow tables.
const KDF = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 };

// KDF cost slows an offline guessing attack but cannot rescue a low-entropy
// secret. A 6-digit PIN is ~20 bits: fine for worthless testnet coins, unsafe as
// the SOLE protection over a mainnet seed that an attacker can copy and grind
// offline. So mainnet persistence requires real entropy (see requireStrong).
export const BITS_PER_WORD = Math.log2(wordlist.length); // 11 (2048-word list)
export const MAINNET_MIN_BITS = 60;

// A Diceware-style passphrase from the BIP-39 wordlist. Entropy is EXACT and
// defensible: nWords * log2(2048) bits (6 words = 66 bits). 2^32 is an exact
// multiple of 2048, so `% 2048` introduces no modulo bias.
export function generateVaultPassphrase(nWords = 6) {
  const idx = new Uint32Array(nWords);
  (globalThis.crypto || crypto).getRandomValues(idx);
  return {
    phrase: Array.from(idx, (i) => wordlist[i % wordlist.length]).join(' '),
    bits: Math.round(nWords * BITS_PER_WORD),
    words: nWords,
  };
}

// Honest strength assessment — no invented numbers.
// - A space-separated run of BIP-39 words has EXACT entropy (words * 11 bits).
// - Any other secret's entropy is unverifiable, so we do NOT claim a bit count;
//   we gate it on structure (length + character classes) and say so.
export function secretStrength(secret) {
  const s = String(secret || '');
  const toks = s.trim().split(/\s+/).filter(Boolean);
  const allWords = toks.length >= 2 && toks.every((t) => wordlist.includes(t.toLowerCase()));
  if (allWords) return { kind: 'passphrase', bits: Math.round(toks.length * BITS_PER_WORD), words: toks.length, verifiable: true };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
  return { kind: 'typed', bits: null, verifiable: false, length: s.length, classes };
}

// Does this secret meet the bar to protect a MAINNET seed on disk?
export function meetsMainnetBar(secret) {
  const st = secretStrength(secret);
  if (st.kind === 'passphrase') return st.bits >= MAINNET_MIN_BITS; // e.g. >= 6 words
  return st.length >= 12 && st.classes >= 3; // typed: structural floor, entropy unverifiable
}

export function sealSeed(mnemonic, pin, { requireStrong = false } = {}) {
  if (!pin || String(pin).length < 6) throw new Error('choose a PIN or passphrase of at least 6 characters');
  if (requireStrong && !meetsMainnetBar(pin))
    throw new Error('a mainnet wallet needs a strong secret — use a generated passphrase (6+ words) or a 12+ character mixed password, not a short PIN');
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = scrypt(utf8ToBytes(String(pin)), salt, KDF);
  const ct = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(mnemonic));
  return JSON.stringify({ v: 1, kdf: 'scrypt-32768-8-1', salt: base64.encode(salt), nonce: base64.encode(nonce), ct: base64.encode(ct) });
}

// Fixed vault geometry — the sealer always writes a 16-byte salt and a 24-byte XChaCha20
// nonce, and the plaintext is a short JSON-wrapped mnemonic. Anything outside these bounds is
// a corrupt or hostile blob, not a wrong PIN.
const SALT_LEN = 16, NONCE_LEN = 24, CT_MIN = 16, CT_MAX = 4096;

export function openSeed(blobJson, pin) {
  let b;
  try { b = JSON.parse(blobJson); } catch { throw new Error('saved wallet data is corrupted'); }
  if (!b || typeof b !== 'object') throw new Error('saved wallet data is corrupted');
  if (b.v !== 1) throw new Error(`unsupported vault version ${b.v}`);
  // L11 — validate the blob's STRUCTURE before spending any work on it. Without this an
  // attacker-inflated salt (e.g. 16 MB) would be base64-decoded and fed into scrypt, turning
  // every unlock into a multi-second DoS. The params are fixed, so we bound the ENCODED string
  // lengths first (truly O(1), never even decoding a giant field), then the decoded lengths.
  // Library decode/length errors are normalized to one message — never raw internals.
  const sS = String(b.salt || ''), nS = String(b.nonce || ''), cS = String(b.ct || '');
  if (sS.length > 64 || nS.length > 64 || cS.length > (CT_MAX * 2))
    throw new Error('saved wallet data is corrupted');
  let salt, nonce, ct;
  try { salt = base64.decode(sS); nonce = base64.decode(nS); ct = base64.decode(cS); }
  catch { throw new Error('saved wallet data is corrupted'); }
  if (salt.length !== SALT_LEN || nonce.length !== NONCE_LEN || ct.length < CT_MIN || ct.length > CT_MAX)
    throw new Error('saved wallet data is corrupted');
  const key = scrypt(utf8ToBytes(String(pin || '')), salt, KDF);
  try {
    return bytesToUtf8(xchacha20poly1305(key, nonce).decrypt(ct));
  } catch {
    throw new Error('wrong PIN (or the saved data was tampered with)');
  }
}
