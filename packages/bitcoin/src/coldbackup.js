// Decrypt an encrypted-backup .json produced by the Olesia cold generator
// (offline.olesia.io), so the wallet can import from that file. Matches the
// generator's format exactly: scrypt N=2^16 + XChaCha20-Poly1305, v3 binding the
// metadata as AEAD associated data. Decrypt-only — the wallet never writes this
// format (its own on-device vault is a separate, lighter format).
import { scrypt } from '@noble/hashes/scrypt';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { bytesToUtf8 } from '@noble/ciphers/utils';

const KDF = { N: 65536, r: 8, p: 1, dkLen: 32 };

// Exact string the generator authenticates (order and separators must match).
const aadString = (h) =>
  `${h.format}|v=${h.version}|net=${h.network}|path=${h.path}` +
  `|addrhash=${h.addressHash}|pp=${h.passphraseUsed ? 1 : 0}`;

export function decryptColdBackup(obj, password) {
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { throw new Error('that is not a valid backup file'); } }
  if (!obj || (obj.format !== 'olesia-backup' && obj.format !== 'alea-backup'))
    throw new Error('not an Olesia cold-generator backup file');
  if (![1, 2, 3].includes(obj.version)) throw new Error('unsupported backup version: ' + obj.version);
  const k = obj.kdf, c = obj.cipher;
  if (!k || k.name !== 'scrypt') throw new Error('unsupported KDF in file');
  if (!c || c.name !== 'xchacha20poly1305') throw new Error('unsupported cipher in file');
  // Refuse anything but the canonical params (blocks a memory-bomb file pre-scrypt).
  if (k.N !== KDF.N || k.r !== KDF.r || k.p !== KDF.p || k.dkLen !== KDF.dkLen)
    throw new Error('backup KDF parameters are not the canonical Olesia values — refusing');
  if (!password) throw new Error('enter the file password');
  const key = scrypt(utf8ToBytes(password), hexToBytes(k.salt), KDF);
  const aad = obj.version >= 3
    ? utf8ToBytes(aadString({ format: obj.format, version: obj.version, network: obj.network,
        path: obj.path, addressHash: obj.addressHash, passphraseUsed: !!obj.passphraseUsed }))
    : undefined;
  let pt;
  try { pt = xchacha20poly1305(key, hexToBytes(c.nonce), aad).decrypt(hexToBytes(obj.ciphertext)); }
  catch { throw new Error('wrong password, corrupt file, or tampered metadata'); }
  return { mnemonic: bytesToUtf8(pt), passphraseUsed: !!obj.passphraseUsed };
}
