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
import { accountXpub, normalizeMnemonic } from '../src/wallet.js';
import { getTxHistory } from '../src/esplora.js';
import { NETWORKS } from '../src/networks.js';

const T = (s) => (s || '').trim();

window.OW = {
  generate: () => generateMnemonic(wordlist, 256),
  validate: (m) => { try { return validateMnemonic(normalizeMnemonic(m), wordlist); } catch { return false; } },
  isXpub: (s) => isXpub(s),
  // Human-readable reason a seed/xpub was rejected — never echoes the words, only positions.
  diagnose: (s) => {
    s = T(s);
    if (isXpub(s)) return 'looks like an xpub';
    const words = normalizeMnemonic(s).split(' ').filter(Boolean);
    if (![12, 15, 18, 21, 24].includes(words.length))
      return `got ${words.length} words — a 24-word seed is expected. Check for a missing/extra word or a line-break.`;
    const bad = []; words.forEach((w, i) => { if (!wordlist.includes(w)) bad.push(i + 1); });
    if (bad.length)
      return `word${bad.length > 1 ? 's' : ''} #${bad.join(', #')} ${bad.length > 1 ? 'are' : 'is'} not a BIP-39 word — likely autocorrect. Fix and reload.`;
    return 'all words are valid BIP-39 words but the checksum fails — a word is probably wrong or out of order.';
  },
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

  // hot-wallet send/sweep (mnemonic required). Mainnet requires CONFIRMED inputs
  // (spending unconfirmed is riskier with real money); testnet may chain unconfirmed.
  send: ({ mnemonic, network, toAddress, amount, message, feeRate, index = 0, broadcast = false, allowUnconfirmed = network !== 'mainnet' }) =>
    prepareAndSend({
      mnemonic: T(mnemonic), network,
      recipients: (toAddress && Number(amount) > 0) ? [{ address: T(toAddress), amount: Number(amount) }] : [],
      message: message || null, feeRate: feeRate ? Number(feeRate) : undefined, index, broadcast, allowUnconfirmed,
    }),
  sweep: ({ mnemonic, network, toAddress, feeRate, index = 0, broadcast = false, allowUnconfirmed = network !== 'mainnet' }) =>
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
