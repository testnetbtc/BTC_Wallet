// Wallet file (.dat): seal/open round-trip, wrong password, tamper detection, hostile-file
// rejection before any key stretching, and the password policy.
import { sealWallet, openWallet, parseWalletFile, passwordPolicy, generatePassword, KDF, FORMAT } from '../src/walletfile.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(72), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re ? re.test(e.message) : true; } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = generatePassword(6).password;
const payload = { kind: 'seed', mnemonic: SEED, passphrase: null, passphraseUsed: false, fingerprint: 'ABCD-1234', scriptType: 'p2wpkh' };

ok('KDF is scrypt N=2^17 r=8 p=1', KDF.N === 131072 && KDF.r === 8 && KDF.p === 1 && KDF.dkLen === 32);
let progressCalls = 0;
const t0 = Date.now();
const file = await sealWallet(payload, PW, { onProgress: () => { progressCalls++; } });
console.log(`   (seal took ${Date.now() - t0} ms)`);
const obj = JSON.parse(file);
ok('file is JSON with the olesia-wallet format tag', obj.format === FORMAT && obj.version === 1 && obj.network === 'mainnet');
ok('no plaintext secret anywhere in the file', !file.includes('abandon') && !file.includes('ABCD-1234') && !file.includes(PW));
ok('fresh 16-byte salt and 24-byte nonce', obj.kdf.salt.length === 32 && obj.cipher.nonce.length === 48);
ok('progress callback fires during key stretching', progressCalls > 0);

const opened = await openWallet(file, PW);
ok('opens with the right password', opened.payload.mnemonic === SEED && opened.payload.kind === 'seed' && opened.network === 'mainnet');
ok('wrong password rejected', await rejects(openWallet(file, PW + 'x'), /wrong password/));
ok('empty password rejected before any work', await rejects(openWallet(file, ''), /enter the wallet file password/));

const file2 = await sealWallet(payload, PW);
ok('two files for the same wallet differ (fresh salt/nonce)', JSON.parse(file2).ciphertext !== obj.ciphertext);

// --- tampering: ciphertext AND every authenticated header field ---
const tamper = (fn) => { const o = JSON.parse(file); fn(o); return JSON.stringify(o); };
ok('flipped ciphertext byte rejected', await rejects(openWallet(tamper((o) => { o.ciphertext = (o.ciphertext[0] === '0' ? '1' : '0') + o.ciphertext.slice(1); }), PW), /wrong password|altered/));
ok('changed network label rejected (bound as AAD)', await rejects(openWallet(tamper((o) => { o.network = 'testnet4'; }), PW), /wrong password|altered/));
ok('changed creation time rejected (bound as AAD)', await rejects(openWallet(tamper((o) => { o.createdAt = '2020-01-01T00:00:00.000Z'; }), PW), /wrong password|altered/));
ok('swapped nonce rejected', await rejects(openWallet(tamper((o) => { o.cipher.nonce = JSON.parse(file2).cipher.nonce; }), PW), /wrong password|altered/));

// --- hostile files are refused BEFORE scrypt runs (no memory bomb, no hang) ---
const t1 = Date.now();
ok('KDF N inflated to 2^24 refused', throws(() => parseWalletFile(tamper((o) => { o.kdf.N = 2 ** 24; })), /non-standard/));
ok('KDF N weakened to 2^10 refused', throws(() => parseWalletFile(tamper((o) => { o.kdf.N = 1024; })), /non-standard/));
ok('KDF r/p changes refused', throws(() => parseWalletFile(tamper((o) => { o.kdf.r = 1; })), /non-standard/) && throws(() => parseWalletFile(tamper((o) => { o.kdf.p = 64; })), /non-standard/));
ok('oversized salt refused', throws(() => parseWalletFile(tamper((o) => { o.kdf.salt = 'ab'.repeat(4096); })), /corrupted/));
ok('giant ciphertext refused', throws(() => parseWalletFile(tamper((o) => { o.ciphertext = 'ab'.repeat(20000); })), /corrupted|too large/));
ok('giant file refused', throws(() => parseWalletFile(' '.repeat(70000) + file), /too large/));
ok('unknown version refused', throws(() => parseWalletFile(tamper((o) => { o.version = 2; })), /unsupported/));
ok('other JSON refused', throws(() => parseWalletFile('{"format":"olesia-backup"}'), /not an Olesia wallet file/));
ok('non-JSON refused', throws(() => parseWalletFile('hello'), /not an Olesia wallet file/));
ok('unknown cipher refused', throws(() => parseWalletFile(tamper((o) => { o.cipher.name = 'aes'; })), /unsupported cipher/));
ok('all hostile-file rejections were instant (no key stretching ran)', Date.now() - t1 < 500);

// --- WIF payload + BIP-39 passphrase handling ---
const wf = await sealWallet({ kind: 'wif', wif: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn' }, PW);
ok('WIF wallet round-trips', (await openWallet(wf, PW)).payload.wif === 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn');
const pf = await sealWallet({ ...payload, passphrase: 'hunter two', passphraseUsed: true }, PW);
ok('stored BIP-39 passphrase round-trips and is not visible in the file', (await openWallet(pf, PW)).payload.passphrase === 'hunter two' && !pf.includes('hunter'));
ok('empty payload refused', await rejects(sealWallet({ kind: 'seed', mnemonic: '' }, PW), /no recovery phrase/));
ok('unknown payload kind refused', await rejects(sealWallet({ kind: 'xprv' }, PW), /unknown wallet kind/));

// --- password policy ---
ok('generated password: 6 words, exactly 66 bits, passes', (() => { const g = generatePassword(6); const p = passwordPolicy(g.password); return g.bits === 66 && p.ok && p.bits === 66; })());
ok('two generated passwords differ', generatePassword().password !== generatePassword().password);
ok('5 random words is below the bar', passwordPolicy(generatePassword(5).password).ok === false);
ok('6-digit PIN refused', passwordPolicy('246800').ok === false);
ok('short password refused', passwordPolicy('Ab1!xyz').ok === false);
ok('"Password1234!" refused (common word + sequence)', passwordPolicy('Password1234!').ok === false);
ok('"Bitcoin2026!!xx" refused (common word)', passwordPolicy('Bitcoin2026!!xx').ok === false);
ok('"aaaaaaaaaaaaaaaa" refused', passwordPolicy('aaaaaaaaaaaaaaaa').ok === false);
ok('a long mixed password passes', passwordPolicy('vT9#kq2Lm!x7RzPw').ok === true);
ok('typed password never gets an invented bit count', passwordPolicy('vT9#kq2Lm!x7RzPw').bits === null);
ok('sealWallet enforces the policy', await rejects(sealWallet(payload, '246800'), /too weak/));
// audit L1: BIP-39 words only count if they look random
ok('six identical words refused', passwordPolicy('abandon abandon abandon abandon abandon abandon').ok === false);
ok('"zoo zoo zoo zoo zoo zoo" refused', passwordPolicy('zoo-zoo-zoo-zoo-zoo-zoo').ok === false);
ok('a famous test-vector phrase refused', passwordPolicy('legal winner thank year wave sausage').ok === false && passwordPolicy('letter advice cage absurd amount doctor').ok === false);
ok('six words in dictionary order refused', passwordPolicy('abandon ability able about above absent').ok === false);
ok('repeated pairs refused', passwordPolicy('apple apple river river stone stone').ok === false);
let allPass = true; for (let i = 0; i < 300; i++) if (!passwordPolicy(generatePassword(6).password).ok) allPass = false;
ok('300 generated passwords all pass the policy', allPass);
// audit I5: the generator refuses a dead RNG too
ok('generatePassword refuses a dead RNG', (() => { try { generatePassword(6, { getRandomValues: (b) => { b.fill(0); return b; } }); return false; } catch (e) { return /cannot generate a password/.test(e.message); } })());

console.log(bad ? '\nWALLETFILE TESTS FAILED' : '\nwalletfile: all checks passed');
process.exit(bad ? 1 : 0);
