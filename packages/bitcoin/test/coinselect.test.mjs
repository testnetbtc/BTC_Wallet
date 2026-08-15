// Platform-wide COIN-SELECTION guarantee: no ordinary transaction on the platform sweeps the
// whole address. Every send/fund builder selects only the coins it needs; sweeps (which MUST
// move everything, by definition) are the sole, deliberate exception. Plus exhaustive unit
// tests of the P2PK funder's selection algorithm.
import { deriveKey, accountXpub } from '../src/wallet.js';
import { buildSignedTx, buildSignedTxMulti, buildSweepTx } from '../src/tx.js';
import { buildUnsignedPSBT, watchOnly } from '../src/psbt.js';
import { selectFundCoins, buildFundP2PK, p2pkScript } from '../src/p2pk_fund.js';
import { decodeRawTx } from '../src/send.js';
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(70), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NET = 'testnet3';
const key = deriveKey(MN, '', NET);
const wo = watchOnly(accountXpub(MN, '', NET), NET, 0, 0);
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const coins = (n, value) => Array.from({ length: n }, (_, i) => ({ txid: (i + 1).toString(16).padStart(2, '0').repeat(32), vout: 0, value }));
const psbtInputs = (b64) => btc.Transaction.fromPSBT(base64.decode(b64), { allowUnknownOutputs: true }).inputsLength;

// ── selectFundCoins: exact behaviour ──
{
  const F1000 = () => 1000n;                              // flat 1000-sat fee
  ok('select: smallest SINGLE coin that covers is chosen (not the biggest, not many)',
     (() => { const s = selectFundCoins([{ value: 5000 }, { value: 8000 }, { value: 100000 }, { value: 500000 }], 6000, F1000); return s.length === 1 && s[0].value === 8000; })());
  ok('select: prefers a small single coin over a huge one', (() => { const s = selectFundCoins([{ value: 500000 }, { value: 8000 }], 6000, F1000); return s.length === 1 && s[0].value === 8000; })());
  ok('select: no single coin covers -> accumulate smallest-first (minimum count)',
     (() => { const s = selectFundCoins([{ value: 5000 }, { value: 5000 }, { value: 5000 }], 12000, () => 500n); return s.length === 3 && s.every((u) => u.value === 5000); })());
  ok('select: fee grows with input count and is accounted for',
     (() => { const s = selectFundCoins([{ value: 10000 }, { value: 10000 }], 15000, (n) => BigInt(2000 * n)); return s.length === 2; })());
  ok('select: insufficient total -> null', selectFundCoins([{ value: 1000 }, { value: 1000 }], 5000, () => 500n) === null);
}

// ── P2PK funder: coin-selects, never sweeps ──
{
  const many = [...coins(19, 1000000), { txid: 'ee'.repeat(32), vout: 0, value: 8000 }];
  const fund = buildFundP2PK({ utxos: many, privKey: key.privKey, pubkey: key.pubkey, targetScript: p2pkScript(key.pubkey), changeScript: key.spend.script, amount: 6000, feeRate: 2 });
  ok('P2PK fund: 20 coins available, small amount -> uses exactly ONE input (no sweep)', fund.inputsUsed === 1);
  ok('P2PK fund: picks the small 8000 coin (tiny change), big coins untouched', fund.change > 0 && fund.change < 3000);
}

// ── every ordinary SEND builder coin-selects (uses < all coins for a small payment) ──
{
  const bt = buildSignedTx({ utxos: coins(10, 100000), key, recipients: [{ address: DEST, amount: 10000 }], feeRate: 5, networkName: NET });
  ok('buildSignedTx: 10 coins, small send -> coin-selected (fewer than 10 inputs)', decodeRawTx({ hex: bt.txHex, network: NET }).inputs.length < 10);

  const keyed = coins(10, 100000).map((u) => ({ ...u, key }));
  const btm = buildSignedTxMulti({ keyedUtxos: keyed, recipients: [{ address: DEST, amount: 10000 }], changeAddress: key.address, feeRate: 5, networkName: NET });
  ok('buildSignedTxMulti: 10 coins, small send -> coin-selected', decodeRawTx({ hex: btm.txHex, network: NET }).inputs.length < 10);

  const up = buildUnsignedPSBT({ utxos: coins(10, 100000), wo, recipients: [{ address: DEST, amount: 10000 }], changeAddress: wo.address, feeRate: 5, network: NET });
  ok('buildUnsignedPSBT (air-gap): 10 coins, small send -> coin-selected', psbtInputs(up.psbt) < 10);
}

// ── SWEEP is the ONE deliberate exception: it must move everything ──
{
  const sw = buildSweepTx({ utxos: coins(10, 100000), key, toAddress: DEST, feeRate: 5, networkName: NET });
  ok('buildSweepTx: intentionally uses ALL 10 inputs (that is what a sweep is)', decodeRawTx({ hex: sw.txHex, network: NET }).inputs.length === 10);
}

console.log(bad ? '\nCOINSELECT TEST FAILED' : '\nCOINSELECT TEST PASS — every ordinary tx coin-selects; only sweeps use all coins');
process.exit(bad ? 1 : 0);
