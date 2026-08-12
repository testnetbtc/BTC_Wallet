// BIP39 passphrase handling: the passphrase is separate from the mnemonic, and
// "same 24 words + different passphrase = a completely different wallet". A
// valid-looking wallet does NOT prove the passphrase was typed correctly — the
// classic silent-loss trap. A non-reversible wallet fingerprint lets a user
// confirm re-entry without revealing the passphrase.
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';
import { accountXpub, deriveKey } from '../src/wallet.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(60), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

const MN = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';
const NET = 'mainnet';
// mirror OW.fingerprint
const fp = (mn, pass) => { const h = bytesToHex(sha256(utf8ToBytes(accountXpub(mn, pass, NET)))).toUpperCase(); return h.slice(0, 4) + '-' + h.slice(4, 8); };

// ---- a passphrase yields a genuinely different wallet ----------------------
const addrNoPass = deriveKey(MN, '', NET, 0).address;
const addrPassA = deriveKey(MN, 'battery horse', NET, 0).address;
const addrPassB = deriveKey(MN, 'Battery horse', NET, 0).address; // one char different
ok('no passphrase vs passphrase = different address', addrNoPass !== addrPassA);
ok('one-character passphrase change = different address', addrPassA !== addrPassB);

// ---- the fingerprint tracks the passphrase, deterministically --------------
ok('fingerprint is stable for the same words+passphrase', fp(MN, 'battery horse') === fp(MN, 'battery horse'));
ok('fingerprint differs with no passphrase', fp(MN, '') !== fp(MN, 'battery horse'));
ok('fingerprint differs on a one-char passphrase change', fp(MN, 'battery horse') !== fp(MN, 'Battery horse'));
ok('fingerprint shape is XXXX-XXXX hex', /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(fp(MN, 'battery horse')));

// ---- non-reversible: fingerprint reveals no more than the exportable xpub ---
// (it is a hash of the account xpub, which the wallet already exposes for
// watch-only). Different mnemonics with the same passphrase differ too.
const MN2 = 'like youth surface loop fire bulk push repair riot scan blame tilt';
ok('different seed, same passphrase = different fingerprint', fp(MN, 'x') !== fp(MN2, 'x'));

console.log(bad ? '\nPASSPHRASE TEST FAILED' : '\nPASSPHRASE TEST PASS — passphrase separation + confirmable fingerprint');
process.exit(bad ? 1 : 0);
