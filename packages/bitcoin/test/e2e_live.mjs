// Olesia — comprehensive LIVE end-to-end matrix.
// Broadcasts real transactions on testnet3/testnet4 (and signet if funded) covering
// every option a user can reach: pay on all 4 addressed script types, OP_RETURN,
// Max-sweep, message-only self-sweep, the P2PK museum (mint + spend), the air-gap
// PSBT round trip (build unsigned -> sign offline -> broadcast), a single-key WIF
// sweep, and the empty-account guard. Results -> scratchpad JSON + console.
//
// All coins are worthless testnet/signet coins. Wallets A/B are throwaway seeds
// published in the report so every line is reproducible.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import {
  walletAddress, statusFor, prepareAndSend, prepareSweep,
  fundP2PK, spendP2PK, prepareUnsigned, signUnsigned, broadcastSigned,
  inspectWIF, sweepWIF,
} from '../src/send.js';
import { wifAddresses } from '../src/wif.js';

const require = createRequire(import.meta.url);
const FAUCET = require('../.secrets/faucet.json').mnemonic;
const A = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';
const B = 'like youth surface loop fire bulk push repair riot scan blame tilt';

const TYPES = ['p2wpkh', 'p2tr', 'p2sh-p2wpkh', 'p2pkh'];
const SHORT = { p2wpkh: 'Native SegWit', p2tr: 'Taproot', 'p2sh-p2wpkh': 'Nested SegWit', p2pkh: 'Legacy', p2pk: 'P2PK' };
const NETS = (process.argv[2] || 'testnet4,testnet3').split(',');
const SETTLE = 3500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { startedAt: new Date().toISOString(), networks: {} };

async function step(rows, label, type, fn) {
  try {
    const r = await fn();
    const row = { step: label, type: type || '', ok: true, ...r };
    rows.push(row);
    console.log(`  ✓ ${label}`.padEnd(52), row.txid ? row.txid.slice(0, 16) + '…' : '');
    await sleep(SETTLE);
    return r;
  } catch (e) {
    rows.push({ step: label, type: type || '', ok: false, error: e.message });
    console.log(`  ✗ ${label}`.padEnd(52), e.message);
    await sleep(1500);
    return null;
  }
}

async function runNetwork(net) {
  console.log(`\n===== ${net} =====`);
  const rows = [];
  const Aad = {}, Bad = {};
  for (const t of TYPES) { Aad[t] = walletAddress(A, net, t); Bad[t] = walletAddress(B, net, t); }

  const fb = await statusFor(FAUCET, net, 'p2wpkh').catch((e) => ({ balance: { confirmed: 0 }, address: '?', err: e.message }));
  console.log(`  faucet ${fb.address} : ${fb.balance.confirmed} sat confirmed`);
  out.networks[net] = { faucet: fb.address, faucetBalance: fb.balance.confirmed, A: Aad, B: Bad, rows };
  if (fb.balance.confirmed < 130000) { console.log('  ! faucet under-funded — skipping this network'); rows.push({ step: 'SKIPPED — faucet under-funded', ok: false, error: `${fb.balance.confirmed} sat` }); return; }

  const fund = { p2wpkh: 70000, p2tr: 22000, 'p2sh-p2wpkh': 22000, p2pkh: 22000 };
  await step(rows, 'FUND A (faucet → A × 4 types)', '', async () => {
    const r = await prepareAndSend({ source: FAUCET, network: net, scriptType: 'p2wpkh', recipients: TYPES.map((t) => ({ address: Aad[t], amount: fund[t] })), feeRate: 2, broadcast: true, allowUnconfirmed: true });
    return { amount: Object.values(fund).reduce((a, b) => a + b, 0), fee: r.fee, txid: r.broadcastTxid };
  });

  for (const t of TYPES) {
    await step(rows, `A → B ${SHORT[t]} (pay)`, t, async () => {
      const r = await prepareAndSend({ source: A, network: net, scriptType: t, recipients: [{ address: Bad[t], amount: 8000 }], feeRate: 2, broadcast: true, allowUnconfirmed: true });
      return { amount: 8000, fee: r.fee, txid: r.broadcastTxid };
    });
  }

  await step(rows, 'A → B SegWit + OP_RETURN', 'p2wpkh', async () => {
    const msg = `Olesia e2e · ${net} · OP_RETURN`;
    const r = await prepareAndSend({ source: A, network: net, scriptType: 'p2wpkh', recipients: [{ address: Bad.p2wpkh, amount: 6000 }], message: msg, feeRate: 2, broadcast: true, allowUnconfirmed: true });
    return { amount: 6000, fee: r.fee, msg, txid: r.broadcastTxid };
  });

  await step(rows, 'A Taproot → B (Max sweep)', 'p2tr', async () => {
    const r = await prepareSweep({ source: A, network: net, scriptType: 'p2tr', toAddress: Bad.p2wpkh, feeRate: 2, broadcast: true, allowUnconfirmed: true });
    return { amount: r.sent ?? r.swept, fee: r.fee, txid: r.broadcastTxid };
  });

  await step(rows, 'A Legacy → self (message-only OP_RETURN)', 'p2pkh', async () => {
    const msg = `Olesia · message-only · ${net}`;
    const r = await prepareSweep({ source: A, network: net, scriptType: 'p2pkh', toAddress: Aad.p2pkh, message: msg, feeRate: 2, broadcast: true, allowUnconfirmed: true });
    return { amount: r.sent ?? r.swept, fee: r.fee, msg, txid: r.broadcastTxid };
  });

  const mint = await step(rows, 'A SegWit → P2PK (mint museum output)', 'p2pk', async () => {
    const f = await fundP2PK({ source: A, network: net, amount: 8000, feeRate: 2, broadcast: true, allowUnconfirmed: true });
    return { amount: 8000, fee: f.fee, txid: f.txid, vout: f.vout };
  });
  if (mint) await step(rows, 'A P2PK → B + OP_RETURN (rarest tx)', 'p2pk', async () => {
    const msg = `Satoshi-style note · ${net}`;
    const s = await spendP2PK({ source: A, network: net, outpoint: { txid: mint.txid, vout: mint.vout }, toAddress: Bad.p2wpkh, message: msg, feeRate: 2, broadcast: true });
    return { amount: s.sent, fee: s.fee, msg, txid: s.txid };
  });

  await step(rows, 'Air-gap PSBT (build unsigned → sign → broadcast)', 'p2wpkh', async () => {
    const u = await prepareUnsigned({ source: A, network: net, recipients: [{ address: Bad.p2wpkh, amount: 4000 }], feeRate: 2, index: 0, allowUnconfirmed: true });
    const signed = signUnsigned({ psbt: u.psbt, mnemonic: A, network: net, index: 0 });
    const b = await broadcastSigned({ psbt: signed.psbt, network: net });
    return { amount: 4000, fee: u.fee, txid: b.txid };
  });

  // single-key WIF: fund a fresh key, inspect it, sweep it back (testnet4 only, to save coins)
  if (net === 'testnet4') {
    const priv = webcrypto.getRandomValues(new Uint8Array(32));
    const wif = btc.WIF(btc.TEST_NETWORK).encode(priv);
    const wifAddr = wifAddresses(wif, net).find((a) => a.type === 'p2wpkh').address;
    out.networks[net].wif = wif;
    await step(rows, 'Fund a fresh WIF key (faucet → WIF SegWit)', 'wif', async () => {
      const r = await prepareAndSend({ source: FAUCET, network: net, scriptType: 'p2wpkh', recipients: [{ address: wifAddr, amount: 7000 }], feeRate: 2, broadcast: true, allowUnconfirmed: true });
      return { amount: 7000, fee: r.fee, txid: r.broadcastTxid };
    });
    await step(rows, 'Inspect WIF (one key → every format)', 'wif', async () => {
      const rowsW = await inspectWIF({ wif, network: net });
      const seg = rowsW.find((x) => x.type === 'p2wpkh');
      return { amount: seg.balance.confirmed + seg.balance.pending, fee: 0, txid: null, formats: rowsW.length };
    });
    await step(rows, 'Sweep WIF SegWit → B', 'wif', async () => {
      const s = await sweepWIF({ wif, network: net, scriptType: 'p2wpkh', toAddress: Bad.p2wpkh, broadcast: true });
      return { amount: s.sent ?? s.swept, fee: s.fee, txid: s.txid ?? s.broadcastTxid };
    });
  }

  // guard: spending from an empty account must fail with a clear message
  await step(rows, 'Guard: spend from EMPTY account is rejected', 'p2wpkh#9', async () => {
    let threw = null;
    try { await prepareAndSend({ source: A, network: net, scriptType: 'p2wpkh', index: 9, recipients: [{ address: Bad.p2wpkh, amount: 1000 }], feeRate: 2, broadcast: false, allowUnconfirmed: true }); }
    catch (e) { threw = e.message; }
    if (!threw) throw new Error('expected a rejection, but the empty account was allowed to spend');
    if (!/no.*UTXO|fund it first/i.test(threw)) throw new Error('rejected, but with an unclear message: ' + threw);
    return { amount: 0, fee: 0, txid: null, note: 'correctly rejected: ' + threw };
  });
}

for (const n of NETS) { try { await runNetwork(n); } catch (e) { console.log(`network ${n} aborted:`, e.message); } }
out.finishedAt = new Date().toISOString();
const path = '/tmp/claude-1000/-home-faucet-bipaudit/883a7552-ef7a-4eee-9232-966dec70b89c/scratchpad/e2e_live_result.json';
// merge into any prior run so separate network invocations accumulate
let merged = out;
try {
  const { readFileSync } = await import('node:fs');
  const prev = JSON.parse(readFileSync(path, 'utf8'));
  merged = { ...prev, ...out, networks: { ...prev.networks, ...out.networks } };
} catch { /* first run */ }
writeFileSync(path, JSON.stringify(merged, null, 2));
const all = Object.values(out.networks).flatMap((n) => n.rows);
const pass = all.filter((r) => r.ok).length;
console.log(`\n===== DONE: ${pass}/${all.length} steps OK =====`);
console.log('result JSON →', path);
