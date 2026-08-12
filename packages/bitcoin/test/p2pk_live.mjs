// LIVE P2PK acceptance (testnet4). The strongest independent validation of the
// hand-rolled P2PK sighash/serialisation: real Bitcoin nodes fully validate the
// signature and script, so a broadcast that is ACCEPTED proves correctness beyond
// any local check. Mints a P2PK from a wallet's SegWit balance, then spends it out
// with an OP_RETURN. Needs network + a funded testnet4 wallet (Wallet A).
import { fundP2PK, spendP2PK, p2pkOutpoints, deriveAt } from '../src/send.js';

const A = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';
const B = 'like youth surface loop fire bulk push repair riot scan blame tilt';
const NET = 'testnet4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = false;
const ok = (l, c) => { console.log(l.padEnd(56), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

const dest = deriveAt(B, NET, 'p2wpkh', 0, 0, '').address;
try {
  const f = await fundP2PK({ source: A, network: NET, amount: 9000, feeRate: 2, broadcast: true, allowUnconfirmed: true });
  ok(`MINT P2PK broadcast + accepted (txid ${f.txid.slice(0, 12)}…)`, /^[0-9a-f]{64}$/.test(f.txid));
  await sleep(6000);
  const [ann] = await p2pkOutpoints({ network: NET, outpoints: [{ txid: f.txid, vout: f.vout, amount: f.amount }] });
  ok('on-chain output type is genuinely p2pk', ann.type === 'p2pk' && ann.value === 9000);
  const s = await spendP2PK({ source: A, network: NET, outpoint: { txid: f.txid, vout: f.vout }, toAddress: dest, message: 'Phase 4 · P2PK spend verified', feeRate: 2, broadcast: true });
  ok(`SPEND P2PK broadcast + accepted (txid ${s.txid.slice(0, 12)}…)`, /^[0-9a-f]{64}$/.test(s.txid));
  ok('fee + sent = P2PK value (conservation)', s.fee + s.sent === 9000);
  console.log(`  fund  https://mempool.space/testnet4/tx/${f.txid}`);
  console.log(`  spend https://mempool.space/testnet4/tx/${s.txid}`);
} catch (e) { ok('live P2PK run completed', false); console.log('  error:', e.message); }

console.log(bad ? '\nP2PK-LIVE FAILED' : '\nP2PK-LIVE PASS — real Bitcoin nodes accept the hand-rolled P2PK txs');
process.exit(bad ? 1 : 0);
