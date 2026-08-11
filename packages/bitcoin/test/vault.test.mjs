// Vault: seal/open roundtrip, wrong-PIN rejection, tamper detection, uniqueness.
import { sealSeed, openSeed } from '../src/vault.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(52), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const blob = sealSeed(SEED, '2468');
ok('seals to JSON with no plaintext seed inside', !blob.includes('abandon'));
ok('opens with the right PIN', openSeed(blob, '2468') === SEED);

let threw = '';
try { openSeed(blob, '2469'); } catch (e) { threw = e.message; }
ok('wrong PIN rejected (auth failure, not garbage)', /wrong PIN/.test(threw));

const b = JSON.parse(blob); b.ct = b.ct.slice(0, -4) + 'AAAA';
threw = ''; try { openSeed(JSON.stringify(b), '2468'); } catch (e) { threw = e.message; }
ok('tampered ciphertext rejected', /wrong PIN|tampered/.test(threw));

ok('two seals of the same seed differ (fresh salt/nonce)', sealSeed(SEED, '2468') !== blob);

threw = ''; try { sealSeed(SEED, '12'); } catch (e) { threw = e.message; }
ok('short PIN refused at seal time', /at least 4/.test(threw));

console.log(bad ? '\nVAULT TEST FAILED' : '\nVAULT TEST PASS — encrypted persistence is sound');
process.exit(bad ? 1 : 0);
