// High-level: fetch UTXOs for the wallet, build+sign a tx (optionally with an
// OP_RETURN message), and optionally broadcast. Testnet-first.
import { deriveKey } from './wallet.js';
import { getUTXOs, getBalance, getFeeRate, broadcast } from './esplora.js';
import { buildSignedTx } from './tx.js';
import { net } from './networks.js';

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
  const spendable = utxos.filter((u) => u.confirmed);
  if (!spendable.length)
    throw new Error(`no confirmed UTXOs on ${key.address} — fund it first (or wait for a confirmation)`);

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
