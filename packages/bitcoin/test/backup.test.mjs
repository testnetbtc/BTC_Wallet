// Backup re-audit (v3): the cold-generator backup binds its metadata as AEAD
// associated data, so ANY tampering with the file's fields must fail cleanly.
// We build a genuine v3 file with the generator's own encryptBackup, then flip
// each field and confirm the wallet's decryptColdBackup rejects it. We also
// confirm the KDF-parameter guard blocks a memory-bomb file before scrypt runs.
import { encryptBackup } from '../../../src/backup.js';
import { decryptColdBackup } from '../src/coldbackup.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(60), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const rejects = (obj, pw, re) => { try { decryptColdBackup(obj, pw); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const MN = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';
const PW = 'a strong file password 123';
const META = { network: 'mainnet', path: "m/84'/0'/0'", address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', passphraseUsed: true };
const raw = encryptBackup(MN, PW, META);
const good = typeof raw === 'string' ? JSON.parse(raw) : raw;

// ---- baseline: a genuine file decrypts, metadata is authenticated ----------
const dec = decryptColdBackup(good, PW);
ok('genuine v3 backup decrypts to the seed', dec.mnemonic === MN);
ok('v3 reports metadata as authenticated', dec.metadataAuthenticated === true);
ok('v3 preserves the passphraseUsed flag', dec.passphraseUsed === true);
ok('wrong password is rejected cleanly', rejects(good, 'wrong password', /wrong password|tampered/));

// ---- tamper each authenticated field: all must fail ------------------------
const tamper = (mut) => { const o = JSON.parse(JSON.stringify(good)); mut(o); return o; };
ok('tampered network rejected',        rejects(tamper((o) => { o.network = 'testnet4'; }), PW, /tampered|wrong password/));
ok('tampered path rejected',           rejects(tamper((o) => { o.path = "m/84'/1'/0'"; }), PW, /tampered|wrong password/));
ok('tampered addressHash rejected',    rejects(tamper((o) => { o.addressHash = 'de'.repeat(32); }), PW, /tampered|wrong password/));
ok('flipped passphraseUsed rejected',  rejects(tamper((o) => { o.passphraseUsed = false; }), PW, /tampered|wrong password/));
ok('tampered version rejected',        rejects(tamper((o) => { o.version = 2; }), PW, /tampered|wrong password|unsupported/));
ok('tampered ciphertext rejected',     rejects(tamper((o) => { o.ciphertext = o.ciphertext.slice(0, -4) + 'dead'; }), PW, /tampered|wrong password/));
ok('tampered nonce rejected',          rejects(tamper((o) => { o.cipher.nonce = o.cipher.nonce.slice(0, -4) + 'beef'; }), PW, /tampered|wrong password/));
ok('tampered salt rejected',           rejects(tamper((o) => { o.kdf.salt = o.kdf.salt.slice(0, -4) + 'cafe'; }), PW, /tampered|wrong password/));

// ---- KDF-parameter guard: memory-bomb rejected BEFORE scrypt runs ----------
ok('inflated N (memory bomb) rejected pre-scrypt', rejects(tamper((o) => { o.kdf.N = 2 ** 26; }), PW, /canonical|parameters/));
ok('inflated r rejected pre-scrypt',               rejects(tamper((o) => { o.kdf.r = 64; }), PW, /canonical|parameters/));

// ---- malformed / wrong-format inputs ---------------------------------------
ok('non-JSON string rejected', rejects('not a backup at all', PW, /valid backup|not an Olesia/));
ok('wrong format field rejected', rejects(tamper((o) => { o.format = 'evil-backup'; }), PW, /not an Olesia/));
ok('unknown cipher rejected', rejects(tamper((o) => { o.cipher.name = 'aes'; }), PW, /unsupported cipher/));
ok('missing password rejected', rejects(good, '', /file password/));

console.log(bad ? '\nBACKUP TEST FAILED' : '\nBACKUP TEST PASS — v3 metadata is authenticated; tampering fails cleanly');
process.exit(bad ? 1 : 0);
