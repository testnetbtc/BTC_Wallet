// Browser entry for the online Olesia wallet. Exposes window.OW.
// A "source" is a 24-word mnemonic (full wallet, any script type) or an account
// xpub (watch-only P2WPKH). Mainnet spending stays behind explicit opt-in.
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import QRCode from 'qrcode';
import {
  walletAddress, walletInfo, statusFor, historyFor, isXpub,
  prepareAndSend, prepareSweep, prepareUnsigned, signUnsigned, broadcastSigned,
  fundP2PK, p2pkOutpoints, spendP2PK,
} from '../src/send.js';
import { accountXpub, normalizeMnemonic } from '../src/wallet.js';
import { scriptTypeList, SCRIPT_TYPES } from '../src/scripts.js';
import { NETWORKS } from '../src/networks.js';

const T = (s) => (s || '').trim();

window.OW = {
  generate: () => generateMnemonic(wordlist, 256),
  validate: (m) => { try { return validateMnemonic(normalizeMnemonic(m), wordlist); } catch { return false; } },
  isXpub: (s) => isXpub(s),
  diagnose: (s) => {
    s = T(s);
    if (isXpub(s)) return 'looks like an xpub';
    const words = normalizeMnemonic(s).split(' ').filter(Boolean);
    if (![12, 15, 18, 21, 24].includes(words.length))
      return `got ${words.length} words — a 24-word seed is expected. Check for a missing/extra word or a line-break.`;
    const bad = []; words.forEach((w, i) => { if (!wordlist.includes(w)) bad.push(i + 1); });
    if (bad.length) return `word${bad.length > 1 ? 's' : ''} #${bad.join(', #')} ${bad.length > 1 ? 'are' : 'is'} not a BIP-39 word — likely autocorrect. Fix and reload.`;
    return 'all words are valid BIP-39 words but the checksum fails — a word is probably wrong or out of order.';
  },
  networks: Object.keys(NETWORKS),
  explorer: (network) => NETWORKS[network].explorer,
  scriptTypes: () => scriptTypeList().map((t) => ({ id: t, label: SCRIPT_TYPES[t].label, about: SCRIPT_TYPES[t].about, noAddress: !!SCRIPT_TYPES[t].noAddress })),
  qr: async (text) => {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#0e1116', light: '#e6edf3' } });
    return 'data:image/svg+xml;base64,' + btoa(svg);
  },

  // all take an optional scriptType (default p2wpkh)
  address: (source, network, scriptType, index = 0) => walletAddress(T(source), network, scriptType, index),
  info: (source, network, scriptType, index = 0) => walletInfo(T(source), network, scriptType, index),
  status: (source, network, scriptType, index = 0) => statusFor(T(source), network, scriptType, index),
  history: (source, network, scriptType, index = 0) => historyFor(T(source), network, scriptType, index),
  xpub: (mnemonic, network) => accountXpub(T(mnemonic), '', network),

  send: ({ mnemonic, network, scriptType, toAddress, amount, message, feeRate, index = 0, broadcast = false, allowUnconfirmed = network !== 'mainnet' }) =>
    prepareAndSend({
      source: T(mnemonic), network, scriptType,
      recipients: (toAddress && Number(amount) > 0) ? [{ address: T(toAddress), amount: Number(amount) }] : [],
      message: message || null, feeRate: feeRate ? Number(feeRate) : undefined, index, broadcast, allowUnconfirmed,
    }),
  sweep: ({ mnemonic, network, scriptType, toAddress, feeRate, index = 0, broadcast = false, allowUnconfirmed = network !== 'mainnet' }) =>
    prepareSweep({ source: T(mnemonic), network, scriptType, toAddress: T(toAddress), feeRate: feeRate ? Number(feeRate) : undefined, index, broadcast, allowUnconfirmed }),

  // air-gap PSBT flow (P2WPKH)
  buildUnsigned: ({ source, network, toAddress, amount, message, feeRate, index = 0 }) =>
    prepareUnsigned({
      source: T(source), network,
      recipients: (toAddress && Number(amount) > 0) ? [{ address: T(toAddress), amount: Number(amount) }] : [],
      message: message || null, feeRate: feeRate ? Number(feeRate) : undefined, index, allowUnconfirmed: true,
    }),
  signPsbt: ({ psbt, mnemonic, network, index = 0 }) => signUnsigned({ psbt: T(psbt), mnemonic: T(mnemonic), network, index }),
  broadcastPsbt: ({ psbt, network }) => broadcastSigned({ psbt: T(psbt), network }),

  // P2PK lab: fund a P2PK from the seed's SegWit balance, track outpoints, spend them out
  fundP2PK: ({ source, network, amount, feeRate, broadcast = true }) =>
    fundP2PK({ source: T(source), network, amount: Number(amount), feeRate: feeRate ? Number(feeRate) : 2, broadcast }),
  p2pkStatus: ({ network, outpoints }) => p2pkOutpoints({ network, outpoints }),
  spendP2PK: ({ source, network, outpoint, toAddress, feeRate, broadcast = true }) =>
    spendP2PK({ source: T(source), network, outpoint, toAddress: T(toAddress), feeRate: feeRate ? Number(feeRate) : 2, broadcast }),
};
