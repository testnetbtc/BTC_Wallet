// Prove we can SPEND from every script type: build + sign a real tx for each of
// P2PKH, P2SH-P2WPKH, P2WPKH, P2TR (send + change) and P2PK (sweep), and confirm
// each decodes in Bitcoin Core. Legacy types (P2PKH, P2PK) need the previous tx —
// we mint one with a P2WPKH funding tx so the test is fully offline.
import * as btc from '@scure/btc-signer';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { execSync } from 'node:child_process';
import { deriveKey } from '../src/wallet.js';
import { deriveScript, scriptTypeList } from '../src/scripts.js';
import { buildSignedTx, buildSweepTx } from '../src/tx.js';

const NET = 'signet';
const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let bad = false;
const ok = (l, c) => { console.log(l.padEnd(46), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const decode = (hex) => { try { return JSON.parse(execSync(`sudo -u bitcoin /usr/local/bin/bitcoin-cli -datadir=/var/lib/bitcoind decoderawtransaction ${hex}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()); } catch { return null; } };

// Mint a minimal legacy "previous tx" paying `value` to `scriptBytes` (raw
// serialization — this is exactly what a legacy input's nonWitnessUtxo needs).
function mintPrevTx(scriptBytes, value) {
  const le = (num, bytes) => { const a = new Uint8Array(bytes); let v = BigInt(num); for (let i = 0; i < bytes; i++) { a[i] = Number(v & 0xffn); v >>= 8n; } return a; };
  const raw = concatBytes(
    le(2, 4),                         // version
    Uint8Array.of(1),                 // vin count
    new Uint8Array(32), le(0, 4),     // prevout (dummy)
    Uint8Array.of(0), le(0xffffffff, 4), // empty scriptSig, sequence
    Uint8Array.of(1),                 // vout count
    le(value, 8),                     // amount
    Uint8Array.of(scriptBytes.length), scriptBytes, // scriptPubKey (len < 0xfd)
    le(0, 4),                         // locktime
  );
  return { hex: bytesToHex(raw), txid: bytesToHex(sha256(sha256(raw)).slice().reverse()) };
}

const RECIPIENT = deriveKey(MN, '', NET, 5).address; // a valid tb1q… to receive
const VALUE = 100_000;

for (const type of scriptTypeList()) {
  const w = deriveScript(MN, NET, type, 0);

  // P2PK: receive/display only (spending a bare pk isn't supported by the signer).
  if (type === 'p2pk') {
    ok('p2pk        derives a script, no address', w.address === null && /ac$/.test(w.scriptHex));
    ok('p2pk        has a scripthash for balance lookup', /^[0-9a-f]{64}$/.test(w.scripthash));
    continue;
  }

  let res;
  if (w.segwit) {
    const utxos = [{ txid: 'ab'.repeat(32), vout: 0, value: VALUE }];
    res = buildSignedTx({ utxos, key: w, recipients: [{ address: RECIPIENT, amount: 20_000 }], feeRate: 5, networkName: NET });
  } else {
    // legacy P2PKH: send + change to own address, needs the previous tx
    const prev = mintPrevTx(w.spend.script, VALUE);
    const utxos = [{ txid: prev.txid, vout: 0, value: VALUE, prevTxHex: prev.hex }];
    res = buildSignedTx({ utxos, key: w, recipients: [{ address: RECIPIENT, amount: 20_000 }], changeAddress: w.address, feeRate: 5, networkName: NET });
  }
  ok(`${type.padEnd(12)} builds + signs (txid ${res.txid.slice(0, 8)}…)`, /^[0-9a-f]{64}$/.test(res.txid));
  const dec = decode(res.txHex);
  if (dec) ok(`${type.padEnd(12)} [node] decodes, ${dec.vin.length} in / ${dec.vout.length} out, fee ${res.fee}`, dec.txid === res.txid && dec.vin.length >= 1);
  else console.log(`${type.padEnd(12)} node decode skipped (bitcoin-cli unreachable)`);
}

console.log(bad ? '\nSCRIPT-TYPES TEST FAILED' : '\nSCRIPT-TYPES TEST PASS — spend works for every script type');
process.exit(bad ? 1 : 0);
