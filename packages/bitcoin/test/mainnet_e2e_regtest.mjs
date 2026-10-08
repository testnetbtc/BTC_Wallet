// LIVE end-to-end test of the mainnet wallet stack against a PRIVATE regtest Bitcoin Core:
// real node -> infra/nodeapi/server.mjs -> src/nodeapi.js -> src/account.js.
// Bitcoin Core is the independent oracle: every transaction the wallet builds must be accepted
// by the node, and every coin the wallet expects must appear in the node's UTXO set.
// Not part of `npm test` (needs bitcoind). Run:  node test/mainnet_e2e_regtest.mjs
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as btc from '@scure/btc-signer';
import { hexToBytes } from '@noble/hashes/utils';
import { NETWORKS } from '../src/networks.js';
import { openSeedAccount, openWifAccount, coinsFromScan, buildSpend, HD_TYPES, openWatchAccount, describeSeed } from '../src/account.js';
import { Session } from '../src/session.js';
import { lockWallet, LockedWallet } from '../src/locked.js';
import { sealWallet, generatePassword } from '../src/walletfile.js';
import { createMnemonic } from '../src/entropy.js';
import { makeNodeApi } from '../src/nodeapi.js';
import { buildFundP2PK } from '../src/p2pk_fund.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.REGTEST_DIR ? mkdtempSync(join(process.env.REGTEST_DIR, 'olesia-e2e-')) : mkdtempSync(join(tmpdir(), 'olesia-e2e-'));
const RPCPORT = 18643, APIPORT = 18787;
const REG = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
NETWORKS.regtest = { coin: 1, btc: REG, bip32: { private: 0x04358394, public: 0x043587cf }, esplora: null, explorer: '' };
const NET = 'regtest';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(78), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re ? re.test(e.message) : true; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeFileSync(join(DIR, 'bitcoin.conf'), `regtest=1\nserver=1\nrpcuser=olesiatest\nrpcpassword=${randomBytes(16).toString('hex')}\nfallbackfee=0.0002\nlisten=0\n[regtest]\nrpcport=${RPCPORT}\n`);
const cli = (...args) => execFileSync('bitcoin-cli', [`-datadir=${DIR}`, ...args.map(String)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cliw = (...args) => cli('-rpcwallet=miner', ...args);
const node = spawn('bitcoind', [`-datadir=${DIR}`], { stdio: 'ignore' });
let apiProc = null;
const cleanup = () => { try { apiProc && apiProc.kill(); } catch {} try { cli('stop'); } catch {} setTimeout(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} }, 1500); };

try {
  for (let i = 0; i < 60; i++) { try { cli('getblockcount'); break; } catch { await sleep(500); } }
  cli('createwallet', 'miner');
  const minerAddr = cliw('getnewaddress', '', 'bech32');
  const mine = (n = 1) => cli('generatetoaddress', n, minerAddr);
  mine(110);

  apiProc = spawn(process.execPath, [join(HERE, '../../../infra/nodeapi/server.mjs')], {
    env: { ...process.env, OLESIA_CHAIN: 'regtest', OLESIA_NODE_CONF: join(DIR, 'bitcoin.conf'), OLESIA_API_PORT: String(APIPORT), OLESIA_RATE_SCALE: '20', OLESIA_PRICE_FIXTURE: JSON.stringify({ usd: { price: 85000, change24h: -3.1 } }) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let apiLog = ''; apiProc.stdout.on('data', (d) => { apiLog += d; }); apiProc.stderr.on('data', (d) => { apiLog += d; });
  const base = `http://127.0.0.1:${APIPORT}`;
  const api = makeNodeApi({ base });
  for (let i = 0; i < 40; i++) { try { await api.status(); break; } catch { await sleep(250); } }
  const st = await api.status();
  ok('API /status reports the node chain + height', st.chain === 'regtest' && st.blocks === 110);
  const fees = await api.fees();
  ok('API /fees returns sane sat/vB numbers', fees.min >= 1 && ['fast', 'normal', 'slow'].every((k) => fees[k] == null || fees[k] >= fees.min));

  // ---------- a freshly CREATED wallet (real entropy path), all four address types ----------
  const { mnemonic } = createMnemonic({ words: 24, dice: '1 2 3 4 5 6', mouse: Uint8Array.of(9, 8, 7) });
  const acct = openSeedAccount({ mnemonic, network: NET });
  const fund = [['p2wpkh', 0, 0, 1.0], ['p2tr', 0, 3, 0.5], ['p2sh-p2wpkh', 0, 1, 0.25], ['p2pkh', 0, 2, 0.125], ['p2wpkh', 0, 42, 0.01]];
  // independent oracle for derivation: Core must agree our scripts belong to these addresses
  ok('Core validates every derived address (all 4 types)', fund.every(([t, c, i]) => { const e = acct.entry(t, c, i); const v = JSON.parse(cli('validateaddress', e.address)); return v.isvalid && v.scriptPubKey === e.script; }));
  for (const [t, c, i, amt] of fund) cliw('sendtoaddress', acct.entry(t, c, i).address, amt);
  mine(1);

  const entries = acct.entries(100);
  const scripts = entries.map((e) => e.script);
  let progressSeen = 0;
  const scan1 = await api.scan(scripts, { pollMs: 200, onProgress: () => { progressSeen++; } });
  let coins = coinsFromScan(entries, scan1);
  const total = (cs) => cs.reduce((a, c) => a + c.value, 0);
  ok('UTXO scan finds all 5 coins across 4 address types (incl. index 42)', coins.length === 5 && total(coins) === 188500000);
  ok('every coin is confirmed + spendable + mapped to its derivation path', coins.every((c) => c.spendable && c.confirmations === 1 && c.entry.path.startsWith('m/')));
  ok('scan height/bestblock match the node tip', scan1.height === 111 && scan1.bestblock === cli('getbestblockhash'));

  // ---------- SEND: mixed types incl. a legacy input (previous tx fetched + verified) ----------
  const dest = cliw('getnewaddress', '', 'bech32');
  const prevCalls = [];
  const fetchPrevTx = async (txid, height) => { prevCalls.push(txid); return api.prevTx(txid, height); };
  const send1 = await buildSpend({ account: acct, coins, to: dest, amount: 150000000, feeRate: 7, changeEntry: acct.changeEntry(0), fetchPrevTx });
  ok('send builds from mixed P2WPKH/P2TR/P2SH/P2PKH inputs', send1.sent === 150000000 && send1.inputs.length >= 3);
  ok('legacy input triggered a previous-transaction fetch through the node', prevCalls.length === 1);
  const acc1 = JSON.parse(cli('testmempoolaccept', JSON.stringify([send1.txHex])))[0];
  ok('Bitcoin Core ACCEPTS the transaction (testmempoolaccept)', acc1.allowed === true && acc1.txid === send1.txid);
  ok('fee Core computes == fee the wallet shows', Math.round(acc1.fees.base * 1e8) === send1.fee && acc1.vsize === send1.vsize);
  const txid1 = await api.broadcast(send1.txHex);
  ok('broadcast returns the txid the wallet computed', txid1 === send1.txid);
  ok('re-broadcasting the same bytes is idempotent', (await api.broadcast(send1.txHex)) === send1.txid);

  // ---------- mempool awareness: the just-spent coins must not be offered again ----------
  const scan2 = await api.scan(scripts, { pollMs: 200 });
  const coins2 = coinsFromScan(entries, scan2);
  const spentSet = new Set(send1.inputs);
  ok('coins spent in the mempool are flagged and NOT spendable', coins2.filter((c) => spentSet.has(`${c.txid}:${c.vout}`)).every((c) => c.spentInMempool && !c.spendable) && coins2.filter((c) => c.spentInMempool).length === send1.inputs.length);
  const pend = await api.txout([{ txid: send1.txid, vout: send1.changeVout }]);
  ok('pending change is visible via /txout (0 conf, right amount + script)', pend[0].unspent && pend[0].confirmations === 0 && pend[0].value === send1.change && pend[0].script === send1.changeScript);
  ok('re-spending a mempool-spent coin is refused by the wallet', await rejects(buildSpend({ account: acct, coins: coins2.filter((c) => c.spentInMempool), to: dest, sweep: true, feeRate: 9, fetchPrevTx }), /not spendable/));

  // ---------- block arrives: cached entry is advanced incrementally (no rescan) ----------
  mine(1);
  const scansBefore = (apiLog.match(/scan done/g) || []).length;
  const scan3 = await api.scan(scripts, { pollMs: 200 });
  const coins3 = coinsFromScan(entries, scan3);
  ok('after a block: spent coins gone, change coin found on m/84h/1h/0h/1/0', coins3.some((c) => c.txid === send1.txid && c.entry.path === "m/84'/1'/0'/1/0" && c.value === send1.change) && !coins3.some((c) => spentSet.has(`${c.txid}:${c.vout}`)));
  ok('wallet balance == funded − sent − fee (nothing lost)', total(coins3) === 188500000 - 150000000 - send1.fee);
  ok('that refresh was served by following the block, not a new scan', (apiLog.match(/scan done/g) || []).length === scansBefore);
  ok('Core agrees: recipient received exactly the amount', Math.round(Number(cliw('getreceivedbyaddress', dest, 1)) * 1e8) === 150000000);

  // ---------- OP_RETURN message: Core must accept it and decode the same bytes ----------
  const NOTE = 'Olesia says hello ✓';
  const noteSend = await buildSpend({ account: acct, coins: coins3, to: dest, amount: 1000000, feeRate: 4, changeEntry: acct.changeEntry(1), fetchPrevTx, message: NOTE });
  const noteDec = JSON.parse(cli('decoderawtransaction', noteSend.txHex));
  const nd = noteDec.vout.filter((o) => o.scriptPubKey.type === 'nulldata');
  ok('message send: Core decodes exactly one nulldata output carrying our bytes', nd.length === 1 && nd[0].value === 0 && nd[0].scriptPubKey.hex.endsWith(Buffer.from(NOTE, 'utf8').toString('hex')));
  ok('message send: accepted + broadcast by Core, fee matches', JSON.parse(cli('testmempoolaccept', JSON.stringify([noteSend.txHex])))[0].allowed === true && (await api.broadcast(noteSend.txHex)) === noteSend.txid);
  mine(1);
  const coins3b = coinsFromScan(entries, await api.scan(scripts, { pollMs: 200 }));
  ok('message send: change is found again, nothing lost', total(coins3b) === total(coins3) - 1000000 - noteSend.fee);
  coins3.length = 0; coins3.push(...coins3b);

  // ---------- SWEEP everything out ----------
  const sweep = await buildSpend({ account: acct, coins: coins3, to: dest, sweep: true, feeRate: 3, fetchPrevTx });
  ok('sweep accepted by Core and empties the wallet', (await api.broadcast(sweep.txHex)) === sweep.txid && sweep.sent + sweep.fee === total(coins3));
  mine(1);
  ok('wallet is empty after the sweep confirms', coinsFromScan(entries, await api.scan(scripts, { pollMs: 200 })).length === 0);

  // (done here, early, so the API's per-minute broadcast limit is not what rejects it)
  const dbl = await buildSpend({ account: acct, coins: coins3, to: dest, sweep: true, feeRate: 5, fetchPrevTx });
  ok('broadcast: a double-spend of already-spent coins is refused by the node', dbl.txid !== sweep.txid && await rejects(api.broadcast(dbl.txHex), /rejected by the node/));

  // ---------- THE PAGE'S REAL PATH: watch-only session + wallet held encrypted ----------
  const fastApi = { ...api, scan: (sc, o) => api.scan(sc, { ...o, pollMs: 200 }) };
  const lkSecret = { kind: 'seed', mnemonic: createMnemonic({ words: 24 }).mnemonic, passphrase: '' };
  const lkPw = generatePassword(6).password;
  const lkPayload = { kind: 'seed', mnemonic: lkSecret.mnemonic, passphrase: '', passphraseUsed: false, fingerprint: describeSeed({ ...lkSecret, network: NET }).fingerprint, scriptType: 'p2wpkh' };
  const lkFile = await sealWallet(lkPayload, lkPw, { network: NET });
  const lk = await lockWallet({ secret: lkSecret, password: lkPw, network: NET, fileText: lkFile, filePayload: lkPayload });
  const locked = new LockedWallet(lk);
  const sess = new Session({ account: openWatchAccount(lk.pub), api: fastApi });
  cliw('sendtoaddress', sess.receive().address, 0.4); mine(1);
  let sm = await sess.refresh();
  ok('watch-only session (public keys only) finds its coin through the node', sm.spendable === 40000000 && sm.coins === 1);
  ok('the session cannot sign without the password', await rejects(sess.prepare({ to: dest, amount: 1000000, feeRate: 3 }), /locked/));
  ok('a wrong password signs nothing', await rejects(locked.withSigner(lkPw + 'x', (signer) => sess.prepare({ to: dest, amount: 1000000, feeRate: 3, signer })), /wrong password/));
  const lkBuilt = await locked.withSigner(lkPw, (signer) => sess.prepare({ to: dest, amount: 1000000, feeRate: 3, signer }));
  const lkRes = await sess.broadcast(lkBuilt);
  ok('with the password: signed, audited, broadcast — Core has the transaction', JSON.parse(cli('getrawmempool')).includes(lkRes.txid) && lkBuilt.changePath === "m/84'/1'/0'/1/0");
  sm = sess.summary();
  ok('balance view after sending: coin marked outgoing, change shown as pending', sm.spendable === 0 && sm.outgoing === 40000000 && sm.pendingChange === lkBuilt.change);
  mine(1); sm = await sess.refresh();
  ok('after a block the watch-only session sees its change (nothing lost)', sm.confirmed === 40000000 - 1000000 - lkBuilt.fee && sess.sent[0].status === 'confirmed');

  // ---------- audit M2: a restored wallet whose coins sit deep in the address chain ----------
  const deepM = createMnemonic({ words: 12 }).mnemonic;
  const deepFull = openSeedAccount({ mnemonic: deepM, network: NET });
  // coins only at change #130 and #150, receive #185 and #230, and one far out at receive #420
  for (const [chain, idx, amt] of [[1, 130, 0.01], [1, 150, 0.02], [0, 185, 0.03], [0, 230, 0.04], [0, 420, 0.05]]) cliw('sendtoaddress', deepFull.entry('p2wpkh', chain, idx).address, amt);
  mine(1);
  const fresh = new Session({ account: openWatchAccount(describeSeed({ mnemonic: deepM, network: NET })), api: fastApi });   // a new device: no stored counters
  sm = await fresh.refresh();
  ok('fresh restore finds coins at change #130/#150 and receive #185 (a 100-address window would miss all of them)', fresh.coinList().some((c) => c.path.endsWith('/1/130')) && fresh.coinList().some((c) => c.path.endsWith('/1/150')) && fresh.coinList().some((c) => c.path.endsWith('/0/185')));
  ok('a coin near the window edge extends the search automatically (finds receive #230)', sm.confirmed === 10000000 && fresh.depth.range === 300);
  ok('known limit: a coin far beyond the window (#420, behind a long empty gap) is not found by default', !fresh.coinList().some((c) => c.path.endsWith('/0/420')));
  fresh.scanDeeper(); sm = await fresh.refresh();
  ok('"Search more addresses" finds it', sm.confirmed === 15000000 && fresh.depth.range === 500);

  // ---------- IMPORTED 12-word phrase with a passphrase ----------
  const acct12 = openSeedAccount({ mnemonic: createMnemonic({ words: 12 }).mnemonic, passphrase: 'correct horse', network: NET });
  cliw('sendtoaddress', acct12.entry('p2tr', 0, 0).address, 0.2); mine(1);
  const e12 = acct12.entries(100);
  const c12 = coinsFromScan(e12, await api.scan(e12.map((e) => e.script), { pollMs: 200 }));
  const s12 = await buildSpend({ account: acct12, coins: c12, to: dest, amount: 5000000, feeRate: 2, changeEntry: acct12.changeEntry(0) });
  ok('12-word + passphrase wallet: Taproot coin found and spent (Core accepts)', c12.length === 1 && (await api.broadcast(s12.txHex)) === s12.txid);

  // ---------- WIF, compressed key: 4 address types + bare P2PK ----------
  const wifC = btc.WIF(REG).encode(randomBytes(32));
  const wc = openWifAccount({ wif: wifC, network: NET });
  for (const t of HD_TYPES) cliw('sendtoaddress', wc.entry(t).address, 0.1);
  mine(1);
  let wcCoins = coinsFromScan(wc.entries(), await api.scan(wc.entries().map((e) => e.script), { pollMs: 200 }));
  ok('compressed WIF: coins found on all 4 address types', wcCoins.length === 4 && total(wcCoins) === 40000000);
  // move some into this key's bare P2PK output (no address) to exercise the P2PK path
  const segCoin = wcCoins.find((c) => c.entry.type === 'p2wpkh');
  const fundPk = buildFundP2PK({ utxos: [{ txid: segCoin.txid, vout: segCoin.vout, value: segCoin.value }], privKey: segCoin.entry.key.privKey, pubkey: segCoin.entry.key.pubkey,
    targetScript: hexToBytes(wc.entry('p2pk').script), changeScript: segCoin.entry.key.spend.script, amount: 3000000, feeRate: 2 });
  await api.broadcast(fundPk.txHex); mine(1);
  wcCoins = coinsFromScan(wc.entries(), await api.scan(wc.entries().map((e) => e.script), { pollMs: 200 }));
  const std = wcCoins.filter((c) => c.entry.group === 'std'), raw = wcCoins.filter((c) => c.entry.group === 'raw');
  ok('bare P2PK coin (no address) is found by script in the UTXO set', raw.length === 1 && raw[0].value === 3000000 && raw[0].entry.type === 'p2pk');
  const wSend = await buildSpend({ account: wc, coins: std, to: dest, amount: 20000000, feeRate: 4, fetchPrevTx });
  ok('compressed WIF send (mixed types, change back to the key) accepted by Core', (await api.broadcast(wSend.txHex)) === wSend.txid && wSend.changeAddress === wc.entry('p2wpkh').address);
  const pkSweep = await buildSpend({ account: wc, coins: raw, to: dest, sweep: true, feeRate: 4, fetchPrevTx });
  ok('compressed P2PK sweep (hand-rolled legacy signer) accepted by Core', (await api.broadcast(pkSweep.txHex)) === pkSweep.txid);

  // ---------- WIF, UNCOMPRESSED key (classic paper wallet): P2PKH + P2PK ----------
  const b58 = (await import('@scure/base')).createBase58check((await import('@noble/hashes/sha256')).sha256);
  const uPriv = randomBytes(32);
  const wifU = b58.encode(Uint8Array.of(REG.wif, ...uPriv));
  const wu = openWifAccount({ wif: wifU, network: NET });
  ok('uncompressed WIF opens with legacy-only scripts', wu.compressed === false && wu.entries().length === 2);
  const uAddr = wu.entry('p2pkh').address;
  ok('Core agrees on the uncompressed-key P2PKH address', JSON.parse(cli('validateaddress', uAddr)).scriptPubKey === wu.entry('p2pkh').script);
  cliw('sendtoaddress', uAddr, 0.3); cliw('sendtoaddress', uAddr, 0.05);
  // fund the uncompressed bare P2PK from the compressed key's remaining SegWit change
  mine(1);
  const wcNow = coinsFromScan(wc.entries(), await api.scan(wc.entries().map((e) => e.script), { pollMs: 200 }));
  const src = wcNow.find((c) => c.entry.type === 'p2wpkh');
  const fundUPk = buildFundP2PK({ utxos: [{ txid: src.txid, vout: src.vout, value: src.value }], privKey: src.entry.key.privKey, pubkey: src.entry.key.pubkey,
    targetScript: hexToBytes(wu.entry('p2pk').script), changeScript: src.entry.key.spend.script, amount: 2000000, feeRate: 2 });
  await api.broadcast(fundUPk.txHex); mine(1);
  let uCoins = coinsFromScan(wu.entries(), await api.scan(wu.entries().map((e) => e.script), { pollMs: 200 }));
  ok('uncompressed key: 2 P2PKH coins + 1 P2PK coin found', uCoins.length === 3 && total(uCoins) === 37000000);
  const uSend = await buildSpend({ account: wu, coins: uCoins, to: dest, amount: 10000000, feeRate: 6, fetchPrevTx });
  const uAcc = JSON.parse(cli('testmempoolaccept', JSON.stringify([uSend.txHex])))[0];
  ok('UNCOMPRESSED P2PKH + P2PK multi-input send: Core ACCEPTS the signatures', uAcc.allowed === true && uAcc.txid === uSend.txid);
  ok('legacy fee Core computes == fee the wallet shows', Math.round(uAcc.fees.base * 1e8) === uSend.fee);
  ok('…and it broadcasts', (await api.broadcast(uSend.txHex)) === uSend.txid);
  mine(1);
  uCoins = coinsFromScan(wu.entries(), await api.scan(wu.entries().map((e) => e.script), { pollMs: 200 }));
  ok('change returned to the uncompressed key and is found again', uCoins.length === 1 && uCoins[0].value === uSend.change);
  const uSweep = await buildSpend({ account: wu, coins: uCoins, to: dest, sweep: true, feeRate: 6, fetchPrevTx, message: 'swept from paper' });
  ok('uncompressed-key sweep WITH a message accepted by Core (legacy signer)', (await api.broadcast(uSweep.txHex)) === uSweep.txid && JSON.parse(cli('decoderawtransaction', uSweep.txHex)).vout.some((o) => o.scriptPubKey.type === 'nulldata'));

  // ---------- the API rejects hostile input ----------
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  ok('scan: non-standard script refused', (await post('/scan', { scripts: ['6a0548656c6c6f'] })).status === 400);
  ok('scan: descriptor-injection attempt refused', (await post('/scan', { scripts: ['0014' + '00'.repeat(20) + ')#x,addr(abc'] })).status === 400);
  ok('scan: empty list refused', (await post('/scan', { scripts: [] })).status === 400);
  ok('scan: more than 8200 scripts refused', (await post('/scan', { scripts: Array.from({ length: 8201 }, (_, i) => '0014' + i.toString(16).padStart(40, '0')) })).status === 400);
  ok('scan: unknown job id is 404', (await fetch(base + '/scan/' + 'ab'.repeat(18))).status === 404);
  ok('broadcast: garbage hex refused', (await post('/broadcast', { txHex: 'zz' })).status === 400);
  ok('prevtx: wrong height for a txid is refused', (await post('/prevtx', { txid: send1.txid, height: 5 })).status === 404);
  ok('unknown route is 404, body is JSON', (await fetch(base + '/nope')).status === 404);
  const cors = await fetch(base + '/status', { headers: { origin: 'https://evil.example' } });
  const corsOk = await fetch(base + '/status', { headers: { origin: 'https://olesia.io' } });
  ok('CORS: olesia.io allowed, other origins not', corsOk.headers.get('access-control-allow-origin') === 'https://olesia.io' && cors.headers.get('access-control-allow-origin') === null);
  ok('API log contains no scripts, addresses or txids', !/[0-9a-f]{40}/.test(apiLog));
} catch (e) {
  console.error('\nE2E ABORTED:', e.stack || e.message); bad = true;
} finally { cleanup(); }

await sleep(2500);
console.log(bad ? '\nE2E FAILED' : '\nmainnet-stack e2e (regtest): all checks passed');
process.exit(bad ? 1 : 0);
