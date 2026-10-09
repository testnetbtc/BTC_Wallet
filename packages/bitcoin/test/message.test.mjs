// Signed messages: BIP-322 against the BIP's own published vector file (test/fixtures/
// bip322_basic_test_vectors.json, sha256 a9184da5687b9cb7a1863807f4a8f4d743ec07d4f683f707cb85ce72f5b33f47, from bitcoin/bips bip-0322/), the legacy
// format against a long-known reference signature and round trips, and the refusals.
// Bitcoin Core itself is the oracle for the legacy format in mainnet_e2e_regtest.mjs.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import * as btc from '@scure/btc-signer';
import { signMessage, verifyMessage, signBip322, signLegacy, bip322MessageHash, legacyMessageHash, coreVerifyCommand, MESSAGE_MAX } from '../src/message.js';
import { parseWIF } from '../src/wif.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(84), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const V = JSON.parse(readFileSync(new URL('./fixtures/bip322_basic_test_vectors.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------- BIP-322 vectors
for (const t of V.tx_hashes) {
  ok(`BIP-322 message hash matches the BIP: ${JSON.stringify(t.message).slice(0, 30)}`, bytesToHex(bip322MessageHash(t.message)) === t.message_hash);
}
for (const t of V.simple.filter((x) => x.type === 'p2wpkh')) {
  const { privKey } = parseWIF(t.private_keys[0], 'mainnet');
  const mine = signBip322({ privKey, address: t.address, message: t.message });
  // the BIP lists two valid signatures per case: a low-R-ground one and the plain RFC-6979 one; ours is the latter
  ok(`BIP-322 p2wpkh: our signature equals the BIP's RFC-6979 vector byte for byte (${JSON.stringify(t.message)})`, t.bip322_signatures.includes('smp' + mine));
  for (const s of t.bip322_signatures) {
    const r = verifyMessage({ address: t.address, message: t.message, signature: s });
    ok(`BIP-322 p2wpkh: published signature verifies (${s.slice(0, 14)}…)`, r.ok && r.format === 'BIP-322 simple');
    ok('BIP-322 p2wpkh: the same signature without the "smp" prefix verifies too', verifyMessage({ address: t.address, message: t.message, signature: s.slice(3) }).ok);
  }
}
for (const t of V.simple.filter((x) => x.type !== 'p2wpkh')) {
  const r = verifyMessage({ address: t.address, message: t.message, signature: t.bip322_signatures[0] });
  ok(`unsupported script type is refused cleanly, never accepted: ${t.type}`, !r.ok && typeof r.reason === 'string');
}
for (const e of V.error) {
  const r = verifyMessage({ address: e.address, message: e.message, signature: e.signature });
  ok(`BIP error vector is rejected: ${e.description}`, !r.ok && typeof r.reason === 'string');
}
// to_spend / to_sign txids (reconstructed the same way the verifier does)
{
  const t = V.tx_hashes[1];
  const spk = btc.OutScript.encode(btc.Address().decode(t.address));
  const raw = btc.RawTx.encode({ version: 0, lockTime: 0, segwitFlag: false, inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: new Uint8Array([0, 0x20, ...bip322MessageHash(t.message)]), sequence: 0 }], outputs: [{ amount: 0n, script: spk }] });
  const spendId = bytesToHex(sha256(sha256(raw)).reverse());
  ok('BIP-322 to_spend txid matches the BIP', spendId === t.to_spend_tx_hash);
  const sign = btc.RawTx.encode({ version: 0, lockTime: 0, segwitFlag: false, inputs: [{ txid: Uint8Array.from(Buffer.from(spendId, 'hex')), index: 0, finalScriptSig: new Uint8Array(0), sequence: 0 }], outputs: [{ amount: 0n, script: Uint8Array.of(0x6a) }] });
  ok('BIP-322 to_sign txid matches the BIP', bytesToHex(sha256(sha256(sign)).reverse()) === t.to_sign_tx_hash);
}

// ---------------------------------------------------------------- legacy format
const LEGACY = { address: '1F3sAm6ZtwLAUnj7d38pGFxtP3RVEvtsbV', message: 'This is an example of a signed message.', signature: 'H9L5yLFjti0QTHhPyFrZCT1V/MMnBtXKmoiKDZ78NDBjERki6ZTQZdSMCtkgoNmp17By9ItJr8o7ChX0XxY91nk=' };
ok('legacy: a long-published reference signature verifies', verifyMessage(LEGACY).ok && verifyMessage(LEGACY).format === 'legacy');
ok('legacy: the same signature fails for a changed message', !verifyMessage({ ...LEGACY, message: LEGACY.message + ' ' }).ok);
ok('legacy: the same signature fails for a different address', /different key/.test(verifyMessage({ ...LEGACY, address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH' }).reason));
ok('legacy: message hash uses the "Bitcoin Signed Message:\\n" magic', bytesToHex(legacyMessageHash('')) !== bytesToHex(sha256(sha256(new Uint8Array(0)))));
ok('legacy: Core verify command is quoted for the shell', /^bitcoin-cli verifymessage '1F3s/.test(coreVerifyCommand({ ...LEGACY, format: 'legacy' })) && coreVerifyCommand({ ...LEGACY, format: 'BIP-322 simple' }) === null);

// ---------------------------------------------------------------- round trips with fresh keys
for (let i = 0; i < 5; i++) {
  const privKey = randomBytes(32);
  if (!secp256k1.utils.isValidPrivateKey(privKey)) continue;
  const pub = secp256k1.getPublicKey(privKey, true);
  const p2pkh = btc.p2pkh(pub).address, p2wpkh = btc.p2wpkh(pub).address;
  const msg = 'Olesia proof ' + i + ' ' + bytesToHex(randomBytes(8)) + ' öäü 😀';
  const a = signMessage({ privKey, address: p2pkh, message: msg }), b = signMessage({ privKey, address: p2wpkh, message: msg });
  ok(`round trip #${i}: 1… → legacy format verifies; bc1q → BIP-322 verifies`, a.format === 'legacy' && verifyMessage({ address: p2pkh, message: msg, signature: a.signature }).ok && b.format === 'BIP-322 simple' && verifyMessage({ address: p2wpkh, message: msg, signature: b.signature }).ok);
  ok(`round trip #${i}: signatures are deterministic (same input, same bytes)`, signMessage({ privKey, address: p2wpkh, message: msg }).signature === b.signature && signMessage({ privKey, address: p2pkh, message: msg }).signature === a.signature);
  // the legacy signature is ALSO valid for the bc1q address (same key; BIP-137 style) — by design; the BIP-322 one is not a legacy signature
  ok(`round trip #${i}: a BIP-322 signature is refused for the 1… address; the legacy one is accepted for bc1q (BIP-137)`, !verifyMessage({ address: p2pkh, message: msg, signature: b.signature }).ok && verifyMessage({ address: p2wpkh, message: msg, signature: a.signature }).ok);
  // BIP-137: a legacy-format signature with the segwit header verifies for the bc1q address (Electrum/Trezor style)
  const raw = Buffer.from(signLegacy({ privKey, message: msg }), 'base64'); raw[0] += 8;
  const r137 = verifyMessage({ address: p2wpkh, message: msg, signature: raw.toString('base64') });
  ok(`round trip #${i}: BIP-137 segwit-header signature is accepted for the bc1q address`, r137.ok && /BIP-137/.test(r137.format));
  // the full BIP-322 form (whole to_sign tx) verifies as well
  const wit = btc.RawWitness.decode(Buffer.from(b.signature, 'base64'));
  const spk = btc.OutScript.encode(btc.Address().decode(p2wpkh));
  const spend = btc.RawTx.encode({ version: 0, lockTime: 0, segwitFlag: false, inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: new Uint8Array([0, 0x20, ...bip322MessageHash(msg)]), sequence: 0 }], outputs: [{ amount: 0n, script: spk }] });
  const full = btc.RawTx.encode({ version: 0, lockTime: 0, segwitFlag: true, inputs: [{ txid: sha256(sha256(spend)).reverse(), index: 0, finalScriptSig: new Uint8Array(0), sequence: 0 }], outputs: [{ amount: 0n, script: Uint8Array.of(0x6a) }], witnesses: [wit] });
  const rf = verifyMessage({ address: p2wpkh, message: msg, signature: 'ful' + Buffer.from(full).toString('base64') });
  ok(`round trip #${i}: the "full" BIP-322 encoding of the same proof verifies`, rf.ok && rf.format === 'BIP-322 full');
  if (i === 0) {
    let threw = '';
    try { signMessage({ privKey: randomBytes(32), address: p2wpkh, message: msg }); } catch (e) { threw = e.message; }
    ok('signing with a key that does not own the address is refused', /does not belong/.test(threw));
    try { signMessage({ privKey, address: p2wpkh, message: 'x'.repeat(MESSAGE_MAX + 1) }); threw = ''; } catch (e) { threw = e.message; }
    ok('an over-long message is refused', /too long/.test(threw));
    ok('verify never throws on garbage', [verifyMessage({ address: 'nope', message: 'm', signature: 'AA==' }), verifyMessage({ address: p2wpkh, message: 'm', signature: '***' }), verifyMessage({ address: p2wpkh, message: 'm', signature: '' }), verifyMessage({ address: p2wpkh, message: null, signature: 'AA==' })].every((r) => r && r.ok === false && r.reason));
    ok('Taproot addresses are refused with a plain reason', /Taproot/.test(verifyMessage({ address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', message: 'm', signature: 'AA==' }).reason));
  }
}

console.log(bad ? '\nMESSAGE TESTS FAILED' : '\nsigned messages: all checks passed');
process.exit(bad ? 1 : 0);
