// High-level: fetch UTXOs for the wallet, build+sign a tx (optionally with an
// OP_RETURN message), and optionally broadcast. Testnet-first.
import { deriveKey } from './wallet.js';
import { getUTXOs, getBalance, getFeeRate, broadcast } from './esplora.js';
import { buildSignedTx, buildSweepTx } from './tx.js';
import { net } from './networks.js';

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
