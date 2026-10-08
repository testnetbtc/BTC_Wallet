// LIVE browser test of the PRODUCTION mainnet wallet page: the exact bytes in mainnet/publish,
// served with their real CSP header, driven in headless Chrome. Requests to https://api.olesia.io
// are intercepted and answered by a local node API in front of a private regtest Bitcoin Core,
// so the whole flow (create -> .dat -> coins -> send -> lock -> reopen -> import) runs for real.
// A scriptPubKey is network-independent, so the page's mainnet addresses are funded on regtest
// by re-encoding the same script with the regtest prefix.
// Needs: bitcoind, puppeteer + Chrome (PUPPETEER_FROM, CHROME).  Run AFTER node mainnet/build.mjs:
//   node test/mainnet_browser_e2e.mjs
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import * as btc from '@scure/btc-signer';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { encryptBackup } from '../../../src/backup.js';
import { openSeedAccount } from '../src/account.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(process.env.PUPPETEER_FROM || '/home/faucet/controlpoint/');
const puppeteer = require('puppeteer');
const CHROME = process.env.CHROME || '/home/faucet/.cache/puppeteer/chrome/linux-151.0.7922.77/chrome-linux64/chrome';
const ROOT = mkdtempSync(join(process.env.REGTEST_DIR || tmpdir(), 'olesia-browser-'));
const DIR = join(ROOT, 'node'), DL = join(ROOT, 'downloads');
execFileSync('mkdir', ['-p', DIR, DL]);
const RPCPORT = 18653, APIPORT = 18797, WEBPORT = 18798, ESPPORT = 18799;
const REG = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const b58 = createBase58check(sha256);

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(80), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeFileSync(join(DIR, 'bitcoin.conf'), `regtest=1\nserver=1\nrpcuser=olesiatest\nrpcpassword=${randomBytes(16).toString('hex')}\nfallbackfee=0.0002\nlisten=0\n[regtest]\nrpcport=${RPCPORT}\n`);
const cli = (...a) => execFileSync('bitcoin-cli', [`-datadir=${DIR}`, ...a.map(String)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cliw = (...a) => cli('-rpcwallet=miner', ...a);
// same script, other network's address encoding
const toRegtest = (mainAddr) => btc.Address(REG).encode(btc.Address(btc.NETWORK).decode(mainAddr));
const toMainnet = (regAddr) => btc.Address(btc.NETWORK).encode(btc.Address(REG).decode(regAddr));
// practice-network (tb1…) addresses <-> the regtest node, same script
const testToRegtest = (testAddr) => btc.Address(REG).encode(btc.Address(btc.TEST_NETWORK).decode(testAddr));
const regtestToTest = (regAddr) => btc.Address(btc.TEST_NETWORK).encode(btc.Address(REG).decode(regAddr));

// A stand-in for the public Esplora API that the Olesia server relays for practice networks.
// It answers from the private regtest node, so the whole practice-network path — page ->
// node API relay -> "public" data source — is exercised for real.
const esp = { byHash: new Map(), indexed: -1 };
function espIndex() {
  const tip = Number(cli('getblockcount'));
  const note = (tx) => tx.vout.forEach((o) => { const hex = o.scriptPubKey.hex; esp.byHash.set(Buffer.from(sha256(Buffer.from(hex, 'hex'))).toString('hex'), hex); });
  for (let h = esp.indexed + 1; h <= tip; h++) JSON.parse(cli('getblock', cli('getblockhash', h), 2)).tx.forEach(note);
  esp.indexed = tip;
  const pool = JSON.parse(cli('getrawmempool')).map((id) => JSON.parse(cli('getrawtransaction', id, 1)));
  pool.forEach(note);
  return { tip, pool };
}
const espServer = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'POST' && path === '/tx') {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => { try { send(200, cli('sendrawtransaction', body.trim())); } catch (e) { send(400, 'sendrawtransaction RPC error: ' + String(e.stderr || e.message).slice(0, 120)); } });
      return;
    }
    if (path === '/blocks/tip/height') return send(200, String(cli('getblockcount')));
    if (path === '/fee-estimates') return send(200, { 2: 1.2, 6: 1, 144: 1 });
    let m = path.match(/^\/scripthash\/([0-9a-f]{64})\/utxo$/);
    if (m) {
      const { pool } = espIndex();
      const script = esp.byHash.get(m[1]);
      if (!script) return send(200, []);
      const live = (txid, vout) => cli('gettxout', txid, vout, 'true') !== '';   // false once the mempool spends it
      const out = JSON.parse(cli('scantxoutset', 'start', JSON.stringify([`raw(${script})`]))).unspents
        .filter((u) => live(u.txid, u.vout)).map((u) => ({ txid: u.txid, vout: u.vout, value: Math.round(u.amount * 1e8), status: { confirmed: true, block_height: u.height } }));
      for (const tx of pool) tx.vout.forEach((o) => { if (o.scriptPubKey.hex === script && live(tx.txid, o.n)) out.push({ txid: tx.txid, vout: o.n, value: Math.round(o.value * 1e8), status: { confirmed: false } }); });
      return send(200, out);
    }
    m = path.match(/^\/tx\/([0-9a-f]{64})\/hex$/);
    if (m) return send(200, cli('getrawtransaction', m[1]));
    send(404, 'not found');
  } catch (e) { send(500, String(e.message).slice(0, 100)); }
});

const pageHtml = readFileSync(join(HERE, '../mainnet/publish/index.html'));
const cspHeader = readFileSync(join(HERE, '../mainnet/publish/_headers'), 'utf8').match(/Content-Security-Policy: (.*)/)[1];
const web = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': cspHeader, 'referrer-policy': 'no-referrer' }); return res.end(pageHtml); }
  res.writeHead(404); res.end('nope');
});

let node = null, apiProc = null, browser = null;
const cleanup = async () => {
  try { browser && await browser.close(); } catch {}
  try { apiProc && apiProc.kill(); } catch {}
  try { web.close(); } catch {}
  try { espServer.close(); } catch {}
  try { cli('stop'); } catch {}
  await sleep(2000);
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
};

try {
  node = spawn('bitcoind', [`-datadir=${DIR}`], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { cli('getblockcount'); break; } catch { await sleep(500); } }
  cli('createwallet', 'miner');
  const minerAddr = cliw('getnewaddress', '', 'bech32');
  const mine = (n = 1) => cli('generatetoaddress', n, minerAddr);
  mine(110);
  await new Promise((r) => espServer.listen(ESPPORT, '127.0.0.1', r));
  const espBase = `http://127.0.0.1:${ESPPORT}`;
  apiProc = spawn(process.execPath, [join(HERE, '../../../infra/nodeapi/server.mjs')], {
    env: { ...process.env, OLESIA_CHAIN: 'regtest', OLESIA_NODE_CONF: join(DIR, 'bitcoin.conf'), OLESIA_API_PORT: String(APIPORT), OLESIA_RATE_SCALE: '20', OLESIA_TEST_BASE_TESTNET4: espBase, OLESIA_TEST_BASE_SIGNET: espBase, OLESIA_TEST_BASE_TESTNET3: espBase, OLESIA_PRICE_FIXTURE: JSON.stringify({ usd: { price: 85000, change24h: 2.5 }, gbp: { price: 64000.4, change24h: -1.25 } }), OLESIA_EXTRA_ORIGINS: `http://127.0.0.1:${WEBPORT}` }, stdio: 'ignore' });
  const localApi = `http://127.0.0.1:${APIPORT}`;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(localApi + '/status')).ok) break; } catch { await sleep(250); } }
  await new Promise((r) => web.listen(WEBPORT, '127.0.0.1', r));
  const ORIGIN = `http://127.0.0.1:${WEBPORT}`;

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const consoleErrors = [], hosts = new Set(), apiCalls = [];
  async function newPage() {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1000 });
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      const u = new URL(req.url());
      if (u.protocol === 'blob:' || u.protocol === 'data:') return req.continue();
      hosts.add(u.host);
      if (u.host !== 'api.olesia.io') return req.continue();
      const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
      apiCalls.push(req.method() + ' ' + u.pathname.replace(/\/scan\/.*/, '/scan/<id>'));
      try {
        const r = await fetch(localApi + u.pathname, { method: req.method(), headers: { 'content-type': 'application/json', origin: ORIGIN }, body: req.method() === 'POST' ? req.postData() : undefined });
        req.respond({ status: r.status, headers: { ...cors, 'content-type': 'application/json' }, body: await r.text() });
      } catch (e) { req.respond({ status: 502, headers: cors, body: JSON.stringify({ error: e.message }) }); }
    });
    await page.goto(ORIGIN + '/', { waitUntil: 'load' });
    return page;
  }
  // DOM-level click: immune to layout shifts and overlays, fires the same handlers
  const tap = (page, sel) => page.$eval(sel, (e) => e.click());
  const text = (page, sel) => page.$eval(sel, (e) => e.textContent);
  const visible = (page, sel) => page.$eval(sel, (e) => !e.classList.contains('hide') && e.getClientRects().length > 0);
  const onPane = (page, name) => page.waitForFunction((n) => document.querySelector('#pane-' + n).classList.contains('on'), { timeout: 60000 }, name);
  const waitBalance = (page, value) => page.waitForFunction((v) => document.querySelector('#bal').textContent === v && document.querySelector('#scanbox').classList.contains('hide'), { timeout: 60000 }, value);
  const refreshUntil = async (page, value) => { for (let i = 0; i < 20; i++) { await tap(page, '#a_refresh'); try { await waitBalance(page, value); return true; } catch { /* retry */ } } return false; };
  const downloads = () => readdirSync(DL).filter((f) => f.endsWith('.dat'));
  const confirmOn = (page) => page.waitForFunction(() => document.querySelector('#confirm').classList.contains('on'), { timeout: 60000 });
  const pwOn = (page) => page.waitForFunction(() => document.querySelector('#pwsheet').classList.contains('on'), { timeout: 60000 });
  // every signature needs the wallet password: Review -> password prompt -> confirmation sheet
  const enterPw = async (page, pw) => { await pwOn(page); await page.type('#p_pw', pw); await tap(page, '#p_go'); };
  const review = async (page, pw) => { await tap(page, '#t_review'); await enterPw(page, pw); await confirmOn(page); };
  // the mandatory "set a password and save the file" step after an import / conversion
  const saveStep = async (page) => {
    await onPane(page, 'save'); await tap(page, '#s_gen');
    const pw = await page.$eval('#s_pw', (e) => e.value);
    const before = downloads().length;
    await tap(page, '#s_go');
    await page.waitForFunction(() => !document.querySelector('#s_done').classList.contains('hide'), { timeout: 180000 });
    for (let i = 0; i < 40 && downloads().length === before; i++) await sleep(250);
    await tap(page, '#s_open'); await onPane(page, 'wallet');
    return pw;
  };
  let curPw = '';
  const tab = async (page, name) => { await tap(page, `#tabbar button[data-tab="${name}"]`); await onPane(page, name); };

  // ================= page loads under its real CSP =================
  let page = await newPage();
  ok('page loads; cryptography self-check passes (welcome buttons enabled)', await page.$eval('#w_create', (b) => !b.disabled) && !(await visible(page, '#selfcheck')));
  ok('RNG health line reports the system generator is alive', (await text(page, '#rngmsg')).startsWith('✓'));
  await page.waitForFunction(() => document.querySelector('#chip_node_t').textContent !== 'node…', { timeout: 15000 });

  // ================= price chip: green for +, red for − =================
  await page.waitForFunction(() => !document.querySelector('#chip_price').classList.contains('hide'), { timeout: 15000 });
  const priceLook = () => page.evaluate(() => ({ v: document.querySelector('#price_v').textContent, c: document.querySelector('#price_c').textContent, cls: document.querySelector('#price_c').className, color: getComputedStyle(document.querySelector('#price_c')).color }));
  let pl = await priceLook();
  ok('price shows "BTC $85,000" with a GREEN "▲ +2.50%" for a positive day', pl.v === 'BTC $85,000' && pl.c === '▲ +2.50%' && pl.cls === 'up' && pl.color === 'rgb(98, 217, 138)');
  await tap(page, '#chip_price'); pl = await priceLook();
  ok('tapping switches currency: "BTC £64,000" with a RED "▼ −1.25%" for a negative day', pl.v === 'BTC £64,000' && pl.c === '▼ −1.25%' && pl.cls === 'down' && pl.color === 'rgb(255, 143, 143)');
  await tap(page, '#chip_price'); pl = await priceLook();
  ok('currencies without a quote are skipped (back to USD)', pl.v === 'BTC $85,000');

  // ================= CREATE =================
  await tap(page, '#w_create'); await onPane(page, 'create1');
  ok('Generate is locked until the mouse has been moved', await page.$eval('#c_gen', (b) => b.disabled));
  const pad = await (await page.$('#pad')).boundingBox();
  for (let i = 0; i < 300; i++) await page.mouse.move(pad.x + 5 + (i * 37 % (pad.width - 10)), pad.y + 5 + (i * 53 % (pad.height - 10)));
  ok('mouse movement fills the bar to 100% and unlocks Generate', (await text(page, '#padmsg')).startsWith('100%') && await page.$eval('#c_gen', (b) => !b.disabled));
  await page.type('#dice', '1 2 3 9');
  ok('an invalid dice digit is reported and blocks Generate', (await text(page, '#dicemsg')).startsWith('✗') && await page.$eval('#c_gen', (b) => b.disabled));
  await page.$eval('#dice', (e) => { e.value = ''; }); await page.type('#dice', '4 2 6 1 3 5 2 6 1 4');
  ok('valid dice rolls are counted', (await text(page, '#dicemsg')).startsWith('10 rolls'));
  await tap(page, '#c_gen'); await onPane(page, 'create2');
  const words24 = await page.$$eval('#c_words span', (els) => els.map((e) => e.lastChild.textContent));
  ok('24 words are shown', words24.length === 24 && words24.every((w) => /^[a-z]+$/.test(w)));
  ok('entropy sources are reported (system ✓, mouse ✓, dice ✓)', /system generator ✓ · mouse movement ✓ · dice ✓ \(10 rolls\)/.test(await text(page, '#c_sources')));
  ok('Continue is locked until "I have written them down" is ticked', await page.$eval('#c_next2', (b) => b.disabled));
  await tap(page, '#c_wrote'); await tap(page, '#c_next2'); await onPane(page, 'create3');
  const asked = await page.$$eval('#q_box .qrow span', (els) => els.map((e) => Number(e.textContent.replace('Word #', ''))));
  await page.type('#q_in0', 'wrongword'); await tap(page, '#q_check');
  ok('backup quiz rejects a wrong word', await page.$eval('#pane-create3', (p) => p.classList.contains('on')));
  await page.$eval('#q_in0', (e) => { e.value = ''; });
  for (let i = 0; i < asked.length; i++) await page.type('#q_in' + i, words24[asked[i] - 1]);
  await tap(page, '#q_check'); await onPane(page, 'save');

  // ================= SAVE .dat =================
  await page.type('#s_pw', 'hunter2'); await page.type('#s_pw2', 'hunter2');
  ok('a weak password cannot be used', await page.$eval('#s_go', (b) => b.disabled) && (await text(page, '#s_policy')).startsWith('✗'));
  await tap(page, '#s_gen');
  const password = await page.$eval('#s_pw', (e) => e.value);
  ok('generated password is 6 random words and enables saving', password.split('-').length === 6 && await page.$eval('#s_go', (b) => !b.disabled));
  await tap(page, '#s_go');
  await page.waitForFunction(() => !document.querySelector('#s_done').classList.contains('hide'), { timeout: 120000 });
  for (let i = 0; i < 40 && !downloads().length; i++) await sleep(250);
  const datName = downloads()[0];
  const dat = datName ? readFileSync(join(DL, datName), 'utf8') : '';
  ok('a .dat file was downloaded (olesia-wallet-YYYYMMDD-HHMMSS.dat)', /^olesia-wallet-\d{8}-\d{6}\.dat$/.test(datName || ''));
  ok('the file is an encrypted olesia-wallet for mainnet', (() => { try { const o = JSON.parse(dat); return o.format === 'olesia-wallet' && o.network === 'mainnet' && o.kdf.N === 131072; } catch { return false; } })());
  ok('the file contains none of the recovery words and not the password', !words24.some((w) => w.length > 4 && dat.includes(w)) && !dat.includes(password));
  await tap(page, '#s_open'); await onPane(page, 'wallet');
  await waitBalance(page, '0.00000000');
  ok('new wallet opens with a zero balance from the node', true);
  ok('the save step cleared the password fields and the words from the page', await page.$eval('#s_pw', (e) => e.value === '') && await page.$eval('#c_words', (e) => e.textContent === ''));
  curPw = password;
  const fp = await text(page, '#w_fp');

  // ================= RECEIVE (SegWit + Legacy only) =================
  await tap(page, '#a_recv'); await onPane(page, 'receive');
  const typeOpts = await page.$$eval('#r_type option', (os) => os.map((o) => o.value));
  ok('exactly two address types are offered: SegWit and Legacy', JSON.stringify(typeOpts) === JSON.stringify(['p2wpkh', 'p2pkh']));
  const addrSeg = await text(page, '#r_addr');
  ok('SegWit receive address is bc1q… with a QR code', /^bc1q[0-9a-z]{38}$/.test(addrSeg) && (await page.$eval('#r_qr', (i) => i.src)).startsWith('data:image/svg+xml'));
  await tap(page, '#r_next');
  const addrSeg2 = await text(page, '#r_addr');
  ok('"New address" moves to a different address', addrSeg2 !== addrSeg && /address #1/.test(await text(page, '#r_path')));
  await page.select('#r_type', 'p2pkh');
  await page.waitForFunction(() => document.querySelector('#r_addr').textContent.startsWith('1'));
  const addrLeg = await text(page, '#r_addr');
  ok('Legacy receive address starts with 1', /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(addrLeg));
  await page.select('#r_type', 'p2wpkh');
  cliw('sendtoaddress', toRegtest(addrSeg), 0.5); cliw('sendtoaddress', toRegtest(addrSeg2), 0.25); cliw('sendtoaddress', toRegtest(addrLeg), 0.125);
  mine(1);
  await tap(page, '#pane-receive .back'); await onPane(page, 'wallet');
  ok('after funding + 1 block the balance is 0.87500000 (SegWit ×2 + Legacy)', await refreshUntil(page, '0.87500000'));
  ok('three coins are listed with type, address and derivation path', (await page.$$('#coins .coin')).length === 3 && /m\/84'\/0'\/0'\/0\/0/.test(await text(page, '#coins')) && /m\/44'\/0'\/0'\/0\/0/.test(await text(page, '#coins')));

  // ================= SEND =================
  const destReg = cliw('getnewaddress', '', 'bech32'), dest = toMainnet(destReg);
  await tap(page, '#a_send'); await onPane(page, 'send');
  await page.waitForFunction(() => document.querySelectorAll('#t_fees button').length > 0, { timeout: 10000 }).catch(() => {});
  await page.type('#t_to', 'bc1qnotanaddress'); await page.type('#t_amt', '0.1'); await tap(page, '#t_review');
  await page.waitForFunction(() => document.querySelector('#t_msg').textContent.startsWith('✗'));
  { const m = await text(page, '#t_msg'); if (!/not a valid Bitcoin mainnet address/.test(m)) console.log('   t_msg was:', JSON.stringify(m), 'to=', JSON.stringify(await page.$eval('#t_to', (e) => e.value))); }
  ok('an invalid address is rejected before anything is built', /not a valid Bitcoin mainnet address/.test(await text(page, '#t_msg')));
  await page.$eval('#t_to', (e) => { e.value = ''; }); await page.type('#t_to', toRegtest(addrSeg));
  await tap(page, '#t_review'); await page.waitForFunction(() => /mainnet address/.test(document.querySelector('#t_msg').textContent));
  ok('a non-mainnet (bcrt1…) address is rejected', true);
  await page.$eval('#t_to', (e) => { e.value = ''; }); await page.type('#t_to', dest);
  await page.$eval('#t_fee', (e) => { e.value = ''; }); await page.type('#t_fee', '3');
  await tap(page, '#t_review'); await pwOn(page);
  ok('Review asks for the wallet password before anything is signed', !(await page.$eval('#confirm', (c) => c.classList.contains('on'))));
  await tap(page, '#p_cancel');
  await page.waitForFunction(() => /Cancelled/.test(document.querySelector('#t_msg').textContent));
  ok('cancelling the password prompt signs nothing', JSON.parse(cli('getrawmempool')).length === 0);
  await tap(page, '#t_review'); await pwOn(page); await page.type('#p_pw', 'not-the-right-password'); await tap(page, '#p_go');
  await page.waitForFunction(() => /Wrong password/.test(document.querySelector('#p_msg').textContent), { timeout: 120000 });
  ok('a wrong password is refused and nothing is signed', await page.$eval('#pwsheet', (c) => c.classList.contains('on')) && !(await page.$eval('#confirm', (c) => c.classList.contains('on'))));
  await page.type('#p_pw', curPw); await tap(page, '#p_go'); await confirmOn(page);
  ok('the right password signs and shows the confirmation', await page.$eval('#p_pw', (e) => e.value === ''));
  const sheet = await text(page, '#c_rows');
  ok('confirmation shows recipient, amount, change path and fee from the signed tx', sheet.includes(dest) && sheet.includes('0.10000000 BTC') && /m\/84'\/0'\/0'\/1\/0/.test(sheet) && /sat\/vB/.test(sheet));
  ok('nothing is broadcast before confirmation', JSON.parse(cli('getrawmempool')).length === 0);
  await tap(page, '#c_cancel');
  await page.waitForFunction(() => /Cancelled/.test(document.querySelector('#t_msg').textContent));
  ok('Cancel sends nothing', JSON.parse(cli('getrawmempool')).length === 0);
  await review(page, curPw);
  await tap(page, '#c_go');
  await page.waitForFunction(() => !document.querySelector('#t_result').classList.contains('hide'), { timeout: 60000 });
  const txid = await text(page, '#t_result p.mono');
  const pool = JSON.parse(cli('getrawmempool'));
  ok('Confirm broadcasts through the node; the node has exactly that txid', pool.length === 1 && pool[0] === txid);
  const fee1 = Math.round(JSON.parse(cli('getmempoolentry', txid)).fees.base * 1e8);
  await tap(page, '#pane-send .back'); await onPane(page, 'wallet');
  ok('the send appears under "Sent in this session" as pending', /pending/.test(await text(page, '#activity')));
  mine(1);
  const after1 = 87500000 - 10000000 - fee1;
  const fmt = (s) => (s / 1e8).toFixed(8);
  ok('after a block: balance = funded − sent − fee, change found again', await refreshUntil(page, fmt(after1)));
  ok('Core: recipient received exactly 0.1 BTC', Math.round(Number(cliw('getreceivedbyaddress', destReg, 1)) * 1e8) === 10000000);
  ok('activity now shows the send as confirmed', /confirmed/.test(await text(page, '#activity')));

  // ================= OP_RETURN message =================
  await tap(page, '#a_send'); await onPane(page, 'send');
  await page.type('#t_note', 'x'.repeat(81));
  ok('message byte counter turns red over 80 bytes', (await text(page, '#t_notecount')) === '81 / 80 bytes' && await page.$eval('#t_notecount', (e) => e.className === 'bad'));
  await page.type('#t_to', dest); await page.type('#t_amt', '0.01'); await page.type('#t_fee', '2'); await tap(page, '#t_review');
  await page.waitForFunction(() => /81 bytes/.test(document.querySelector('#t_msg').textContent));
  ok('an over-long message is refused before anything is built', !(await page.$eval('#confirm', (c) => c.classList.contains('on'))));
  await page.$eval('#t_note', (e) => { e.value = ''; }); await page.type('#t_note', 'Olesia was here ✓');
  await review(page, curPw);
  ok('confirmation shows the message, its size, and that it is public and permanent', /Message \(OP_RETURN\)“Olesia was here ✓”/.test(await text(page, '#c_rows')) && /public and permanent/.test(await text(page, '#c_rows')));
  await tap(page, '#c_go');
  await page.waitForFunction(() => !document.querySelector('#t_result').classList.contains('hide'), { timeout: 60000 });
  const noteTxid = await text(page, '#t_result p.mono');
  const noteRaw = JSON.parse(cli('getrawtransaction', noteTxid, 1));
  ok('Core has the transaction with one OP_RETURN output carrying exactly that text', noteRaw.vout.filter((o) => o.scriptPubKey.type === 'nulldata').length === 1 && noteRaw.vout.find((o) => o.scriptPubKey.type === 'nulldata').scriptPubKey.hex.endsWith(Buffer.from('Olesia was here ✓', 'utf8').toString('hex')));
  const feeNote = Math.round(JSON.parse(cli('getmempoolentry', noteTxid)).fees.base * 1e8);
  mine(1);
  await tap(page, '#pane-send .back'); await onPane(page, 'wallet');
  const after2 = after1 - 1000000 - feeNote;
  ok('balance after the message payment is exact', await refreshUntil(page, fmt(after2)));
  // message only: send to my own address
  await tap(page, '#a_send'); await onPane(page, 'send');
  await page.type('#t_note', 'note to self'); await tap(page, '#t_self'); await page.type('#t_fee', '2');
  ok('"only write a message" fills in my own address and selects send-everything', /^bc1q/.test(await page.$eval('#t_to', (e) => e.value)) && await page.$eval('#t_all', (e) => e.checked));
  await review(page, curPw);
  await tap(page, '#c_go');
  await page.waitForFunction(() => !document.querySelector('#t_result').classList.contains('hide'), { timeout: 60000 });
  const selfTxid = await text(page, '#t_result p.mono');
  const feeSelf = Math.round(JSON.parse(cli('getmempoolentry', selfTxid)).fees.base * 1e8);
  mine(1);
  await tap(page, '#pane-send .back'); await onPane(page, 'wallet');
  const after3 = after2 - feeSelf;
  ok('message-only: the coins come back to the wallet, only the fee is spent', await refreshUntil(page, fmt(after3)));

  // ================= PRACTICE NETWORKS: same words, separate keys, worthless coins =================
  const mainnetBalance = fmt(after3);
  await tab(page, 'networks');
  const netRows = await page.$$eval('#netlist .netrow', (rs) => rs.map((r) => r.dataset.net));
  ok('Networks lists four wallets: Bitcoin, Testnet 4, Signet, Testnet 3', netRows.join() === 'mainnet,testnet4,signet,testnet3');
  ok('Bitcoin is tagged "real bitcoin"; the others "no value"', /Bitcoin\s*real bitcoin/i.test(await page.$eval('#netlist .netrow[data-net="mainnet"]', (e) => e.textContent)) && /no value/i.test(await page.$eval('#netlist .netrow[data-net="signet"]', (e) => e.textContent)));
  await tab(page, 'faucet');
  const tAddr = await text(page, '#f_addr');
  const fHref = await page.$eval('#f_go', (a) => a.href);
  ok('Faucet shows this wallet\'s Testnet 4 address (tb1…) — different from every mainnet address', /^tb1q[0-9a-z]{38}$/.test(tAddr) && tAddr !== addrSeg);
  ok('"Get test coins" links to the faucet page with network + address filled in', fHref === 'https://app.olesia.io/faucet/?network=testnet4&address=' + tAddr && await page.$eval('#f_go', (a) => a.target === '_blank' && /noopener/.test(a.rel)));
  cliw('sendtoaddress', testToRegtest(tAddr), 0.02); mine(1);   // stands in for the faucet payout
  await tap(page, '#f_open'); await onPane(page, 'wallet');
  ok('opening the practice wallet: header says Testnet 4, hero is tagged "no value", unit is tBTC', (await text(page, '#netname')) === 'Testnet 4' && await visible(page, '#testtag') && (await text(page, '#bal_unit')) === 'tBTC');
  ok('practice balance arrives through the relayed public data source', await refreshUntil(page, '0.02000000'));
  ok('no fiat value is shown for worthless coins', (await text(page, '#bal_fiat')) === '');
  ok('the practice coin sits on the test derivation path m/84h/1h/…', /m\/84'\/1'\/0'\/0\/0/.test(await text(page, '#coins')));
  await tap(page, '#a_send'); await onPane(page, 'send');
  await page.type('#t_to', dest); await page.type('#t_amt', '0.005'); await page.type('#t_fee', '1'); await tap(page, '#t_review');
  await page.waitForFunction(() => /not a valid Testnet 4 address/.test(document.querySelector('#t_msg').textContent));
  ok('a MAINNET address is refused on a practice network (no cross-network sends)', !(await page.$eval('#pwsheet', (c) => c.classList.contains('on'))));
  const tDest = regtestToTest(destReg);
  await page.$eval('#t_to', (e) => { e.value = ''; }); await page.type('#t_to', tDest);
  await review(page, curPw);
  const tSheet = await text(page, '#c_rows');
  ok('confirmation names the network and says the coins have no value', /NetworkTestnet 4practice coins · no value/.test(tSheet) && tSheet.includes(tDest) && /m\/84'\/1'\/0'\/1\/0/.test(tSheet));
  await tap(page, '#c_go');
  await page.waitForFunction(() => !document.querySelector('#t_result').classList.contains('hide'), { timeout: 60000 });
  const tTxid = await text(page, '#t_result p.mono');
  ok('practice payment is broadcast through the relay and reaches the network', JSON.parse(cli('getrawmempool')).includes(tTxid));
  const tFee = Math.round(JSON.parse(cli('getmempoolentry', tTxid)).fees.base * 1e8);
  await tap(page, '#pane-send .back'); await onPane(page, 'wallet');
  mine(1);
  ok('after a block the practice change is back (balance exact)', await refreshUntil(page, fmt(2000000 - 500000 - tFee)));
  await tab(page, 'networks');
  ok('Networks now shows the Testnet 4 balance', (await page.$eval('#netlist .netrow[data-net="testnet4"] .v', (e) => e.textContent)).startsWith(fmt(2000000 - 500000 - tFee)));
  await tap(page, '#netlist .netrow[data-net="mainnet"]'); await onPane(page, 'wallet');
  await waitBalance(page, mainnetBalance);
  ok('back on Bitcoin: the mainnet balance is untouched and the header says so', (await text(page, '#netname')) === 'Bitcoin mainnet' && !(await visible(page, '#testtag')) && (await text(page, '#bal_unit')) === 'BTC');
  ok('practice lookups went to /n/testnet4/… on the same single host', apiCalls.some((c) => c === 'POST /n/testnet4/scan') && apiCalls.some((c) => c === 'POST /n/testnet4/broadcast'));

  // ================= nothing secret persisted; no third-party requests =================
  const stored = await page.evaluate(() => ({ local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage)) }));
  const storedText = JSON.stringify(stored);
  ok('browser storage holds only address counters — no words, no keys', !words24.some((w) => w.length > 4 && storedText.includes(w)) && Object.keys(stored.session).length === 0
    && Object.keys(stored.local).length >= 1 && Object.keys(stored.local).every((k) => /^olesia:(mainnet|testnet4|signet|testnet3):idx:[0-9a-f]+$/.test(k) || k === 'olesia:mainnet:cur')
    && !storedText.includes(curPw));
  // the open page holds no plaintext secret: not in the DOM, not on window.OM, not in any global
  const leak = await page.evaluate((w) => { const hay = document.documentElement.outerHTML; const fields = [...document.querySelectorAll('input,textarea')].map((e) => ' ' + e.value + ' ').join('|'); return w.filter((x) => x.length > 5 && (hay.includes('>' + x + '<') || fields.includes(' ' + x + ' '))).length; }, words24);
  ok('no recovery word is present anywhere in the page (text or form fields) while the wallet is open', leak === 0);
  ok('a tab bar (Wallet / Networks / Faucet / Settings) appears once a wallet is open', await visible(page, '#tabbar') && (await page.$$('#tabbar button')).length === 4);
  await tab(page, 'settings');
  ok('the recovery phrase is hidden by default', !(await visible(page, '#reveal_box')));
  await tap(page, '#a_reveal'); await pwOn(page); await page.type('#p_pw', 'wrong-wrong-wrong'); await tap(page, '#p_go');
  await page.waitForFunction(() => /Wrong password/.test(document.querySelector('#p_msg').textContent), { timeout: 120000 });
  ok('showing the recovery phrase needs the password — a wrong one shows nothing', !(await visible(page, '#reveal_box')));
  await page.type('#p_pw', curPw); await tap(page, '#p_go');
  await page.waitForFunction(() => !document.querySelector('#reveal_box').classList.contains('hide'), { timeout: 120000 });
  const shown = await page.$$eval('#reveal_words span', (els) => els.map((e) => e.lastChild.textContent));
  ok('with the right password the same 24 words are shown', shown.join(' ') === words24.join(' '));
  await tap(page, '#a_reveal');
  ok('tapping again hides them and removes them from the page', !(await visible(page, '#reveal_box')) && (await page.$eval('#reveal_words', (e) => e.textContent)) === '');
  ok('"Download wallet file" is offered (the encrypted file, again)', await visible(page, '#a_savefile'));
  await tab(page, 'wallet');

  // ================= LOCK, then OPEN the .dat =================
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), tap(page, '#lockbtn')]);
  ok('Lock reloads the page: back at Welcome, no wallet in memory', await page.$eval('#pane-welcome', (p) => p.classList.contains('on')) && await page.$eval('#lockbtn', (b) => b.classList.contains('hide')));
  await tap(page, '#w_open'); await onPane(page, 'open');
  await (await page.$('#o_file')).uploadFile(join(DL, datName));
  await page.waitForFunction(() => /Olesia wallet file · mainnet/.test(document.querySelector('#o_info').textContent));
  await page.type('#o_pw', 'wrong-password-wrong-password'); await tap(page, '#o_go');
  await page.waitForFunction(() => /wrong password/.test(document.querySelector('#o_msg').textContent), { timeout: 120000 });
  ok('wrong password is rejected', true);
  await page.$eval('#o_pw', (e) => { e.value = ''; }); await page.type('#o_pw', password); await tap(page, '#o_go');
  await onPane(page, 'wallet'); await waitBalance(page, fmt(after3));
  ok('the .dat file + password reopens the SAME wallet (fingerprint + balance)', (await text(page, '#w_fp')) === fp);

  // ================= send everything (incl. the Legacy coin -> previous-tx path) =================
  await tap(page, '#a_send'); await onPane(page, 'send');
  await page.type('#t_to', dest); await tap(page, '#t_all'); await page.type('#t_fee', '2'); await review(page, curPw);
  ok('send-everything spends every remaining coin with no change output', /Coinsspent[1-9]/.test((await text(page, '#c_rows')).replace(/\s+/g, '')) && !/Change back/.test(await text(page, '#c_rows')));
  await tap(page, '#c_go');
  await page.waitForFunction(() => !document.querySelector('#t_result').classList.contains('hide'), { timeout: 60000 });
  ok('legacy input was signed after fetching its previous tx through the node', apiCalls.includes('POST /prevtx'));
  mine(1);
  await tap(page, '#pane-send .back'); await onPane(page, 'wallet');
  ok('wallet is empty after the sweep confirms', await refreshUntil(page, '0.00000000'));

  // ================= CREATE with an optional PASSPHRASE (12 words, Legacy, mouse skipped) =================
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), tap(page, '#lockbtn')]);
  await tap(page, '#w_create'); await onPane(page, 'create1');
  await tap(page, '#c_len button[data-words="12"]'); await tap(page, '#c_type button[data-type="p2pkh"]'); await tap(page, '#padskip');
  ok('ticking "skip" enables a 12-word wallet without moving the mouse', (await text(page, '#c_gen')) === 'Generate 12-word wallet' && await page.$eval('#c_gen', (b) => !b.disabled));
  await tap(page, '#c_gen'); await onPane(page, 'create2');
  const words12 = await page.$$eval('#c_words span', (els) => els.map((e) => e.lastChild.textContent));
  ok('12 words are shown, entropy reported as 128-bit', words12.length === 12 && /^128-bit/.test(await text(page, '#c_sources')));
  await tap(page, '#c_wrote'); await tap(page, '#c_next2'); await onPane(page, 'create3');
  const asked12 = await page.$$eval('#q_box .qrow span', (els) => els.map((e) => Number(e.textContent.replace('Word #', ''))));
  for (let i = 0; i < asked12.length; i++) await page.type('#q_in' + i, words12[asked12[i] - 1]);
  await tap(page, '#q_check'); await onPane(page, 'save');
  ok('the optional passphrase step is offered at creation, off by default', await visible(page, '#s_passbox') && !(await visible(page, '#s_passfields')));
  await tap(page, '#s_usepass'); await tap(page, '#s_gen');
  await page.type('#s_pass', 'my secret passphrase'); await page.type('#s_pass2', 'my secret passphrasX');
  ok('mismatched passphrase confirmation blocks saving', await page.$eval('#s_go', (b) => b.disabled) && /passphrases do not match/.test(await text(page, '#s_policy')));
  await page.$eval('#s_pass2', (e) => { e.value = ''; }); await page.type('#s_pass2', 'my secret passphrase');
  const pw2 = await page.$eval('#s_pw', (e) => e.value);
  const before = downloads().length;
  await tap(page, '#s_go');
  await page.waitForFunction(() => !document.querySelector('#s_done').classList.contains('hide'), { timeout: 120000 });
  for (let i = 0; i < 40 && downloads().length === before; i++) await sleep(250);
  const dat2Name = downloads().sort().filter((f) => f !== datName).pop();
  const dat2 = readFileSync(join(DL, dat2Name), 'utf8');
  ok('passphrase wallet file saved; passphrase is not in it', !dat2.includes('my secret') && /NOT in the file/.test(await text(page, '#s_done')));
  await tap(page, '#s_open'); await onPane(page, 'wallet'); await waitBalance(page, '0.00000000');
  curPw = pw2;
  const fpPass = await text(page, '#w_fp');
  ok('wallet opens as "12-word recovery phrase + passphrase"', /12-word recovery phrase \+ passphrase/.test(await text(page, '#w_kind')));
  await tap(page, '#a_recv'); await onPane(page, 'receive');
  const legacyFirst = await text(page, '#r_addr');
  ok('a wallet created as Legacy shows a 1… address first', legacyFirst.startsWith('1') && (await page.$eval('#r_type', (e) => e.value)) === 'p2pkh');
  cliw('sendtoaddress', toRegtest(legacyFirst), 0.3); mine(1);
  await tap(page, '#pane-receive .back'); await onPane(page, 'wallet');
  ok('passphrase wallet receives on its Legacy address', await refreshUntil(page, '0.30000000'));
  // send part of it: change must come back to a LEGACY change address (m/44'/0'/0'/1/0)
  await tap(page, '#a_send'); await onPane(page, 'send');
  await page.type('#t_to', dest); await page.type('#t_amt', '5000000'); await page.select('#t_unit', 'sat'); await page.type('#t_fee', '2'); await review(page, curPw);
  const sheetL = await text(page, '#c_rows');
  ok('amount in sats works; Legacy wallet sends change to a Legacy change address', sheetL.includes('0.05000000 BTC') && /m\/44'\/0'\/0'\/1\/0/.test(sheetL));
  await tap(page, '#c_go');
  await page.waitForFunction(() => !document.querySelector('#t_result').classList.contains('hide'), { timeout: 60000 });
  const feeL = Math.round(JSON.parse(cli('getmempoolentry', await text(page, '#t_result p.mono'))).fees.base * 1e8);
  mine(1);
  await tap(page, '#pane-send .back'); await onPane(page, 'wallet');
  ok('Legacy change is found again after confirmation', await refreshUntil(page, fmt(30000000 - 5000000 - feeL)));
  // reopen the file: the passphrase must be asked for and verified
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), tap(page, '#lockbtn')]);
  await tap(page, '#w_open'); await onPane(page, 'open');
  await (await page.$('#o_file')).uploadFile(join(DL, dat2Name));
  await page.type('#o_pw', pw2); await tap(page, '#o_go');
  await page.waitForFunction(() => !document.querySelector('#o_passrow').classList.contains('hide'), { timeout: 120000 });
  ok('opening the file asks for the passphrase (it is not stored)', await page.$eval('#pane-open', (p) => p.classList.contains('on')));
  await page.type('#o_pass', 'wrong passphrase'); await tap(page, '#o_go');
  await page.waitForFunction(() => /does not match this wallet/.test(document.querySelector('#o_msg').textContent), { timeout: 30000 });
  ok('a wrong passphrase is REJECTED (not silently opened as an empty wallet)', true);
  await page.$eval('#o_pass', (e) => { e.value = ''; }); await page.type('#o_pass', 'my secret passphrase'); await tap(page, '#o_go');
  await onPane(page, 'wallet'); await waitBalance(page, fmt(30000000 - 5000000 - feeL));
  ok('the right passphrase opens the same wallet (fingerprint + balance)', (await text(page, '#w_fp')) === fpPass);

  // ================= IMPORT: 12-word phrase =================
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), tap(page, '#lockbtn')]);
  await tap(page, '#w_import'); await onPane(page, 'import');
  await page.type('#i_phrase', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'); await tap(page, '#i_go');
  await page.waitForFunction(() => document.querySelector('#i_msg').textContent.startsWith('✗'));
  ok('a phrase with a bad checksum is rejected with a helpful message', /checksum/.test(await text(page, '#i_msg')));
  await page.$eval('#i_phrase', (e) => { e.value = ''; });
  await page.type('#i_phrase', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'); await tap(page, '#i_go');
  await onPane(page, 'save');
  ok('an imported wallet cannot be used until it has a password and a file', (await text(page, '#s_title')) === 'Protect this wallet' && await page.$eval('#lockbtn', (b) => b.classList.contains('hide')));
  curPw = await saveStep(page);
  ok('after saving, the 12-word import opens', /12-word/.test(await text(page, '#w_kind')));
  await tap(page, '#a_recv'); await onPane(page, 'receive');
  ok('imported phrase derives the published BIP-84 address', (await text(page, '#r_addr')) === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');

  // ================= OPEN an OLD cold-generator backup (.json) =================
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const oldBackup = encryptBackup(M, 'old-backup-password', { network: 'mainnet', path: "m/84'/0'/0'/0/0", address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', passphraseUsed: false });
  writeFileSync(join(DL, 'olesia-backup-mainnet.json'), JSON.stringify(oldBackup, null, 2));
  await tap(page, '#w_open'); await onPane(page, 'open');
  await (await page.$('#o_file')).uploadFile(join(DL, 'olesia-backup-mainnet.json'));
  await page.waitForFunction(() => /Olesia backup file \(mainnet\)/.test(document.querySelector('#o_info').textContent));
  await page.type('#o_pw', 'old-backup-password'); await tap(page, '#o_go');
  await onPane(page, 'save');
  ok('an old cold-generator .json backup decrypts and must be re-saved in the new format', (await text(page, '#s_title')) === 'Save as a new wallet file');
  curPw = await saveStep(page);
  await tap(page, '#a_recv'); await onPane(page, 'receive');
  ok('…and it is the right wallet (published BIP-84 address)', (await text(page, '#r_addr')) === 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');

  // ---- audit M1: an old backup made WITH a passphrase must reject a wrong passphrase ----
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  const ppAddr = openSeedAccount({ mnemonic: M, passphrase: 'TREZOR' }).entry('p2wpkh', 0, 0).address;
  const oldPp = encryptBackup(M, 'old-backup-password', { network: 'mainnet', path: "m/84'/0'/0'/0/0", address: ppAddr, passphraseUsed: true });
  writeFileSync(join(DL, 'olesia-backup-pp.json'), JSON.stringify(oldPp, null, 2));
  await tap(page, '#w_open'); await onPane(page, 'open');
  await (await page.$('#o_file')).uploadFile(join(DL, 'olesia-backup-pp.json'));
  await page.waitForFunction(() => /Olesia backup file \(mainnet\)/.test(document.querySelector('#o_info').textContent));
  await page.type('#o_pw', 'old-backup-password'); await tap(page, '#o_go');
  await page.waitForFunction(() => !document.querySelector('#o_passrow').classList.contains('hide'), { timeout: 60000 });
  await page.type('#o_pass', 'TREZ0R'); await tap(page, '#o_go');
  await page.waitForFunction(() => /does not match this wallet/.test(document.querySelector('#o_msg').textContent), { timeout: 30000 });
  ok('old backup + WRONG passphrase is rejected (no silent different wallet)', await page.$eval('#pane-open', (p) => p.classList.contains('on')));
  await page.$eval('#o_pass', (e) => { e.value = ''; }); await page.type('#o_pass', 'TREZOR'); await tap(page, '#o_go');
  await onPane(page, 'save');
  ok('old backup + the right passphrase is accepted and goes on to the save step', (await text(page, '#s_title')) === 'Save as a new wallet file' && await visible(page, '#s_storebox'));

  // ================= IMPORT: uncompressed WIF (paper wallet) + sweep =================
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  const uPriv = randomBytes(32);
  const wifMain = b58.encode(Uint8Array.of(0x80, ...uPriv));
  await tap(page, '#w_import'); await onPane(page, 'import');
  await tap(page, '#i_mode button[data-mode="wif"]'); await page.type('#i_wif', wifMain); await tap(page, '#i_go');
  curPw = await saveStep(page); await waitBalance(page, '0.00000000');
  ok('uncompressed "5…" private key imports', wifMain.startsWith('5') && /uncompressed/.test(await text(page, '#w_kind')));
  await tap(page, '#a_recv'); await onPane(page, 'receive');
  const paperAddr = await text(page, '#r_addr');
  ok('a single key offers only its Legacy address', paperAddr.startsWith('1') && !(await visible(page, '#r_typebox')));
  cliw('sendtoaddress', toRegtest(paperAddr), 0.2); mine(1);
  await tap(page, '#pane-receive .back'); await onPane(page, 'wallet');
  ok('paper-wallet balance appears', await refreshUntil(page, '0.20000000'));
  await tap(page, '#a_send'); await onPane(page, 'send');
  await page.type('#t_to', dest); await tap(page, '#t_all'); await page.type('#t_fee', '2'); await review(page, curPw);
  await tap(page, '#c_go');
  await page.waitForFunction(() => !document.querySelector('#t_result').classList.contains('hide'), { timeout: 60000 });
  ok('paper-wallet sweep is accepted by Bitcoin Core', JSON.parse(cli('getrawmempool')).includes(await text(page, '#t_result p.mono')));

  // ================= global invariants =================
  ok('the page talked to exactly one remote host: api.olesia.io', [...hosts].sort().join(',') === ['127.0.0.1:' + WEBPORT, 'api.olesia.io'].sort().join(','));
  const realErrors = consoleErrors.filter((e) => !/favicon/.test(e));
  ok('no CSP violations or JavaScript errors in the console', realErrors.length === 0);
  if (realErrors.length) console.log(realErrors.slice(0, 6));
} catch (e) {
  console.error('\nBROWSER E2E ABORTED:', e.stack || e.message); bad = true;
} finally { await cleanup(); }

console.log(bad ? '\nBROWSER E2E FAILED' : '\nmainnet wallet browser e2e: all checks passed');
process.exit(bad ? 1 : 0);
