// Alea — wallet seed generator core. Built on audited primitives only.
import { entropyToMnemonic, mnemonicToSeedSync, generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';

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

export function makeWallet({ mouseBytes, diceString, passphrase, testnet }) {
  const entropy = buildEntropy({ mouseBytes, diceString });
  const mnemonic = entropyToMnemonic(entropy, wordlist);       // 24 words
  const seed = mnemonicToSeedSync(mnemonic, passphrase || ''); // passphrase = BIP-39 25th word
  const root = HDKey.fromMasterSeed(seed);
  const coin = testnet ? 1 : 0;
  const path = `m/84'/${coin}'/0'/0/0`;
  const child = root.derive(path);
  return {
    mnemonic,
    passphraseUsed: !!(passphrase && passphrase.length),
    path,
    address: p2wpkh(child.publicKey, testnet),
    network: testnet ? 'testnet' : 'mainnet',
  };
}

// expose for the page + a self-check hook
if (typeof window !== 'undefined') {
  window.Alea = { makeWallet, _vectorCheck };
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
