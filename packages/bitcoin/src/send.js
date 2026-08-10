// High-level: resolve a wallet (any script type), fetch balance/UTXOs, build+sign a
// tx (optionally with an OP_RETURN message), and optionally broadcast. Testnet-first.
import { deriveKey } from './wallet.js';
import { deriveScript } from './scripts.js';
import { getUTXOs, getBalance, getTxHistory, getTxHex, getFeeRate, broadcast } from './esplora.js';
import { buildSignedTx, buildSweepTx } from './tx.js';
import { watchOnly, buildUnsignedPSBT, signPSBTOffline, extractTx } from './psbt.js';
import { net } from './networks.js';

const XPUB_RE = /^(xpub|tpub|ypub|zpub|vpub|upub)[0-9A-Za-z]+$/;
export const isXpub = (s) => XPUB_RE.test((s || '').trim());

// Unified wallet from a source. A mnemonic -> full wallet at the chosen script type
// (can sign). An xpub -> watch-only P2WPKH (script-type selection needs the seed).
export function resolveWallet(source, network, scriptType = 'p2wpkh', index = 0) {
  const s = (source || '').trim();
  if (isXpub(s)) {
    const w = watchOnly(s, network, 0, index);
    return { spend: { script: w.script, address: w.address }, address: w.address, segwit: true, type: 'p2wpkh', watchOnly: true, scripthash: null };
  }
  const w = deriveScript(s, network, scriptType, index);
  return { spend: w.spend, privKey: w.privKey, address: w.address, segwit: w.segwit, type: w.type,
           scripthash: w.scripthash, scriptHex: w.scriptHex, about: w.about, label: w.label, watchOnly: false };
}

// esplora lookup target: an address, or { scripthash } for address-less types (P2PK).
const locatorOf = (w) => (w.address ? w.address : { scripthash: w.scripthash });

export function walletAddress(source, network, scriptType, index = 0) {
  return resolveWallet(source, network, scriptType, index).address;
}
export function walletInfo(source, network, scriptType, index = 0) {
  const w = resolveWallet(source, network, scriptType, index);
  return { address: w.address, scriptHex: w.scriptHex, type: w.type, about: w.about, label: w.label, segwit: w.segwit, watchOnly: w.watchOnly };
}
export async function statusFor(source, network, scriptType, index = 0) {
  const w = resolveWallet(source, network, scriptType, index);
  const loc = locatorOf(w);
  const [balance, utxos] = await Promise.all([getBalance(loc, network), getUTXOs(loc, network)]);
  return { address: w.address, scriptHex: w.scriptHex, type: w.type, network, balance, utxos, watchOnly: w.watchOnly };
}
export function historyFor(source, network, scriptType, index = 0) {
  return getTxHistory(locatorOf(resolveWallet(source, network, scriptType, index)), network);
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
  const { source, mnemonic, network, scriptType = 'p2wpkh', recipients = [], message = null, index = 0 } = opts;
  const w = resolveWallet(source ?? mnemonic, network, scriptType, index);
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
  const { source, mnemonic, network, scriptType = 'p2wpkh', toAddress, index = 0 } = opts;
  const w = resolveWallet(source ?? mnemonic, network, scriptType, index);
  if (w.watchOnly || !w.address) throw new Error('cannot sweep from this source/type');
  const spendable = await spendableUtxos(w, network, opts.allowUnconfirmed);
  const feeRate = opts.feeRate ?? await getFeeRate(network, 6);
  const built = buildSweepTx({ utxos: spendable, key: w, toAddress, feeRate, networkName: network });
  const broadcastTxid = opts.broadcast ? await broadcast(built.txHex, network) : null;
  return { from: w.address, to: toAddress, ...built, feeRate, broadcast: !!opts.broadcast, broadcastTxid,
           explorer: broadcastTxid ? net(network).explorer + broadcastTxid : null };
}

// ---- air-gap PSBT flow (P2WPKH / xpub watch-only) ----
export function woFrom(source, network, index = 0) {
  const s = (source || '').trim();
  if (isXpub(s)) { const w = watchOnly(s, network, 0, index); return { script: w.script, address: w.address, watchOnly: true }; }
  const k = deriveKey(s, '', network, index);
  return { script: k.spend.script, address: k.address, key: k, watchOnly: false };
}
export async function prepareUnsigned(opts) {
  const { source, network, recipients = [], message = null, index = 0 } = opts;
  const wo = woFrom(source, network, index);
  const utxos = await getUTXOs(wo.address, network);
  const spendable = opts.allowUnconfirmed ? utxos : utxos.filter((u) => u.confirmed);
  if (!spendable.length) throw new Error(`no spendable UTXOs on ${wo.address}`);
  const feeRate = opts.feeRate ?? await getFeeRate(network, 6);
  const built = buildUnsignedPSBT({ utxos: spendable, wo: { script: wo.script, address: wo.address }, recipients, message, changeAddress: wo.address, feeRate, network });
  return { from: wo.address, ...built, feeRate };
}
export function signUnsigned({ psbt, mnemonic, network, index = 0 }) {
  return signPSBTOffline(psbt, (mnemonic || '').trim(), '', network, index);
}
export async function broadcastSigned({ psbt, network }) {
  const { txHex } = extractTx(psbt);
  const bid = await broadcast(txHex, network);
  return { txid: bid, explorer: net(network).explorer + bid };
}
