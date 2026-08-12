// Safety test for the watch-only classifier. The SECRET cases MUST all reject.
import { classifyInput, xpubAddresses } from './lib.mjs';
import { accountXpub } from '../src/wallet.js';

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
expect('xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi', 'SECRET', 'xprv');
expect('tprv8ZgxMBicQKsPeDgjzdC36fs6bMjGApWDNLR9erAXMs5skhMv36j9MV5ecvfavji5khqjWaWSFhN3YcCUUdKb2WYW9tdrRk9dvC5rJ6RcCTf', 'SECRET', 'tprv');
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
