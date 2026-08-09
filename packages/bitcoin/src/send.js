// High-level: fetch UTXOs for the wallet, build+sign a tx (optionally with an
// OP_RETURN message), and optionally broadcast. Testnet-first.
import { deriveKey } from './wallet.js';
import { getUTXOs, getBalance, getFeeRate, broadcast } from './esplora.js';
import { buildSignedTx, buildSweepTx } from './tx.js';
import { watchOnly, buildUnsignedPSBT, signPSBTOffline, extractTx } from './psbt.js';
import { net } from './networks.js';

const XPUB_RE = /^(xpub|tpub|ypub|zpub|vpub|upub)[0-9A-Za-z]+$/;
export const isXpub = (s) => XPUB_RE.test((s || '').trim());

// Resolve a "source" (account xpub OR mnemonic) to a spend object {script,address}.
// An xpub is watch-only (no key); a mnemonic yields the full key (can sign).
export function woFrom(source, network, index = 0) {
  const s = (source || '').trim();
  if (isXpub(s)) { const w = watchOnly(s, network, 0, index); return { script: w.script, address: w.address, watchOnly: true }; }
  const k = deriveKey(s, '', network, index);
  return { script: k.spend.script, address: k.address, key: k, watchOnly: false };
}

export function walletAddress(source, network, index = 0) { return woFrom(source, network, index).address; }

export async function statusByAddress(address, network) {
  const [balance, utxos] = await Promise.all([getBalance(address, network), getUTXOs(address, network)]);
  return { address, network, balance, utxos };
}

// AIR-GAP: build an UNSIGNED PSBT from a source (xpub watch-only OR mnemonic).
export async function prepareUnsigned(opts) {
  const { source, network, recipients = [], message = null, index = 0 } = opts;
  const wo = woFrom(source, network, index);
  const utxos = await getUTXOs(wo.address, network);
  const spendable = opts.allowUnconfirmed ? utxos : utxos.filter((u) => u.confirmed);
  if (!spendable.length) throw new Error(`no spendable UTXOs on ${wo.address}`);
  const feeRate = opts.feeRate ?? await getFeeRate(network, 6);
  const built = buildUnsignedPSBT({
    utxos: spendable, wo: { script: wo.script, address: wo.address },
    recipients, message, changeAddress: wo.address, feeRate, network,
  });
  return { from: wo.address, ...built, feeRate };
}

// AIR-GAP: sign an unsigned PSBT with the seed (run this OFFLINE for mainnet).
export function signUnsigned({ psbt, mnemonic, network, index = 0 }) {
  return signPSBTOffline(psbt, (mnemonic || '').trim(), '', network, index);
}

// AIR-GAP: extract + broadcast a signed PSBT.
export async function broadcastSigned({ psbt, network }) {
  const { txHex } = extractTx(psbt);
  const bid = await broadcast(txHex, network);
  return { txid: bid, explorer: net(network).explorer + bid };
}

// Send the entire spendable balance to `toAddress`, minus fee.
export async function prepareSweep(opts) {
  const { mnemonic, passphrase = '', network, toAddress, index = 0 } = opts;
  const key = deriveKey(mnemonic, passphrase, network, index);
  const utxos = await getUTXOs(key.address, network);
  const spendable = opts.allowUnconfirmed ? utxos : utxos.filter((u) => u.confirmed);
  if (!spendable.length) throw new Error(`no spendable UTXOs on ${key.address}`);
  const feeRate = opts.feeRate ?? await getFeeRate(network, 6);
  const built = buildSweepTx({ utxos: spendable, key, toAddress, feeRate, networkName: network });
  let broadcastTxid = null;
  if (opts.broadcast) broadcastTxid = await broadcast(built.txHex, network);
  return {
    from: key.address, to: toAddress, ...built, feeRate,
    broadcast: !!opts.broadcast, broadcastTxid,
    explorer: broadcastTxid ? net(network).explorer + broadcastTxid : null,
  };
}

export function receiveAddress(mnemonic, passphrase, network, index = 0) {
  return deriveKey(mnemonic, passphrase, network, index).address;
}

export async function walletStatus(mnemonic, passphrase, network, index = 0) {
  const key = deriveKey(mnemonic, passphrase, network, index);
  const [balance, utxos] = await Promise.all([
    getBalance(key.address, network),
    getUTXOs(key.address, network),
  ]);
  return { address: key.address, network, balance, utxos };
}

// opts: { mnemonic, passphrase?, network, recipients?, message?, feeRate?,
//         index?, broadcast?: boolean }
export async function prepareAndSend(opts) {
  const { mnemonic, passphrase = '', network, recipients = [], message = null,
          index = 0 } = opts;
  const key = deriveKey(mnemonic, passphrase, network, index);
  const utxos = await getUTXOs(key.address, network);
  // By default only spend confirmed coins; allowUnconfirmed lets us chain off a
  // still-in-mempool funding tx (fine on testnet — the child confirms with the parent).
  const spendable = opts.allowUnconfirmed ? utxos : utxos.filter((u) => u.confirmed);
  if (!spendable.length)
    throw new Error(`no ${opts.allowUnconfirmed ? '' : 'confirmed '}UTXOs on ${key.address} — fund it first`);

  const feeRate = opts.feeRate ?? await getFeeRate(network, 6);
  const built = buildSignedTx({
    utxos: spendable, key, recipients, message,
    changeAddress: key.address, feeRate, networkName: network,
  });

  let broadcastTxid = null;
  if (opts.broadcast) broadcastTxid = await broadcast(built.txHex, network);

  return {
    from: key.address,
    ...built,
    feeRate,
    broadcast: !!opts.broadcast,
    broadcastTxid,
    explorer: broadcastTxid ? net(network).explorer + broadcastTxid : null,
  };
}
