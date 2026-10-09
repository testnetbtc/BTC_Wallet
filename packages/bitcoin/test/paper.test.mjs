// Paper wallets: key source, second-path check, read-back verification.
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { createPaperWallet, checkPaperWallet, PAPER_TYPES } from '../src/paper.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(84), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

let calls = 0; const rb = (n) => { calls++; return randomBytes(n); };
const w = createPaperWallet({ randomBytes: rb, type: 'p2wpkh' });
ok('a paper wallet is a compressed mainnet WIF and a bc1q address', /^[KL]/.test(w.wif) && w.address.startsWith('bc1q') && calls >= 1);
const priv = btc.WIF().decode(w.wif);
ok('the WIF decodes to the key whose public key gives exactly that address', btc.p2wpkh(secp256k1.getPublicKey(priv, true)).address === w.address);
const l = createPaperWallet({ randomBytes: rb, type: 'p2pkh' });
ok('a Legacy paper wallet gives a 1… address from the same construction', l.address.startsWith('1') && btc.p2pkh(secp256k1.getPublicKey(btc.WIF().decode(l.wif), true)).address === l.address);
ok('two wallets never share a key', createPaperWallet({ randomBytes: rb }).wif !== createPaperWallet({ randomBytes: rb }).wif);
ok('the random source is mandatory and must be a function', (() => { try { createPaperWallet({}); return false; } catch (e) { return /random source/.test(e.message); } })());
ok('only the two address types the wallet issues', PAPER_TYPES.join() === 'p2wpkh,p2pkh' && (() => { try { createPaperWallet({ randomBytes: rb, type: 'p2tr' }); return false; } catch { return true; } })());
// the only randomness used is the injected source: a fixed source gives a fixed key
const fixed = (n) => new Uint8Array(n).fill(7);
ok('keys are a pure function of the random source (no hidden entropy, no time)', createPaperWallet({ randomBytes: fixed }).wif === createPaperWallet({ randomBytes: fixed }).wif);
// read-back
ok('read-back: the printed key verifies against the printed address', checkPaperWallet({ wif: w.wif, expectAddress: w.address }).ok);
ok('read-back: surrounding whitespace is tolerated', checkPaperWallet({ wif: '  ' + w.wif + '\n', expectAddress: w.address }).ok);
ok('read-back: a mistyped character is a clear failure, not a different wallet', (() => { const r = checkPaperWallet({ wif: w.wif.slice(0, -1) + (w.wif.endsWith('a') ? 'b' : 'a'), expectAddress: w.address }); return !r.ok && /not a valid private key|different address/.test(r.reason); })());
ok('read-back: a valid but different key names the address it really controls', (() => { const o = createPaperWallet({ randomBytes: rb }); const r = checkPaperWallet({ wif: o.wif, expectAddress: w.address }); return !r.ok && r.address === o.address && /different address/.test(r.reason); })());
ok('read-back: the type matters (a bc1q sheet checked as Legacy fails)', !checkPaperWallet({ wif: w.wif, expectAddress: w.address, type: 'p2pkh' }).ok);
console.log(bad ? '\nPAPER TESTS FAILED' : '\npaper wallet: all checks passed');
process.exit(bad ? 1 : 0);
