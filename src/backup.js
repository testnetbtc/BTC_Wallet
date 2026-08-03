// Encrypted backup + watch-only descriptor export.
import { scrypt } from '@noble/hashes/scrypt';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

// KDF: scrypt N=2^16, r=8, p=1 -> 64 MB memory-hard, ~1-2 s in-browser.
// Chosen deliberately: strong enough that a leaked backup file resists offline
// password guessing, cheap enough to run on a laptop. (Contrast: 250 PBKDF2
// iterations, which buys essentially nothing.)
export const KDF = { name: 'scrypt', N: 65536, r: 8, p: 1, dkLen: 32 };

const rand = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; };

export function encryptBackup(mnemonic, password, meta) {
  if (!password) throw new Error('a file password is required');
  const salt  = rand(16);
  const nonce = rand(24);
  const key   = scrypt(utf8ToBytes(password), salt, KDF);
  const ct    = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(mnemonic));
  return {
    format: 'alea-backup', version: 1,
    warning: 'Encrypted BIP-39 recovery phrase. The BIP-39 passphrase (if used) is NOT stored here by design.',
    network: meta.network, path: meta.path, address: meta.address,
    passphraseUsed: !!meta.passphraseUsed,
    createdAt: new Date().toISOString(),
    kdf: { ...KDF, salt: bytesToHex(salt) },
    cipher: { name: 'xchacha20poly1305', nonce: bytesToHex(nonce) },
    ciphertext: bytesToHex(ct),
  };
}

export function decryptBackup(obj, password) {
  if (!obj || obj.format !== 'alea-backup') throw new Error('not an Alea backup file');
  if (obj.version !== 1) throw new Error('unsupported backup version: ' + obj.version);
  const k = obj.kdf, c = obj.cipher;
  if (k.name !== 'scrypt') throw new Error('unsupported KDF: ' + k.name);
  if (c.name !== 'xchacha20poly1305') throw new Error('unsupported cipher: ' + c.name);
  const key = scrypt(utf8ToBytes(password), hexToBytes(k.salt),
                     { N: k.N, r: k.r, p: k.p, dkLen: k.dkLen });
  let pt;
  try { pt = xchacha20poly1305(key, hexToBytes(c.nonce)).decrypt(hexToBytes(obj.ciphertext)); }
  catch { throw new Error('wrong password (or the file is corrupt)'); }
  return { mnemonic: new TextDecoder().decode(pt), meta: obj };
}

// --- Bitcoin Core output-descriptor checksum (doc/descriptors.md) ----------
const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polyMod(c, val) {
  const c0 = c >> 35n;
  c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(val);
  if (c0 & 1n)  c ^= 0xf5dee51989n;
  if (c0 & 2n)  c ^= 0xa9fdca3312n;
  if (c0 & 4n)  c ^= 0x1bab10e32dn;
  if (c0 & 8n)  c ^= 0x3706b1677an;
  if (c0 & 16n) c ^= 0x644d626ffdn;
  return c;
}

export function descriptorChecksum(desc) {
  let c = 1n, cls = 0, clscount = 0;
  for (const ch of desc) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos === -1) return '';
    c = polyMod(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    if (++clscount === 3) { c = polyMod(c, cls); cls = 0; clscount = 0; }
  }
  if (clscount > 0) c = polyMod(c, cls);
  for (let j = 0; j < 8; j++) c = polyMod(c, 0);
  c ^= 1n;
  let out = '';
  for (let j = 0; j < 8; j++) out += CHECKSUM_CHARSET[Number((c >> (5n * BigInt(7 - j))) & 31n)];
  return out;
}

export function withChecksum(desc) { return desc + '#' + descriptorChecksum(desc); }
