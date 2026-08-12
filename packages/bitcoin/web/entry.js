// Browser entry for the online Olesia wallet. Exposes window.OW.
// A "source" is a 24-word mnemonic (full wallet, any script type) or an account
// xpub (watch-only P2WPKH). Mainnet spending stays behind explicit opt-in.
import { generateMnemonic, validateMnemonic, entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import QRCode from 'qrcode';
import {
  walletAddress, walletInfo, statusFor, historyFor, isXpub,
  prepareAndSend, prepareSweep, prepareUnsigned, signUnsigned, broadcastSigned,
  fundP2PK, p2pkOutpoints, spendP2PK, importP2PK,
  inspectWIF, sweepWIF, decodeRawTx, broadcastRaw, describePsbt,
} from '../src/send.js';
import { accountXpub, normalizeMnemonic } from '../src/wallet.js';
import { sealSeed, openSeed } from '../src/vault.js';
import { decryptColdBackup } from '../src/coldbackup.js';
import { scriptTypeList, SCRIPT_TYPES } from '../src/scripts.js';
import { NETWORKS } from '../src/networks.js';

const T = (s) => (s || '').trim();

window.OW = {
  generate: () => generateMnemonic(wordlist, 256),
  // 256 bits from the OS CSPRNG, optionally stirred with user entropy (dice
  // rolls, key mashing). A hash of many sources is strong if ANY ONE is strong,
  // so extra entropy can only help — the CSPRNG floor is always there.
  generateFrom: (extra) => {
    const rnd = crypto.getRandomValues(new Uint8Array(32));
    if (!extra || !String(extra).trim()) return entropyToMnemonic(rnd, wordlist);
    return entropyToMnemonic(sha256(concatBytes(rnd, utf8ToBytes(String(extra)))), wordlist);
  },
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

  // all take an optional scriptType (default p2wpkh) and optional passphrase
  address: (source, network, scriptType, index = 0, passphrase = '') => walletAddress(T(source), network, scriptType, index, passphrase),
  info: (source, network, scriptType, index = 0, passphrase = '') => walletInfo(T(source), network, scriptType, index, passphrase),
  status: (source, network, scriptType, index = 0, passphrase = '') => statusFor(T(source), network, scriptType, index, passphrase),
  history: (source, network, scriptType, index = 0, passphrase = '') => historyFor(T(source), network, scriptType, index, passphrase),
  xpub: (mnemonic, network, passphrase = '') => accountXpub(T(mnemonic), passphrase || '', network),

  send: ({ mnemonic, network, scriptType, toAddress, amount, message, feeRate, index = 0, broadcast = false, allowUnconfirmed = network !== 'mainnet', passphrase = '' }) =>
    prepareAndSend({
      source: T(mnemonic), network, scriptType, passphrase,
      recipients: (toAddress && Number(amount) > 0) ? [{ address: T(toAddress), amount: Number(amount) }] : [],
      message: message || null, feeRate: feeRate ? Number(feeRate) : undefined, index, broadcast, allowUnconfirmed,
    }),
  sweep: ({ mnemonic, network, scriptType, toAddress, message, feeRate, index = 0, broadcast = false, allowUnconfirmed = network !== 'mainnet', passphrase = '' }) =>
    prepareSweep({ source: T(mnemonic), network, scriptType, toAddress: T(toAddress), message: message || null, feeRate: feeRate ? Number(feeRate) : undefined, index, broadcast, allowUnconfirmed, passphrase }),

  // air-gap PSBT flow (P2WPKH)
  buildUnsigned: ({ source, network, toAddress, amount, message, feeRate, index = 0, passphrase = '' }) =>
    prepareUnsigned({
      source: T(source), network, passphrase,
      recipients: (toAddress && Number(amount) > 0) ? [{ address: T(toAddress), amount: Number(amount) }] : [],
      message: message || null, feeRate: feeRate ? Number(feeRate) : undefined, index, allowUnconfirmed: true,
    }),
  signPsbt: ({ psbt, mnemonic, network, index = 0, passphrase = '' }) => signUnsigned({ psbt: T(psbt), mnemonic: T(mnemonic), network, index, passphrase }),
  // independent decode+verify of an untrusted PSBT (for the review-before-sign sheet)
  describePsbt: ({ psbt, source, network, passphrase = '' }) => describePsbt({ psbt: T(psbt), source: T(source), network, passphrase }),
  broadcastPsbt: ({ psbt, network }) => broadcastSigned({ psbt: T(psbt), network }),

  // encrypted on-device persistence (scrypt + XChaCha20-Poly1305; ciphertext only)
  vault: {
    exists: () => { try { return !!localStorage.getItem('olesia:vault'); } catch { return false; } },
    save: (mnemonic, pin, passphrase = '') => {
      localStorage.setItem('olesia:vault', sealSeed(JSON.stringify({ w: 2, m: T(mnemonic), p: String(passphrase || '') }), pin));
      // remember the PIN length (not the PIN) so unlock can auto-submit at the right
      // digit — only meaningful for all-numeric PINs; harmless for passphrase unlocks
      try { if (/^[0-9]+$/.test(String(pin))) localStorage.setItem('olesia:pinlen', String(String(pin).length)); else localStorage.removeItem('olesia:pinlen'); } catch {}
    },
    open: (pin) => {
      const raw = openSeed(localStorage.getItem('olesia:vault'), pin);
      try { const o = JSON.parse(raw); if (o && o.m) return { m: o.m, p: o.p || '' }; } catch {}
      return { m: raw, p: '' }; // vaults saved before passphrase support
    },
    forget: () => localStorage.removeItem('olesia:vault'),
  },

  // import an encrypted backup .json exported by the cold generator (offline.olesia.io)
  importBackup: ({ json, password }) => decryptColdBackup(json, password),

  // freeze-and-broadcast: decode a signed tx for display; broadcast EXACT bytes
  decodeTx: ({ hex, network }) => decodeRawTx({ hex: T(hex), network }),
  broadcastHex: ({ hex, network }) => broadcastRaw({ hex: T(hex), network }),

  // single private key (WIF): inspect every address format + sweep any funded one
  wifInspect: ({ wif, network }) => inspectWIF({ wif: T(wif), network }),
  wifSweep: ({ wif, network, scriptType, toAddress, message, broadcast = true }) =>
    sweepWIF({ wif: T(wif), network, scriptType, toAddress: T(toAddress), message: message || null, broadcast }),

  // P2PK lab: fund a P2PK from the seed's SegWit balance, track outpoints, spend them out
  fundP2PK: ({ source, network, amount, feeRate, broadcast = true, passphrase = '' }) =>
    fundP2PK({ source: T(source), network, amount: Number(amount), feeRate: feeRate ? Number(feeRate) : 2, broadcast, passphrase }),
  p2pkStatus: ({ network, outpoints }) => p2pkOutpoints({ network, outpoints }),
  p2pkImport: ({ source, network, txid, vout, passphrase = '' }) => importP2PK({ source: T(source), network, txid: T(txid), vout: Number(vout) || 0, passphrase }),
  spendP2PK: ({ source, network, outpoint, toAddress, message, feeRate, broadcast = true, passphrase = '' }) =>
    spendP2PK({ source: T(source), network, outpoint, toAddress: T(toAddress), message: message || null, feeRate: feeRate ? Number(feeRate) : 2, broadcast, passphrase }),
};
