// LIVE P2PK acceptance (testnet4). The strongest independent validation of the
// hand-rolled P2PK sighash/serialisation: real Bitcoin nodes fully validate the
// signature and script, so a broadcast that is ACCEPTED proves correctness beyond
// any local check. Mints a P2PK from a wallet's SegWit balance, then spends it out
// with an OP_RETURN. Needs network + a funded testnet4 wallet (Wallet A).
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fundP2PK, spendP2PK, p2pkOutpoints, deriveAt } from '../src/send.js';

const require = createRequire(import.meta.url);
const A = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';
const B = 'like youth surface loop fire bulk push repair riot scan blame tilt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = false;
const ok = (l, c) => { console.log(l.padEnd(56), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

// each leg: a wallet with a SegWit balance on `net`, a P2PK amount, and a dest.
const LEGS = [{ net: 'testnet4', src: A, amount: 9000 }];
// signet leg only if its funded wallet secret is present (gitignored)
if (existsSync(new URL('../.secrets/signet.json', import.meta.url)))
  LEGS.push({ net: 'signet', src: require('../.secrets/signet.json').mnemonic, amount: 4000 });

for (const { net, src, amount } of LEGS) {
  const dest = deriveAt(B, net, 'p2wpkh', 0, 0, '').address;
  console.log(`\n--- ${net} ---`);
  try {
    const f = await fundP2PK({ source: src, network: net, amount, feeRate: 2, broadcast: true, allowUnconfirmed: true });
    ok(`[${net}] MINT P2PK broadcast + accepted (${f.txid.slice(0, 12)}…)`, /^[0-9a-f]{64}$/.test(f.txid));
    await sleep(7000);
    const [ann] = await p2pkOutpoints({ network: net, outpoints: [{ txid: f.txid, vout: f.vout, amount: f.amount }] });
    ok(`[${net}] on-chain output type is genuinely p2pk`, ann.type === 'p2pk' && ann.value === amount);
    const s = await spendP2PK({ source: src, network: net, outpoint: { txid: f.txid, vout: f.vout }, toAddress: dest, message: `Olesia P2PK on ${net} · Phase 4`, feeRate: 2, broadcast: true });
    ok(`[${net}] SPEND P2PK broadcast + accepted (${s.txid.slice(0, 12)}…)`, /^[0-9a-f]{64}$/.test(s.txid));
    ok(`[${net}] fee + sent = P2PK value (conservation)`, s.fee + s.sent === amount);
    console.log(`  fund  https://mempool.space/${net}/tx/${f.txid}`);
    console.log(`  spend https://mempool.space/${net}/tx/${s.txid}`);
  } catch (e) { ok(`[${net}] live P2PK run completed`, false); console.log('  error:', e.message); }
}

console.log(bad ? '\nP2PK-LIVE FAILED' : '\nP2PK-LIVE PASS — real Bitcoin nodes accept the hand-rolled P2PK txs');
process.exit(bad ? 1 : 0);
