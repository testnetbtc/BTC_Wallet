// Safety test for the watch-only classifier. The SECRET cases MUST all reject.
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { classifyInput, xpubAddresses } from './lib.mjs';
import { accountXpub } from '../src/wallet.js';
import { net } from '../src/networks.js';

let fail = 0;
const expect = (input, kind, note = '') => {
  const r = classifyInput(input);
  const ok = r.kind === kind;
  if (!ok) fail++;
  const shown = kind === 'SECRET' ? '<redacted secret>' : (input.length > 40 ? input.slice(0, 40) + '…' : input);
  console.log(`${ok ? 'PASS' : 'FAIL'}  expect ${kind}  got ${r.kind}  ${note || shown}`);
};

// A real (throwaway) BIP-39 test vector — MUST be rejected, never stored.
const SEED12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED24 = (SEED12 + ' ' + SEED12).split(' ').slice(0, 24).join(' ');

console.log('--- SECRETS (must all REJECT) ---');
expect(SEED12, 'SECRET', '12-word seed');
expect(SEED24, 'SECRET', '24-word seed');
expect('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ', 'SECRET', 'mainnet WIF');
expect('cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy', 'SECRET', 'testnet WIF');
// xprv/tprv derived at RUNTIME from the throwaway test seed — so a real private
// extended key is fed to the classifier, but no key-shaped literal sits in the
// repo (which the CI secret-scan rightly flags, test vector or not).
const root = mnemonicToSeedSync(SEED12, '');
expect(HDKey.fromMasterSeed(root, net('mainnet').bip32).privateExtendedKey, 'SECRET', 'xprv (runtime-derived)');
expect(HDKey.fromMasterSeed(root, net('testnet4').bip32).privateExtendedKey, 'SECRET', 'tprv (runtime-derived)');
expect('0000000000000000000000000000000000000000000000000000000000000001', 'SECRET', 'hex privkey');

console.log('\n--- PUBLIC (must ACCEPT) ---');
expect('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'ADDRESS', 'mainnet P2PKH');
expect('bc1qa5wkgaew2dkv56kfvj49j0av5nml45x9ek9hz6', 'ADDRESS', 'mainnet bech32');
expect('3JZq4atUahhuA9rLhXLMhhTo133J9rF97j', 'ADDRESS', 'mainnet P2SH');
const xpub = accountXpub(SEED12, '', 'mainnet');
expect(xpub, 'XPUB', 'derived mainnet xpub');

console.log('\n--- GARBAGE (must be INVALID) ---');
expect('hello world this is not a key', 'INVALID');
expect('bc1qINVALIDCHECKSUMxxxxxxxxxxxxxxxxxxxxx', 'INVALID');

console.log('\n--- xpub -> addresses (gap-limit derivation) ---');
const addrs = xpubAddresses(xpub, 'mainnet');
console.log(`derived ${addrs.length} addresses (expect 40); first: ${addrs[0]}`);
if (addrs.length !== 40 || !addrs[0]?.startsWith('bc1q')) fail++;

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ ' + fail + ' FAILURES'}`);
process.exit(fail ? 1 : 0);
