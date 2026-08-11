// Single private key (WIF) support — for the educational "inspect & sweep" tool.
// A WIF is ONE key, not an HD wallet: it yields exactly one keypair, which maps
// to one address in every script format. We derive all of them, look up their
// balances, and can sweep any funded one. Same key-object shape as scripts.js so
// the existing tx builders sign it unchanged.
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { scriptHashOf, SCRIPT_TYPES } from './scripts.js';
import { net } from './networks.js';

// Decode a WIF -> { privKey, pubkey }. Throws on invalid or wrong-network WIF.
export function parseWIF(wif, network) {
  const n = net(network).btc;
  let priv;
  try { priv = btc.WIF(n).decode((wif || '').trim()); }
  catch { throw new Error(`not a valid WIF for ${network} (mainnet keys start K/L/5, testnet c/9)`); }
  return { privKey: priv, pubkey: secp256k1.getPublicKey(priv, true) };
}

function scriptFor(pub, network, type) {
  const n = net(network).btc;
  if (type === 'p2pkh') return btc.p2pkh(pub, n);
  if (type === 'p2wpkh') return btc.p2wpkh(pub, n);
  if (type === 'p2sh-p2wpkh') return btc.p2sh(btc.p2wpkh(pub, n), n);
  if (type === 'p2tr') return btc.p2tr(pub.slice(1), undefined, n);
  if (type === 'p2pk') return btc.p2pk(pub);
  throw new Error('unknown script type: ' + type);
}

// Key object for one WIF + script type — matches deriveScript's shape so
// buildSignedTx / buildSweepTx / buildSpendP2PK sign it with no changes.
export function wifKey(wif, network, type) {
  const { privKey, pubkey } = parseWIF(wif, network);
  const spend = scriptFor(pubkey, network, type);
  const t = SCRIPT_TYPES[type];
  return {
    type, privKey, pubkey, spend,
    address: spend.address || null,
    segwit: !!t.segwit,
    scriptHex: bytesToHex(spend.script),
    scripthash: scriptHashOf(spend.script),
  };
}

// All five addresses this single key produces, with lookup locators.
export function wifAddresses(wif, network) {
  return Object.keys(SCRIPT_TYPES).map((type) => {
    const k = wifKey(wif, network, type);
    return { type, label: SCRIPT_TYPES[type].label, address: k.address, scriptHex: k.scriptHex,
             scripthash: k.scripthash, segwit: k.segwit };
  });
}
