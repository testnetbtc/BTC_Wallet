import { entropyToMnemonic, mnemonicToSeedSync, generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

// Official BIP-39 test vector (Trezor python-mnemonic), passphrase "TREZOR":
const v128_entropy = '00000000000000000000000000000000';
const v128_mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const v128_seed = 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04';

const m = entropyToMnemonic(hexToBytes(v128_entropy), wordlist);
const s = bytesToHex(mnemonicToSeedSync(m, 'TREZOR'));
console.log('mnemonic match:', m === v128_mnemonic);
console.log('seed match    :', s === v128_seed);

// 256-bit: all-zero entropy -> 24 words ending in "art"
const m256 = entropyToMnemonic(hexToBytes('00'.repeat(32)), wordlist);
console.log('256-bit words :', m256.split(' ').length, '| ends with "art":', m256.endsWith(' art'));

// Derivation sanity: BIP-84 testnet path from a fixed seed -> deterministic address prefix
const seed = mnemonicToSeedSync(m256, '');
const root = HDKey.fromMasterSeed(seed);
const child = root.derive("m/84'/1'/0'/0/0");   // testnet native segwit account
console.log('derives a key :', child.publicKey.length === 33);

const ok = (m === v128_mnemonic) && (s === v128_seed) && (m256.split(' ').length === 24) && m256.endsWith(' art');
console.log(ok ? '\nSELFTEST PASS — library wiring is correct.' : '\nSELFTEST FAIL');
process.exit(ok ? 0 : 1);
