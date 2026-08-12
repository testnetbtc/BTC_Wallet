// Wrong-network protection: a mainnet address must be rejected on a test network
// and vice-versa, for every script format, BEFORE it can become an output — a
// classic way to burn funds. Network is validated at build time.
import { assertAddressNetwork, buildSignedTx, buildSweepTx } from '../src/tx.js';
import { deriveScript } from '../src/scripts.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(60), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const MN = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';

// derive a real address of each format on each network
const addr = (net, type) => deriveScript(MN, net, type, 0, '').address;
const TYPES = ['p2wpkh', 'p2tr', 'p2sh-p2wpkh', 'p2pkh'];

// same-network addresses ACCEPT; cross-network REJECT, for every format
for (const t of TYPES) {
  const main = addr('mainnet', t), test = addr('testnet4', t);
  ok(`${t}: valid mainnet addr accepted on mainnet`, assertAddressNetwork(main, 'mainnet') === main);
  ok(`${t}: valid testnet addr accepted on testnet4`, assertAddressNetwork(test, 'testnet4') === test);
  ok(`${t}: mainnet addr REJECTED on testnet4`, throws(() => assertAddressNetwork(main, 'testnet4'), /wrong network|not a valid/));
  ok(`${t}: testnet addr REJECTED on mainnet`, throws(() => assertAddressNetwork(test, 'mainnet'), /wrong network|not a valid/));
}
ok('empty address rejected', throws(() => assertAddressNetwork('', 'mainnet'), /missing/));
ok('garbage rejected', throws(() => assertAddressNetwork('not-an-address', 'testnet4'), /not a valid/));

// the guard is wired into the actual builders (recipient + sweep destination)
const key = deriveScript(MN, 'testnet4', 'p2wpkh', 0, '');
key.address = key.address; // (deriveScript returns address+spend already)
const skey = { ...key, privKey: key.privKey };
const utxos = [{ txid: 'ab'.repeat(32), vout: 0, value: 100000 }];
const mainAddr = addr('mainnet', 'p2wpkh');
ok('buildSignedTx rejects a mainnet recipient on testnet4',
  throws(() => buildSignedTx({ utxos, key: skey, recipients: [{ address: mainAddr, amount: 9000 }], feeRate: 2, networkName: 'testnet4' }), /not a valid testnet4|wrong network/));
ok('buildSweepTx rejects a mainnet destination on testnet4',
  throws(() => buildSweepTx({ utxos, key: skey, toAddress: mainAddr, feeRate: 2, networkName: 'testnet4' }), /not a valid testnet4|wrong network/));
ok('buildSignedTx still accepts a correct testnet4 recipient',
  !throws(() => buildSignedTx({ utxos, key: skey, recipients: [{ address: addr('testnet4', 'p2wpkh'), amount: 9000 }], feeRate: 2, networkName: 'testnet4' })));

console.log(bad ? '\nWRONG-NETWORK TEST FAILED' : '\nWRONG-NETWORK TEST PASS — cross-network addresses cannot become outputs');
process.exit(bad ? 1 : 0);
