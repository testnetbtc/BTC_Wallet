// Encrypted on-device seed vault. Lets the wallet persist between visits the
// honest way: the seed is encrypted under a user PIN/passphrase with
// scrypt (key stretching) + XChaCha20-Poly1305 (authenticated encryption) —
// the same audited primitives as the cold generator's backup files. Only the
// ciphertext blob is ever handed to storage; plaintext exists in memory only,
// after a successful unlock. Wrong PIN = authentication failure, not garbage.
import { scrypt } from '@noble/hashes/scrypt';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/hashes/utils';
import { utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils';
import { base64 } from '@scure/base';

// scrypt cost: N=2^15 keeps unlock ~0.5s on a phone while still making a
// short-PIN brute force expensive; the salt is per-vault so no rainbow tables.
const KDF = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 };

export function sealSeed(mnemonic, pin) {
  if (!pin || String(pin).length < 4) throw new Error('choose a PIN or passphrase of at least 4 characters');
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = scrypt(utf8ToBytes(String(pin)), salt, KDF);
  const ct = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(mnemonic));
  return JSON.stringify({ v: 1, kdf: 'scrypt-32768-8-1', salt: base64.encode(salt), nonce: base64.encode(nonce), ct: base64.encode(ct) });
}

export function openSeed(blobJson, pin) {
  let b;
  try { b = JSON.parse(blobJson); } catch { throw new Error('saved wallet data is corrupted'); }
  if (b.v !== 1) throw new Error(`unsupported vault version ${b.v}`);
  const key = scrypt(utf8ToBytes(String(pin || '')), base64.decode(b.salt), KDF);
  try {
    return bytesToUtf8(xchacha20poly1305(key, base64.decode(b.nonce)).decrypt(base64.decode(b.ct)));
  } catch {
    throw new Error('wrong PIN (or the saved data was tampered with)');
  }
}
