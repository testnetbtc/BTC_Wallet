// Derive a BIP-84 (native segwit, P2WPKH) signing key for send/receive.
// Same derivation as the offline Olesia generator: m/84'/coin'/0'/0/index.
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import * as btc from '@scure/btc-signer';
import { net } from './networks.js';

// Normalise a pasted mnemonic: lowercase (BIP-39 is all-lowercase; iOS often
// auto-capitalises), collapse any whitespace/newlines to single spaces, trim.
export function normalizeMnemonic(s) {
  return (s || '').normalize('NFKD').trim().toLowerCase().replace(/\s+/g, ' ');
}

const rootOf = (mnemonic, passphrase, networkName) =>
  HDKey.fromMasterSeed(mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase || ''), net(networkName).bip32);

// Account-level extended PUBLIC key (m/84'/coin'/0') — hand to a watch-only wallet
// so it sees balances / builds PSBTs WITHOUT the seed. Now serialises with the
// correct version bytes (tpub on test networks, xpub on mainnet).
export function accountXpub(mnemonic, passphrase, networkName) {
  const n = net(networkName);
  return rootOf(mnemonic, passphrase, networkName).derive(`m/84'/${n.coin}'/0'`).publicExtendedKey;
}

// Master key fingerprint (first 4 bytes of hash160 of the root pubkey), hex — the
// [fingerprint/…] prefix that makes an output descriptor unambiguous.
// Parse an account xpub/tpub robustly. @scure's fromExtendedKey defaults to
// mainnet version bytes and throws "Version mismatch" on a tpub, so we try the
// network's versions and both standards. Version bytes only affect (de)serial-
// isation — child derivation is identical once parsed — so accepting either
// prefix is safe and makes watch-only import network-tolerant.
const XVERS = [{ private: 0x0488ade4, public: 0x0488b21e }, { private: 0x04358394, public: 0x043587cf }];
export function parseExtendedKey(extKey, networkName) {
  const s = (extKey || '').trim();
  const tries = [net(networkName).bip32, ...XVERS];
  for (const v of tries) { try { return HDKey.fromExtendedKey(s, v); } catch { /* next */ } }
  throw new Error('not a recognised extended key (xpub/tpub)');
}

export function masterFingerprint(mnemonic, passphrase, networkName) {
  const fp = rootOf(mnemonic, passphrase, networkName).fingerprint; // uint32
  return (fp >>> 0).toString(16).padStart(8, '0');
}

// Derive a BIP-84 key at (chain, index). chain 0 = external/receive, 1 = internal/
// change. Default chain 0 preserves every existing single-address derivation.
export function deriveKey(mnemonic, passphrase, networkName, index = 0, chain = 0) {
  const n = net(networkName);
  const path = `m/84'/${n.coin}'/0'/${chain}/${index}`;
  const child = rootOf(mnemonic, passphrase, networkName).derive(path);
  if (!child.privateKey) throw new Error('no private key derived');
  const spend = btc.p2wpkh(child.publicKey, n.btc); // { script, address }
  return {
    networkName, index, chain,
    privKey: child.privateKey,   // 32 bytes
    pubkey: child.publicKey,     // 33 bytes compressed
    address: spend.address,      // tb1... / bc1...
    spend,                       // {script, address} used when adding inputs
    segwit: true,                // P2WPKH — spend needs only witnessUtxo
    type: 'p2wpkh',
    path,
  };
}
