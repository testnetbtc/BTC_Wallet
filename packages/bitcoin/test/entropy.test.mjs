// Wallet-creation entropy: the mixer, dice handling, RNG health gate, and 12/24-word output.
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes, concatBytes } from '@noble/hashes/utils';
import { validateMnemonic, mnemonicToEntropy, entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { mixEntropy, diceOnlyEntropy, createMnemonic, rngHealth, normalizeDice, diceBits, DICE_ONLY_MIN_ROLLS } from '../src/entropy.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(72), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const fixedRng = (fill) => ({ getRandomValues: (b) => { b.fill(fill); return b; } });
let ctr = 0;
const countingRng = { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = (ctr = (ctr * 1103515245 + 12345) >>> 0) >>> 16 & 255; return b; } };

const root = new Uint8Array(32).fill(7);
const u32 = (n) => Uint8Array.of(0, 0, n >> 8, n & 255);

// --- mixer is exactly the documented construction (independent re-computation) ---
const mouse = Uint8Array.of(1, 2, 3, 4, 5);
const expect = sha256(concatBytes(utf8ToBytes('olesia/wallet-entropy/v1'), u32(32), root, u32(32), sha256(mouse), u32(6), utf8ToBytes('123456')));
ok('mixEntropy == SHA-256(tag ‖ lp(root) ‖ lp(SHA-256(mouse)) ‖ lp(dice))', bytesToHex(mixEntropy({ root, mouse, dice: '1 2 3 4 5 6' })) === bytesToHex(expect));
ok('256-bit output is 32 bytes', mixEntropy({ root }).length === 32);
ok('128-bit output is 16 bytes = first half of the same hash', bytesToHex(mixEntropy({ root, bits: 128 })) === bytesToHex(mixEntropy({ root })).slice(0, 32));

// --- every source changes the result; none can be dropped silently ---
const base = bytesToHex(mixEntropy({ root }));
ok('mouse samples change the entropy', bytesToHex(mixEntropy({ root, mouse })) !== base);
ok('dice change the entropy', bytesToHex(mixEntropy({ root, dice: '1' })) !== base);
ok('one more dice roll changes the entropy', bytesToHex(mixEntropy({ root, dice: '11' })) !== bytesToHex(mixEntropy({ root, dice: '1' })));
ok('a different CSPRNG root changes the entropy', bytesToHex(mixEntropy({ root: new Uint8Array(32).fill(8) })) !== base);
ok('fields cannot be confused (mouse "x" + dice "" ≠ mouse "" + dice…)', bytesToHex(mixEntropy({ root, mouse: utf8ToBytes('12') })) !== bytesToHex(mixEntropy({ root, dice: '12' })));
ok('dice formatting is normalised (spaces/commas ignored)', bytesToHex(mixEntropy({ root, dice: '1,2 3\n4' })) === bytesToHex(mixEntropy({ root, dice: '1234' })));

// --- the root is mandatory and must be full size ---
ok('rejects a missing root', throws(() => mixEntropy({}), /32 bytes/));
ok('rejects a short root (16 bytes)', throws(() => mixEntropy({ root: new Uint8Array(16) }), /32 bytes/));
ok('rejects bits other than 128/256', throws(() => mixEntropy({ root, bits: 192 }), /128 or 256/));

// --- dice validation ---
ok('dice with a 7 is rejected (not silently dropped)', throws(() => normalizeDice('1 2 7'), /1 to 6/));
ok('dice with a 0 is rejected', throws(() => normalizeDice('0123'), /1 to 6/));
ok('dice with letters is rejected', throws(() => normalizeDice('12a'), /1 to 6/));
ok('99 rolls ≈ 255.9 bits', Math.abs(diceBits('1'.repeat(99)) - 255.9) < 0.1);

// --- dice-only mode: reproducible by hand, and gated on enough rolls ---
const rolls99 = '123456'.repeat(16) + '123';
ok('dice-only == SHA-256(ASCII rolls)', bytesToHex(diceOnlyEntropy(rolls99, 256)) === bytesToHex(sha256(utf8ToBytes(rolls99))));
ok('dice-only refuses 98 rolls for 24 words', throws(() => diceOnlyEntropy(rolls99.slice(0, 98), 256), /at least 99/));
ok('dice-only refuses 49 rolls for 12 words', throws(() => diceOnlyEntropy('1'.repeat(49), 128), /at least 50/));
ok('dice-only minimums are 50 / 99', DICE_ONLY_MIN_ROLLS[128] === 50 && DICE_ONLY_MIN_ROLLS[256] === 99);
const d1 = createMnemonic({ words: 24, dice: rolls99, diceOnly: true });
const d2 = createMnemonic({ words: 24, dice: rolls99, diceOnly: true, rng: fixedRng(0) });
ok('dice-only phrase is deterministic and ignores the CSPRNG entirely', d1.mnemonic === d2.mnemonic && d1.sources.csprng === false);
ok('dice-only phrase == BIP-39 of SHA-256(rolls)', d1.mnemonic === entropyToMnemonic(sha256(utf8ToBytes(rolls99)), wordlist));

// --- createMnemonic ---
const a = createMnemonic({ words: 24 }), b = createMnemonic({ words: 24 });
ok('24-word phrase is valid BIP-39 with 256 bits of entropy', validateMnemonic(a.mnemonic, wordlist) && mnemonicToEntropy(a.mnemonic, wordlist).length === 32 && a.bits === 256);
ok('two phrases differ', a.mnemonic !== b.mnemonic);
const c = createMnemonic({ words: 12 });
ok('12-word phrase is valid BIP-39 with 128 bits of entropy', validateMnemonic(c.mnemonic, wordlist) && c.mnemonic.split(' ').length === 12 && mnemonicToEntropy(c.mnemonic, wordlist).length === 16);
ok('15/18/21-word creation is refused', throws(() => createMnemonic({ words: 18 }), /12 or 24/));
ok('same extras, fresh CSPRNG -> different phrase (root always contributes)', createMnemonic({ dice: '123456', mouse }).mnemonic !== createMnemonic({ dice: '123456', mouse }).mnemonic);
ok('sources are reported honestly', a.sources.csprng === true && createMnemonic({ dice: '1 2 3' }).sources.diceRolls === 3);

// --- the RNG health gate: a dead generator can never mint a wallet ---
ok('healthy system RNG passes', rngHealth().ok === true);
ok('all-zero RNG fails', rngHealth(fixedRng(0)).ok === false);
ok('constant 0xAA RNG fails', rngHealth(fixedRng(0xaa)).ok === false);
ok('missing crypto fails cleanly', rngHealth({}).ok === false);
ok('a varied (if weak) PRNG passes — the check is liveness only', rngHealth(countingRng).ok === true);
ok('createMnemonic REFUSES with a dead RNG', throws(() => createMnemonic({ rng: fixedRng(0) }), /refusing to create a wallet/));
ok('…but dice-only still works with a dead RNG', validateMnemonic(createMnemonic({ dice: rolls99, diceOnly: true, rng: fixedRng(0) }).mnemonic, wordlist));

// --- statistical smoke test on real output: bit balance across 400 fresh entropies ---
let ones = 0; const N = 400;
for (let i = 0; i < N; i++) for (const v of mnemonicToEntropy(createMnemonic({ words: 24 }).mnemonic, wordlist)) { let x = v; while (x) { ones += x & 1; x >>= 1; } }
const bits = N * 256, z = Math.abs(ones - bits / 2) / (0.5 * Math.sqrt(bits));
ok(`bit balance over ${bits} generated bits (z=${z.toFixed(2)} < 4.5)`, z < 4.5);

console.log(bad ? '\nENTROPY TESTS FAILED' : '\nentropy: all checks passed');
process.exit(bad ? 1 : 0);
