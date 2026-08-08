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

// v3 authenticates the security-relevant metadata by binding it as AEAD associated
// data (AAD). If any of these fields is altered in the file, restore fails instead
// of silently deriving the wrong thing. Salt and nonce are already integrity-bound
// by the AEAD itself (a wrong salt yields a wrong key -> MAC failure), so they are
// not repeated here. Order is fixed so encrypt and decrypt produce identical bytes.
function aadString(h) {
  // Prefix is the file's own format tag so encrypt/decrypt stay self-consistent
  // across a rebrand: old files carry format 'alea-backup', new ones 'olesia-backup',
  // and each reproduces the exact AAD it was sealed with.
  return `${h.format}|v=${h.version}|net=${h.network}|path=${h.path}`
       + `|addrhash=${h.addressHash}|pp=${h.passphraseUsed ? 1 : 0}`;
}

export function encryptBackup(mnemonic, password, meta) {
  if (!password) throw new Error('a file password is required');
  const salt  = rand(16);
  const nonce = rand(24);
  const key   = scrypt(utf8ToBytes(password), salt, KDF);
  // v3 header: sha256(address) not the address (privacy), passphrase NEVER stored,
  // and the header below is authenticated via AAD.
  const header = {
    format: 'olesia-backup', version: 3,
    network: meta.network, path: meta.path,
    addressHash: bytesToHex(sha256(utf8ToBytes(meta.address))),
    passphraseUsed: !!meta.passphraseUsed,
  };
  const aad = utf8ToBytes(aadString(header));
  const ct  = xchacha20poly1305(key, nonce, aad).encrypt(utf8ToBytes(mnemonic));
  return {
    ...header,
    warning: 'Encrypted BIP-39 recovery phrase. The BIP-39 passphrase (if used) is NOT stored here by design. In v3 the metadata is authenticated (bound as AEAD associated data), so tampering is detected on restore.',
    createdAt: new Date().toISOString(),
    kdf: { ...KDF, salt: bytesToHex(salt) },
    cipher: { name: 'xchacha20poly1305', nonce: bytesToHex(nonce) },
    ciphertext: bytesToHex(ct),
  };
}

export function decryptBackup(obj, password) {
  if (!obj || (obj.format !== 'olesia-backup' && obj.format !== 'alea-backup'))
    throw new Error('not an Olesia backup file');
  if (obj.version !== 1 && obj.version !== 2 && obj.version !== 3)
    throw new Error('unsupported backup version: ' + obj.version);
  const k = obj.kdf, c = obj.cipher;
  if (!k || k.name !== 'scrypt') throw new Error('unsupported KDF: ' + (k && k.name));
  if (!c || c.name !== 'xchacha20poly1305') throw new Error('unsupported cipher: ' + (c && c.name));
  // Accept ONLY the exact canonical KDF parameters Olesia itself emits. Olesia has always
  // used these values, so every genuine backup passes; a malicious file that sets N
  // huge (a memory bomb) is rejected BEFORE scrypt runs, eliminating the restore-time
  // DoS entirely. Any future parameter change ships as a new backup version, not as
  // attacker-chosen numbers inside the file.
  if (k.N !== KDF.N || k.r !== KDF.r || k.p !== KDF.p || k.dkLen !== KDF.dkLen)
    throw new Error('backup KDF parameters are not the canonical Olesia values — refusing (out of range)');
  const key = scrypt(utf8ToBytes(password), hexToBytes(k.salt), KDF);
  // v3 binds metadata as AAD; v1/v2 predate that and used no associated data.
  const aad = obj.version >= 3
    ? utf8ToBytes(aadString({ format: obj.format, version: obj.version, network: obj.network,
                              path: obj.path, addressHash: obj.addressHash,
                              passphraseUsed: !!obj.passphraseUsed }))
    : undefined;
  let pt;
  try { pt = xchacha20poly1305(key, hexToBytes(c.nonce), aad).decrypt(hexToBytes(obj.ciphertext)); }
  catch { throw new Error('wrong password, corrupt file, or tampered metadata'); }
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

// Verify a restored address against a backup file. Handles v2 (address hash) and
// v1 (cleartext address, kept for backwards compatibility with early backups).
export function verifyAddress(obj, address) {
  if (obj.addressHash) return bytesToHex(sha256(utf8ToBytes(address))) === obj.addressHash;
  if (obj.address)     return address === obj.address;
  return false;
}
