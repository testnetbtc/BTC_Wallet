// Wallet-creation entropy. This is the most security-critical file in the wallet: a seed is
// only as strong as the randomness it came from, and weak browser randomness is exactly how
// the 2011–2015 generation of web wallets was drained.
//
// DESIGN (deliberately simple, so it can be audited line by line):
//   root    = 32 bytes from the operating system CSPRNG (crypto.getRandomValues)   <- the security
//   extras  = mouse/touch movement samples, optional dice rolls                    <- defence in depth
//   entropy = SHA-256( tag ‖ len‖root ‖ len‖SHA-256(mouse) ‖ len‖dice )
//
// Hashing independent sources together gives a result at least as unpredictable as the
// STRONGEST single source. So the extras can only help: if the CSPRNG is sound the seed is
// full strength regardless; if the CSPRNG were somehow broken, the mouse/dice still stand
// between the user and an attacker. Extras can never weaken the root.
//
// Every field is length-prefixed and the hash is domain-separated, so no two different
// (root, mouse, dice) inputs can serialize to the same bytes.
//
// 24 words = 256 bits of entropy; 12 words = 128 bits (the first 16 bytes of the same hash).
// A separate, explicit DICE-ONLY mode derives the seed from dice alone (SHA-256 of the roll
// string) so a user who distrusts all computer randomness can reproduce it by hand offline.
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, utf8ToBytes, bytesToHex } from '@noble/hashes/utils';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const TAG = utf8ToBytes('olesia/wallet-entropy/v1');
const u32be = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const lp = (b) => concatBytes(u32be(b.length), b);
const EMPTY = new Uint8Array(0);

export const WORDS_TO_BITS = { 12: 128, 24: 256 };
export const DICE_BITS_PER_ROLL = Math.log2(6);            // ≈ 2.585
// Rolls needed for dice ALONE to carry the full entropy of the phrase (industry convention:
// 99 rolls ≈ 255.9 bits for 24 words, 50 rolls ≈ 129.2 bits for 12 words).
export const DICE_ONLY_MIN_ROLLS = { 128: 50, 256: 99 };

function osRandom(n, rng) {
  const c = rng || globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('no cryptographic random number generator is available in this browser — cannot create a wallet');
  const b = new Uint8Array(n);
  c.getRandomValues(b);
  return b;
}

// Liveness / sanity check on the CSPRNG. It catches a GROSSLY broken generator — all zeros, a
// constant, a repeating output, a heavy bias. It CANNOT prove cryptographic quality (any
// competent PRNG passes); it exists so an obviously dead RNG can never silently mint a wallet.
export function rngHealth(rng) {
  let a, b, big;
  try { a = osRandom(32, rng); b = osRandom(32, rng); big = osRandom(4096, rng); }
  catch (e) { return { ok: false, reason: e.message }; }
  if (bytesToHex(a) === bytesToHex(b)) return { ok: false, reason: 'the random number generator returned the same value twice' };
  if (new Set(a).size < 8 || new Set(b).size < 8) return { ok: false, reason: 'the random number generator output is not varied enough' };
  let ones = 0; const seen = new Set();
  for (const v of big) { seen.add(v); let x = v; while (x) { ones += x & 1; x >>= 1; } }
  const bits = big.length * 8;
  const z = Math.abs(ones - bits / 2) / (0.5 * Math.sqrt(bits));
  if (z > 5) return { ok: false, reason: 'the random number generator output is biased' };
  if (seen.size < 250) return { ok: false, reason: 'the random number generator output is not varied enough' };
  return { ok: true, z, distinct: seen.size };
}

// Dice: accept digits 1–6 separated by anything whitespace-like or commas. Anything else is
// an error (a typo silently dropped would mislead the user about how many rolls counted).
export function normalizeDice(input) {
  const s = String(input == null ? '' : input).replace(/[\s,;.-]+/g, '');
  if (s && /[^1-6]/.test(s)) throw new Error('dice rolls may only contain the digits 1 to 6');
  return s;
}
export const diceBits = (rolls) => normalizeDice(rolls).length * DICE_BITS_PER_ROLL;

// Core mixer. `root` MUST be 32 CSPRNG bytes. Returns 32 bytes (256-bit) or 16 bytes (128-bit).
export function mixEntropy({ root, mouse = EMPTY, dice = '', bits = 256 }) {
  if (!(root instanceof Uint8Array) || root.length !== 32) throw new Error('entropy root must be exactly 32 bytes from the CSPRNG');
  if (bits !== 256 && bits !== 128) throw new Error('entropy must be 128 or 256 bits');
  if (!(mouse instanceof Uint8Array)) throw new Error('mouse samples must be bytes');
  const d = normalizeDice(dice);
  const h = sha256(concatBytes(TAG, lp(root), lp(sha256(mouse)), lp(utf8ToBytes(d))));
  return bits === 256 ? h : h.slice(0, 16);
}

// Dice-only entropy: SHA-256 over the ASCII roll string — reproducible by hand with any
// independent SHA-256 tool (`printf 123456… | sha256sum`), with NO computer randomness.
export function diceOnlyEntropy(dice, bits = 256) {
  if (bits !== 256 && bits !== 128) throw new Error('entropy must be 128 or 256 bits');
  const d = normalizeDice(dice);
  const need = DICE_ONLY_MIN_ROLLS[bits];
  if (d.length < need) throw new Error(`dice-only mode needs at least ${need} rolls for a ${bits === 256 ? 24 : 12}-word phrase (you entered ${d.length})`);
  const h = sha256(utf8ToBytes(d));
  return bits === 256 ? h : h.slice(0, 16);
}

// Create a new recovery phrase. `words` is 24 (default) or 12.
//   { words, mouse: Uint8Array, dice: string, diceOnly: boolean, rng? }
// Returns the mnemonic plus an honest description of what went into it.
export function createMnemonic({ words = 24, mouse = EMPTY, dice = '', diceOnly = false, rng } = {}) {
  const bits = WORDS_TO_BITS[words];
  if (!bits) throw new Error('a recovery phrase must be 12 or 24 words');
  const d = normalizeDice(dice);
  let entropy, sources;
  if (diceOnly) {
    entropy = diceOnlyEntropy(d, bits);
    sources = { csprng: false, mouseSamples: 0, diceRolls: d.length, diceOnly: true };
  } else {
    const health = rngHealth(rng);
    if (!health.ok) throw new Error(`refusing to create a wallet: ${health.reason}. Use dice-only mode or another device.`);
    const root = osRandom(32, rng);
    entropy = mixEntropy({ root, mouse, dice: d, bits });
    root.fill(0);
    sources = { csprng: true, mouseBytes: mouse.length, diceRolls: d.length, diceOnly: false };
  }
  const mnemonic = entropyToMnemonic(entropy, wordlist);
  const out = { mnemonic, bits, words, sources };
  entropy.fill(0);
  return out;
}
