// The mainnet wallet's account model: turn a secret (recovery phrase or single private key)
// into the set of scripts it controls, match the node's UTXO lookup against them, and build
// transactions from the coins that were found.
//
// Coins come from the operator's own node (nodeapi.js). The node's answers are UNTRUSTED:
//   · a returned coin is only accepted if its script is one this wallet derived itself;
//   · pre-SegWit inputs are only signed after their full previous transaction has been
//     fetched and hash-verified (the legacy sighash does not commit to the amount);
//   · every built transaction is decoded again from its final bytes and audited — recipient,
//     amount, change destination and fee — before it is shown or broadcast.
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { createBase58check } from '@scure/base';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';
import { net } from './networks.js';
import { normalizeMnemonic } from './wallet.js';
import { SCRIPT_TYPES } from './scripts.js';
import { buildSignedTxMulti, buildSweepTxMulti, assertAddressNetwork, assertFeeRate, assertRecipientAmount, opReturnScript, OP_RETURN_MAX, MAX_FEERATE } from './tx.js';
import { buildLegacyTx } from './legacy_sign.js';

const hash160 = (b) => ripemd160(sha256(b));
const b58check = createBase58check(sha256);

// Address types a recovery phrase is scanned for (BIP-84, 86, 49, 44), in display order.
export const HD_TYPES = ['p2wpkh', 'p2tr', 'p2sh-p2wpkh', 'p2pkh'];
// Address types the wallet OFFERS for receiving and change: native SegWit (bc1q…) or Legacy
// (1…). The other two are still scanned so an imported wallet's existing coins are found.
export const RECEIVE_TYPES = ['p2wpkh', 'p2pkh'];
export const TYPE_LABEL = { p2wpkh: 'Native SegWit', p2tr: 'Taproot', 'p2sh-p2wpkh': 'Nested SegWit', p2pkh: 'Legacy', p2pk: 'P2PK' };
export const DEFAULT_RANGE = 100;       // addresses scanned per chain, per type
export const COINBASE_MATURITY = 100;
export const MESSAGE_MAX_BYTES = OP_RETURN_MAX;   // 80: relayed and mined everywhere

function spendFor(type, pub, n) {
  if (type === 'p2pkh') return btc.p2pkh(pub, n);
  if (type === 'p2wpkh') return btc.p2wpkh(pub, n);
  if (type === 'p2sh-p2wpkh') return btc.p2sh(btc.p2wpkh(pub, n), n);
  if (type === 'p2tr') return btc.p2tr(pub.slice(1), undefined, n);
  throw new Error('unhandled script type ' + type);
}
// key object in the shape tx.js builders expect (same as scripts.js deriveScript / wif.js wifKey)
function stdKey(type, privKey, pub, n) {
  const spend = spendFor(type, pub, n);
  return { type, segwit: !!SCRIPT_TYPES[type].segwit, privKey, pubkey: pub, spend, address: spend.address, scriptHex: bytesToHex(spend.script) };
}
const fingerprintOf = (text) => { const h = bytesToHex(sha256(utf8ToBytes(text))).toUpperCase(); return h.slice(0, 4) + '-' + h.slice(4, 8); };
const walletIdOf = (scriptHex) => bytesToHex(sha256(utf8ToBytes('olesia/wallet-id/v1|' + scriptHex))).slice(0, 24);

// ---- recovery phrase (HD) account --------------------------------------------------------
export function openSeedAccount({ mnemonic, passphrase = '', network = 'mainnet' }) {
  const m = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(m, wordlist)) throw new Error('that is not a valid BIP-39 recovery phrase');
  const n = net(network);
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(m, passphrase || ''), n.bip32);
  const chainNodes = new Map(), cache = new Map();
  const chainNode = (type, chain) => {
    const k = `${type}/${chain}`;
    if (!chainNodes.has(k)) chainNodes.set(k, root.derive(`m/${SCRIPT_TYPES[type].purpose}'/${n.coin}'/0'/${chain}`));
    return chainNodes.get(k);
  };
  function entry(type, chain, index) {
    if (!HD_TYPES.includes(type)) throw new Error('unknown address type ' + type);
    if (chain !== 0 && chain !== 1) throw new Error('bad chain');
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error('bad address index');
    const k = `${type}/${chain}/${index}`;
    if (cache.has(k)) return cache.get(k);
    const child = chainNode(type, chain).deriveChild(index);
    if (!child.privateKey) throw new Error('no private key derived');
    const key = stdKey(type, child.privateKey, child.publicKey, n.btc);
    const e = { group: 'std', type, chain, index, path: `m/${SCRIPT_TYPES[type].purpose}'/${n.coin}'/0'/${chain}/${index}`,
                address: key.address, script: key.scriptHex, key };
    cache.set(k, e);
    return e;
  }
  const xpub84 = root.derive(`m/84'/${n.coin}'/0'`).publicExtendedKey;
  return {
    kind: 'seed', network, words: m.split(' ').length, hasPassphrase: !!passphrase,
    fingerprint: fingerprintOf(xpub84),                 // same definition as the previous wallet
    id: walletIdOf(entry('p2wpkh', 0, 0).script),
    entry,
    // every script to look up: all types × receive+change × [0, range)
    entries(range = DEFAULT_RANGE, otherRange = range) {
      const out = [];
      for (const type of HD_TYPES) for (const chain of [0, 1]) for (let i = 0; i < (RECEIVE_TYPES.includes(type) ? range : otherRange); i++) out.push(entry(type, chain, i));
      return out;
    },
    receiveTypes: () => RECEIVE_TYPES.slice(),
    changeEntry: (index, type = 'p2wpkh') => {
      if (!RECEIVE_TYPES.includes(type)) throw new Error('change must go to a SegWit or Legacy address');
      return entry(type, 1, index);
    },
  };
}

// ---- single private key (WIF) account ------------------------------------------------------
// Accepts compressed ("K…"/"L…") AND uncompressed ("5…") mainnet keys. An uncompressed key
// only ever controlled legacy outputs (its P2PKH address and bare P2PK), so only those are derived.
export function parseWifAny(wif, network = 'mainnet') {
  const n = net(network).btc;
  let raw;
  try { raw = b58check.decode(String(wif || '').trim()); } catch { throw new Error('that is not a valid private key (WIF) — check for a typo'); }
  if (raw[0] !== n.wif) throw new Error(`that private key is not a ${network} key`);
  let compressed;
  if (raw.length === 34 && raw[33] === 0x01) compressed = true;
  else if (raw.length === 33) compressed = false;
  else throw new Error('that is not a valid private key (WIF)');
  const privKey = raw.slice(1, 33);
  if (!secp256k1.utils.isValidPrivateKey(privKey)) throw new Error('that private key is out of range');
  return { privKey, compressed, pubkey: secp256k1.getPublicKey(privKey, compressed) };
}

export function openWifAccount({ wif, network = 'mainnet' }) {
  const n = net(network);
  const { privKey, compressed, pubkey } = parseWifAny(wif, network);
  const list = [];
  if (compressed) {
    for (const type of HD_TYPES) {
      const key = stdKey(type, privKey, pubkey, n.btc);
      list.push({ group: 'std', type, chain: 0, index: 0, path: 'single key', address: key.address, script: key.scriptHex, key });
    }
  } else {
    const pkh = hash160(pubkey);
    const script = concatBytes(hexToBytes('76a914'), pkh, hexToBytes('88ac'));
    list.push({ group: 'raw', type: 'p2pkh', rawKind: 'p2pkh', chain: 0, index: 0, path: 'single key (uncompressed)',
                address: btc.Address(n.btc).encode({ type: 'pkh', hash: pkh }), script: bytesToHex(script), key: { privKey, pubkey } });
  }
  // bare pay-to-pubkey for this key (no address) — spendable through the legacy signer
  const pk = concatBytes(Uint8Array.of(pubkey.length), pubkey, Uint8Array.of(0xac));
  list.push({ group: 'raw', type: 'p2pk', rawKind: 'p2pk', chain: 0, index: 0, path: 'single key (P2PK)', address: null, script: bytesToHex(pk), key: { privKey, pubkey } });
  const primary = list[0];
  return {
    kind: 'wif', network, compressed,
    fingerprint: fingerprintOf(primary.script),
    id: walletIdOf(primary.script),
    entry: (type) => { const e = list.find((x) => x.type === type); if (!e) throw new Error('this key has no ' + type + ' address'); return e; },
    entries: () => list.slice(),
    receiveTypes: () => (compressed ? RECEIVE_TYPES.slice() : ['p2pkh']),
    // a single key has nowhere else to send change: it returns to the key's own address
    changeEntry: (_index, type = 'p2wpkh') => (compressed ? list.find((x) => x.type === (RECEIVE_TYPES.includes(type) ? type : 'p2wpkh')) : primary),
  };
}

// ---- public description, watch-only account, and short-lived signer ---------------------------
// The open wallet keeps NO private key between actions. What stays in memory is a public
// description (account xpubs, or one public key) — enough to derive addresses and find coins —
// plus the encrypted wallet. A signer is rebuilt from the decrypted secret only for the moment
// a transaction is signed, and every key it hands out is checked against the public script
// it is supposed to control.
export function describeSeed({ mnemonic, passphrase = '', network = 'mainnet' }) {
  const m = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(m, wordlist)) throw new Error('that is not a valid BIP-39 recovery phrase');
  const n = net(network);
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(m, passphrase || ''), n.bip32);
  const xpubs = {};
  for (const type of HD_TYPES) xpubs[type] = root.derive(`m/${SCRIPT_TYPES[type].purpose}'/${n.coin}'/0'`).publicExtendedKey;
  const first = HDKey.fromExtendedKey(xpubs.p2wpkh, n.bip32).deriveChild(0).deriveChild(0).publicKey;
  return { v: 1, kind: 'seed', network, words: m.split(' ').length, hasPassphrase: !!passphrase,
           fingerprint: fingerprintOf(xpubs.p2wpkh), id: walletIdOf(bytesToHex(spendFor('p2wpkh', first, n.btc).script)), xpubs };
}
export function describeWif({ wif, network = 'mainnet' }) {
  const n = net(network);
  const { compressed, pubkey } = parseWifAny(wif, network);
  const primary = compressed ? bytesToHex(spendFor('p2wpkh', pubkey, n.btc).script) : bytesToHex(concatBytes(hexToBytes('76a914'), hash160(pubkey), hexToBytes('88ac')));
  return { v: 1, kind: 'wif', network, compressed, pubkey: bytesToHex(pubkey), fingerprint: fingerprintOf(primary), id: walletIdOf(primary) };
}
export const describeSecret = (secret, network = 'mainnet') =>
  (secret && secret.kind === 'wif' ? describeWif({ wif: secret.wif, network }) : describeSeed({ mnemonic: secret.mnemonic, passphrase: secret.passphrase || '', network }));

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export function openWatchAccount(pub) {
  if (!pub || pub.v !== 1 || (pub.kind !== 'seed' && pub.kind !== 'wif')) throw new Error('unknown wallet description');
  const n = net(pub.network);
  const base = { kind: pub.kind, network: pub.network, fingerprint: pub.fingerprint, id: pub.id, watchOnly: true };
  if (pub.kind === 'seed') {
    const chainNodes = new Map(), cache = new Map();
    const chainNode = (type, chain) => {
      const k = `${type}/${chain}`;
      if (!chainNodes.has(k)) chainNodes.set(k, HDKey.fromExtendedKey(pub.xpubs[type], n.bip32).deriveChild(chain));
      return chainNodes.get(k);
    };
    const entry = (type, chain, index) => {
      if (!HD_TYPES.includes(type)) throw new Error('unknown address type ' + type);
      if (chain !== 0 && chain !== 1) throw new Error('bad chain');
      if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error('bad address index');
      const k = `${type}/${chain}/${index}`;
      if (cache.has(k)) return cache.get(k);
      const spend = spendFor(type, chainNode(type, chain).deriveChild(index).publicKey, n.btc);
      const e = { group: 'std', type, chain, index, path: `m/${SCRIPT_TYPES[type].purpose}'/${n.coin}'/0'/${chain}/${index}`,
                  address: spend.address, script: bytesToHex(spend.script) };
      cache.set(k, e);
      return e;
    };
    const plan = (range, otherRange) => { const out = []; for (const type of HD_TYPES) for (const chain of [0, 1]) for (let i = 0; i < (RECEIVE_TYPES.includes(type) ? range : otherRange); i++) out.push([type, chain, i]); return out; };
    return { ...base, words: pub.words, hasPassphrase: !!pub.hasPassphrase, entry,
      entries: (range = DEFAULT_RANGE, otherRange = range) => plan(range, otherRange).map((a) => entry(...a)),
      // same as entries(), but yields to the browser between batches so the page stays responsive
      async entriesAsync(range = DEFAULT_RANGE, otherRange = range) {
        const out = []; let fresh = 0;
        for (const a of plan(range, otherRange)) { if (!cache.has(a.join('/')) && ++fresh % 48 === 0) await yieldToUi(); out.push(entry(...a)); }
        return out;
      },
      receiveTypes: () => RECEIVE_TYPES.slice(),
      changeEntry: (index, type = 'p2wpkh') => { if (!RECEIVE_TYPES.includes(type)) throw new Error('change must go to a SegWit or Legacy address'); return entry(type, 1, index); },
    };
  }
  const pubkey = hexToBytes(pub.pubkey);
  const compressed = pubkey.length === 33;
  if (compressed !== !!pub.compressed || (pubkey.length !== 33 && pubkey.length !== 65)) throw new Error('unknown wallet description');
  const list = [];
  if (compressed) for (const type of HD_TYPES) { const sp = spendFor(type, pubkey, n.btc); list.push({ group: 'std', type, chain: 0, index: 0, path: 'single key', address: sp.address, script: bytesToHex(sp.script) }); }
  else { const pkh = hash160(pubkey); list.push({ group: 'raw', type: 'p2pkh', rawKind: 'p2pkh', chain: 0, index: 0, path: 'single key (uncompressed)', address: btc.Address(n.btc).encode({ type: 'pkh', hash: pkh }), script: bytesToHex(concatBytes(hexToBytes('76a914'), pkh, hexToBytes('88ac'))) }); }
  list.push({ group: 'raw', type: 'p2pk', rawKind: 'p2pk', chain: 0, index: 0, path: 'single key (P2PK)', address: null, script: bytesToHex(concatBytes(Uint8Array.of(pubkey.length), pubkey, Uint8Array.of(0xac))) });
  return { ...base, compressed,
    entry: (type) => { const e = list.find((x) => x.type === type); if (!e) throw new Error('this key has no ' + type + ' address'); return e; },
    entries: () => list.slice(),
    receiveTypes: () => (compressed ? RECEIVE_TYPES.slice() : ['p2pkh']),
    changeEntry: (_index, type = 'p2wpkh') => (compressed ? list.find((x) => x.type === (RECEIVE_TYPES.includes(type) ? type : 'p2wpkh')) : list[0]),
  };
}

// A signer for ONE unlocked secret. It refuses a secret that is not the open wallet, and it
// refuses to hand out a key whose script differs from the public entry it was asked for.
export function makeSigner(secret, pub) {
  const mismatch = () => new Error('that secret does not belong to the open wallet — nothing was signed');
  if (!secret || !pub || secret.kind !== pub.kind) throw mismatch();
  const d = describeSecret(secret, pub.network);
  if (d.id !== pub.id || d.fingerprint !== pub.fingerprint) throw mismatch();
  const full = pub.kind === 'seed' ? openSeedAccount({ mnemonic: secret.mnemonic, passphrase: secret.passphrase || '', network: pub.network })
                                   : openWifAccount({ wif: secret.wif, network: pub.network });
  return {
    keyFor(entry) {
      const e = pub.kind === 'seed' ? full.entry(entry.type, entry.chain, entry.index) : full.entry(entry.type);
      if (e.script !== entry.script) throw new Error('derived key does not match the coin\'s script — refusing to sign');
      return e.key;
    },
  };
}

// ---- coins ------------------------------------------------------------------------------------
// Match a node scan result against the entries we asked about. Anything the node returns for
// a script we did not derive is ignored.
export function coinsFromScan(entries, scan) {
  const byScript = new Map(entries.map((e) => [e.script, e]));
  const coins = [];
  for (const u of scan.utxos || []) {
    const e = byScript.get(String(u.script || '').toLowerCase());
    if (!e) continue;
    if (!/^[0-9a-f]{64}$/.test(u.txid) || !Number.isInteger(u.vout) || u.vout < 0 || u.vout > 0xffffffff || !Number.isSafeInteger(u.value) || u.value <= 0) continue;
    if (coins.some((c) => c.txid === u.txid && c.vout === u.vout)) continue;   // a coin can only be listed once
    const confirmations = Number.isInteger(u.confirmations) ? u.confirmations : 0;
    const immature = !!u.coinbase && confirmations < COINBASE_MATURITY;
    coins.push({ txid: u.txid, vout: u.vout, value: u.value, height: u.height, confirmations, coinbase: !!u.coinbase,
                 spentInMempool: !!u.spentInMempool, immature, spendable: !u.spentInMempool && !immature && confirmations >= 1, entry: e });
  }
  return coins;
}
export const outpointOf = (c) => `${c.txid}:${c.vout}`;

// ---- previous-transaction verification (legacy inputs) ------------------------------------------
export function verifyPrevout(prevHex, coin) {
  let tx;
  try { tx = btc.Transaction.fromRaw(hexToBytes(prevHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true }); }
  catch { throw new Error('could not parse the previous transaction for a legacy coin'); }
  if (tx.id !== coin.txid) throw new Error('previous transaction does not match the coin (txid mismatch) — refusing to sign');
  if (coin.vout >= tx.outputsLength) throw new Error('previous transaction has no such output — refusing to sign');
  const out = tx.getOutput(coin.vout);
  if (bytesToHex(out.script) !== coin.entry.script) throw new Error('previous transaction output is not locked to this wallet — refusing to sign');
  if (out.amount !== BigInt(coin.value)) throw new Error('the coin amount reported by the node does not match the blockchain — refusing to sign');
  return true;
}

// ---- building ------------------------------------------------------------------------------------
// { account, coins (the coins to spend from — all one group), to, amount (sats) | sweep,
//   feeRate (sat/vB), changeEntry, fetchPrevTx(txid,height) -> hex,
//   message: optional short public note, written as one OP_RETURN output (<= 80 bytes UTF-8) }
export async function buildSpend({ account, coins, to, amount = null, sweep = false, feeRate, changeEntry, fetchPrevTx, message = null, signer = null }) {
  // keys come from the short-lived signer (normal case) or from a full account (tests)
  const keyOf = (c) => (signer ? signer.keyFor(c.entry) : c.entry.key);
  const network = account.network;
  const note = message == null || String(message) === '' ? null : String(message);
  const dataScript = note == null ? null : opReturnScript(note);   // throws if > 80 bytes
  feeRate = assertFeeRate(feeRate);
  const dest = assertAddressNetwork(to, network);
  if (!coins?.length) throw new Error('no spendable coins selected');
  if (coins.some((c) => !c.spendable)) throw new Error('a selected coin is not spendable yet');
  const group = coins[0].entry.group;
  if (coins.some((c) => c.entry.group !== group)) throw new Error('old-format (P2PK / uncompressed) coins must be spent separately from the others');
  if (!sweep) assertRecipientAmount(amount);
  const change = changeEntry || account.changeEntry(0);

  // legacy inputs: fetch + verify the full previous transaction before anything is signed
  const needsPrev = (c) => group === 'raw' || !SCRIPT_TYPES[c.entry.type].segwit;
  const prev = new Map();
  for (const c of coins) {
    if (!needsPrev(c)) continue;
    if (typeof fetchPrevTx !== 'function') throw new Error('legacy coins need their previous transaction to be signed safely');
    const hex = await fetchPrevTx(c.txid, c.height);
    verifyPrevout(hex, c);
    prev.set(outpointOf(c), hex);
  }

  let built;
  if (group === 'std') {
    const keyedUtxos = coins.map((c) => ({ txid: c.txid, vout: c.vout, value: c.value, key: keyOf(c), prevTxHex: prev.get(outpointOf(c)) }));
    built = sweep
      ? buildSweepTxMulti({ keyedUtxos, toAddress: dest, feeRate, networkName: network, message: note })
      : buildSignedTxMulti({ keyedUtxos, recipients: [{ address: dest, amount }], message: note, changeAddress: change.address, feeRate, networkName: network });
  } else {
    const destScript = btc.OutScript.encode(btc.Address(net(network).btc).decode(dest));
    const inputs = coins.map((c) => { const k = keyOf(c); return { txid: c.txid, vout: c.vout, value: c.value, script: hexToBytes(c.entry.script), kind: c.entry.rawKind, privKey: k.privKey, pubkey: k.pubkey }; });
    // change for an old-format key goes back to the first input's own script
    built = buildLegacyTx({ inputs, destScript, recipientAmount: sweep ? null : amount, changeScript: sweep ? null : hexToBytes(change.script), feeRate, dataScript });
  }
  const audit = auditBuiltTx({ hex: built.txHex, network, coins, to: dest, amount: sweep ? null : amount, changeScript: sweep ? null : change.script, message: note });
  if (audit.txid !== built.txid) throw new Error('internal error: transaction id mismatch after build — nothing was sent');
  return { txHex: built.txHex, txid: built.txid, vsize: built.vsize ?? audit.vsize, feeRate, sweep, group,
           fee: audit.fee, sent: audit.sent, change: audit.change, changeAddress: audit.change ? change.address : null,
           changeScript: audit.change ? change.script : null, changeVout: audit.changeVout,
           to: dest, inputs: audit.inputs, effectiveFeeRate: audit.fee / (built.vsize ?? audit.vsize),
           message: audit.message, messageBytes: audit.message == null ? 0 : utf8ToBytes(audit.message).length };
}

// Decode the FINAL signed bytes and check them against what the user asked for. This — not
// the form fields, and not the builder's own bookkeeping — is what the confirmation shows.
export function auditBuiltTx({ hex, network, coins, to, amount, changeScript, message = null }) {
  const n = net(network);
  const tx = btc.Transaction.fromRaw(hexToBytes(hex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const selected = new Map(coins.map((c) => [outpointOf(c), c]));
  let inSum = 0n; const inputs = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const op = `${bytesToHex(inp.txid)}:${inp.index}`;
    const c = selected.get(op);
    if (!c) throw new Error('built transaction spends a coin that was not selected — refusing');
    inSum += BigInt(c.value); inputs.push(op);
  }
  if (new Set(inputs).size !== inputs.length) throw new Error('built transaction spends the same coin twice — refusing');
  const destScript = bytesToHex(btc.OutScript.encode(btc.Address(n.btc).decode(to)));
  let outSum = 0n, sent = 0n, change = 0n, changeVout = null, destCount = 0, dataCount = 0;
  const sameScript = changeScript === destScript;   // paying your own change address
  // the ONLY data output allowed is the exact OP_RETURN the user asked for, carrying no value
  const expectData = message == null ? null : bytesToHex(opReturnScript(message));
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    const s = bytesToHex(o.script);
    outSum += o.amount;
    if (o.script[0] === 0x6a) {
      if (expectData == null) throw new Error('built transaction carries a data output that was not requested — refusing');
      if (s !== expectData) throw new Error('built transaction carries a different message than requested — refusing');
      if (o.amount !== 0n) throw new Error('built transaction puts value on a data output — refusing');
      dataCount++; continue;
    }
    const isDest = s === destScript && (!sameScript || (destCount === 0 && (amount == null || o.amount === BigInt(amount) || i === tx.outputsLength - 1)));
    if (isDest) { sent += o.amount; destCount++; }
    else if (changeScript && s === changeScript) { change += o.amount; changeVout = i; }
    else throw new Error('built transaction pays an unexpected destination — refusing');
  }
  if (destCount !== 1) throw new Error('built transaction does not pay the recipient exactly once — refusing');
  if (dataCount !== (expectData == null ? 0 : 1)) throw new Error('built transaction does not carry the requested message exactly once — refusing');
  if (amount != null && sent !== BigInt(amount)) throw new Error('built transaction pays a different amount than requested — refusing');
  const fee = inSum - outSum;
  if (fee <= 0n) throw new Error('built transaction has no fee — refusing');
  // defence in depth: whatever the builders and the UI did, never pass a transaction whose fee
  // exceeds the engine's hard rate cap (plus one dust output that may have been folded in)
  if (fee > BigInt(MAX_FEERATE) * BigInt(tx.vsize) + 546n) throw new Error('built transaction pays an absurd fee — refusing');
  return { txid: tx.id, vsize: tx.vsize, fee: Number(fee), sent: Number(sent), change: Number(change), changeVout, inputs, inTotal: Number(inSum), message: expectData == null ? null : message };
}
