// Olesia Vanity — pattern checking, exact difficulty, and the key search.
//
// A vanity address is found by brute force: generate keys, keep the first whose address starts
// with the wanted text. This module is deliberately plain:
//   * randomness: every search starts from 32 bytes of the platform CSPRNG, reduced mod n.
//     There are no seeds, passphrases, "rekey" modes or pseudo-random generators anywhere.
//   * arithmetic: @noble/curves field ops only (the wallet's existing library). The fast path is
//     the standard "batch of independent points, one inversion" trick on those ops; there is no
//     hand-written big-number code.
//   * every result is re-derived by a second path (secp256k1.getPublicKey → hash160 → the wallet's
//     own address encoder) and compared with the pattern before it is returned.
//   * difficulty is exact (counted from the real distribution of addresses), never 58^n.
// See docs/VANITY_DESIGN.md.
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { createBase58check } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { net } from './networks.js';

const b58check = createBase58check(sha256);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const N = secp256k1.CURVE.n;
export const TYPES = {
  p2wpkh: { label: 'SegWit', hrp: 'bc1q', maxChars: 32, charset: BECH32, example: 'bc1qjon…' },
  p2pkh:  { label: 'Legacy', hrp: '1',    maxChars: 33, charset: BASE58, example: '1Jon…' },
};
export const MAX_PATTERN = 12;   // longer than this is years of work on any hardware; refuse early

// ---- hash160 and the wallet's own encoders (the "second path") --------------------------------
export const hash160 = (b) => ripemd160(sha256(b));
export function addressOf(pubkey, type, network = 'mainnet') {
  const n = net(network).btc;
  return type === 'p2wpkh' ? btc.p2wpkh(pubkey, n).address : btc.p2pkh(pubkey, n).address;
}
/** Address for a hash160 directly (used by the sampling tests). */
export function addressFromHash160(h, type, network = 'mainnet') {
  return btc.Address(net(network).btc).encode(type === 'p2wpkh' ? { type: 'wpkh', hash: h } : { type: 'pkh', hash: h });
}
export function wifOf(privKey, network = 'mainnet') {
  return b58check.encode(concatBytes(Uint8Array.of(net(network).btc.wif), privKey, Uint8Array.of(1)));
}

// ---- exact probability that a random key's address starts with a pattern ---------------------
// Legacy: the address is Base58Check(0x00 ‖ hash160 ‖ checksum). The 0x00 becomes a leading '1';
// every further leading ZERO BYTE of the 24-byte body becomes another '1'; the remaining bytes are
// one big number V, written in base 58 with no leading zero digit. V is uniform, so the fraction of
// keys whose address begins with "1" + "1"*z + rest is
//     P(exactly z leading zero bytes) × P(base58(V) starts with rest)
// counted exactly with integers. (rest empty → at least z zero bytes.)
// SegWit: the characters after "bc1q" are the hash160 five bits at a time: exactly 32^-n.
function digitsValue(s) { let v = 0n; for (const c of s) v = v * 58n + BigInt(BASE58.indexOf(c)); return v; }
function b58PrefixRanges(rest, bytes) {
  // numeric ranges of V (top byte non-zero, `bytes` bytes long) whose base58 text starts with `rest`
  const top = 1n << BigInt(8 * bytes), floor = 1n << BigInt(8 * (bytes - 1));
  const n = rest.length, val = digitsValue(rest), out = [];
  for (let L = Math.max(n, 1); L <= 45; L++) {
    const p = 58n ** BigInt(L - n);
    const lo = max(val * p, 58n ** BigInt(L - 1), floor), hi = min((val + 1n) * p, 58n ** BigInt(L), top);
    if (hi > lo) out.push([lo, hi]);
  }
  return out;
}
const max = (...a) => a.reduce((x, y) => (x > y ? x : y)), min = (...a) => a.reduce((x, y) => (x < y ? x : y));
const SCALE = 1n << 64n;   // probabilities are returned as Number; computed as (count << 64) / space
function legacyProbability(afterOne) {
  // afterOne = the text after the leading '1'
  let z = 0; while (z < afterOne.length && afterOne[z] === '1') z++;
  const rest = afterOne.slice(z);
  const zeroBytesExactly = (255n * SCALE) / (256n ** BigInt(z + 1));        // (255/256)·256^-z
  const zeroBytesAtLeast = SCALE / (256n ** BigInt(z));
  if (rest.length === 0) return Number(zeroBytesAtLeast) / Number(SCALE);
  const bytes = 24 - z;
  if (bytes < 1) return 0;
  const space = (1n << BigInt(8 * bytes)) - (1n << BigInt(8 * (bytes - 1)));  // V with non-zero top byte
  const count = b58PrefixRanges(rest, bytes).reduce((s, [lo, hi]) => s + (hi - lo), 0n);
  return Number((zeroBytesExactly * count) / space) / Number(SCALE);
}
function legacyIntervals64(afterOne) {
  // coarse filter for the hot loop: intervals of the TOP 64 BITS of hash160 that can match
  // (widened at the edges; exact check follows by encoding the candidate)
  let z = 0; while (z < afterOne.length && afterOne[z] === '1') z++;
  const rest = afterOne.slice(z), bytes = 24 - z;
  if (bytes < 1) return [];
  if (rest.length === 0) return [[0n, z >= 8 ? 0n : (1n << BigInt(64 - 8 * z)) - 1n]];   // at least z zero bytes
  // V occupies the low 8·bytes bits of the 192-bit body; hash160 is the top 160 bits of the body
  return b58PrefixRanges(rest, bytes).map(([lo, hi]) => [lo >> 128n, (hi - 1n) >> 128n]);  // 192-64 = 128
}

// ---- pattern analysis ---------------------------------------------------------------------------
const LEGACY_SWAPS = { '0': 'o', 'O': 'o', 'I': 'i', 'l': 'L' };
const BECH_SWAPS = { 'b': '6', 'i': 'j', 'o': '0', '1': 'l', 'B': '8', 'I': 'j', 'O': '0' };
function caseVariants(s) {
  // all upper/lower variants of s that are valid Base58 (ignore-case search for Legacy)
  let out = [''];
  for (const c of s) {
    const alts = new Set([c, c.toLowerCase(), c.toUpperCase()].filter((x) => BASE58.includes(x)));
    const next = [];
    for (const p of out) for (const a of alts) next.push(p + a);
    out = next;
    if (out.length > 4096) throw new Error('too many case combinations — shorten the text or match the case exactly');
  }
  return out;
}
function human(n) {
  if (!isFinite(n)) return '∞';
  if (n < 1e3) return String(Math.round(n));
  const u = [['k', 1e3], ['million', 1e6], ['billion', 1e9], ['trillion', 1e12], ['quadrillion', 1e15]];
  for (let i = u.length - 1; i >= 0; i--) if (n >= u[i][1]) return (n / u[i][1]).toPrecision(3).replace(/\.?0+$/, '') + ' ' + u[i][0];
  return String(Math.round(n));
}
export function humanTime(seconds) {
  if (!isFinite(seconds)) return 'never';
  if (seconds < 1) return 'under a second';
  if (seconds < 90) return Math.round(seconds) + ' seconds';
  const m = seconds / 60; if (m < 90) return Math.round(m) + ' minutes';
  const h = m / 60; if (h < 48) return h.toFixed(1).replace(/\.0$/, '') + ' hours';
  const d = h / 24; if (d < 60) return d.toFixed(1).replace(/\.0$/, '') + ' days';
  const y = d / 365.25; if (y < 1000) return y.toFixed(1).replace(/\.0$/, '') + ' years';
  return 'thousands of years';
}

/** Check a wanted text for an address type. Never throws; returns {ok, errors, suggestions, …}. */
export function analyzePattern({ type = 'p2wpkh', text = '', ignoreCase = false } = {}) {
  const t = TYPES[type]; if (!t) return { ok: false, errors: ['unknown address type'] };
  let s = String(text || '').trim();
  const errors = [], notes = [], suggestions = [];
  // `text` is what comes AFTER the fixed prefix (bc1q / 1). A typed "bc1q" is tolerated ("b" is not
  // in the bech32 alphabet, so it is unambiguous); a leading "1" for Legacy is NOT stripped — it
  // means a zero byte ("11…"). Callers holding a full pattern strip the first "1" themselves.
  if (type === 'p2wpkh' && /^bc1q/i.test(s)) s = s.slice(4);
  const suggest = (text2, why) => {
    if (!text2 || suggestions.some((x) => x.text === text2)) return;
    const a = analyzePattern({ type, text: text2, ignoreCase });
    if (a.ok) suggestions.push({ text: a.display, why, difficulty: a.difficulty });
  };
  if (!s.length) return { ok: false, type, errors: ['type the characters you want after ' + t.hrp], suggestions: [], difficulty: 1, display: t.hrp };
  if (s.length > MAX_PATTERN) { errors.push(`${s.length} characters is beyond any practical search — ${MAX_PATTERN} is the most this tool will attempt`); suggest(s.slice(0, 6), 'the first 6 characters'); }
  if (type === 'p2wpkh') {
    const lower = s.toLowerCase();
    if (s !== lower) { errors.push('SegWit addresses are always lower-case'); suggest(lower, 'in lower-case'); }
    const bad = [...new Set([...lower].filter((c) => !BECH32.includes(c)))];
    if (bad.length) {
      errors.push(`SegWit addresses never contain ${bad.map((c) => `"${c}"`).join(', ')} (the alphabet is ${BECH32})`);
      const swapped = [...lower].map((c) => (BECH32.includes(c) ? c : (BECH_SWAPS[c] || ''))).join('');
      if (swapped !== lower) suggest(swapped, 'with look-alike characters swapped');
      suggest([...lower].filter((c) => BECH32.includes(c)).join(''), 'with the impossible characters removed');
    }
    if (errors.length) return { ok: false, type, errors, notes, suggestions, display: t.hrp + s };
    const probability = 32 ** -s.length;
    return { ok: true, type, display: t.hrp + s, text: s, ignoreCase: false, probability, difficulty: 1 / probability,
             difficultyHuman: human(1 / probability), notes, suggestions, matcher: { kind: 'bech32', text: s } };
  }
  // ---- legacy ----
  const bad = [...new Set([...s].filter((c) => !BASE58.includes(c)))];
  if (bad.length) {
    errors.push(`Legacy addresses never contain ${bad.map((c) => `"${c}"`).join(', ')} (0, O, I and l are left out of Base58 so they cannot be confused)`);
    const swapped = [...s].map((c) => (BASE58.includes(c) ? c : (LEGACY_SWAPS[c] || ''))).join('');
    if (swapped !== s) suggest(swapped, 'with look-alike characters swapped');
    suggest([...s].filter((c) => BASE58.includes(c)).join(''), 'with the impossible characters removed');
    return { ok: false, type, errors, notes, suggestions, display: t.hrp + s };
  }
  let variants;
  try { variants = ignoreCase ? caseVariants(s) : [s]; } catch (e) { return { ok: false, type, errors: [e.message], notes, suggestions, display: t.hrp + s }; }
  const probs = variants.map((v) => legacyProbability(v));
  const probability = probs.reduce((a, b) => a + b, 0);
  if (probability === 0) {
    errors.push('no Legacy address can start with this text');
    return { ok: false, type, errors, notes, suggestions, display: t.hrp + s };
  }
  // the second character: in the usual 34-character form it can only be 2…Q; others exist only in
  // the rarer 33-character form, which costs about ×58 more
  const second = s[0];
  if (second !== '1' && BASE58.indexOf(second) > 23) {
    notes.push(`addresses starting "1${second}" only exist in the shorter 33-character form, so this is about 60× harder than a text starting with 2…Q`);
  }
  if (s.startsWith('1')) notes.push('each extra "1" at the start is a zero byte in the hash — about 256× harder per "1"');
  if (!ignoreCase && /[A-Za-z]/.test(s)) {
    const a = analyzePattern({ type, text: s, ignoreCase: true });
    if (a.ok && a.difficulty < 1 / probability) suggestions.push({ text: a.display, why: 'ignoring upper/lower case', difficulty: a.difficulty, ignoreCase: true });
  }
  return { ok: true, type, display: t.hrp + s, text: s, ignoreCase: !!ignoreCase, probability, difficulty: 1 / probability,
           difficultyHuman: human(1 / probability), notes, suggestions,
           matcher: { kind: 'legacy', variants, intervals: mergeIntervals(variants.flatMap(legacyIntervals64)), ignoreCase: !!ignoreCase } };
}
function mergeIntervals(list) {
  const s = list.map(([a, b]) => [a, b]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const out = [];
  for (const iv of s) { const last = out[out.length - 1]; if (last && iv[0] <= last[1] + 1n) { if (iv[1] > last[1]) last[1] = iv[1]; } else out.push(iv); }
  return out;
}

// ---- matching -----------------------------------------------------------------------------------
/** Build a fast test on a hash160 (Uint8Array(20)). Returns true only for candidates that MAY match;
 *  the exact string test is `finalMatch`. */
export function compileMatcher(m) {
  if (m.kind === 'bech32') {
    // the text is the top 5·n bits of hash160, read big-endian five bits at a time
    const n = m.text.length, bits = 5 * n, want = new Uint8Array(20), mask = new Uint8Array(20);
    let acc = 0n;
    for (const c of m.text) acc = (acc << 5n) | BigInt(BECH32.indexOf(c));
    acc <<= BigInt(160 - bits);
    for (let i = 19; i >= 0; i--) { want[i] = Number(acc & 0xffn); acc >>= 8n; }
    for (let b = 0; b < bits; b++) mask[b >> 3] |= 0x80 >> (b & 7);
    const nb = (bits + 7) >> 3;
    return (h) => { for (let i = 0; i < nb; i++) if ((h[i] & mask[i]) !== want[i]) return false; return true; };
  }
  const iv = m.intervals;   // sorted, disjoint [lo, hi] over the top 64 bits of hash160
  if (!iv.length) return () => false;
  const dv = (h) => new DataView(h.buffer, h.byteOffset, 8).getBigUint64(0);
  return (h) => {
    const v = dv(h); let lo = 0, hi = iv.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; const [a, b] = iv[mid]; if (v < a) hi = mid - 1; else if (v > b) lo = mid + 1; else return true; }
    return false;
  };
}
export function finalMatch(address, analysis) {
  const a = analysis;
  if (a.type === 'p2wpkh') return address.startsWith('bc1q' + a.text);
  const body = address.slice(1);
  return a.matcher.variants.some((v) => body.startsWith(v));
}

// ---- the search ---------------------------------------------------------------------------------
const Fp = secp256k1.CURVE.Fp, Point = secp256k1.ProjectivePoint;
let TABLE = null, TABLE_SIZE = 0;
function table(size) {
  if (TABLE && TABLE_SIZE === size) return TABLE;
  // T[i] = (i+1)·G as affine BigInt pairs, i = 0..size-1 — built once per worker
  const pts = []; let q = Point.BASE;
  for (let i = 0; i < size; i++) { pts.push(q); q = q.add(Point.BASE); }
  // toAffine() per entry (not normalizeZ: in @noble/curves 1.9 it normalises x but not y)
  TABLE = pts.map((q) => { const a = q.toAffine(); return [a.x, a.y]; }); TABLE_SIZE = size;
  return TABLE;
}
function randomScalar(randomBytes) {
  // 32 CSPRNG bytes reduced mod n (bias 2^-128, standard); never 0
  for (;;) { const k = BigInt('0x' + bytesToHex(randomBytes(32))) % N; if (k > 0n) return k; }
}
function compressed(x, y) {
  const out = new Uint8Array(33); out[0] = (y & 1n) ? 3 : 2;
  let v = x; for (let i = 32; i >= 1; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

/**
 * Create a search. `randomBytes(n)` must be a CSPRNG (crypto.getRandomValues wrapper or node:crypto).
 * step(count) advances about `count` keys and returns {found} or null. Pure CPU; call it in a worker.
 */
export function createSearch({ analysis, randomBytes, batch = 1024, network = 'mainnet', startPoint = null }) {
  if (!analysis || !analysis.ok) throw new Error('pattern is not searchable');
  const T = table(batch), quick = compileMatcher(analysis.matcher);
  // SPLIT-KEY: with `startPoint` (someone else's public key A, compressed hex) the walk is over
  // A + k·G and what is found is the OFFSET k — useless on its own; only the holder of A's secret
  // can turn it into a key (splitKeyFinish). Without it the walk is over k·G and k is the key.
  const A = startPoint ? Point.fromHex(startPoint) : null;
  if (A) A.assertValidity();
  let k = randomScalar(randomBytes);
  const pointFor = (scalar) => (A ? A.add(Point.BASE.multiply(scalar)) : Point.BASE.multiply(scalar)).toAffine();
  let P = pointFor(k); let px = P.x, py = P.y;
  let tried = 0n;
  const verify = (key) => {                                   // THE SECOND PATH — nothing from above
    const kb = new Uint8Array(32); let v = key; for (let i = 31; i >= 0; i--) { kb[i] = Number(v & 0xffn); v >>= 8n; }
    if (!secp256k1.utils.isValidPrivateKey(kb)) return null;
    const pub = A ? A.add(Point.BASE.multiply(key)).toRawBytes(true) : secp256k1.getPublicKey(kb, true);
    const address = addressOf(pub, analysis.type, network);
    if (!finalMatch(address, analysis)) return null;
    if (A) return { offset: kb, pubkey: pub, address, type: analysis.type };
    return { privKey: kb, pubkey: pub, address, wif: wifOf(kb, network), type: analysis.type };
  };
  function step(count = batch) {
    for (let done = 0; done < count; done += batch) {
      const dx = new Array(batch);
      for (let i = 0; i < batch; i++) dx[i] = Fp.sub(T[i][0], px);
      if (dx.some((d) => d === 0n)) { k = randomScalar(randomBytes); P = pointFor(k); px = P.x; py = P.y; continue; }   // P = ±(i+1)G: astronomically rare; restart
      const inv = Fp.invertBatch(dx);
      let lx = 0n, ly = 0n;
      for (let i = 0; i < batch; i++) {
        const lam = Fp.mul(Fp.sub(T[i][1], py), inv[i]);
        const x = Fp.sub(Fp.sub(Fp.sqr(lam), px), T[i][0]);
        const y = Fp.sub(Fp.mul(lam, Fp.sub(px, x)), py);
        const h = hash160(compressed(x, y));
        if (quick(h)) {
          const r = verify((k + BigInt(i + 1)) % N);
          if (r) { tried += BigInt(i + 1); return { found: r, tried }; }
        }
        if (i === batch - 1) { lx = x; ly = y; }
      }
      px = lx; py = ly; k = (k + BigInt(batch)) % N; tried += BigInt(batch);
    }
    return null;
  }
  return { step, get tried() { return tried; } };
}

// ---- split-key: a server (or anyone) searches without ever being able to learn the key ---------
// Client: {secret a, public A = a·G} = splitKeyStart(). Send only A. The searcher returns an offset
// i with address(A + i·G) matching. Client: k = a + i (mod n) — and re-derives the address itself.
const bytes32 = (v) => { const b = new Uint8Array(32); for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
export function splitKeyStart(randomBytes) {
  const a = randomScalar(randomBytes);
  return { secret: bytes32(a), pubkey: bytesToHex(Point.BASE.multiply(a).toRawBytes(true)) };
}
/** Combine the secret with a returned offset; refuses anything that does not produce a matching address. */
export function splitKeyFinish({ secret, offsetHex, analysis, network = 'mainnet', expectAddress = null }) {
  if (!/^[0-9a-f]{64}$/i.test(offsetHex || '')) throw new Error('the server returned a malformed offset');
  const a = BigInt('0x' + bytesToHex(secret)), i = BigInt('0x' + offsetHex);
  if (i <= 0n || i >= N) throw new Error('the server returned an offset out of range');
  const k = (a + i) % N;
  if (k === 0n) throw new Error('degenerate key');
  const kb = bytes32(k);
  const pub = secp256k1.getPublicKey(kb, true);                 // independent of the search entirely
  const address = addressOf(pub, analysis.type, network);
  if (!finalMatch(address, analysis)) throw new Error('the server returned an offset that does not produce the requested address — result refused');
  if (expectAddress && expectAddress !== address) throw new Error('the server reported a different address than the key produces — result refused');
  return { privKey: kb, pubkey: pub, address, wif: wifOf(kb, network), type: analysis.type };
}

/** Measure this machine's rate (keys/s, one thread) for the estimate. */
export function benchmark({ randomBytes, ms = 1500 }) {
  const a = analyzePattern({ type: 'p2wpkh', text: 'qqqqqqqqqqqq' });   // 32^-12: will not be found
  const s = createSearch({ analysis: a, randomBytes, batch: 512 });
  const t0 = Date.now(); let n = 0;
  while (Date.now() - t0 < ms) { s.step(512); n += 512; }
  return Math.round(n / ((Date.now() - t0) / 1000));
}

/** Estimate text for a difficulty at a rate (keys/s). Expected time, and a "very likely by" bound. */
export function estimate(difficulty, keysPerSecond) {
  if (!keysPerSecond) return null;
  const expected = difficulty / keysPerSecond;
  return { expectedSeconds: expected, expected: humanTime(expected), likely: humanTime(expected * 3), unlucky: humanTime(expected * 5),
           note: 'the search is random: half of all runs finish before the expected time, 95% within 3× it, and 1 in 150 takes longer than 5×' };
}
