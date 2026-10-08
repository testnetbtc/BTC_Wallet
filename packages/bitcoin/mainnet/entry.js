// Browser entry for the Olesia MAINNET wallet (the opening page of olesia.io). Exposes
// window.OM. Mainnet only — there is no network switch in this build.
//
// An OPEN wallet holds no private key and no recovery phrase: it keeps a public description
// (to show addresses and find coins) and the wallet in ENCRYPTED form. Signing a payment or
// showing the recovery words asks for the password, decrypts, uses the secret and lets it go.
// The only network endpoint is the operator's own node API.
import { validateMnemonic, entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import QRCode from 'qrcode';
import { createMnemonic, rngHealth, normalizeDice, DICE_BITS_PER_ROLL, DICE_ONLY_MIN_ROLLS } from '../src/entropy.js';
import { sealWallet, openWallet, parseWalletFile, passwordPolicy, generatePassword, FORMAT } from '../src/walletfile.js';
import { decryptColdBackup } from '../src/coldbackup.js';
import { openSeedAccount, openWifAccount, openWatchAccount, describeSeed, describeSecret, makeSigner, parseWifAny, TYPE_LABEL, MESSAGE_MAX_BYTES } from '../src/account.js';
import { normalizeMnemonic } from '../src/wallet.js';
import { assertAddressNetwork, MAX_FEERATE } from '../src/tx.js';
import { makeNodeApi, DEFAULT_API } from '../src/nodeapi.js';
import { Session, MAINNET_WINDOW, TEST_WINDOW } from '../src/session.js';
import { NETWORKS } from '../src/networks.js';
import { lockWallet, LockedWallet } from '../src/locked.js';
import { analyzePattern as vanityAnalyze, estimate as vanityEstimate, humanTime, TYPES as VANITY_TYPES, MAX_PATTERN as VANITY_MAX } from '../src/vanity.js';

const NETWORK = 'mainnet';
const API_BASE = (typeof __OLESIA_API__ === 'string' && __OLESIA_API__) || DEFAULT_API;
const api = makeNodeApi({ base: API_BASE });
// Practice networks: the SAME recovery phrase on a separate derivation path (different keys),
// with worthless coins. Their chain data is public data relayed by the Olesia server.
const PRACTICE = ['testnet4', 'signet', 'testnet3'];
const NET_INFO = {
  mainnet:  { label: 'Bitcoin',   long: 'Bitcoin mainnet', unit: 'BTC',  test: false, hint: 'bc1…, 3… or 1…' },
  testnet4: { label: 'Testnet 4', long: 'Testnet 4',       unit: 'tBTC', test: true,  hint: 'tb1…, 2…, m… or n…' },
  signet:   { label: 'Signet',    long: 'Signet',          unit: 'sBTC', test: true,  hint: 'tb1…, 2…, m… or n…' },
  testnet3: { label: 'Testnet 3', long: 'Testnet 3',       unit: 'tBTC', test: true,  hint: 'tb1…, 2…, m… or n…' },
};
const apis = { mainnet: api };
for (const n of PRACTICE) apis[n] = makeNodeApi({ base: API_BASE, network: n });
// where the faucet's own page lives (a separate origin: it runs a third-party human check)
const FAUCET_URL = (typeof __OLESIA_FAUCET__ === 'string' && __OLESIA_FAUCET__) || 'https://app.olesia.io/faucet/';
const safeStore = (() => { try { const s = window.localStorage; s.getItem('x'); return s; } catch { return undefined; } })();

// Known-answer self-check, run on every page load BEFORE any wallet can be made or opened.
// If the bundled crypto does not reproduce the published BIP-39/44/49/84/86 vectors, the page
// refuses to create or open wallets.
function selfCheck() {
  const out = [];
  const t = (name, fn) => { let ok = false; try { ok = !!fn(); } catch { ok = false; } out.push({ name, ok }); };
  const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  t('BIP-39 128-bit vector', () => entropyToMnemonic(new Uint8Array(16), wordlist) === M);
  t('BIP-39 256-bit vector', () => entropyToMnemonic(new Uint8Array(32).fill(0x7f), wordlist) ===
    'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title');
  let a; t('seed opens', () => { a = openSeedAccount({ mnemonic: M, network: NETWORK }); return true; });
  t('BIP-84 address', () => a.entry('p2wpkh', 0, 0).address === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  t('BIP-84 change address', () => a.entry('p2wpkh', 1, 0).address === 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
  t('BIP-86 address', () => a.entry('p2tr', 0, 0).address === 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
  t('BIP-49 address', () => a.entry('p2sh-p2wpkh', 0, 0).address === '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');
  t('BIP-44 address', () => a.entry('p2pkh', 0, 0).address === '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  t('WIF (compressed)', () => openWifAccount({ wif: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn' }).entry('p2pkh').address === '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH');
  t('WIF (uncompressed)', () => openWifAccount({ wif: '5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf' }).entry('p2pkh').address === '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm');
  // the watch-only (public-key) derivation the open wallet uses must agree with the private one
  let pub, w;
  t('watch-only derivation', () => { pub = describeSeed({ mnemonic: M, network: NETWORK }); w = openWatchAccount(pub);
    return w.entry('p2wpkh', 0, 7).script === a.entry('p2wpkh', 0, 7).script && w.entry('p2pkh', 1, 3).script === a.entry('p2pkh', 1, 3).script && w.entry('p2tr', 0, 0).address === a.entry('p2tr', 0, 0).address; });
  t('signer binds key to script', () => makeSigner({ kind: 'seed', mnemonic: M, passphrase: '' }, pub).keyFor(w.entry('p2wpkh', 1, 0)).address === 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
  return { ok: out.every((r) => r.ok), results: out };
}

function diagnose(text) {
  const words = normalizeMnemonic(text).split(' ').filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length)) return `that is ${words.length} word${words.length === 1 ? '' : 's'} — a recovery phrase has 12, 15, 18, 21 or 24. Check for a missing or extra word.`;
  const badAt = []; words.forEach((w, i) => { if (!wordlist.includes(w)) badAt.push(i + 1); });
  if (badAt.length) return `word${badAt.length > 1 ? 's' : ''} #${badAt.join(', #')} ${badAt.length > 1 ? 'are' : 'is'} not in the BIP-39 word list — check the spelling.`;
  return 'every word is valid, but the checksum fails — a word is wrong or out of order.';
}

// "Open wallet file" accepts the .dat format and the older cold-generator .json backups.
async function openFile(text, password, onProgress) {
  let probe = null; try { probe = JSON.parse(text); } catch { /* handled below */ }
  if (probe && (probe.format === 'olesia-backup' || probe.format === 'alea-backup')) {
    const r = decryptColdBackup(probe, password);
    return { legacy: { network: String(probe.network || ''), addressHash: typeof probe.addressHash === 'string' ? probe.addressHash : null,
                       address: typeof probe.address === 'string' ? probe.address : null, authenticated: !!r.metadataAuthenticated },
             payload: { kind: 'seed', mnemonic: r.mnemonic, passphrase: null, passphraseUsed: !!r.passphraseUsed, fingerprint: null } };
  }
  const o = await openWallet(text, password, { onProgress });
  if (o.network !== NETWORK) throw new Error(`this wallet file is for ${o.network}, not mainnet`);
  return { legacy: null, payload: o.payload, createdAt: o.createdAt };
}

// An old backup file has no fingerprint, but it does record (a hash of) the wallet's first
// address as it was when the backup was made — WITH the passphrase applied. Re-deriving that
// address lets a wrong passphrase be rejected instead of silently opening a different wallet.
function legacyPassphraseCheck({ mnemonic, passphrase, legacy }) {
  if (!legacy || (!legacy.addressHash && !legacy.address)) return 'unknown';
  const netName = legacy.network === 'mainnet' ? 'mainnet' : 'testnet4';   // every test network derives identically
  const addr = openSeedAccount({ mnemonic, passphrase: passphrase || '', network: netName }).entry('p2wpkh', 0, 0).address;
  if (legacy.addressHash) return bytesToHex(sha256(utf8ToBytes(addr))) === legacy.addressHash ? 'ok' : 'mismatch';
  return addr === legacy.address ? 'ok' : 'mismatch';
}

function describeFile(text) {
  let probe = null; try { probe = JSON.parse(text); } catch { throw new Error('that is not an Olesia wallet file'); }
  if (probe && (probe.format === 'olesia-backup' || probe.format === 'alea-backup')) return { kind: 'legacy-backup', network: String(probe.network || '?'), createdAt: String(probe.createdAt || '') };
  const o = parseWalletFile(text);
  return { kind: FORMAT, network: o.network, createdAt: o.createdAt };
}

// An open wallet as the UI sees it. `session` is watch-only; anything that needs a key takes
// the password and goes through the locked wallet.
function openLocked({ pubs, vaultText, scriptType = null }) {
  const networks = ['mainnet', ...PRACTICE].filter((n) => pubs[n]);
  const sessions = {};
  // one watch-only session per network, created the first time that network is opened
  const session = (network = NETWORK) => {
    if (!pubs[network]) throw new Error('this wallet has no ' + network + ' wallet');
    if (!sessions[network]) sessions[network] = new Session({
      account: openWatchAccount(pubs[network]), api: apis[network], store: safeStore,
      scriptType: network === NETWORK ? scriptType : null, explorer: NETWORKS[network].explorer,
      window: network === NETWORK ? MAINNET_WINDOW : TEST_WINDOW });
    return sessions[network];
  };
  const lockedFor = (network) => new LockedWallet({ pub: pubs[network], vaultText });
  return {
    networks, session,
    opened: (network) => !!sessions[network],
    prepare: (network, args, password, onProgress) => lockedFor(network).withSigner(password, (signer) => session(network).prepare({ ...args, signer }), { onProgress }),
    reveal: async (password, onProgress) => {
      const { secret } = await lockedFor(NETWORK).unlock(password, { onProgress });
      return secret.kind === 'wif' ? { kind: 'wif', wif: secret.wif } : { kind: 'seed', mnemonic: normalizeMnemonic(secret.mnemonic), hasPassphrase: !!secret.passphrase };
    },
  };
}

// ---- vanity addresses: the search runs in Web Workers built from code bundled into this page ----
const VANITY_WORKER = typeof __OLESIA_VANITY_WORKER__ === 'string' ? __OLESIA_VANITY_WORKER__ : '';
const VANITY_SCRIPT = typeof __OLESIA_VANITY_SCRIPT__ === 'object' ? __OLESIA_VANITY_SCRIPT__ : null;
let vanityWorkerUrl = null;
function vanityWorker() {
  if (!VANITY_WORKER) throw new Error('vanity worker not bundled');
  if (!vanityWorkerUrl) vanityWorkerUrl = URL.createObjectURL(new Blob([VANITY_WORKER], { type: 'text/javascript' }));
  return new Worker(vanityWorkerUrl);
}
const vanity = {
  types: VANITY_TYPES, maxChars: VANITY_MAX, script: VANITY_SCRIPT, humanTime,
  threads: Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4) - 1)),
  /** validity, exact difficulty, notes, suggestions — plain data for the UI (no BigInt) */
  analyze: ({ type, text, ignoreCase }) => {
    const a = vanityAnalyze({ type, text, ignoreCase });
    return { ok: a.ok, type: a.type, display: a.display, text: a.text, ignoreCase: !!a.ignoreCase, errors: a.errors || [], notes: a.notes || [],
             suggestions: (a.suggestions || []).map((s) => ({ text: s.text, why: s.why, difficulty: s.difficulty, ignoreCase: !!s.ignoreCase })),
             difficulty: a.difficulty || null, difficultyHuman: a.difficultyHuman || null };
  },
  estimate: (difficulty, keysPerSecond) => vanityEstimate(difficulty, keysPerSecond),
  /** keys/s for one thread on this device, measured in a worker so the page stays responsive */
  benchmark: () => new Promise((resolve, reject) => {
    const w = vanityWorker();
    w.onmessage = (e) => { w.terminate(); if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.rate); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker failed')); };
    w.postMessage({ cmd: 'bench', ms: 1200 });
  }),
  /** start a search on `threads` workers; onProgress(keysTriedTotal); resolves {wif, address, type, tried} */
  start: ({ type, text, ignoreCase, threads, onProgress }) => {
    const n = Math.max(1, threads || vanity.threads);
    const workers = []; let tried = 0; let done = false;
    const stopAll = () => { for (const w of workers) w.terminate(); };
    const promise = new Promise((resolve, reject) => {
      for (let i = 0; i < n; i++) {
        const w = vanityWorker();
        w.onmessage = (e) => {
          const m = e.data;
          if (m.progress) { tried += m.progress; if (onProgress) onProgress(tried); }
          if (m.error && !done) { done = true; stopAll(); reject(new Error(m.error)); }
          if (m.found && !done) { done = true; tried += m.tried || 0; stopAll(); resolve({ ...m.found, tried }); }
        };
        w.onerror = (e) => { if (!done) { done = true; stopAll(); reject(new Error(e.message || 'worker failed')); } };
        w.postMessage({ cmd: 'start', type, text, ignoreCase: !!ignoreCase });
        workers.push(w);
      }
    });
    return { promise, stop: () => { if (!done) { done = true; stopAll(); } }, get tried() { return tried; } };
  },
};

window.OM = {
  vanity,
  network: NETWORK, apiBase: API_BASE, typeLabel: TYPE_LABEL, maxFeeRate: MAX_FEERATE,
  netInfo: NET_INFO, practiceNetworks: PRACTICE, faucetUrl: FAUCET_URL,
  messageMax: MESSAGE_MAX_BYTES, messageBytes: (t) => new TextEncoder().encode(String(t || '')).length,
  selfCheck, rngHealth: () => rngHealth(),

  // creation
  create: ({ words, mouse, dice, diceOnly }) => createMnemonic({ words, mouse, dice, diceOnly }),
  dice: (text) => {
    try { const d = normalizeDice(text); return { ok: true, rolls: d.length, bits: d.length * DICE_BITS_PER_ROLL, need: DICE_ONLY_MIN_ROLLS }; }
    catch (e) { return { ok: false, error: e.message, rolls: 0, bits: 0, need: DICE_ONLY_MIN_ROLLS }; }
  },
  randomIndices: (count, below) => {            // unbiased, for the backup quiz
    const out = new Set(); const buf = new Uint32Array(1); const lim = Math.floor(0x100000000 / below) * below;
    while (out.size < Math.min(count, below)) { crypto.getRandomValues(buf); if (buf[0] < lim) out.add(buf[0] % below); }
    return [...out].sort((a, b) => a - b);
  },

  // import
  validPhrase: (m) => { try { return validateMnemonic(normalizeMnemonic(m), wordlist); } catch { return false; } },
  diagnose,
  wifInfo: (wif) => { const k = parseWifAny(wif, NETWORK); return { compressed: k.compressed }; },
  describe: (secret) => { const d = describeSecret(secret, NETWORK); return { kind: d.kind, fingerprint: d.fingerprint, words: d.words || null, hasPassphrase: !!d.hasPassphrase, compressed: d.kind === 'wif' ? d.compressed : null }; },

  // wallet file
  passwordPolicy, generatePassword: () => generatePassword(6),
  seal: (payload, password, onProgress) => sealWallet(payload, password, { network: NETWORK, onProgress }),
  openFile, describeFile, legacyPassphraseCheck,

  // locking + opening
  lock: (args, onProgress) => lockWallet({ ...args, network: NETWORK, practiceNetworks: PRACTICE, onProgress }),
  open: openLocked,

  // node
  status: () => api.status(), fees: (network = NETWORK) => apis[network].fees(), price: () => api.price(),
  checkAddress: (a, network = NETWORK) => { try { assertAddressNetwork(a, network); return true; } catch { return false; } },

  qr: async (text) => 'data:image/svg+xml;base64,' + btoa(await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#0e1116', light: '#eef2f6' } })),
};
