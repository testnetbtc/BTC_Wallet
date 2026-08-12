// Vault: seal/open roundtrip, wrong-PIN rejection, tamper detection, uniqueness,
// and the mainnet strength policy (a weak PIN must not protect a mainnet seed).
import { sealSeed, openSeed, generateVaultPassphrase, secretStrength, meetsMainnetBar, BITS_PER_WORD } from '../src/vault.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(58), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const blob = sealSeed(SEED, '246800');
ok('seals to JSON with no plaintext seed inside', !blob.includes('abandon'));
ok('opens with the right PIN', openSeed(blob, '246800') === SEED);

let threw = '';
try { openSeed(blob, '246801'); } catch (e) { threw = e.message; }
ok('wrong PIN rejected (auth failure, not garbage)', /wrong PIN/.test(threw));

const b = JSON.parse(blob); b.ct = b.ct.slice(0, -4) + 'AAAA';
threw = ''; try { openSeed(JSON.stringify(b), '246800'); } catch (e) { threw = e.message; }
ok('tampered ciphertext rejected', /wrong PIN|tampered/.test(threw));

ok('two seals of the same seed differ (fresh salt/nonce)', sealSeed(SEED, '246800') !== blob);

threw = ''; try { sealSeed(SEED, '12345'); } catch (e) { threw = e.message; }
ok('short PIN (<6) refused at seal time', /at least 6/.test(threw));

// ---- P3: mainnet strength policy ------------------------------------------
ok('11 bits per BIP-39 word (2048-word list)', BITS_PER_WORD === Math.log2(2048));
const gen = generateVaultPassphrase(6);
ok('generated 6-word passphrase = exactly 66 bits', gen.words === 6 && gen.bits === 66);
ok('generated passphrase is 6 space-separated words', gen.phrase.split(' ').length === 6);
ok('two generated passphrases differ (CSPRNG)', generateVaultPassphrase(6).phrase !== gen.phrase);

// strength assessment is honest: exact for word-passphrases, unclaimed for typed
ok('secretStrength counts a word-passphrase exactly', secretStrength(gen.phrase).bits === 66 && secretStrength(gen.phrase).verifiable);
ok('secretStrength does NOT invent bits for a typed password', secretStrength('Tr0ub4dour&3xtra').bits === null);

// the mainnet bar: weak numeric PINs rejected; strong secrets accepted
ok('mainnet bar REJECTS a 6-digit PIN', meetsMainnetBar('246800') === false);
ok('mainnet bar REJECTS a 12-digit numeric PIN', meetsMainnetBar('123456789012') === false);
ok('mainnet bar REJECTS a 5-word passphrase (55 bits)', meetsMainnetBar(generateVaultPassphrase(5).phrase) === false);
ok('mainnet bar ACCEPTS a 6-word passphrase (66 bits)', meetsMainnetBar(gen.phrase) === true);
ok('mainnet bar ACCEPTS a 12+ char mixed password', meetsMainnetBar('Tr0ub4dour&3x') === true);

// sealSeed enforces the bar only when requireStrong (mainnet)
ok('mainnet seal REFUSES a 6-digit PIN', throws(() => sealSeed(SEED, '246800', { requireStrong: true }), /strong secret/));
ok('mainnet seal ACCEPTS a generated passphrase', openSeed(sealSeed(SEED, gen.phrase, { requireStrong: true }), gen.phrase) === SEED);
ok('testnet seal (default) still accepts a 6-digit PIN', openSeed(sealSeed(SEED, '246800'), '246800') === SEED);

console.log(bad ? '\nVAULT TEST FAILED' : '\nVAULT TEST PASS — encrypted persistence + mainnet strength policy');
process.exit(bad ? 1 : 0);
