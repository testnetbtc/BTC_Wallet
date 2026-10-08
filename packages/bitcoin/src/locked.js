// The LOCKED form of an open wallet.
//
// While a wallet is open the page holds two things: a public description (to show addresses
// and find coins) and the wallet ENCRYPTED — the same scrypt + XChaCha20-Poly1305 ciphertext
// as the .dat file. No recovery phrase, private key or password is kept between actions.
// Every action that needs a key (signing a payment, showing the recovery words) asks for the
// password, decrypts, uses the secret, and lets it go.
//
// Honest limit: JavaScript cannot erase memory on demand. After use the secret is unreferenced
// and will be reclaimed by the browser, but this module cannot prove when. What it does
// guarantee is that an unattended open wallet cannot sign or reveal anything without the password.
import { sealWallet, openWallet } from './walletfile.js';
import { describeSecret, makeSigner } from './account.js';

const secretOf = (payload) => (payload.kind === 'wif'
  ? { kind: 'wif', wif: payload.wif }
  : { kind: 'seed', mnemonic: payload.mnemonic, passphrase: typeof payload.passphrase === 'string' ? payload.passphrase : '' });

// Build the locked form from a secret the caller holds right now (at create / open / import).
//   fileText + filePayload: the wallet file as written to disk. If that file alone is enough
//   to sign (no BIP-39 passphrase, or the passphrase is stored inside it) it is reused as the
//   in-memory vault. Otherwise a second ciphertext is made, under the same password, that also
//   contains the passphrase — it exists only in memory and is never offered for download.
// `practiceNetworks`: for a recovery-phrase wallet, also describe the SAME words on these test
// networks (separate derivation path, so different keys). Public data only — done here because
// this is the one moment the secret is available.
export async function lockWallet({ secret, password, network = 'mainnet', fileText = null, filePayload = null, scriptType = 'p2wpkh', practiceNetworks = [], onProgress }) {
  const pub = describeSecret(secret, network);
  const pubs = { [network]: pub };
  if (secret.kind === 'seed') for (const tn of practiceNetworks) pubs[tn] = describeSecret(secret, tn);
  const fileIsEnough = !!fileText && !!filePayload && (secret.kind === 'wif' || !secret.passphrase || filePayload.passphrase === secret.passphrase);
  let vaultText = fileText;
  if (!fileIsEnough) {
    const payload = secret.kind === 'wif' ? { kind: 'wif', wif: secret.wif, scriptType }
      : { kind: 'seed', mnemonic: secret.mnemonic, passphrase: secret.passphrase || '', passphraseUsed: !!secret.passphrase, fingerprint: pub.fingerprint, scriptType };
    vaultText = await sealWallet(payload, password, { network, onProgress, enforcePolicy: false });
  }
  return { pub, pubs, vaultText };
}

export class LockedWallet {
  constructor({ pub, vaultText }) {
    if (!pub || typeof vaultText !== 'string' || !vaultText) throw new Error('nothing to lock');
    this.pub = pub; this.vaultText = vaultText;
  }
  // Decrypt with the password and prove the result is THIS wallet. Returns the secret and a signer.
  async unlock(password, { onProgress } = {}) {
    const { payload } = await openWallet(this.vaultText, password, { onProgress });
    const secret = secretOf(payload);
    return { secret, signer: makeSigner(secret, this.pub) };
  }
  // Run fn with a signer; the secret never leaves this call.
  async withSigner(password, fn, opts) {
    const { signer } = await this.unlock(password, opts);
    return fn(signer);
  }
}
