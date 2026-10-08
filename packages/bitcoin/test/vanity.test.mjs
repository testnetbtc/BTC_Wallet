// Olesia Vanity — engine tests: pattern analysis, EXACT difficulty vs sampling, the search's
// hit rate vs theory, and the independence of the verification path.
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { analyzePattern, createSearch, benchmark, estimate, humanTime, addressOf, addressFromHash160, compileMatcher, finalMatch, hash160, MAX_PATTERN } from '../src/vanity.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(84), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const b58 = createBase58check(sha256);

// ---------------------------------------------------------------- analysis
const A = (type, text, ignoreCase = false) => analyzePattern({ type, text, ignoreCase });
ok('SegWit: lower-case bech32 text is accepted and prefixed with bc1q', A('p2wpkh', 'jn').ok && A('p2wpkh', 'jn').display === 'bc1qjn');
ok('SegWit: a typed "bc1q" prefix is tolerated', A('p2wpkh', 'bc1qjn').display === 'bc1qjn' && A('p2wpkh', 'BC1Qjn').ok);
ok('SegWit: difficulty is exactly 32^n', A('p2wpkh', 'jn').difficulty === 1024 && A('p2wpkh', 'j0n').difficulty === 32768);
ok('SegWit: "o", "i", "b", "1" are rejected with the reason and swaps', (() => { const a = A('p2wpkh', 'bob'); return !a.ok && /never contain/.test(a.errors[0]) && a.suggestions.some((s) => s.text === 'bc1q606'); })());
ok('SegWit: capitals rejected, lower-case version suggested', (() => { const a = A('p2wpkh', 'JN'); return !a.ok && a.suggestions.some((s) => s.text === 'bc1qjn'); })());
ok('Legacy: text is what follows the fixed "1"; a typed "1" means a zero byte', A('p2pkh', 'Jon').display === '1Jon' && A('p2pkh', '1Jon').display === '11Jon');
ok('Legacy: 0 O I l rejected with look-alike swaps', (() => { const a = A('p2pkh', 'Olesia'); return !a.ok && a.suggestions.some((s) => s.text === '1oLesia'); })());
ok('Legacy: ignore-case difficulty is the sum over valid case variants and is easier', A('p2pkh', 'jon', true).difficulty < A('p2pkh', 'Jon').difficulty && A('p2pkh', 'Jon').suggestions.some((s) => s.ignoreCase));
ok('Legacy: second character beyond Q is noted as the rare 33-char form', A('p2pkh', 'R').notes.some((n) => /33-character/.test(n)) && A('p2pkh', 'Q').notes.length === 0);
ok('Legacy: leading "1"s are zero bytes (×256 each)', Math.round(A('p2pkh', '1').difficulty) === 256 && Math.round(A('p2pkh', '11').difficulty) === 65536);
ok('too-long text is refused with a shorter suggestion', (() => { const a = A('p2wpkh', 'q'.repeat(MAX_PATTERN + 1)); return !a.ok && a.suggestions.length > 0; })());
ok('empty text is not searchable and never throws', !A('p2wpkh', '').ok && !A('p2pkh', '   ').ok && !analyzePattern({ type: 'nope', text: 'x' }).ok);
ok('estimate: expected time scales with difficulty and rate', estimate(1e6, 1e4).expectedSeconds === 100 && estimate(1e6, 1e4).expected === '2 minutes' && humanTime(3600 * 30) === '30 hours');

// ---------------------------------------------------------------- exact probability vs sampling
// Random hash160s (uniform, like real keys) encoded with the wallet's own encoder; the observed
// fraction must agree with the computed probability within sampling error (6σ — never flaky).
const N = 60000;
const samples = Array.from({ length: N }, () => randomBytes(20));
const legacyAddrs = samples.map((h) => addressFromHash160(h, 'p2pkh'));
const segwitAddrs = samples.map((h) => addressFromHash160(h, 'p2wpkh'));
const cases = [['p2pkh', 'A', false], ['p2pkh', 'B', false], ['p2pkh', 'Q', false], ['p2pkh', 'R', false], ['p2pkh', '11', false], ['p2pkh', 'a', true], ['p2pkh', '1', false], ['p2wpkh', 'q', false], ['p2wpkh', 'q0', false]];
for (const [type, text, ic] of cases) {
  const a = A(type, text, ic);
  const addrs = type === 'p2pkh' ? legacyAddrs : segwitAddrs;
  const hits = addrs.filter((ad) => finalMatch(ad, a)).length;
  const want = N * a.probability, sd = Math.sqrt(Math.max(want, 1));
  ok(`exact probability matches sampling: ${a.display}${ic ? ' (ic)' : ''}  observed ${hits}, expected ${want.toFixed(1)}`, Math.abs(hits - want) <= 6 * sd + 1);
}
// the quick matcher (hash160 filter) must never reject a true match
for (const [type, text, ic] of cases) {
  const a = A(type, text, ic), quick = compileMatcher(a.matcher);
  const addrs = type === 'p2pkh' ? legacyAddrs : segwitAddrs;
  let missed = 0, passed = 0;
  samples.forEach((h, i) => { const m = finalMatch(addrs[i], a), q = quick(h); if (m && !q) missed++; if (q) passed++; });
  const want = N * a.probability;
  ok(`quick filter never misses a match and is tight: ${a.display}${ic ? ' (ic)' : ''}  passed ${passed} for ${want.toFixed(0)} matches`, missed === 0 && passed <= 1.5 * want + 50);
}

// ---------------------------------------------------------------- the search finds keys at the theoretical rate
function runs(a, n) { let tot = 0n; for (let i = 0; i < n; i++) { const s = createSearch({ analysis: a, randomBytes }); let r = null; while (!r) r = s.step(1024); tot += r.tried; if (!r.found.address.startsWith(a.type === 'p2wpkh' ? 'bc1q' + a.text : '1')) throw new Error('bad result'); } return Number(tot) / n; }
for (const [type, text, ic] of [['p2wpkh', 'q', false], ['p2pkh', 'A', false], ['p2pkh', 'a', true], ['p2pkh', '1', false]]) {
  const a = A(type, text, ic), n = 300, mean = runs(a, n);
  // the number of keys per hit is geometric with mean = difficulty; the mean of n runs has sd ≈ difficulty/√n
  ok(`search hit rate equals theory: ${a.display}${ic ? ' (ic)' : ''}  mean ${mean.toFixed(1)} vs ${a.difficulty.toFixed(1)}`, Math.abs(mean - a.difficulty) < 5 * a.difficulty / Math.sqrt(n) + 2);
}

// ---------------------------------------------------------------- results are right and independently verified
{
  const a = A('p2pkh', 'Jo'), s = createSearch({ analysis: a, randomBytes }); let r = null; while (!r) r = s.step(1024);
  const { privKey, address, wif, pubkey } = r.found;
  const pub2 = secp256k1.getPublicKey(privKey, true);
  ok('found key: public key matches a fresh scalar multiplication', Buffer.from(pub2).equals(Buffer.from(pubkey)));
  ok('found key: address equals the wallet encoder applied to that key', addressOf(pub2, 'p2pkh') === address && address.startsWith('1Jo'));
  const raw = b58.decode(wif);
  ok('found key: WIF is mainnet, compressed, and carries the same key', raw[0] === 0x80 && raw.length === 34 && raw[33] === 1 && Buffer.from(raw.slice(1, 33)).equals(Buffer.from(privKey)));
  ok('found key: hash160 of the pubkey is the address payload', Buffer.from(b58.decode(address).slice(1)).equals(Buffer.from(hash160(pub2))));
  const two = [createSearch({ analysis: a, randomBytes }), createSearch({ analysis: a, randomBytes })].map((x) => { let q = null; while (!q) q = x.step(1024); return q.found.address; });
  ok('two searches for the same pattern give different keys (fresh CSPRNG start each time)', two[0] !== two[1]);
}
// a broken "incremental" step cannot produce a wrong result: verification re-derives from the key
{
  const a = A('p2wpkh', 'q');
  let threw = false;
  try { createSearch({ analysis: { ...a, ok: false }, randomBytes }); } catch { threw = true; }
  ok('an unsearchable analysis is refused', threw);
}
ok('benchmark returns a sane per-thread rate', (() => { const r = benchmark({ randomBytes, ms: 400 }); return r > 1000 && r < 5e6; })());

console.log(bad ? '\nVANITY TESTS FAILED' : '\nvanity engine: all checks passed');
process.exit(bad ? 1 : 0);
