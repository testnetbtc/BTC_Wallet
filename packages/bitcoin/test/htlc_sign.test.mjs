// Atomic-swap HTLC-spend signer (src/htlc_sign.js) — the Olesia wallet ↔ swap hand-off.
//
// Fixtures below are REAL PSBTs produced by the swap engine (bitcoinjs) via its own
// buildHtlcScript + buildSpendPsbt, with their engine-computed intent txids. The core safety
// property (contract §"Test vectors"): a correctly-signed HTLC spend reproduces the engine's
// intent txid (segwit txid is witness-independent). These were additionally validated
// out-of-band by feeding the wallet-signed bytes to the engine's OWN acceptance verifier
// (verifySignedAgainstIntent: re-derives BIP-143 sighash + ecc.verify) — it accepts them.
//
//   interop_* : HTLC built with FIXED keys (not in this wallet) — proves parse+txid interop.
//   wk_*      : HTLC built with THIS wallet's BIP-84 pubkeys (redeem=0/0, refund=1/0) — full sign.
import { signHtlcSpend, describeHtlcSpend, parseHtlcScript } from '../src/htlc_sign.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(72), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const F = {
  interop_redeem: { txid: 'b2ff93709149d622f02155676d81431dc8c3e7222024d3b3c12b07bf2281b2e1', psbt: 'cHNidP8BAF4CAAAAAaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAAAAAAD/////AUyaAAAAAAAAIgAgs5P9a3/ybKrzoLW1dnDfC5gz9GWUe260EBw0jhUE188AAAAAAAEBK0CcAAAAAAAAIgAgs5P9a3/ybKrzoLW1dnDfC5gz9GWUe260EBw0jhUE188BAwQBAAAAAQVyY6ggeWnsD8uLZI394ksdCuJFaNOY3MOoO4CoUPlzI4zf09mIIQMbhMVWexJkQJldPtWqugVl1x4YNGBIGf+cF/Xp1d0Hj6xnA0ANA7F1IQJNS2zRNhAyypvSrrnZAKpNRdnq2ArJQjN0xFGnJU0HZqxoAAA=' },
  interop_refund: { txid: 'b60fa01ee206fb2e49309dda3d5075ff53792840dc9382f61c8e81f401e94759', lt: 200000, psbt: 'cHNidP8BAF4CAAAAAaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAAAAAAD+////AUyaAAAAAAAAIgAgs5P9a3/ybKrzoLW1dnDfC5gz9GWUe260EBw0jhUE189ADQMAAAEBK0CcAAAAAAAAIgAgs5P9a3/ybKrzoLW1dnDfC5gz9GWUe260EBw0jhUE188BAwQBAAAAAQVyY6ggeWnsD8uLZI394ksdCuJFaNOY3MOoO4CoUPlzI4zf09mIIQMbhMVWexJkQJldPtWqugVl1x4YNGBIGf+cF/Xp1d0Hj6xnA0ANA7F1IQJNS2zRNhAyypvSrrnZAKpNRdnq2ArJQjN0xFGnJU0HZqxoAAA=' },
  wk_redeem: { txid: '11947e0518110f27c3291758f0f332b6d4782a2cac4e448f879d3ac81d3fc9fa', amt: 40000, secret: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', psbt: 'cHNidP8BAF4CAAAAAaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAAAAAAD/////AUyaAAAAAAAAIgAgsk/1pQpR4/OLn19mjxXrJ6/qPMj7HmP3cdJmTC+cr0QAAAAAAAEBK0CcAAAAAAAAIgAgsk/1pQpR4/OLn19mjxXrJ6/qPMj7HmP3cdJmTC+cr0QBAwQBAAAAAQVyY6ggeWnsD8uLZI394ksdCuJFaNOY3MOoO4CoUPlzI4zf09mIIQLnqyU3tdSelwMJquBunknzbOHJ/rvUTsjg0cygtPnDGaxnA0ANA7F1IQNdSezNVNAJnkNnYnfHptRiXWEdqIpd9Jv5UXp3kad3paxoAAA=' },
  wk_refund: { txid: 'f248091e81dca650be4d146d908b560dc09f3f4f0a7379437eb027fad5900e00', psbt: 'cHNidP8BAF4CAAAAAaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAAAAAAD+////AUyaAAAAAAAAIgAgsk/1pQpR4/OLn19mjxXrJ6/qPMj7HmP3cdJmTC+cr0RADQMAAAEBK0CcAAAAAAAAIgAgsk/1pQpR4/OLn19mjxXrJ6/qPMj7HmP3cdJmTC+cr0QBAwQBAAAAAQVyY6ggeWnsD8uLZI394ksdCuJFaNOY3MOoO4CoUPlzI4zf09mIIQLnqyU3tdSelwMJquBunknzbOHJ/rvUTsjg0cygtPnDGaxnA0ANA7F1IQNdSezNVNAJnkNnYnfHptRiXWEdqIpd9Jv5UXp3kad3paxoAAA=' },
};

// Minimal segwit-tx witness extractor for input 0 (one-input HTLC spends).
function readVarint(b, o) { const f = b[o]; if (f < 0xfd) return [f, o + 1]; if (f === 0xfd) return [b[o + 1] | (b[o + 2] << 8), o + 3]; if (f === 0xfe) return [(b[o + 1] | (b[o + 2] << 8) | (b[o + 3] << 16) | (b[o + 4] * 0x1000000)) >>> 0, o + 5]; let n = 0; for (let i = 0; i < 8; i++) n += b[o + 1 + i] * 2 ** (8 * i); return [n, o + 9]; }
function witnessOf(hex) {
  const b = hexToBytes(hex); let o = 4;
  if (b[o] !== 0x00 || b[o + 1] !== 0x01) throw new Error('not a segwit tx'); o += 2;
  let n; [n, o] = readVarint(b, o);                       // vin count
  for (let i = 0; i < n; i++) { o += 36; let sl; [sl, o] = readVarint(b, o); o += sl + 4; }
  let vo; [vo, o] = readVarint(b, o);                     // vout count
  for (let i = 0; i < vo; i++) { o += 8; let sl; [sl, o] = readVarint(b, o); o += sl; }
  let items; [items, o] = readVarint(b, o);               // witness stack count (input 0)
  const stack = [];
  for (let i = 0; i < items; i++) { let il; [il, o] = readVarint(b, o); stack.push(b.slice(o, o + il)); o += il; }
  return stack;
}

// ── interop: the parser reproduces the engine's intent txid from a real bitcoinjs PSBT ──
{
  const d = describeHtlcSpend({ psbtBase64: F.interop_redeem.psbt, network: 'testnet4', mnemonic: MN });
  ok('interop redeem: parser reproduces engine intent txid', d.intentTxid === F.interop_redeem.txid);
  ok('interop redeem: branch=redeem, amount=40000, not this wallet', d.branch === 'redeem' && d.amount === 40000 && d.mine === false);
  const r = describeHtlcSpend({ psbtBase64: F.interop_refund.psbt, network: 'testnet4', mnemonic: MN });
  ok('interop refund: reproduces intent txid + branch/locktime', r.intentTxid === F.interop_refund.txid && r.branch === 'refund' && r.locktime === 200000);
}

// ── full sign with THIS wallet's keys: txid reproduction + exact witness layout ──
{
  const r = signHtlcSpend({ psbtBase64: F.wk_redeem.psbt, network: 'testnet4', mnemonic: MN, secretHex: F.wk_redeem.secret });
  ok('redeem: finalized txid == engine intent txid', r.txid === F.wk_redeem.txid && r.branch === 'redeem');
  const w = witnessOf(r.signedTxHex);
  ok('redeem witness = [sig, secret(32), 0x01, script]',
     w.length === 4 && bytesToHex(w[1]) === F.wk_redeem.secret && w[1].length === 32 && w[2].length === 1 && w[2][0] === 0x01);
  ok('redeem witness trailing item is the HTLC script', (() => { try { parseHtlcScript(w[3]); return true; } catch { return false; } })());

  const f = signHtlcSpend({ psbtBase64: F.wk_refund.psbt, network: 'testnet4', mnemonic: MN });
  ok('refund: finalized txid == engine intent txid', f.txid === F.wk_refund.txid && f.branch === 'refund');
  const wf = witnessOf(f.signedTxHex);
  ok('refund witness = [sig, <empty>, script]', wf.length === 3 && wf[1].length === 0);
}

// ── safety rails ──
{
  ok('redeem WITHOUT the secret is refused', throws(() => signHtlcSpend({ psbtBase64: F.wk_redeem.psbt, network: 'testnet4', mnemonic: MN })));
  ok('redeem with a WRONG secret (bad hashlock) is refused', throws(() => signHtlcSpend({ psbtBase64: F.wk_redeem.psbt, network: 'testnet4', mnemonic: MN, secretHex: 'ab'.repeat(32) })));
  ok('refuses an HTLC whose key is NOT in this wallet', throws(() => signHtlcSpend({ psbtBase64: F.interop_redeem.psbt, network: 'testnet4', mnemonic: MN, secretHex: F.wk_redeem.secret })));
  ok('describe marks a foreign HTLC as not mine', describeHtlcSpend({ psbtBase64: F.interop_refund.psbt, network: 'testnet4', mnemonic: MN }).mine === false);
}

console.log(bad ? '\nHTLC-SIGN TEST FAILED' : '\nHTLC-SIGN TEST PASS — engine-accepted redeem/refund signing, txid-preserving, fail-closed');
process.exit(bad ? 1 : 0);
