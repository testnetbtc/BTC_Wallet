// Browser entry for the online Olesia wallet. Exposes window.OW.
// A "source" is either a 24-word mnemonic (full wallet, can sign — hot) OR an
// account xpub (watch-only, cannot sign). Mainnet is meant to be watch-only here;
// signing for mainnet happens OFFLINE via the PSBT tools.
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import QRCode from 'qrcode';
import {
  walletAddress, statusByAddress, isXpub, prepareAndSend, prepareSweep,
  prepareUnsigned, signUnsigned, broadcastSigned,
} from '../src/send.js';
import { accountXpub } from '../src/wallet.js';
import { getTxHistory } from '../src/esplora.js';
import { NETWORKS } from '../src/networks.js';

const T = (s) => (s || '').trim();

window.OW = {
  generate: () => generateMnemonic(wordlist, 256),
  validate: (m) => { try { return validateMnemonic(T(m), wordlist); } catch { return false; } },
  isXpub: (s) => isXpub(s),
  networks: Object.keys(NETWORKS),
  explorer: (network) => NETWORKS[network].explorer,
  qr: async (text) => {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#0e1116', light: '#e6edf3' } });
    return 'data:image/svg+xml;base64,' + btoa(svg);
  },

  // works for a mnemonic OR an xpub
  address: (source, network, index = 0) => walletAddress(T(source), network, index),
  status: (source, network, index = 0) => statusByAddress(walletAddress(T(source), network, index), network),
  history: (source, network, index = 0) => getTxHistory(walletAddress(T(source), network, index), network),
  xpub: (mnemonic, network) => accountXpub(T(mnemonic), '', network),

  // hot-wallet send/sweep (mnemonic required)
  send: ({ mnemonic, network, toAddress, amount, message, feeRate, index = 0, broadcast = false, allowUnconfirmed = true }) =>
    prepareAndSend({
      mnemonic: T(mnemonic), network,
      recipients: (toAddress && Number(amount) > 0) ? [{ address: T(toAddress), amount: Number(amount) }] : [],
      message: message || null, feeRate: feeRate ? Number(feeRate) : undefined, index, broadcast, allowUnconfirmed,
    }),
  sweep: ({ mnemonic, network, toAddress, feeRate, index = 0, broadcast = false, allowUnconfirmed = true }) =>
    prepareSweep({ mnemonic: T(mnemonic), network, toAddress: T(toAddress), feeRate: feeRate ? Number(feeRate) : undefined, index, broadcast, allowUnconfirmed }),

  // air-gap PSBT flow
  buildUnsigned: ({ source, network, toAddress, amount, message, feeRate, index = 0 }) =>
    prepareUnsigned({
      source: T(source), network,
      recipients: (toAddress && Number(amount) > 0) ? [{ address: T(toAddress), amount: Number(amount) }] : [],
      message: message || null, feeRate: feeRate ? Number(feeRate) : undefined, index, allowUnconfirmed: true,
    }),
  signPsbt: ({ psbt, mnemonic, network, index = 0 }) => signUnsigned({ psbt: T(psbt), mnemonic: T(mnemonic), network, index }),
  broadcastPsbt: ({ psbt, network }) => broadcastSigned({ psbt: T(psbt), network }),
};
