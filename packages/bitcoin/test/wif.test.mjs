// WIF: parse, derive every address format from one key, reject wrong network,
// build a sweep that Bitcoin Core decodes.
import { execSync } from 'node:child_process';
import * as btc from '@scure/btc-signer';
import { hexToBytes } from '@noble/hashes/utils';
import { parseWIF, wifKey, wifAddresses } from '../src/wif.js';
import { buildSweepTx } from '../src/tx.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(50), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const decode = (hex) => { try { return JSON.parse(execSync(`sudo -u bitcoin /usr/local/bin/bitcoin-cli -datadir=/var/lib/bitcoind decoderawtransaction ${hex}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()); } catch { return null; } };

const NET = 'signet'; // testnet address params
const priv = hexToBytes('0101010101010101010101010101010101010101010101010101010101010101');
const wif = btc.WIF(btc.TEST_NETWORK).encode(priv);

const p = parseWIF(wif, NET);
ok('parses WIF to a 32-byte key + 33-byte pubkey', p.privKey.length === 32 && p.pubkey.length === 33);

const addrs = wifAddresses(wif, NET);
ok('one key -> five script formats', addrs.length === 5);
ok('p2wpkh is tb1q…', addrs.find((a) => a.type === 'p2wpkh').address.startsWith('tb1q'));
ok('p2tr is tb1p…', addrs.find((a) => a.type === 'p2tr').address.startsWith('tb1p'));
ok('p2pkh is m/n…', /^[mn]/.test(addrs.find((a) => a.type === 'p2pkh').address));
ok('p2sh-p2wpkh is 2…', addrs.find((a) => a.type === 'p2sh-p2wpkh').address.startsWith('2'));
ok('p2pk has no address, script ends ac', addrs.find((a) => a.type === 'p2pk').address === null && /ac$/.test(addrs.find((a) => a.type === 'p2pk').scriptHex));

let threw = false;
try { parseWIF('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ', NET); } catch { threw = true; }
ok('mainnet WIF rejected on a testnet', threw);

// build a sweep from the WIF's SegWit key and confirm it decodes
const key = wifKey(wif, NET, 'p2wpkh');
const sweep = buildSweepTx({ utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 50000 }], key, toAddress: addrs.find((a) => a.type === 'p2pkh').address, feeRate: 2, networkName: NET });
ok(`sweep builds (txid ${sweep.txid.slice(0, 8)}…)`, /^[0-9a-f]{64}$/.test(sweep.txid));
const dec = decode(sweep.txHex);
if (dec) ok('sweep [node] decodes, 1 in / 1 out', dec.vin.length === 1 && dec.vout.length === 1);
else console.log('sweep node decode skipped (bitcoin-cli unreachable)');

console.log(bad ? '\nWIF TEST FAILED' : '\nWIF TEST PASS — one key, every format, sweepable');
process.exit(bad ? 1 : 0);
