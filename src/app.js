// Alea — wallet seed generator core. Built on audited primitives only.
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { concatBytes, utf8ToBytes, bytesToHex } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';
import { encryptBackup, decryptBackup, withChecksum, verifyAddress } from './backup.js';

const hash160 = (b) => ripemd160(sha256(b));

function p2wpkh(pubkey, testnet) {
  const hrp = testnet ? 'tb' : 'bc';
  const words = [0, ...bech32.toWords(hash160(pubkey))]; // witness v0
  return bech32.encode(hrp, words);
}

// Combine independent entropy sources into 256 bits.
// SECURITY ROOT: crypto.getRandomValues (the OS CSPRNG). Mouse + dice are mixed
// in as DEFENCE IN DEPTH — because we hash everything together, the result is
// >=256-bit strong as long as ANY ONE source is strong, and the CSPRNG always is.
// You cannot launder a weak source, but you CAN safely fold extra sources onto a
// strong one. (That is the lesson of this whole project, made into code.)
export function buildEntropy({ mouseBytes, diceString }) {
  const csprng = new Uint8Array(32);
  crypto.getRandomValues(csprng);                 // <-- the real security
  const parts = [
    csprng,
    sha256(mouseBytes && mouseBytes.length ? mouseBytes : new Uint8Array(1)),
    sha256(utf8ToBytes('dice:' + (diceString || ''))),
  ];
  return sha256(concatBytes(...parts));           // 32 bytes = 256 bits
}

// BIP-32 serialization version bytes. Testnet extended keys must serialize as
// tpub/tprv, not xpub/xprv, or descriptor imports into Sparrow/Core can be
// rejected or misread. (Address derivation is unaffected -- it uses the raw
// pubkey -- so this changes only the exported descriptor string.)
const VERSIONS = {
  mainnet: { private: 0x0488ade4, public: 0x0488b21e },
  testnet: { private: 0x04358394, public: 0x043587cf },
};

export function deriveFrom(mnemonic, passphrase, testnet) {
  const seed = mnemonicToSeedSync(mnemonic, passphrase || '');
  const root = HDKey.fromMasterSeed(seed, testnet ? VERSIONS.testnet : VERSIONS.mainnet);
  const coin = testnet ? 1 : 0;
  const path = `m/84'/${coin}'/0'/0/0`;
  return { address: p2wpkh(root.derive(path).publicKey, testnet), path };
}

// `network` is 'mainnet' | 'testnet3' | 'testnet4'. IMPORTANT HONESTY NOTE:
// testnet3 and testnet4 derive IDENTICALLY -- both use BIP-44 coin type 1', the
// `tb` bech32 prefix, and tpub serialization, so the seed/address/descriptor are
// byte-for-byte the same. The label records only which test CHAIN you intend to
// broadcast on; it changes nothing about the keys. (Legacy callers may still pass
// `testnet:true`, which maps to 'testnet3'.)
export function makeWallet({ mouseBytes, diceString, passphrase, network, testnet }) {
  if (!network) network = testnet ? 'testnet3' : 'mainnet';
  const isTestnet = network !== 'mainnet';
  const entropy = buildEntropy({ mouseBytes, diceString });
  const mnemonic = entropyToMnemonic(entropy, wordlist);       // 24 words
  const seed = mnemonicToSeedSync(mnemonic, passphrase || ''); // passphrase = BIP-39 25th word
  const root = HDKey.fromMasterSeed(seed, isTestnet ? VERSIONS.testnet : VERSIONS.mainnet);
  const coin = isTestnet ? 1 : 0;
  const acctPath = `m/84'/${coin}'/0'`;
  const path = `${acctPath}/0/0`;
  const child = root.derive(path);
  const acct = root.derive(acctPath);
  const fp = root.fingerprint.toString(16).padStart(8, '0');
  const origin = `[${fp}/84h/${coin}h/0h]`;
  return {
    mnemonic,
    entropyHex: bytesToHex(entropy),          // the 256-bit root, for verification
    passphraseUsed: !!(passphrase && passphrase.length),
    path,
    address: p2wpkh(child.publicKey, isTestnet),
    network,
    descriptorReceive: withChecksum(`wpkh(${origin}${acct.publicExtendedKey}/0/*)`),
    descriptorChange:  withChecksum(`wpkh(${origin}${acct.publicExtendedKey}/1/*)`),
  };
}

// RNG liveness / sanity smoke test. Draws fresh bytes from the SAME CSPRNG the
// wallet uses (crypto.getRandomValues) and runs a monobit (bit-balance) plus
// byte-uniformity check. It detects a GROSSLY broken or stuck RNG -- all-zeros, a
// constant, or a heavy bias. It CANNOT prove cryptographic quality: any competent
// PRNG, secure or not, passes these. The real assurance is the source and this
// page's reproducible build, not a statistical test on the output.
export function rngSelfTest(nBytes = 8192) {
  const buf = new Uint8Array(nBytes);
  crypto.getRandomValues(buf);
  const freq = new Uint32Array(256);
  let ones = 0;
  for (let i = 0; i < nBytes; i++) {
    let b = buf[i];
    freq[b]++;
    b = b - ((b >> 1) & 0x55);                // popcount of the byte
    b = (b & 0x33) + ((b >> 2) & 0x33);
    ones += (b + (b >> 4)) & 0x0f;
  }
  const bits = nBytes * 8;
  const proportion = ones / bits;
  const sigma = 0.5 * Math.sqrt(bits);
  const z = Math.abs(ones - bits / 2) / sigma;  // monobit z-score
  let distinct = 0, maxFreq = 0;
  for (let v = 0; v < 256; v++) { if (freq[v]) distinct++; if (freq[v] > maxFreq) maxFreq = freq[v]; }
  const monobitOk = z < 4;                        // ~1-in-16000 false fail
  const notStuck = distinct > 200 && maxFreq < (nBytes / 256) * 4;
  return { ok: monobitOk && notStuck, nBytes, bits, ones, proportion, z, distinct, monobitOk, notStuck };
}

// Generate a strong random passphrase for the ENCRYPTED BACKUP FILE (not the
// wallet). Backup files can be attacked offline, so a weak file password is the
// weak link; the easiest honest fix is to make a strong one one click away.
// Diceware-style from the BIP-39 wordlist: 6 words ~= 66 bits. 2^32 is an exact
// multiple of 2048, so `% 2048` is unbiased.
export function randomPassword(nWords = 6) {
  const idx = new Uint32Array(nWords);
  crypto.getRandomValues(idx);
  return Array.from(idx, (i) => wordlist[i % 2048]).join('-');
}

// expose for the page + a self-check hook
if (typeof window !== 'undefined') {
  window.Alea = { makeWallet, deriveFrom, encryptBackup, decryptBackup, verifyAddress, rngSelfTest, randomPassword, _vectorCheck };
}

// Correctness self-check the PAGE runs on load against the official BIP-84 vector.
export function _vectorCheck() {
  const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = mnemonicToSeedSync(m, '');
  const child = HDKey.fromMasterSeed(seed).derive("m/84'/0'/0'/0/0");
  const addr = p2wpkh(child.publicKey, false);
  const expected = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';   // BIP-84 spec vector
  return { ok: addr === expected, addr, expected };
}
