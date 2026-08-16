// Connect-bridge browser entry (app.olesia.io). Exposes window.OLESIA_CONNECT: unlock the
// same-origin vault the wallet already stores, then serve the two hand-off methods over the
// audited engine. NETWORK-LESS by construction — nothing here fetches or broadcasts; the seed
// never leaves this origin, and the only output is a signed PSBT handed back to the opener.
import { openSeed } from '../src/vault.js';
import { getAccount, review, sign, CONNECT_NETWORKS } from './core.mjs';

window.OLESIA_CONNECT = {
  networks: [...CONNECT_NETWORKS],
  hasVault() { try { return !!localStorage.getItem('olesia:vault'); } catch { return false; } },
  // Unlock the on-device vault (scrypt + XChaCha20-Poly1305) with the user's PIN/passphrase.
  unlock(pin) {
    const raw = openSeed(localStorage.getItem('olesia:vault'), pin);
    try { const o = JSON.parse(raw); if (o && o.m) return { mnemonic: o.m, passphrase: o.p || '' }; } catch { /* legacy plain */ }
    return { mnemonic: raw, passphrase: '' };
  },
  getAccount, review, sign,
};
