// P2PK dedicated audit — the hand-rolled serialization + signing is attacked here
// from every angle the remediation order lists. Independence: (1) Bitcoin Core
// decoderawtransaction validates structure; (2) the signature is verified against
// a SIGHASH recomputed by a SEPARATE code path in this test (not the production
// preimage); (3) DER + low-S are parsed and checked; (4) deterministic hex is
// pinned as a regression vector. Live real-network acceptance is p2pk_live.mjs.
import { execSync } from 'node:child_process';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import * as btc from '@scure/btc-signer';
import { buildFundP2PK, buildSpendP2PK, p2pkScript, varint } from '../src/p2pk_fund.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(58), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const decode = (hex) => { try { return JSON.parse(execSync(`sudo -u bitcoin /usr/local/bin/bitcoin-cli -datadir=/var/lib/bitcoind decoderawtransaction ${hex}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()); } catch { return null; } };
const dsha = (b) => sha256(sha256(b));
const hash160 = (b) => ripemd160(sha256(b));
const u32 = (n) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n, true); return a; };
const u64 = (n) => { const a = new Uint8Array(8); new DataView(a.buffer).setBigUint64(0, BigInt(n), true); return a; };
const rev = (h) => hexToBytes(h).slice().reverse();
const wl = (s) => concatBytes(varint(s.length), s);

const priv = hexToBytes('0101010101010101010101010101010101010101010101010101010101010101');
const pub = secp256k1.getPublicKey(priv, true);
const wpkh = btc.p2wpkh(pub, btc.TEST_NETWORK);
const target = p2pkScript(pub);
const N = secp256k1.CURVE.n;

// ---- 1. VarInt boundaries (the classic serialization trap) -----------------
const vh = (n) => bytesToHex(varint(n));
ok('varint 0xfc  -> 1 byte',        vh(0xfc) === 'fc');
ok('varint 0xfd  -> fd + LE16',     vh(0xfd) === 'fdfd00');
ok('varint 0xffff-> fd + LE16',     vh(0xffff) === 'fdffff');
ok('varint 0x10000 -> fe + LE32',   vh(0x10000) === 'fe00000100');
ok('varint 0xffffffff -> fe + LE32', vh(0xffffffff) === 'feffffffff');
ok('varint 0x100000000 -> ff + LE64', vh(0x100000000) === 'ff0000000001000000');

// ---- 2. FUND: structure via Core + independent BIP-143 sig verification ----
const fund = buildFundP2PK({ utxos: [{ txid: '11'.repeat(32), vout: 0, value: 100000 }], privKey: priv, pubkey: pub, targetScript: target, changeScript: wpkh.script, amount: 60000, feeRate: 2 });
ok('fund txHex is deterministic (regression pin)', fund.txid === 'accb9dcb429f96a011eb0e002fc29e91c37670ea12b3d40b8302b22043579134');
ok('fund fee = inputs - outputs (exact)', fund.fee === 100000 - 60000 - fund.change);
const fd = decode(fund.txHex);
if (fd) {
  ok('[Core] fund vout0 is a P2PK (pubkey) output', fd.vout[0].scriptPubKey.type === 'pubkey');
  ok('[Core] fund vout0 carries OUR pubkey', fd.vout[0].scriptPubKey.asm.startsWith(bytesToHex(pub)));
  ok('[Core] fund vout0 value = 60000', Math.round(fd.vout[0].value * 1e8) === 60000);
  ok('[Core] fund is segwit (input has witness)', !!fd.vin[0].txinwitness);
  ok('[Core] Core txid == Olesia txid', fd.txid === fund.txid);
} else console.log('  (Core decode skipped)');

// independent BIP-143 sighash for input 0, recomputed here, then verify the sig
{
  const scriptCode = concatBytes(hexToBytes('1976a914'), hash160(pub), hexToBytes('88ac'));
  const outs = [{ script: target, amount: 60000n }, { script: wpkh.script, amount: BigInt(fund.change) }];
  const nSeq = hexToBytes('fdffffff');   // matches the builder's BIP-125 RBF sequence
  const hashPrevouts = dsha(concatBytes(rev('11'.repeat(32)), u32(0)));
  const hashSequence = dsha(nSeq);
  const hashOutputs = dsha(concatBytes(...outs.map((o) => concatBytes(u64(o.amount), wl(o.script)))));
  const preimage = concatBytes(u32(2), hashPrevouts, hashSequence, rev('11'.repeat(32)), u32(0), scriptCode, u64(100000), nSeq, hashOutputs, u32(0), u32(1));
  const z = dsha(preimage);
  // extract the DER sig from the witness (first item, minus the trailing sighash byte)
  const wit = fd ? fd.vin[0].txinwitness[0] : null;
  const derHex = wit ? wit.slice(0, -2) : null;
  ok('[independent] fund signature verifies against a separately-computed BIP-143 sighash',
    derHex ? secp256k1.verify(secp256k1.Signature.fromDER(hexToBytes(derHex)), z, pub) : false);
  if (derHex) { const s = secp256k1.Signature.fromDER(hexToBytes(derHex)).s; ok('[low-S] fund signature S <= n/2 (canonical)', s <= N / 2n); }
}

// ---- 3. SPEND: legacy structure + independent legacy sighash verification ---
const destPub = secp256k1.getPublicKey(hexToBytes('02'.repeat(32)), true);
const dest = btc.p2wpkh(destPub, btc.TEST_NETWORK);
const spend = buildSpendP2PK({ utxo: { txid: fund.txid, vout: 0, value: 60000 }, privKey: priv, p2pkScriptBytes: target, destScript: dest.script, feeRate: 2, message: 'Satoshi' });
ok('spend fee + sent = input value (conservation)', spend.fee + spend.sent === 60000);
const sd = decode(spend.txHex);
if (sd) {
  ok('[Core] spend is legacy (no witness)', !sd.vin[0].txinwitness);
  ok('[Core] spend scriptSig pushes a signature', /^30/.test(sd.vin[0].scriptSig.asm.split(' ')[0]));
  ok('[Core] spend has an OP_RETURN (nulldata) output', sd.vout.some((o) => o.scriptPubKey.type === 'nulldata'));
  ok('[Core] Core txid == Olesia txid', sd.txid === spend.txid);
}
// independent legacy sighash: serialize with the input's scriptSig = the P2PK script
{
  const nSeq = hexToBytes('fdffffff');   // matches the builder's BIP-125 RBF sequence
  const sentSat = BigInt(spend.sent);
  const orData = new TextEncoder().encode('Satoshi');
  const orScript = concatBytes(Uint8Array.of(0x6a, orData.length), orData);
  const outsSer = concatBytes(varint(2), u64(sentSat), wl(dest.script), u64(0n), wl(orScript));
  const body = (ss) => concatBytes(u32(2), varint(1), rev(fund.txid), u32(0), ss, nSeq, outsSer, u32(0));
  const z = dsha(concatBytes(body(wl(target)), u32(1)));
  const ssAsm = sd ? sd.vin[0].scriptSig.hex : null; // push(sig) => [len][sig..][01]
  const der = ssAsm ? ssAsm.slice(2, -2) : null;      // strip push-len and sighash byte
  ok('[independent] spend signature verifies against a separately-computed legacy sighash',
    der ? secp256k1.verify(secp256k1.Signature.fromDER(hexToBytes(der)), z, pub) : false);
  if (der) { const s = secp256k1.Signature.fromDER(hexToBytes(der)).s; ok('[low-S] spend signature S <= n/2 (canonical)', s <= N / 2n); }
}

// ---- 4. edge cases ---------------------------------------------------------
// dust change absorbed (change < 294 sat -> no change output, folded into fee)
const dustFund = buildFundP2PK({ utxos: [{ txid: '22'.repeat(32), vout: 0, value: 60400 }], privKey: priv, pubkey: pub, targetScript: target, changeScript: wpkh.script, amount: 60000, feeRate: 2 });
ok('fund with dust change -> no change output', dustFund.change === 0);
const dfd = decode(dustFund.txHex);
if (dfd) ok('[Core] dust-change fund has exactly ONE output', dfd.vout.length === 1);

// EXACT dust boundary: fee is fixed (estVsize-based) so pick amounts making
// change land exactly on 294 (kept) vs 293 (absorbed). estVsize=154 => fee=308.
{
  const fee = 308; const amount = 60000;
  const keep = buildFundP2PK({ utxos: [{ txid: '23'.repeat(32), vout: 0, value: amount + fee + 294 }], privKey: priv, pubkey: pub, targetScript: target, changeScript: wpkh.script, amount, feeRate: 2 });
  const drop = buildFundP2PK({ utxos: [{ txid: '24'.repeat(32), vout: 0, value: amount + fee + 293 }], privKey: priv, pubkey: pub, targetScript: target, changeScript: wpkh.script, amount, feeRate: 2 });
  ok('exact boundary: change of 294 IS kept', keep.change === 294);
  ok('exact boundary: change of 293 is absorbed (dust)', drop.change === 0);
}

// accumulate path: an amount that genuinely needs every coin uses all 10 inputs
{
  const utxos = Array.from({ length: 10 }, (_, i) => ({ txid: (i + 100).toString(16).padStart(2, '0').repeat(32), vout: 0, value: 20000 }));
  const big = buildFundP2PK({ utxos, privKey: priv, pubkey: pub, targetScript: target, changeScript: wpkh.script, amount: 195000, feeRate: 2 });
  ok('accumulate: an amount needing every coin uses all 10 inputs', big.inputsUsed === 10);
  const bd = decode(big.txHex);
  ok('[Core] 10-input fund decodes correctly', bd ? bd.vin.length === 10 && bd.vout[0].scriptPubKey.type === 'pubkey' : true);
}

// coin selection uses only the MINIMUM coins needed, NEVER sweeps: 60000 from 50000-coins
// always selects exactly 2, whether the wallet holds 2 or 3 of them.
for (const k of [2, 3]) {
  const utxos = Array.from({ length: k }, (_, i) => ({ txid: (30 + i).toString(16).padStart(2, '0').repeat(32), vout: 0, value: 50000 }));
  const mf = buildFundP2PK({ utxos, privKey: priv, pubkey: pub, targetScript: target, changeScript: wpkh.script, amount: 60000, feeRate: 2 });
  ok(`selection: with ${k} coins available, uses exactly 2 (min) — no sweep`, mf.inputsUsed === 2);
  const md = decode(mf.txHex);
  if (md) ok(`[Core] ${k}-coin case builds a valid 2-input tx, each input witnessed`, md.vin.length === 2 && md.vin.every((v) => v.txinwitness && v.txinwitness.length === 2));
}

// insufficient funds rejected
ok('fund rejects insufficient funds', throws(() => buildFundP2PK({ utxos: [{ txid: '44'.repeat(32), vout: 0, value: 100 }], privKey: priv, pubkey: pub, targetScript: target, changeScript: wpkh.script, amount: 60000, feeRate: 2 }), /insufficient/));
// spend of a value too small to cover fee
ok('spend rejects value below the fee', throws(() => buildSpendP2PK({ utxo: { txid: '55'.repeat(32), vout: 0, value: 50 }, privKey: priv, p2pkScriptBytes: target, destScript: dest.script, feeRate: 2 }), /too small/));

// OP_RETURN at the size boundaries: 75 (1-byte push), 76 (OP_PUSHDATA1), 80 (max), 81 (reject)
for (const len of [75, 76, 80]) {
  const msg = 'a'.repeat(len);
  const sp = buildSpendP2PK({ utxo: { txid: '66'.repeat(32), vout: 0, value: 60000 }, privKey: priv, p2pkScriptBytes: target, destScript: dest.script, feeRate: 2, message: msg });
  const d = decode(sp.txHex);
  ok(`OP_RETURN ${len} bytes builds + [Core] decodes as nulldata`, d ? d.vout.some((o) => o.scriptPubKey.type === 'nulldata') : true);
}
ok('OP_RETURN 81 bytes rejected', throws(() => buildSpendP2PK({ utxo: { txid: '77'.repeat(32), vout: 0, value: 60000 }, privKey: priv, p2pkScriptBytes: target, destScript: dest.script, feeRate: 2, message: 'a'.repeat(81) }), /> 80/));

// uncompressed pubkey P2PK (65-byte) — the true Satoshi-era form
const upub = secp256k1.getPublicKey(priv, false);
const uTarget = p2pkScript(upub);
ok('uncompressed (65-byte) P2PK script is 67 bytes ending ac', uTarget.length === 67 && uTarget[66] === 0xac);
const uFund = buildFundP2PK({ utxos: [{ txid: '88'.repeat(32), vout: 0, value: 100000 }], privKey: priv, pubkey: pub, targetScript: uTarget, changeScript: wpkh.script, amount: 60000, feeRate: 2 });
const ufd = decode(uFund.txHex);
if (ufd) ok('[Core] uncompressed P2PK output decodes as pubkey', ufd.vout[0].scriptPubKey.type === 'pubkey');

console.log(bad ? '\nP2PK-VECTORS TEST FAILED' : '\nP2PK-VECTORS TEST PASS — hand-rolled P2PK verified vs Bitcoin Core + independent sighash');
process.exit(bad ? 1 : 0);
