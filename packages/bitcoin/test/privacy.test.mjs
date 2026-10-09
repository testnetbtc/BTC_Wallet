// Privacy report: every finding is driven by constructed coins and real serialised transactions.
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex } from '@noble/hashes/utils';
import { randomBytes } from 'node:crypto';
import { privacyReport, parseTx, inputKeyHashes, DUST_SATS } from '../src/privacy.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(84), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const h160 = (b) => bytesToHex(ripemd160(sha256(b)));
const keys = Array.from({ length: 6 }, () => { const k = randomBytes(32); const p = secp256k1.getPublicKey(k, true); return { priv: k, pub: p, hash: h160(p), wpkh: btc.p2wpkh(p).address, pkh: btc.p2pkh(p).address }; });
const ours = new Set(keys.slice(0, 4).map((k) => k.hash));   // keys 4, 5 belong to someone else
const coin = (k, value, type = 'p2wpkh', extra = {}) => ({ txid: bytesToHex(randomBytes(32)), vout: 0, value, address: type === 'p2wpkh' ? k.wpkh : k.pkh, type, confirmations: 6, ...extra });
const ids = (r) => r.findings.map((f) => f.id);

// a real serialised transaction spending with the given keys (witness or scriptSig carry the pubkeys)
function tx(inputKeys, { legacy = false } = {}) {
  const inputs = inputKeys.map((k) => ({ txid: randomBytes(32), index: 0, sequence: 0xfffffffd,
    finalScriptSig: legacy ? new Uint8Array([71, ...randomBytes(71), 33, ...k.pub]) : new Uint8Array(0) }));
  const witnesses = legacy ? undefined : inputKeys.map((k) => [randomBytes(71), k.pub]);
  const raw = btc.RawTx.encode({ version: 2, lockTime: 0, segwitFlag: !legacy, inputs, outputs: [{ amount: 10000n, script: btc.OutScript.encode(btc.Address().decode(keys[0].wpkh)) }], witnesses });
  return bytesToHex(raw);
}

// ---- parsing
{
  const t = parseTx(tx([keys[0], keys[4]]));
  ok('parseTx: witness public keys become hash160s per input', t.inputs.length === 2 && t.inputs[0].keyHashes[0] === keys[0].hash && t.inputs[1].keyHashes[0] === keys[4].hash);
  const l = parseTx(tx([keys[1]], { legacy: true }));
  ok('parseTx: a legacy scriptSig public key is found too', l.inputs[0].keyHashes[0] === keys[1].hash && l.outputs[0].value === 10000);
  ok('inputKeyHashes: an input of an unknown type yields nothing', inputKeyHashes({ finalScriptSig: new Uint8Array([0x00]) }, [randomBytes(64)]).length === 0);
}
// ---- an empty wallet
ok('empty wallet: only the scope note, summary says nothing is visible', ids(privacyReport({ coins: [] })).join() === 'scope' && /No coins yet/.test(privacyReport({ coins: [] }).summary));
// ---- a clean HD wallet
{
  const r = privacyReport({ kind: 'seed', coins: [coin(keys[0], 50000), coin(keys[1], 70000)], ourHashes: ours, feeRate: 10 });
  ok('clean wallet: "no reuse" good mark, nothing else', ids(r).join() === 'scope,no-reuse' || ids(r).join() === 'no-reuse,scope');
  ok('clean wallet: summary is reassuring', /Nothing to worry/.test(r.summary));
}
// ---- reuse
{
  const r = privacyReport({ kind: 'seed', coins: [coin(keys[0], 50000), coin(keys[0], 20000), coin(keys[1], 500000)], ourHashes: ours });
  const f = r.findings.find((x) => x.id === 'reuse');
  ok('reuse: an address with two coins is a medium finding naming it and the total', f && f.level === 'medium' && /holds 2 separate payments \(70,000 sats\)/.test(f.detail) && /fresh address/.test(f.advice));
  ok('reuse: the "no reuse" good mark is not shown at the same time', !ids(r).includes('no-reuse'));
}
// ---- single key
{
  const r = privacyReport({ kind: 'wif', coins: [coin(keys[0], 50000), coin(keys[0], 20000)], ourHashes: ours });
  ok('single-key wallet: high finding, and reuse is not double-reported', ids(r).includes('single-key') && !ids(r).includes('reuse') && r.findings[0].level === 'high' && /Something important/.test(r.summary));
}
// ---- dust and uneconomic
{
  const r = privacyReport({ kind: 'seed', coins: [coin(keys[0], 546), coin(keys[1], 1200, 'p2pkh'), coin(keys[2], 90000)], ourHashes: ours, feeRate: 20 });
  const d = r.findings.find((x) => x.id === 'dust'), u = r.findings.find((x) => x.id === 'uneconomic');
  ok(`dust: a ${DUST_SATS}-sat threshold flags the 546-sat coin as a possible dust attack`, d && d.level === 'medium' && /546 sats/.test(d.detail) && /Never spend these together/.test(d.advice));
  ok('uneconomic: a 1,200-sat Legacy coin at 20 sat/vB costs ~2,960 sats to spend', u && /1,200 sats would cost about 2,960 sats/.test(u.detail));
  ok('unconfirmed coins are not judged for dust', !ids(privacyReport({ kind: 'seed', coins: [coin(keys[0], 100, 'p2wpkh', { confirmations: 0 })] })).includes('dust'));
}
// ---- linked addresses via a past spend
{
  const c = coin(keys[0], 40000);
  const txs = new Map([[c.txid, parseTx(tx([keys[1], keys[2], keys[5]]))]]);   // our change came from a spend of two of our addresses + a foreign input (coinjoin-ish)
  const r = privacyReport({ kind: 'seed', coins: [c], ourHashes: ours, txs });
  const f = r.findings.find((x) => x.id === 'linked');
  ok('linked: a creating transaction with two of our keys among its inputs is reported', f && /spent from 2 of your addresses/.test(f.detail));
  const txs1 = new Map([[c.txid, parseTx(tx([keys[1], keys[5]]))]]);
  ok('linked: one of ours plus a stranger\'s input is NOT a link', !ids(privacyReport({ kind: 'seed', coins: [c], ourHashes: ours, txs: txs1 })).includes('linked'));
}
// ---- mixed types and ordering
{
  const r = privacyReport({ kind: 'seed', coins: [coin(keys[0], 50000), coin(keys[1], 50000, 'p2pkh'), coin(keys[1], 700, 'p2pkh')], ourHashes: ours, feeRate: 5 });
  ok('mixed types: SegWit + Legacy coins produce the info finding', ids(r).includes('mixed-types'));
  const lv = r.findings.map((f) => f.level), order = ['high', 'medium', 'low', 'info', 'good'];
  ok('findings are ordered by severity', lv.every((l, i) => i === 0 || order.indexOf(l) >= order.indexOf(lv[i - 1])));
  ok('scope note states the limits honestly (no address index)', /no address index/.test(r.findings.find((f) => f.id === 'scope').detail));
}
console.log(bad ? '\nPRIVACY TESTS FAILED' : '\nprivacy report: all checks passed');
process.exit(bad ? 1 : 0);
