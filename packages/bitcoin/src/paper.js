// Paper wallets: one fresh private key, printed. The oldest form of cold storage and still an
// honest one, provided the user understands the three rules this module exists to enforce:
//   1. the key must come from the operating system's CSPRNG and nothing else;
//   2. the printed key must be PROVEN readable before any money goes to the address
//      (a paper wallet whose key cannot be read back is a donation to nobody);
//   3. it is one address: spend it all at once, then never use it again.
// Key generation and the key → address path are the wallet's normal ones (@noble/curves,
// @scure/btc-signer); nothing here is new cryptography.
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { addressOf, wifOf } from './vanity.js';
import { parseWifAny } from './account.js';

export const PAPER_TYPES = ['p2wpkh', 'p2pkh'];

function randomPrivKey(randomBytes) {
  for (;;) { const k = randomBytes(32); if (secp256k1.utils.isValidPrivateKey(k)) return k; }
}

// Make one paper wallet: { wif, address, type, pubkey }. `randomBytes` is injected so tests can
// prove what is used (the page passes crypto.getRandomValues; nothing else is ever accepted).
export function createPaperWallet({ randomBytes, type = 'p2wpkh', network = 'mainnet' }) {
  if (typeof randomBytes !== 'function') throw new Error('a random source is required');
  if (!PAPER_TYPES.includes(type)) throw new Error('paper wallets are bc1q or 1… addresses');
  const privKey = randomPrivKey(randomBytes);
  const pubkey = secp256k1.getPublicKey(privKey, true);
  const wif = wifOf(privKey, network);
  const address = addressOf(pubkey, type, network);
  // second path: the WIF we are about to print must decode to the same key and address
  const back = parseWifAny(wif, network);
  if (bytesToHex(back.privKey) !== bytesToHex(privKey) || !back.compressed || addressOf(back.pubkey, type, network) !== address) throw new Error('self-check failed — nothing was made');
  privKey.fill(0);
  return { wif, address, type, pubkey: bytesToHex(pubkey) };
}

// The read-back check: the user types (or scans) the key from the printed sheet; it must be
// exactly the printed one. Returns { ok, address } — `address` is what the typed key really
// controls, so a wrong-but-valid key shows where money would actually go.
export function checkPaperWallet({ wif, expectAddress, type = 'p2wpkh', network = 'mainnet' }) {
  let k;
  try { k = parseWifAny(String(wif || '').trim(), network); } catch (e) { return { ok: false, reason: 'that is not a valid private key: ' + e.message }; }
  const address = addressOf(k.pubkey, type, network);
  if (address !== expectAddress) return { ok: false, reason: 'that key controls a different address — one or more characters were read wrongly', address };
  return { ok: true, address };
}

// Characters a reader confuses on paper; shown on the sheet as a legend.
export const WIF_LOOKALIKES = 'The key never contains 0 (zero), O (capital o), I (capital i) or l (lower-case L).';
