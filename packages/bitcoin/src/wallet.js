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

// Account-level extended PUBLIC key (m/84'/coin'/0') — this is what you hand to a
// watch-only online wallet so it can see balances and build PSBTs WITHOUT the seed.
export function accountXpub(mnemonic, passphrase, networkName) {
  const n = net(networkName);
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase || '');
  return HDKey.fromMasterSeed(seed).derive(`m/84'/${n.coin}'/0'`).publicExtendedKey;
}

export function deriveKey(mnemonic, passphrase, networkName, index = 0) {
  const n = net(networkName);
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase || '');
  const child = HDKey.fromMasterSeed(seed).derive(`m/84'/${n.coin}'/0'/0/${index}`);
  if (!child.privateKey) throw new Error('no private key derived');
  const spend = btc.p2wpkh(child.publicKey, n.btc); // { script, address }
  return {
    networkName,
    index,
    privKey: child.privateKey,   // 32 bytes
    pubkey: child.publicKey,     // 33 bytes compressed
    address: spend.address,      // tb1... / bc1...
    spend,                       // {script, address} used when adding inputs
    segwit: true,                // P2WPKH — spend needs only witnessUtxo
    type: 'p2wpkh',
    path: `m/84'/${n.coin}'/0'/0/${index}`,
  };
}
