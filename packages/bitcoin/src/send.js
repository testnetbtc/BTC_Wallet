// High-level: resolve a wallet (any script type), fetch balance/UTXOs, build+sign a
// tx (optionally with an OP_RETURN message), and optionally broadcast. Testnet-first.
import * as btc from '@scure/btc-signer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { deriveKey } from './wallet.js';
import { deriveScript } from './scripts.js';
import { getUTXOs, getBalance, getTxHistory, getTxHex, getFeeRate, broadcast, getTx, getOutspend } from './esplora.js';
import { buildSignedTx, buildSweepTx } from './tx.js';
import { buildFundP2PK, buildSpendP2PK } from './p2pk_fund.js';
import { wifKey, wifAddresses } from './wif.js';
import { watchOnly, buildUnsignedPSBT, signPSBTOffline, extractTx } from './psbt.js';
import { net } from './networks.js';

const XPUB_RE = /^(xpub|tpub|ypub|zpub|vpub|upub)[0-9A-Za-z]+$/;
export const isXpub = (s) => XPUB_RE.test((s || '').trim());

// Unified wallet from a source. A mnemonic -> full wallet at the chosen script type
// (can sign). An xpub -> watch-only P2WPKH (script-type selection needs the seed).
export function resolveWallet(source, network, scriptType = 'p2wpkh', index = 0, passphrase = '') {
  const s = (source || '').trim();
  if (isXpub(s)) {
    const w = watchOnly(s, network, 0, index);
    return { spend: { script: w.script, address: w.address }, address: w.address, segwit: true, type: 'p2wpkh', watchOnly: true, scripthash: null };
  }
  const w = deriveScript(s, network, scriptType, index, passphrase);
  return { spend: w.spend, privKey: w.privKey, address: w.address, segwit: w.segwit, type: w.type,
           scripthash: w.scripthash, scriptHex: w.scriptHex, about: w.about, label: w.label, watchOnly: false };
}

// esplora lookup target: an address, or { scripthash } for address-less types (P2PK).
const locatorOf = (w) => (w.address ? w.address : { scripthash: w.scripthash });

export function walletAddress(source, network, scriptType, index = 0, passphrase = '') {
  return resolveWallet(source, network, scriptType, index, passphrase).address;
}
export function walletInfo(source, network, scriptType, index = 0, passphrase = '') {
  const w = resolveWallet(source, network, scriptType, index, passphrase);
  return { address: w.address, scriptHex: w.scriptHex, type: w.type, about: w.about, label: w.label, segwit: w.segwit, watchOnly: w.watchOnly };
}
export async function statusFor(source, network, scriptType, index = 0, passphrase = '') {
  const w = resolveWallet(source, network, scriptType, index, passphrase);
  const loc = locatorOf(w);
  const [balance, utxos] = await Promise.all([getBalance(loc, network), getUTXOs(loc, network)]);
  return { address: w.address, scriptHex: w.scriptHex, type: w.type, network, balance, utxos, watchOnly: w.watchOnly };
}
export function historyFor(source, network, scriptType, index = 0, passphrase = '') {
  return getTxHistory(locatorOf(resolveWallet(source, network, scriptType, index, passphrase)), network);
}

// legacy (non-segwit) inputs need the full previous tx (nonWitnessUtxo)
async function attachPrevTxs(utxos, network, wallet) {
  if (wallet.segwit !== false) return utxos;
  return Promise.all(utxos.map(async (u) => ({ ...u, prevTxHex: await getTxHex(u.txid, network) })));
}
async function spendableUtxos(w, network, allowUnconfirmed) {
  const utxos = await getUTXOs(locatorOf(w), network);
  const s = allowUnconfirmed ? utxos : utxos.filter((u) => u.confirmed);
  if (!s.length) throw new Error(`no ${allowUnconfirmed ? '' : 'confirmed '}UTXOs on ${w.address || 'this script'} — fund it first`);
  return attachPrevTxs(s, network, w);
}

export async function prepareAndSend(opts) {
  const { source, mnemonic, network, scriptType = 'p2wpkh', recipients = [], message = null, index = 0, passphrase = '' } = opts;
  const w = resolveWallet(source ?? mnemonic, network, scriptType, index, passphrase);
  if (w.watchOnly) throw new Error('watch-only (xpub) cannot sign — use the air-gap tools');
  if (!w.address) throw new Error('P2PK has no address; spending it is a museum feature (coming soon)');
  const spendable = await spendableUtxos(w, network, opts.allowUnconfirmed);
  const feeRate = opts.feeRate ?? await getFeeRate(network, 6);
  const built = buildSignedTx({ utxos: spendable, key: w, recipients, message, changeAddress: w.address, feeRate, networkName: network });
  const broadcastTxid = opts.broadcast ? await broadcast(built.txHex, network) : null;
  return { from: w.address, ...built, feeRate, broadcast: !!opts.broadcast, broadcastTxid,
           explorer: broadcastTxid ? net(network).explorer + broadcastTxid : null };
}

export async function prepareSweep(opts) {
  const { source, mnemonic, network, scriptType = 'p2wpkh', toAddress, index = 0, passphrase = '', message = null } = opts;
  const w = resolveWallet(source ?? mnemonic, network, scriptType, index, passphrase);
  if (w.watchOnly || !w.address) throw new Error('cannot sweep from this source/type');
  const spendable = await spendableUtxos(w, network, opts.allowUnconfirmed);
  const feeRate = opts.feeRate ?? await getFeeRate(network, 6);
  const built = buildSweepTx({ utxos: spendable, key: w, toAddress, feeRate, networkName: network, message });
  const broadcastTxid = opts.broadcast ? await broadcast(built.txHex, network) : null;
  return { from: w.address, to: toAddress, ...built, feeRate, broadcast: !!opts.broadcast, broadcastTxid,
           explorer: broadcastTxid ? net(network).explorer + broadcastTxid : null };
}

// ---- P2PK lab: fund a P2PK output from the seed's SegWit balance, track it, spend it ----
// P2PK has no address (nothing to paste), and public explorers don't index it, so the
// wallet moves coins in from its own P2WPKH balance and tracks the outpoint itself.
export async function fundP2PK({ source, network, amount, feeRate = 2, broadcast: doBroadcast = false, allowUnconfirmed = true, passphrase = '' }) {
  const src = deriveScript(source, network, 'p2wpkh', 0, passphrase);
  const tgt = deriveScript(source, network, 'p2pk', 0, passphrase);
  const utxos = (await getUTXOs(src.address, network)).filter((u) => allowUnconfirmed || u.confirmed);
  if (!utxos.length) throw new Error(`fund your SegWit address first (${src.address}) — no coins to move into P2PK`);
  const built = buildFundP2PK({ utxos, privKey: src.privKey, pubkey: src.pubkey, targetScript: tgt.spend.script, changeScript: src.spend.script, amount: Number(amount), feeRate: Number(feeRate) });
  const txid = doBroadcast ? await broadcast(built.txHex, network) : built.txid;
  return { txid, vout: 0, amount: Number(amount), scriptHex: tgt.scriptHex, fee: built.fee, vsize: built.vsize,
           broadcast: !!doBroadcast, explorer: doBroadcast ? net(network).explorer + txid : null };
}

// Annotate tracked P2PK outpoints with live value/confirmed/spent (from /tx + /outspend).
export async function p2pkOutpoints({ network, outpoints }) {
  return Promise.all((outpoints || []).map(async (op) => {
    try {
      const [tx, spend] = await Promise.all([getTx(op.txid, network), getOutspend(op.txid, op.vout, network)]);
      const vout = tx.vout[op.vout];
      return { txid: op.txid, vout: op.vout, value: vout?.value ?? op.amount, type: vout?.scriptpubkey_type,
               confirmed: !!tx.status?.confirmed, spent: !!spend?.spent };
    } catch (e) { return { txid: op.txid, vout: op.vout, value: op.amount, error: e.message }; }
  }));
}

// Recover a P2PK coin by its funding txid: verify the output really is THIS
// wallet's P2PK script (explorers can't look it up by address), then return it
// so the UI can re-track it after browser data was cleared.
export async function importP2PK({ source, network, txid, vout = 0, passphrase = '' }) {
  const tgt = deriveScript(source, network, 'p2pk', 0, passphrase);
  const tx = await getTx(txid, network);
  const out = tx.vout?.[vout];
  if (!out) throw new Error(`no output #${vout} in that transaction`);
  if ((out.scriptpubkey || '').toLowerCase() !== tgt.scriptHex.toLowerCase())
    throw new Error(`output #${vout} isn't this wallet's P2PK — wrong txid, vout, or seed`);
  const spend = await getOutspend(txid, vout, network);
  return { txid, vout, amount: out.value, confirmed: !!tx.status?.confirmed, spent: !!spend?.spent };
}

// Sweep one tracked P2PK output to any address (hand-rolled legacy spend).
export async function spendP2PK({ source, network, outpoint, toAddress, feeRate = 2, broadcast: doBroadcast = false, passphrase = '', message = null }) {
  const tgt = deriveScript(source, network, 'p2pk', 0, passphrase);
  const tx = await getTx(outpoint.txid, network);
  const vout = tx.vout[outpoint.vout];
  if (!vout) throw new Error('P2PK output not found on chain');
  if ((await getOutspend(outpoint.txid, outpoint.vout, network))?.spent) throw new Error('this P2PK coin was already spent');
  const destScript = btc.OutScript.encode(btc.Address(net(network).btc).decode((toAddress || '').trim()));
  const built = buildSpendP2PK({ utxo: { txid: outpoint.txid, vout: outpoint.vout, value: vout.value }, privKey: tgt.privKey, p2pkScriptBytes: tgt.spend.script, destScript, feeRate: Number(feeRate), message });
  const txid = doBroadcast ? await broadcast(built.txHex, network) : built.txid;
  return { txid, sent: built.sent, fee: built.fee, to: (toAddress || '').trim(), broadcast: !!doBroadcast, explorer: doBroadcast ? net(network).explorer + txid : null };
}

// ---- freeze-and-broadcast primitives (build once, confirm once, send SAME bytes) ----
// Decode a fully-signed raw transaction so the confirmation UI can be rendered
// from the TRANSACTION ITSELF (the source of truth), never from form values.
export function decodeRawTx({ hex, network }) {
  const n = net(network);
  const tx = btc.Transaction.fromRaw(hexToBytes(hex), { allowUnknownOutputs: true, allowUnknownInputs: true });
  const outputs = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    let address = null, opReturn = null, type = 'unknown';
    if (o.script && o.script[0] === 0x6a) {
      type = 'op_return';
      try { const dec = btc.Script.decode(o.script); const data = dec.find((x) => x instanceof Uint8Array); opReturn = data ? new TextDecoder().decode(data) : ''; } catch { opReturn = ''; }
    } else {
      try { const d = btc.OutScript.decode(o.script); type = d.type; address = btc.Address(n.btc).encode(d); } catch { /* unknown script */ }
    }
    outputs.push({ vout: i, address, amount: Number(o.amount), type, opReturn });
  }
  const inputs = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    inputs.push({ txid: bytesToHex(inp.txid), vout: inp.index });
  }
  return { txid: tx.id, vsize: tx.vsize, inputs, outputs, totalOut: outputs.reduce((a, o) => a + o.amount, 0) };
}

// Broadcast EXACT bytes previously shown to the user. The txid is recomputed
// from the hex itself and (when the API echoes one) cross-checked — a mismatch
// aborts loudly rather than reporting the wrong transaction as sent.
export async function broadcastRaw({ hex, network }) {
  const expected = decodeRawTx({ hex, network }).txid;
  const got = await broadcast(hex, network);
  const txid = (got || '').trim() || expected;
  if (txid !== expected) throw new Error(`broadcast txid mismatch — expected ${expected}, network reported ${txid}`);
  return { txid, explorer: net(network).explorer + txid };
}

// ---- single private key (WIF): inspect all formats, sweep any funded one ----
export async function inspectWIF({ wif, network }) {
  const rows = wifAddresses(wif, network);
  return Promise.all(rows.map(async (r) => {
    const loc = r.address ? r.address : { scripthash: r.scripthash };
    try {
      const [balance, utxos] = await Promise.all([getBalance(loc, network), getUTXOs(loc, network)]);
      return { ...r, balance, utxos: utxos.length };
    } catch (e) { return { ...r, balance: { confirmed: 0, pending: 0 }, utxos: 0, error: e.message }; }
  }));
}

export async function sweepWIF({ wif, network, scriptType, toAddress, message = null, broadcast: doBroadcast = false }) {
  const key = wifKey(wif, network, scriptType);
  const loc = key.address ? key.address : { scripthash: key.scripthash };
  const utxos = await getUTXOs(loc, network);
  if (!utxos.length) throw new Error('no coins at this address to sweep');
  if (scriptType === 'p2pk') {
    // bare-pubkey UTXOs use the hand-rolled spender — one tx per UTXO
    const destScript = btc.OutScript.encode(btc.Address(net(network).btc).decode((toAddress || '').trim()));
    const feeRate = await getFeeRate(network, 6);
    const txids = []; let sent = 0;
    for (const u of utxos) {
      const built = buildSpendP2PK({ utxo: { txid: u.txid, vout: u.vout, value: u.value }, privKey: key.privKey, p2pkScriptBytes: key.spend.script, destScript, message, feeRate });
      const txid = doBroadcast ? await broadcast(built.txHex, network) : built.txid;
      txids.push(txid); sent += built.sent;
    }
    return { txid: txids[0], txids, swept: sent, count: txids.length, explorer: net(network).explorer + txids[0] };
  }
  const withPrev = await attachPrevTxs(utxos, network, key);
  const feeRate = await getFeeRate(network, 6);
  const built = buildSweepTx({ utxos: withPrev, key, toAddress: (toAddress || '').trim(), feeRate, networkName: network, message });
  const txid = doBroadcast ? await broadcast(built.txHex, network) : built.txid;
  // txHex returned so the caller can freeze these bytes: confirm, then broadcastRaw
  return { txid, txHex: built.txHex, swept: built.swept, fee: built.fee, feeRate, explorer: doBroadcast ? net(network).explorer + txid : null };
}

// ---- air-gap PSBT flow (P2WPKH / xpub watch-only) ----
export function woFrom(source, network, index = 0, passphrase = '') {
  const s = (source || '').trim();
  if (isXpub(s)) { const w = watchOnly(s, network, 0, index); return { script: w.script, address: w.address, watchOnly: true }; }
  const k = deriveKey(s, passphrase || '', network, index);
  return { script: k.spend.script, address: k.address, key: k, watchOnly: false };
}
export async function prepareUnsigned(opts) {
  const { source, network, recipients = [], message = null, index = 0, passphrase = '' } = opts;
  const wo = woFrom(source, network, index, passphrase);
  const utxos = await getUTXOs(wo.address, network);
  const spendable = opts.allowUnconfirmed ? utxos : utxos.filter((u) => u.confirmed);
  if (!spendable.length) throw new Error(`no spendable UTXOs on ${wo.address}`);
  const feeRate = opts.feeRate ?? await getFeeRate(network, 6);
  const built = buildUnsignedPSBT({ utxos: spendable, wo: { script: wo.script, address: wo.address }, recipients, message, changeAddress: wo.address, feeRate, network });
  return { from: wo.address, ...built, feeRate };
}
export function signUnsigned({ psbt, mnemonic, network, index = 0, passphrase = '' }) {
  return signPSBTOffline(psbt, (mnemonic || '').trim(), passphrase || '', network, index);
}
export async function broadcastSigned({ psbt, network }) {
  const { txHex } = extractTx(psbt);
  const bid = await broadcast(txHex, network);
  return { txid: bid, explorer: net(network).explorer + bid };
}
