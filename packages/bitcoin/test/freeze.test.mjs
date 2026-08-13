// Freeze-and-broadcast primitives: the confirmation display must come from the
// transaction bytes (decodeRawTx), and broadcastRaw must refuse to report a
// different txid than the bytes it sent.
import { buildSignedTx } from '../src/tx.js';
import { decodeRawTx, broadcastRaw, assertBroadcastTxid } from '../src/send.js';
import { deriveKey } from '../src/wallet.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(58), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

const MN = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';
const key = deriveKey(MN, '', 'testnet4', 0);
const DEST = 'tb1qw2yu74j97dlc6fzc7256lt5wvh47kjjhcmjs23'; // wallet B
const built = buildSignedTx({
  utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 100000 }],
  key, recipients: [{ address: DEST, amount: 40000 }],
  message: 'freeze test', changeAddress: key.address, feeRate: 2, networkName: 'testnet4',
});

const dec = decodeRawTx({ hex: built.txHex, network: 'testnet4' });
ok('decoded txid matches builder txid', dec.txid === built.txid);
ok('decoded vsize matches builder vsize', dec.vsize === built.vsize);
const pay = dec.outputs.find((o) => o.address === DEST);
const chg = dec.outputs.find((o) => o.address === key.address);
const opr = dec.outputs.find((o) => o.type === 'op_return');
ok('payment output decoded (40000 to dest)', pay && pay.amount === 40000);
ok('change output decoded back to wallet', chg && chg.amount > 0);
ok('OP_RETURN decoded with the exact text', opr && opr.opReturn === 'freeze test');
ok('fee = inputs - outputs is consistent', 100000 - dec.totalOut === built.fee);

// broadcastRaw txid cross-check: a network that reports a DIFFERENT txid aborts
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'deadbeef'.repeat(8) });
let threw = false;
try { await broadcastRaw({ hex: built.txHex, network: 'testnet4' }); } catch (e) { threw = /mismatch/.test(e.message); }
ok('broadcastRaw aborts on txid mismatch from the network', threw);
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => built.txid });
const res = await broadcastRaw({ hex: built.txHex, network: 'testnet4' });
ok('broadcastRaw returns the verified txid on match', res.txid === built.txid);
globalThis.fetch = realFetch;

// ── RT-5: the faucet/send paths must reject an explorer-returned txid that does
// not match the locally-built txid (never trust the explorer's reported txid) ──
{
  const built = 'aa'.repeat(32);
  ok('RT-5: matching txid is accepted', assertBroadcastTxid(built, built) === built);
  ok('RT-5: empty/echo-less response falls back to the built txid', assertBroadcastTxid(built, '') === built && assertBroadcastTxid(built, null) === built);
  let threw = false;
  try { assertBroadcastTxid(built, 'bb'.repeat(32)); } catch { threw = true; }
  ok('RT-5: a DIFFERENT explorer txid is REJECTED (throws)', threw);
  let threw2 = false;
  try { assertBroadcastTxid(built, '<script>evil</script>'); } catch { threw2 = true; }
  ok('RT-5: a garbage/hostile explorer txid is rejected', threw2);
}

console.log(bad ? '\nFREEZE TEST FAILED' : '\nFREEZE TEST PASS — display decodes the bytes; broadcast verifies the txid');
process.exit(bad ? 1 : 0);
