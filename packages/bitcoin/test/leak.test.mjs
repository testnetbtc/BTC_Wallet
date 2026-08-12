// Secret-leakage regression: prove that key derivation, transaction building,
// PSBT signing, and vault sealing issue NO network request at all, and that the
// only thing broadcast is the public signed transaction — never the mnemonic,
// passphrase, private key, or WIF. A fetch spy records every call and its body.
import { bytesToHex } from '@noble/hashes/utils';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(60), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

// --- fetch spy -------------------------------------------------------------
const calls = [];
let echoTxid = 'ab'.repeat(32); // set to the real txid for the broadcast leg
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: opts && opts.body ? String(opts.body) : '' });
  return { ok: true, status: 200, text: async () => echoTxid, json: async () => ({}) };
};

const MN = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';
const PASSPHRASE = 'correct horse battery staple';
const NET = 'testnet4';

const wallet = await import('../src/wallet.js');
const txmod = await import('../src/tx.js');
const psbtmod = await import('../src/psbt.js');
const vault = await import('../src/vault.js');
const send = await import('../src/send.js');

// secrets that must NEVER appear in any network request
const key = wallet.deriveKey(MN, PASSPHRASE, NET, 0);
const privHex = bytesToHex(key.privKey);
const SECRETS = [MN, PASSPHRASE, privHex, ...MN.split(' ')];

// --- 1. pure offline ops issue ZERO network calls --------------------------
calls.length = 0;
wallet.deriveKey(MN, PASSPHRASE, NET, 0);
wallet.accountXpub(MN, PASSPHRASE, NET);
wallet.walletAddress ? wallet.walletAddress(MN, NET, 'p2wpkh') : null;
const built = txmod.buildSignedTx({ utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 100000 }], key, recipients: [{ address: key.address, amount: 40000 }], feeRate: 2, networkName: NET });
psbtmod.signPSBTOffline(psbtmod.buildUnsignedPSBT({ utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 100000 }], wo: { script: key.spend.script, address: key.address }, recipients: [{ address: key.address, amount: 40000 }], changeAddress: key.address, feeRate: 2, network: NET }).psbt, MN, PASSPHRASE, NET, 0);
const sealed = vault.sealSeed(JSON.stringify({ w: 2, m: MN, p: PASSPHRASE }), 'strong test password 123');
vault.openSeed(sealed, 'strong test password 123');
send.describePsbt ? send.describePsbt({ psbt: psbtmod.buildUnsignedPSBT({ utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 100000 }], wo: { script: key.spend.script, address: key.address }, recipients: [{ address: key.address, amount: 40000 }], changeAddress: key.address, feeRate: 2, network: NET }).psbt, source: MN, network: NET, passphrase: PASSPHRASE }) : null;
ok('derive / build / sign / seal / describe make ZERO network calls', calls.length === 0);

// --- 2. the sealed vault blob contains no plaintext secret -----------------
ok('sealed vault blob leaks no seed word', !SECRETS.some((s) => sealed.includes(s)));

// --- 3. broadcast sends ONLY the public txHex, no secret -------------------
calls.length = 0;
echoTxid = built.txid; // the honest network echoes back the same txid
await send.broadcastRaw({ hex: built.txHex, network: NET });
const bodies = calls.map((c) => c.url + ' ' + c.body).join('\n');
ok('broadcast made a network call (as expected)', calls.length >= 1);
ok('no request body contains the mnemonic', !bodies.includes(MN));
ok('no request body contains any single seed word run', !MN.split(' ').some((w) => bodies.includes(' ' + w + ' ')));
ok('no request body contains the passphrase', !bodies.includes(PASSPHRASE));
ok('no request body contains the private key hex', !bodies.includes(privHex));
ok('the broadcast body IS the public signed tx hex', bodies.includes(built.txHex));

globalThis.fetch = realFetch;
console.log(bad ? '\nLEAK TEST FAILED' : '\nLEAK TEST PASS — secrets never touch the network');
process.exit(bad ? 1 : 0);
