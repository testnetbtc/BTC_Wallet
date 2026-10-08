// The Olesia wallet file (.dat) — an encrypted, self-contained copy of a wallet's secret that
// the user keeps on their own computer and loads whenever they want to use the wallet.
//
// It is NOT Bitcoin Core's wallet.dat (a database format); it is a small JSON document:
//   scrypt (N=2^17, r=8, p=1: memory-hard, ~128 MB)  ->  32-byte key
//   XChaCha20-Poly1305 (authenticated encryption)     ->  ciphertext of the secret payload
// The clear-text header (format, version, network, creation time, KDF parameters) is bound to
// the ciphertext as AEAD associated data, so editing any of it makes decryption fail.
//
// The file can be copied by anyone who reaches the user's disk and then attacked offline, so
// the PASSWORD is the weak link: a strength policy is enforced when the file is written.
import { scryptAsync } from '@noble/hashes/scrypt';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes, bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { bytesToUtf8 } from '@noble/ciphers/utils';
import { wordlist } from '@scure/bip39/wordlists/english';
import { rngHealth } from './entropy.js';

export const FORMAT = 'olesia-wallet';
export const VERSION = 1;
export const FILE_EXT = '.dat';
export const KDF = Object.freeze({ name: 'scrypt', N: 131072, r: 8, p: 1, dkLen: 32 });
const SALT_LEN = 16, NONCE_LEN = 24, MAX_FILE_CHARS = 64 * 1024, MAX_CT_BYTES = 8 * 1024;

const aadOf = (h) => utf8ToBytes(
  `${h.format}|v=${h.version}|net=${h.network}|created=${h.createdAt}` +
  `|kdf=${h.kdf.name}:${h.kdf.N}:${h.kdf.r}:${h.kdf.p}:${h.kdf.dkLen}|cipher=${h.cipher.name}`);

// ---- password policy -----------------------------------------------------------------------
// Honest: we cannot measure a typed password's entropy. We (a) give exact figures for a
// generated word passphrase, (b) enforce a structural floor on typed passwords, and (c) reject
// the obviously guessable. The one-click generator is the recommended path.
const WEAK_TOKENS = ['password', 'passwort', 'qwerty', 'azerty', 'letmein', 'iloveyou', 'bitcoin', 'satoshi', 'olesia',
  'wallet', 'welcome', 'admin', 'dragon', 'monkey', 'abc123', '123456', '654321', '111111', '000000'];
const FAMOUS_PHRASES = ['abandon abandon', 'zoo zoo', 'legal winner thank year', 'letter advice cage absurd', 'void come effort suffer',
  'army van defense carry', 'correct horse battery', 'all all all', 'bacon bacon'];
export function passwordPolicy(password) {
  const s = String(password || '');
  const toks = s.trim().split(/[\s-]+/).filter(Boolean);
  const allWords = toks.length >= 2 && toks.every((t) => wordlist.includes(t.toLowerCase()));
  if (allWords) {
    // Words from the BIP-39 list carry 11 bits each ONLY if they were picked at random. We
    // cannot know that, so the obviously non-random cases are refused: repeated words, words
    // in dictionary order, and the well-known example phrases.
    const low = toks.map((t) => t.toLowerCase()), idx = low.map((w) => wordlist.indexOf(w));
    const issues = [];
    if (toks.length < 6) issues.push('use at least 6 random words');
    if (new Set(low).size < low.length - 1) issues.push('the words repeat — use different, random words');
    if (idx.every((v, i) => i === 0 || v === idx[i - 1] + 1) || idx.every((v, i) => i === 0 || v === idx[i - 1] - 1)) issues.push('the words are in dictionary order');
    const joined = low.join(' ');
    if (FAMOUS_PHRASES.some((f) => joined.includes(f))) issues.push('that is a well-known example phrase');
    return { ok: issues.length === 0, kind: 'words', bits: Math.round(toks.length * 11), words: toks.length, issues };
  }
  const issues = [];
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
  if (s.length < 12) issues.push('use at least 12 characters');
  if (classes < 3 && s.length < 20) issues.push('mix upper-case, lower-case, digits and symbols (or make it 20+ characters)');
  const low = s.toLowerCase();
  if (WEAK_TOKENS.some((w) => low.includes(w))) issues.push('it contains a very common word or pattern');
  if (/^(.)\1+$/.test(s) || new Set(s).size < 6) issues.push('it repeats too few different characters');
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|zxcv)/i.test(s)) issues.push('it contains a keyboard or counting sequence');
  return { ok: issues.length === 0, kind: 'typed', bits: null, length: s.length, classes, issues };
}

// A random passphrase from the BIP-39 word list: exactly 11 bits per word (6 words = 66 bits).
// 2^32 is an exact multiple of 2048, so `% 2048` has no modulo bias.
export function generatePassword(nWords = 6, rng = globalThis.crypto) {
  const health = rngHealth(rng);
  if (!health.ok) throw new Error(`cannot generate a password: ${health.reason}`);
  for (let attempt = 0; attempt < 20; attempt++) {
    const idx = new Uint32Array(nWords);
    rng.getRandomValues(idx);
    const password = Array.from(idx, (i) => wordlist[i % 2048]).join('-');
    if (nWords < 6 || passwordPolicy(password).ok) return { password, bits: nWords * 11, words: nWords };   // re-draw the rare repeat
  }
  throw new Error('cannot generate a password: the random number generator keeps repeating itself');
}

// ---- payload ---------------------------------------------------------------------------------
// { kind:'seed', mnemonic, passphrase: string|null, passphraseUsed: bool, fingerprint, scriptType }
// { kind:'wif',  wif }
function checkPayload(p) {
  if (!p || typeof p !== 'object') throw new Error('nothing to save');
  if (p.kind === 'seed') {
    if (typeof p.mnemonic !== 'string' || !p.mnemonic.trim()) throw new Error('no recovery phrase to save');
    if (p.passphrase != null && typeof p.passphrase !== 'string') throw new Error('bad passphrase field');
  } else if (p.kind === 'wif') {
    if (typeof p.wif !== 'string' || !p.wif.trim()) throw new Error('no private key to save');
  } else throw new Error('unknown wallet kind');
  return p;
}

export async function sealWallet(payload, password, { network = 'mainnet', createdAt = new Date().toISOString(), onProgress, enforcePolicy = true } = {}) {
  checkPayload(payload);
  if (enforcePolicy) {
    const pol = passwordPolicy(password);
    if (!pol.ok) throw new Error('password too weak: ' + pol.issues.join('; '));
  } else if (!password) throw new Error('a password is required');
  const salt = randomBytes(SALT_LEN), nonce = randomBytes(NONCE_LEN);
  const header = { format: FORMAT, version: VERSION, network, createdAt, kdf: { ...KDF }, cipher: { name: 'xchacha20poly1305' } };
  const key = await scryptAsync(utf8ToBytes(String(password).normalize('NFKC')), salt, { N: KDF.N, r: KDF.r, p: KDF.p, dkLen: KDF.dkLen, onProgress });
  const pt = utf8ToBytes(JSON.stringify({ v: 1, ...payload }));
  const ct = xchacha20poly1305(key, nonce, aadOf(header)).encrypt(pt);
  key.fill(0); pt.fill(0);
  return JSON.stringify({
    ...header,
    kdf: { ...KDF, salt: bytesToHex(salt) },
    cipher: { name: 'xchacha20poly1305', nonce: bytesToHex(nonce) },
    ciphertext: bytesToHex(ct),
    note: 'Encrypted Olesia wallet file. Keep copies safe. Without the password it cannot be opened; with the password it controls the funds.',
  }, null, 1);
}

// Parse + structurally validate WITHOUT doing any expensive work, so a hostile file cannot
// turn "open wallet" into a memory bomb or a multi-minute hang.
export function parseWalletFile(text) {
  const s = String(text || '');
  if (s.length > MAX_FILE_CHARS) throw new Error('that file is too large to be an Olesia wallet file');
  let o; try { o = JSON.parse(s); } catch { throw new Error('that is not an Olesia wallet file'); }
  if (!o || typeof o !== 'object' || o.format !== FORMAT) throw new Error('that is not an Olesia wallet file');
  if (o.version !== VERSION) throw new Error(`unsupported wallet file version (${String(o.version)})`);
  const k = o.kdf || {}, c = o.cipher || {};
  if (k.name !== KDF.name || k.N !== KDF.N || k.r !== KDF.r || k.p !== KDF.p || k.dkLen !== KDF.dkLen)
    throw new Error('wallet file has non-standard key-stretching parameters — refusing to open it');
  if (c.name !== 'xchacha20poly1305') throw new Error('wallet file uses an unsupported cipher');
  const hexOk = (v, bytes) => typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-f]+$/.test(v);
  if (!hexOk(k.salt, SALT_LEN) || !hexOk(c.nonce, NONCE_LEN)) throw new Error('wallet file is corrupted');
  if (typeof o.ciphertext !== 'string' || !/^[0-9a-f]+$/.test(o.ciphertext) || o.ciphertext.length % 2 || o.ciphertext.length < 34 || o.ciphertext.length > MAX_CT_BYTES * 2)
    throw new Error('wallet file is corrupted');
  if (typeof o.network !== 'string' || typeof o.createdAt !== 'string' || o.createdAt.length > 40) throw new Error('wallet file is corrupted');
  return o;
}

export async function openWallet(text, password, { onProgress } = {}) {
  const o = typeof text === 'string' ? parseWalletFile(text) : parseWalletFile(JSON.stringify(text));
  if (!password) throw new Error('enter the wallet file password');
  const header = { format: o.format, version: o.version, network: o.network, createdAt: o.createdAt,
                   kdf: { name: o.kdf.name, N: o.kdf.N, r: o.kdf.r, p: o.kdf.p, dkLen: o.kdf.dkLen }, cipher: { name: o.cipher.name } };
  const key = await scryptAsync(utf8ToBytes(String(password).normalize('NFKC')), hexToBytes(o.kdf.salt), { N: KDF.N, r: KDF.r, p: KDF.p, dkLen: KDF.dkLen, onProgress });
  let pt;
  try { pt = xchacha20poly1305(key, hexToBytes(o.cipher.nonce), aadOf(header)).decrypt(hexToBytes(o.ciphertext)); }
  catch { throw new Error('wrong password (or the file has been altered)'); }
  finally { key.fill(0); }
  let payload; try { payload = JSON.parse(bytesToUtf8(pt)); } catch { throw new Error('wallet file decrypted but its contents are damaged'); }
  pt.fill(0);
  checkPayload(payload);
  return { payload, network: o.network, createdAt: o.createdAt };
}
