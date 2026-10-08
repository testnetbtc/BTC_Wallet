// Account model: derivation vectors (BIP-44/49/84/86), agreement with the existing audited
// derivation path, WIF parsing (compressed + uncompressed), scan-result filtering, previous-
// transaction verification, and the post-build transaction audit.
import * as btc from '@scure/btc-signer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { openSeedAccount, openWifAccount, parseWifAny, coinsFromScan, verifyPrevout, auditBuiltTx, buildSpend, HD_TYPES,
         describeSeed, describeWif, openWatchAccount, makeSigner } from '../src/account.js';
import { lockWallet, LockedWallet } from '../src/locked.js';
import { sealWallet, generatePassword } from '../src/walletfile.js';
import { deriveScript } from '../src/scripts.js';
import { wifAddresses } from '../src/wif.js';
import { buildLegacyTx } from '../src/legacy_sign.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(76), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re ? re.test(e.message) : true; } };

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const acct = openSeedAccount({ mnemonic: SEED });

// --- published test vectors (mainnet, "abandon … about") ---
ok('BIP-84 m/84h/0h/0h/0/0', acct.entry('p2wpkh', 0, 0).address === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
ok('BIP-84 m/84h/0h/0h/0/1', acct.entry('p2wpkh', 0, 1).address === 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
ok('BIP-84 change m/84h/0h/0h/1/0', acct.entry('p2wpkh', 1, 0).address === 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
ok('BIP-86 m/86h/0h/0h/0/0', acct.entry('p2tr', 0, 0).address === 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
ok('BIP-86 m/86h/0h/0h/0/1', acct.entry('p2tr', 0, 1).address === 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh');
ok('BIP-86 change m/86h/0h/0h/1/0', acct.entry('p2tr', 1, 0).address === 'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7');
ok('BIP-49 m/49h/0h/0h/0/0', acct.entry('p2sh-p2wpkh', 0, 0).address === '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');
ok('BIP-44 m/44h/0h/0h/0/0', acct.entry('p2pkh', 0, 0).address === '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');

// --- agreement with the pre-existing derivation (scripts.js), every type, both chains ---
let agree = true;
for (const type of HD_TYPES) for (const chain of [0, 1]) for (const index of [0, 1, 7, 99]) {
  const a = acct.entry(type, chain, index), b = deriveScript(SEED, 'mainnet', type, index, '', chain);
  if (a.address !== b.address || a.script !== b.scriptHex || bytesToHex(a.key.privKey) !== bytesToHex(b.privKey) || a.path !== b.path) agree = false;
}
ok('fast derivation == scripts.js deriveScript (address, script, key, path)', agree);
ok('entries(100) = 4 types × 2 chains × 100 = 800 unique scripts', new Set(acct.entries(100).map((e) => e.script)).size === 800);
ok('change always lands on the BIP-84 change chain', acct.changeEntry(5).path === "m/84'/0'/0'/1/5");

// --- passphrase (25th word) gives a different wallet + fingerprint ---
const acctP = openSeedAccount({ mnemonic: SEED, passphrase: 'TREZOR' });
ok('passphrase changes addresses and fingerprint', acctP.entry('p2wpkh', 0, 0).address !== acct.entry('p2wpkh', 0, 0).address && acctP.fingerprint !== acct.fingerprint);
ok('fingerprint is stable and well-formed', acct.fingerprint === openSeedAccount({ mnemonic: SEED }).fingerprint && /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(acct.fingerprint));
ok('pasted phrase is normalised (case, whitespace)', openSeedAccount({ mnemonic: '  ' + SEED.toUpperCase().replace(/ /g, '\n ') }).fingerprint === acct.fingerprint);
ok('bad checksum rejected', throws(() => openSeedAccount({ mnemonic: SEED.replace('about', 'abandon') }), /not a valid BIP-39/));
ok('12, 15, 18, 21, 24-word phrases are all accepted', [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon address',
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon agent',
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon admit',
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
].every((m) => { try { return openSeedAccount({ mnemonic: m }).words === m.split(' ').length; } catch { return false; } }));

// --- WIF: private key = 1, both encodings ---
const WIF_C = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn', WIF_U = '5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf';
const wc = openWifAccount({ wif: WIF_C }), wu = openWifAccount({ wif: WIF_U });
ok('compressed WIF -> P2PKH 1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', wc.entry('p2pkh').address === '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH');
ok('compressed WIF -> P2WPKH bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', wc.entry('p2wpkh').address === 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
ok('compressed WIF addresses == wif.js (existing path)', wifAddresses(WIF_C, 'mainnet').filter((r) => r.type !== 'p2pk').every((r) => wc.entry(r.type).address === r.address));
ok('compressed WIF exposes 4 address types + bare P2PK', wc.entries().length === 5 && wc.entry('p2pk').script === '210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac');
ok('UNCOMPRESSED WIF -> P2PKH 1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm', wu.compressed === false && wu.entry('p2pkh').address === '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm');
ok('uncompressed WIF derives NO SegWit addresses (they would be unspendable)', wu.entries().length === 2 && throws(() => wu.entry('p2wpkh'), /no p2wpkh/));
ok('uncompressed P2PK script uses the 65-byte key', wu.entry('p2pk').script.startsWith('4104') && wu.entry('p2pk').script.length === 134);
ok('testnet WIF rejected on mainnet', throws(() => parseWifAny('cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA'), /not a mainnet key/));
ok('typo in WIF rejected (checksum)', throws(() => parseWifAny(WIF_C.slice(0, -1) + 'o'), /not a valid private key/));
ok('garbage rejected', throws(() => parseWifAny('hello world'), /not a valid private key/));

// --- BIP-39 passphrase normalisation (audit I3): composed and decomposed forms are the same wallet ---
ok('passphrase is NFKD-normalised: "é" (U+00E9) == "e" + U+0301', openSeedAccount({ mnemonic: SEED, passphrase: 'café' }).fingerprint === openSeedAccount({ mnemonic: SEED, passphrase: 'café' }).fingerprint);

// --- watch-only account (public keys only) + short-lived signer ---
const pub = describeSeed({ mnemonic: SEED });
const watch = openWatchAccount(pub);
ok('public description carries no secret (4 account xpubs, ids, counts)', Object.keys(pub.xpubs).length === 4 && Object.values(pub.xpubs).every((x) => x.startsWith('xpub')) && !JSON.stringify(pub).includes('abandon') && !JSON.stringify(pub).includes('xprv'));
ok('watch account has the same id + fingerprint as the full account', pub.id === acct.id && pub.fingerprint === acct.fingerprint && watch.watchOnly === true);
let watchAgree = true;
for (const type of HD_TYPES) for (const chain of [0, 1]) for (const index of [0, 1, 7, 99, 250]) {
  const a = acct.entry(type, chain, index), b = watch.entry(type, chain, index);
  if (a.address !== b.address || a.script !== b.script || a.path !== b.path || b.key !== undefined) watchAgree = false;
}
ok('watch-only derivation == private derivation for every type/chain (and exposes no key)', watchAgree);
ok('watch entries(200, 100) = 2×2×200 + 2×2×100 = 1200 scripts', watch.entries(200, 100).length === 1200 && new Set(watch.entries(200, 100).map((e) => e.script)).size === 1200);
ok('entriesAsync gives the same list', (await watch.entriesAsync(50, 20)).map((e) => e.script).join() === watch.entries(50, 20).map((e) => e.script).join());
const signer = makeSigner({ kind: 'seed', mnemonic: SEED, passphrase: '' }, pub);
ok('signer returns the private key for a watch entry', bytesToHex(signer.keyFor(watch.entry('p2tr', 1, 5)).privKey) === bytesToHex(acct.entry('p2tr', 1, 5).key.privKey));
ok('signer REFUSES a different seed', throws(() => makeSigner({ kind: 'seed', mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', passphrase: '' }, pub), /does not belong/));
ok('signer REFUSES the right seed with a wrong passphrase', throws(() => makeSigner({ kind: 'seed', mnemonic: SEED, passphrase: 'x' }, pub), /does not belong/));
ok('signer REFUSES an entry whose script was tampered with', throws(() => signer.keyFor({ ...watch.entry('p2wpkh', 0, 0), script: watch.entry('p2wpkh', 0, 1).script }), /does not match/));
const wpub = describeWif({ wif: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn' }), upub = describeWif({ wif: '5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf' });
ok('WIF watch accounts match the full ones (compressed + uncompressed)', openWatchAccount(wpub).entries().map((e) => e.script).join() === openWifAccount({ wif: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn' }).entries().map((e) => e.script).join()
  && openWatchAccount(upub).entries().map((e) => e.script).join() === openWifAccount({ wif: '5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf' }).entries().map((e) => e.script).join() && !JSON.stringify(wpub).includes('KwDiBf'));
ok('a WIF signer refuses a different key', throws(() => makeSigner({ kind: 'wif', wif: 'L5oLkpV3aqBjhki6LmvChTCV6odsp4SXM6FfU2Gppt5kFLaHLuZ9' }, wpub), /does not belong/));

// --- scan results are untrusted: foreign scripts and malformed rows are dropped ---
const e0 = acct.entry('p2wpkh', 0, 0), e1 = acct.entry('p2pkh', 0, 0);
const T = 'aa'.repeat(32);
const coins = coinsFromScan(acct.entries(5), { utxos: [
  { txid: T, vout: 0, script: e0.script, value: 50000, height: 100, confirmations: 6 },
  { txid: T, vout: 1, script: '0014' + '00'.repeat(20), value: 99999999, height: 100, confirmations: 6 },   // not ours
  { txid: 'zz', vout: 2, script: e0.script, value: 1, height: 1, confirmations: 1 },                          // bad txid
  { txid: T, vout: 3, script: e0.script, value: 1.5, height: 1, confirmations: 1 },                           // non-integer
  { txid: T, vout: 4, script: e0.script.toUpperCase(), value: 700, height: 100, confirmations: 3, spentInMempool: true },
  { txid: T, vout: 5, script: e0.script, value: 800, height: 100, confirmations: 10, coinbase: true },
  { txid: T, vout: 6, script: e1.script, value: 900, height: 100, confirmations: 0 },
] });
ok('only coins on derived scripts with sane fields are kept', coins.length === 4 && coins.every((c) => c.entry));
ok('negative / oversized vout and duplicate outpoints are dropped (audit L2)', coinsFromScan(acct.entries(5), { utxos: [
  { txid: T, vout: -1, script: e0.script, value: 5, height: 1, confirmations: 1 }, { txid: T, vout: 2 ** 32, script: e0.script, value: 5, height: 1, confirmations: 1 },
  { txid: T, vout: 9, script: e0.script, value: 5, height: 1, confirmations: 1 }, { txid: T, vout: 9, script: e0.script, value: 500000, height: 1, confirmations: 1 } ] }).length === 1);
ok('mempool-spent coin is not spendable', coins.find((c) => c.vout === 4).spendable === false);
ok('immature coinbase is not spendable', coins.find((c) => c.vout === 5).immature && !coins.find((c) => c.vout === 5).spendable);
ok('unconfirmed coin is not spendable', coins.find((c) => c.vout === 6).spendable === false);

// --- end-to-end build on fake coins (SegWit path needs no node) + audit ---
const DEST = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const mk = (entry, vout, value) => coinsFromScan([entry], { utxos: [{ txid: T, vout, script: entry.script, value, height: 100, confirmations: 6 }] })[0];
const cA = mk(acct.entry('p2wpkh', 0, 0), 0, 60000), cB = mk(acct.entry('p2tr', 0, 2), 1, 40000), cC = mk(acct.entry('p2sh-p2wpkh', 1, 3), 2, 30000);
const sent = await buildSpend({ account: acct, coins: [cA, cB, cC], to: DEST, amount: 70000, feeRate: 5, changeEntry: acct.changeEntry(4) });
ok('mixed SegWit/Taproot/nested inputs build + sign', /^[0-9a-f]{64}$/.test(sent.txid) && sent.sent === 70000);
ok('change goes to the requested BIP-84 change address', sent.changeAddress === acct.changeEntry(4).address && sent.change > 0);
ok('audited fee == inputs − outputs and matches the rate', sent.fee === sent.inputs.reduce((a, op) => a + [cA, cB, cC].find((c) => `${c.txid}:${c.vout}` === op).value, 0) - sent.sent - sent.change && Math.abs(sent.effectiveFeeRate - 5) < 1.5);
const sw = await buildSpend({ account: acct, coins: [cA, cB], to: DEST, sweep: true, feeRate: 3 });
ok('sweep spends every selected coin, no change', sw.inputs.length === 2 && sw.change === 0 && sw.sent + sw.fee === 100000);
ok('send below dust refused', await rejects(buildSpend({ account: acct, coins: [cA], to: DEST, amount: 100, feeRate: 2 }), /minimum/));
ok('float amount refused', await rejects(buildSpend({ account: acct, coins: [cA], to: DEST, amount: 1000.5, feeRate: 2 }), /integer/));
ok('testnet destination refused', await rejects(buildSpend({ account: acct, coins: [cA], to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', amount: 1000, feeRate: 2 }), /not a valid mainnet address/));
ok('insufficient funds refused', await rejects(buildSpend({ account: acct, coins: [cA], to: DEST, amount: 60000, feeRate: 2 }), /insufficient|selection failed/));
ok('absurd fee rate refused', await rejects(buildSpend({ account: acct, coins: [cA], to: DEST, amount: 1000, feeRate: 9999 }), /hard cap/));
ok('unspendable (mempool-spent) coin refused', await rejects(buildSpend({ account: acct, coins: [coins.find((c) => c.vout === 4)], to: DEST, amount: 600, feeRate: 1 }), /not spendable/));
ok('legacy coin without a previous-tx source refused', await rejects(buildSpend({ account: acct, coins: [mk(acct.entry('p2pkh', 0, 0), 0, 50000)], to: DEST, amount: 1000, feeRate: 2 }), /previous transaction/));

// --- the audit catches a transaction that differs from what was asked ---
const auditArgs = { hex: sent.txHex, network: 'mainnet', coins: [cA, cB, cC], to: DEST, amount: 70000, changeScript: acct.changeEntry(4).script };
ok('audit accepts the honest transaction', auditBuiltTx(auditArgs).fee === sent.fee);
ok('audit rejects a different requested amount', throws(() => auditBuiltTx({ ...auditArgs, amount: 70001 }), /different amount/));
ok('audit rejects an unexpected change destination', throws(() => auditBuiltTx({ ...auditArgs, changeScript: acct.changeEntry(5).script }), /unexpected destination/));
ok('audit rejects a different recipient', throws(() => auditBuiltTx({ ...auditArgs, to: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' }), /unexpected destination|exactly once/));
ok('audit rejects inputs outside the selected set', throws(() => auditBuiltTx({ ...auditArgs, coins: [cA] }), /not selected/));
// audit I1: an absurd fee is refused by the audit itself, whatever the builders or the UI did
{
  const burn = new btc.Transaction({ allowUnknownOutputs: true });
  burn.addInput({ txid: hexToBytes(T), index: 0, witnessUtxo: { script: cA.entry.key.spend.script, amount: 60000n }, ...cA.entry.key.spend, sequence: 0xfffffffd });
  burn.addOutputAddress(DEST, 1000n, btc.NETWORK);
  burn.sign(cA.entry.key.privKey); burn.finalize();
  const big = { ...cA, value: 60000000 };
  const hexBurn = bytesToHex(burn.extract());
  ok('audit accepts a normal-fee hand-built transaction', auditBuiltTx({ hex: hexBurn, network: 'mainnet', coins: [cA], to: DEST, amount: 1000, changeScript: null }).fee === 59000);
  ok('audit REJECTS a transaction burning an absurd fee', throws(() => auditBuiltTx({ hex: hexBurn, network: 'mainnet', coins: [big], to: DEST, amount: 1000, changeScript: null }), /absurd fee/));
}

// --- optional OP_RETURN message ---
const NOTE = 'Olesia — hello, chain ✓';
const withNote = await buildSpend({ account: acct, coins: [cA, cB], to: DEST, amount: 30000, feeRate: 5, changeEntry: acct.changeEntry(4), message: NOTE });
const noteTx = btc.Transaction.fromRaw(hexToBytes(withNote.txHex), { allowUnknownOutputs: true });
const noteOuts = Array.from({ length: noteTx.outputsLength }, (_, i) => noteTx.getOutput(i));
const dataOut = noteOuts.find((o) => o.script[0] === 0x6a);
ok('message becomes exactly one zero-value OP_RETURN output with the UTF-8 bytes', noteOuts.filter((o) => o.script[0] === 0x6a).length === 1 && dataOut.amount === 0n && new TextDecoder().decode(dataOut.script.slice(2)) === NOTE);
ok('build reports the message and its byte length', withNote.message === NOTE && withNote.messageBytes === new TextEncoder().encode(NOTE).length && withNote.sent === 30000 && withNote.change > 0);
ok('a send with no message has no data output', !Array.from({ length: 3 }, (_, i) => i).some((i) => { try { return btc.Transaction.fromRaw(hexToBytes(sent.txHex), { allowUnknownOutputs: true }).getOutput(i).script[0] === 0x6a; } catch { return false; } }) && sent.message === null);
ok('empty-string message is treated as no message (no empty OP_RETURN)', (await buildSpend({ account: acct, coins: [cA], to: DEST, amount: 30000, feeRate: 5, message: '' })).message === null);
ok('80-byte message accepted', (await buildSpend({ account: acct, coins: [cA], to: DEST, amount: 30000, feeRate: 5, message: 'x'.repeat(80) })).messageBytes === 80);
ok('81-byte message refused', await rejects(buildSpend({ account: acct, coins: [cA], to: DEST, amount: 30000, feeRate: 5, message: 'x'.repeat(81) }), /81 bytes/));
ok('multi-byte characters are counted in BYTES (27 × "€" = 81 bytes refused)', await rejects(buildSpend({ account: acct, coins: [cA], to: DEST, amount: 30000, feeRate: 5, message: '€'.repeat(27) }), /81 bytes/));
const sweepNote = await buildSpend({ account: acct, coins: [cA, cB], to: acct.entry('p2wpkh', 0, 0).address, sweep: true, feeRate: 3, message: 'note to self' });
ok('message-only (sweep to your own address) works: one payment output + one data output', sweepNote.message === 'note to self' && sweepNote.sent + sweepNote.fee === 100000 && sweepNote.change === 0);
const nArgs = { hex: withNote.txHex, network: 'mainnet', coins: [cA, cB], to: DEST, amount: 30000, changeScript: acct.changeEntry(4).script };
ok('audit accepts the transaction with the requested message', auditBuiltTx({ ...nArgs, message: NOTE }).message === NOTE);
ok('audit REJECTS a data output nobody asked for', throws(() => auditBuiltTx({ ...nArgs, message: null }), /not requested/));
ok('audit REJECTS a different message than requested', throws(() => auditBuiltTx({ ...nArgs, message: NOTE + '!' }), /different message/));
ok('audit REJECTS a missing message', throws(() => auditBuiltTx({ ...auditArgs, message: 'expected but absent' }), /exactly once/));

// --- spending through the watch account + signer (the path the page uses) ---
const wA = coinsFromScan(watch.entries(10), { utxos: [{ txid: T, vout: 0, script: watch.entry('p2wpkh', 0, 0).script, value: 60000, height: 100, confirmations: 6 }] })[0];
const viaSigner = await buildSpend({ account: watch, coins: [wA], to: DEST, amount: 20000, feeRate: 5, changeEntry: watch.changeEntry(4), signer });
const viaFull = await buildSpend({ account: acct, coins: [cA], to: DEST, amount: 20000, feeRate: 5, changeEntry: acct.changeEntry(4) });
ok('watch account + signer produce the identical transaction to the full account', viaSigner.txid === viaFull.txid && viaSigner.txHex === viaFull.txHex);
ok('a watch-only coin cannot be spent without a signer', await rejects(buildSpend({ account: watch, coins: [wA], to: DEST, amount: 20000, feeRate: 5 }), /./));

// --- the locked wallet: encrypted in memory, password needed for every signature ---
const PW = generatePassword(6).password;
const filePayload = { kind: 'seed', mnemonic: SEED, passphrase: '', passphraseUsed: false, fingerprint: pub.fingerprint, scriptType: 'p2wpkh' };
const fileText = await sealWallet(filePayload, PW);
const lk = await lockWallet({ secret: { kind: 'seed', mnemonic: SEED, passphrase: '' }, password: PW, fileText, filePayload });
ok('no passphrase: the wallet file itself is the in-memory vault (no second ciphertext)', lk.vaultText === fileText && lk.pub.id === pub.id);
ok('the vault and the public description contain no plaintext secret', !lk.vaultText.includes('abandon') && !JSON.stringify(lk.pub).includes('abandon'));
const locked = new LockedWallet(lk);
ok('wrong password cannot unlock', await rejects(locked.unlock(PW + 'x'), /wrong password/));
const viaLocked = await locked.withSigner(PW, (sg) => buildSpend({ account: watch, coins: [wA], to: DEST, amount: 20000, feeRate: 5, changeEntry: watch.changeEntry(4), signer: sg }));
ok('right password signs — same transaction again', viaLocked.txid === viaFull.txid);
const ppSecret = { kind: 'seed', mnemonic: SEED, passphrase: 'TREZOR' };
const ppPayload = { kind: 'seed', mnemonic: SEED, passphrase: null, passphraseUsed: true, fingerprint: describeSeed(ppSecret).fingerprint, scriptType: 'p2wpkh' };
const ppFile = await sealWallet(ppPayload, PW);
const ppLk = await lockWallet({ secret: ppSecret, password: PW, fileText: ppFile, filePayload: ppPayload });
ok('passphrase not stored in the file: a separate in-memory vault is made, also encrypted', ppLk.vaultText !== ppFile && !ppLk.vaultText.includes('TREZOR') && !ppLk.vaultText.includes('abandon'));
ok('…and it unlocks to the passphrase wallet, not the plain one', (await new LockedWallet(ppLk).unlock(PW)).secret.passphrase === 'TREZOR' && ppLk.pub.fingerprint !== pub.fingerprint);
ok('a vault swapped in from another wallet is refused', await rejects(new LockedWallet({ pub, vaultText: ppLk.vaultText }).unlock(PW), /does not belong/));

// --- previous-transaction verification for legacy coins ---
const legacyEntry = acct.entry('p2pkh', 0, 0);
const prevTx = new btc.Transaction({ allowUnknownOutputs: true });
prevTx.addInput({ txid: hexToBytes('11'.repeat(32)), index: 0, witnessUtxo: { script: acct.entry('p2wpkh', 0, 9).key.spend.script, amount: 100000n }, ...acct.entry('p2wpkh', 0, 9).key.spend });
prevTx.addOutputAddress(legacyEntry.address, 90000n, btc.NETWORK);
prevTx.sign(acct.entry('p2wpkh', 0, 9).key.privKey); prevTx.finalize();
const prevHex = bytesToHex(prevTx.extract());
const lc = coinsFromScan([legacyEntry], { utxos: [{ txid: prevTx.id, vout: 0, script: legacyEntry.script, value: 90000, height: 100, confirmations: 6 }] })[0];
ok('verifyPrevout accepts the genuine previous transaction', verifyPrevout(prevHex, lc) === true);
ok('verifyPrevout rejects a wrong txid', throws(() => verifyPrevout(prevHex, { ...lc, txid: T }), /txid mismatch/));
ok('verifyPrevout rejects an inflated amount (fee-burn attack)', throws(() => verifyPrevout(prevHex, { ...lc, value: 900000 }), /does not match the blockchain/));
ok('verifyPrevout rejects an understated amount (fee-burn attack)', throws(() => verifyPrevout(prevHex, { ...lc, value: 9000 }), /does not match the blockchain/));
ok('verifyPrevout rejects a missing output index', throws(() => verifyPrevout(prevHex, { ...lc, vout: 5 }), /no such output/));
const legacySend = await buildSpend({ account: acct, coins: [lc, cA], to: DEST, amount: 100000, feeRate: 4, fetchPrevTx: async () => prevHex });
ok('legacy + SegWit inputs build once the previous tx is verified', legacySend.sent === 100000 && legacySend.inputs.length === 2);
ok('a lying node amount for a legacy coin aborts the build', await rejects(buildSpend({ account: acct, coins: [{ ...lc, value: 50000 }], to: DEST, sweep: true, feeRate: 4, fetchPrevTx: async () => prevHex }), /does not match the blockchain/));

// --- old-format (uncompressed / P2PK) group: built by the hand-rolled legacy signer ---
const ue = wu.entry('p2pkh');
const uPrev = new btc.Transaction({ allowUnknownOutputs: true });
uPrev.addInput({ txid: hexToBytes('22'.repeat(32)), index: 1, witnessUtxo: { script: acct.entry('p2wpkh', 0, 9).key.spend.script, amount: 200000n }, ...acct.entry('p2wpkh', 0, 9).key.spend });
uPrev.addOutput({ script: hexToBytes(ue.script), amount: 150000n });
uPrev.sign(acct.entry('p2wpkh', 0, 9).key.privKey); uPrev.finalize();
const uCoin = coinsFromScan(wu.entries(), { utxos: [{ txid: uPrev.id, vout: 0, script: ue.script, value: 150000, height: 100, confirmations: 6 }] })[0];
const uSweep = await buildSpend({ account: wu, coins: [uCoin], to: DEST, sweep: true, feeRate: 10, fetchPrevTx: async () => bytesToHex(uPrev.extract()) });
ok('uncompressed-key P2PKH sweep builds (legacy signer)', uSweep.group === 'raw' && uSweep.sent + uSweep.fee === 150000 && uSweep.change === 0);
const uSend = await buildSpend({ account: wu, coins: [uCoin], to: DEST, amount: 50000, feeRate: 10, fetchPrevTx: async () => bytesToHex(uPrev.extract()) });
ok('uncompressed-key send returns change to the same key', uSend.sent === 50000 && uSend.changeAddress === ue.address && uSend.change === 150000 - 50000 - uSend.fee);
ok('legacy fee is at least the requested rate (worst-case signature size)', uSweep.fee / uSweep.vsize >= 10 && uSweep.fee / uSweep.vsize < 10.3);
const uNote = await buildSpend({ account: wu, coins: [uCoin], to: DEST, amount: 50000, feeRate: 10, message: 'paper wallet says hi', fetchPrevTx: async () => bytesToHex(uPrev.extract()) });
ok('old-format (uncompressed key) send can carry a message too', uNote.message === 'paper wallet says hi' && uNote.sent === 50000 && uNote.change === 150000 - 50000 - uNote.fee);
ok('mixing old-format and standard coins in one spend is refused', await rejects(buildSpend({ account: wu, coins: [uCoin, cA], to: DEST, sweep: true, feeRate: 2, fetchPrevTx: async () => prevHex }), /spent separately/));
ok('legacy builder refuses a sweep that would leave dust', throws(() => buildLegacyTx({ inputs: [{ txid: T, vout: 0, value: 700, script: hexToBytes(ue.script), kind: 'p2pkh', privKey: ue.key.privKey, pubkey: ue.key.pubkey }], destScript: hexToBytes('0014' + '00'.repeat(20)), feeRate: 2 }), /too small/));

console.log(bad ? '\nACCOUNT TESTS FAILED' : '\naccount: all checks passed');
process.exit(bad ? 1 : 0);
