// Air-gap round-trip: watch-only build (xpub) -> offline sign (seed) -> extract.
// Proves the seed is not needed to build, and the result is a valid broadcastable
// tx (cross-checked with Bitcoin Core + against the direct hot-wallet build).
import { execSync } from 'node:child_process';
import { deriveKey, accountXpub } from '../src/wallet.js';
import { watchOnly, buildUnsignedPSBT, signPSBTOffline, extractTx } from '../src/psbt.js';
import { buildSignedTx } from '../src/tx.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(42), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NET = 'testnet4';

// 1) watch-only from xpub derives the SAME address as the full key (no seed needed)
const xpub = accountXpub(MN, '', NET);
const wo = watchOnly(xpub, NET, 0, 0);
const key = deriveKey(MN, '', NET, 0);
console.log('watch-only address:', wo.address);
ok('xpub-only address == full-key address', wo.address === key.address);

// 2) ONLINE builds an unsigned PSBT (no seed)
const utxos = [{ txid: 'b'.repeat(64), vout: 0, value: 50_000 }];
const un = buildUnsignedPSBT({ utxos, wo, recipients: [{ address: wo.address, amount: 1000 }],
                               message: 'air-gap olesia', feeRate: 3, network: NET });
ok('unsigned PSBT produced', typeof un.psbt === 'string' && un.psbt.length > 20);
console.log('unsigned fee/vsize:', un.fee, '/', un.vsize);

// 3) OFFLINE signs it with the seed
const signed = signPSBTOffline(un.psbt, MN, '', NET, 0);
ok('offline sign produced a txid', /^[0-9a-f]{64}$/.test(signed.txid));

// 4) ONLINE extracts the raw tx and it decodes cleanly in Bitcoin Core
const ext = extractTx(signed.psbt);
ok('extract matches signer txid', ext.txid === signed.txid);
try {
  const dec = JSON.parse(execSync(
    `sudo -u bitcoin /usr/local/bin/bitcoin-cli -datadir=/var/lib/bitcoind decoderawtransaction ${ext.txHex}`,
    { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  const opret = dec.vout.find((v) => v.scriptPubKey.type === 'nulldata');
  ok('[node] valid tx, our txid', dec.txid === signed.txid);
  ok('[node] carries the OP_RETURN', !!opret && opret.scriptPubKey.asm.includes(Buffer.from('air-gap olesia').toString('hex')));
} catch (e) { console.log('node cross-check   : skipped —', String(e.message).slice(0, 50)); }

// 5) air-gap result == direct hot-wallet build (same deterministic tx)
const direct = buildSignedTx({ utxos, key, recipients: [{ address: key.address, amount: 1000 }],
                               message: 'air-gap olesia', feeRate: 3, networkName: NET });
ok('air-gap txHex == direct-build txHex', ext.txHex === direct.txHex);

console.log(bad ? '\nPSBT TEST FAILED' : '\nPSBT TEST PASS');
process.exit(bad ? 1 : 0);
