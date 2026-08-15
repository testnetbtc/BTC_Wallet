// OFFLINE signer — browser entry, exposes window.SIGN. AIR-GAPPED BY CONSTRUCTION: this bundle
// imports NOTHING that can touch the network (no esplora, no broadcast, no fetch). The build
// hardens the page to CSP connect-src 'none', so even a bug cannot phone home. It reuses the
// audited engine: BIP-39 generation/validation, account-xpub derivation, and the signer core
// (WYSIWYS review with an independently-computed fee + multi-path signing).
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { normalizeMnemonic, accountXpub } from '../src/wallet.js';
import { reviewPSBT, signPSBT } from './core.mjs';

window.SIGN = {
  // 24 words (256-bit) is the default; 12 words (128-bit) is an option.
  generate: (words = 24) => generateMnemonic(wordlist, words === 12 ? 128 : 256),
  validate: (m) => { try { return validateMnemonic(normalizeMnemonic(m || ''), wordlist); } catch { return false; } },
  // the account xpub — so the user can set up watch-only on the online wallet without the seed.
  xpub: (m, network, passphrase = '') => accountXpub(normalizeMnemonic(m || ''), passphrase || '', network),
  // WYSIWYS review of an unsigned PSBT — returns the breakdown + safety verdict; NEVER signs.
  review: ({ mnemonic, passphrase = '', network, psbt }) => reviewPSBT({ mnemonic, passphrase, network, psbtB64: (psbt || '').trim() }),
  // sign a reviewed PSBT -> { signedPsbtB64, txid, txHex } for the online wallet to broadcast.
  sign: ({ mnemonic, passphrase = '', network, psbt }) => signPSBT({ mnemonic, passphrase, network, psbtB64: (psbt || '').trim() }),
  networks: ['mainnet', 'testnet3', 'testnet4', 'signet'],
  offline: true,
};
