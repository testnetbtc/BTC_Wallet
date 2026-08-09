// Browser entry for the online Olesia wallet (send/receive). Exposes a small API
// on window.OW. The seed lives only in this tab's memory, is never stored, and is
// used to sign locally with @scure/btc-signer. Testnet-first (hot wallet).
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import QRCode from 'qrcode';
import { receiveAddress, walletStatus, prepareAndSend, prepareSweep } from '../src/send.js';
import { getTxHistory } from '../src/esplora.js';
import { NETWORKS } from '../src/networks.js';

window.OW = {
  generate: () => generateMnemonic(wordlist, 256),
  validate: (m) => { try { return validateMnemonic(m.trim(), wordlist); } catch { return false; } },
  networks: Object.keys(NETWORKS),
  explorer: (network) => NETWORKS[network].explorer,

  address: (mnemonic, network, index = 0) => receiveAddress(mnemonic.trim(), '', network, index),
  status: (mnemonic, network, index = 0) => walletStatus(mnemonic.trim(), '', network, index),
  history: (mnemonic, network, index = 0) => getTxHistory(receiveAddress(mnemonic.trim(), '', network, index), network),
  qr: async (text) => {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#0e1116', light: '#e6edf3' } });
    return 'data:image/svg+xml;base64,' + btoa(svg); // canvas-free; CSP img-src data:
  },

  send: ({ mnemonic, network, toAddress, amount, message, feeRate, index = 0, broadcast = false, allowUnconfirmed = true }) =>
    prepareAndSend({
      mnemonic: mnemonic.trim(), network,
      recipients: (toAddress && Number(amount) > 0) ? [{ address: toAddress.trim(), amount: Number(amount) }] : [],
      message: message ? message : null,
      feeRate: feeRate ? Number(feeRate) : undefined,
      index, broadcast, allowUnconfirmed,
    }),

  sweep: ({ mnemonic, network, toAddress, feeRate, index = 0, broadcast = false, allowUnconfirmed = true }) =>
    prepareSweep({
      mnemonic: mnemonic.trim(), network, toAddress: toAddress.trim(),
      feeRate: feeRate ? Number(feeRate) : undefined, index, broadcast, allowUnconfirmed,
    }),
};
