// "Every script type" — the educational heart of Olesia. Derive a key at each
// type's standard BIP path and produce its address (or, for P2PK, its raw script),
// with a plain-English explainer. Built on @scure/btc-signer.
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import * as btc from '@scure/btc-signer';
import { net } from './networks.js';
import { normalizeMnemonic } from './wallet.js';

// purpose = BIP-44/49/84/86 account path. segwit = spend needs only witnessUtxo;
// legacy types need the full previous tx (nonWitnessUtxo) to spend.
export const SCRIPT_TYPES = {
  p2pk:        { label: 'P2PK — Pay to Public Key',        purpose: 44, segwit: false, noAddress: true,
    about: "Satoshi's original script: pay straight to a public key (⟨pubkey⟩ OP_CHECKSIG). It has NO address — the output IS the key. This is how the genesis block and the earliest coins are held. Because the public key sits on-chain in the clear, it's the classic example in the quantum-resistance discussion." },
  p2pkh:       { label: 'P2PKH — Pay to Public Key Hash',  purpose: 44, segwit: false,
    about: 'The classic "1…" (mainnet) / "m/n…" (testnet) address. Locks coins to the HASH of a public key (OP_DUP OP_HASH160 … OP_EQUALVERIFY OP_CHECKSIG), so the key only appears when you spend. The standard for years before SegWit.' },
  'p2sh-p2wpkh': { label: 'P2SH-P2WPKH — wrapped SegWit',  purpose: 49, segwit: true,
    about: 'SegWit wrapped inside a "3…" / "2…" P2SH address, for compatibility with old wallets that never learned bech32. Cheaper than legacy, works everywhere.' },
  p2wpkh:      { label: 'P2WPKH — native SegWit',          purpose: 84, segwit: true,
    about: 'Native SegWit ("bc1q…" / "tb1q…"). Smaller, cheaper fees, and the default here. The witness (signature) is moved outside the transaction body.' },
  p2tr:        { label: 'P2TR — Taproot',                  purpose: 86, segwit: true, taproot: true,
    about: 'Taproot ("bc1p…" / "tb1p…"), the newest type. Schnorr signatures, better privacy (a complex spend can look like a simple one), and cheaper multisig.' },
};

export function scriptTypeList() { return Object.keys(SCRIPT_TYPES); }

// electrum-style scripthash for esplora lookups: reverse(sha256(scriptPubKey)) hex.
// This is how we look up balances for P2PK, which has no address.
export function scriptHashOf(scriptBytes) { return bytesToHex(sha256(scriptBytes).slice().reverse()); }

export function deriveScript(mnemonic, network, type, index = 0, passphrase = '', chain = 0) {
  const n = net(network);
  const t = SCRIPT_TYPES[type];
  if (!t) throw new Error('unknown script type: ' + type);
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase || '');
  const path = `m/${t.purpose}'/${n.coin}'/0'/${chain}/${index}`;
  const child = HDKey.fromMasterSeed(seed, n.bip32).derive(path);
  if (!child.privateKey) throw new Error('no private key derived');
  const pub = child.publicKey; // 33-byte compressed

  let spend;
  if (type === 'p2pkh')        spend = btc.p2pkh(pub, n.btc);
  else if (type === 'p2wpkh')  spend = btc.p2wpkh(pub, n.btc);
  else if (type === 'p2sh-p2wpkh') spend = btc.p2sh(btc.p2wpkh(pub, n.btc), n.btc);
  else if (type === 'p2tr')    spend = btc.p2tr(pub.slice(1), undefined, n.btc); // x-only internal key
  else if (type === 'p2pk')    spend = btc.p2pk(pub); // no address
  else throw new Error('unhandled type ' + type);

  return {
    type, label: t.label, about: t.about, segwit: !!t.segwit, path, index, chain,
    privKey: child.privateKey, pubkey: pub, spend,
    address: spend.address || null,           // null for P2PK
    scriptHex: bytesToHex(spend.script),
    scripthash: scriptHashOf(spend.script),   // for address-less lookups
  };
}
