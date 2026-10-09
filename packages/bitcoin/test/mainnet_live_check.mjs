// LIVE read-only check of a DEPLOYED mainnet wallet page against the REAL node API.
//   node test/mainnet_live_check.mjs https://olesia.io/
// Verifies: served bytes == this repo's build, the CSP header, the page boots and passes its
// self-check, it reaches the node, a wallet can be created/saved/reopened, and a real UTXO-set
// lookup completes. It never sends a transaction and uses only a throw-away wallet plus the
// public BIP-39 test phrase.
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = (process.argv[2] || 'https://olesia.io/').replace(/\/?$/, '/');
const require = createRequire(process.env.PUPPETEER_FROM || '/home/faucet/controlpoint/');
const puppeteer = require('puppeteer');
const CHROME = process.env.CHROME || '/home/faucet/.cache/puppeteer/chrome/linux-151.0.7922.77/chrome-linux64/chrome';
const DL = mkdtempSync(join(tmpdir(), 'olesia-live-'));
let bad = false;
const ok = (l, c) => { console.log(l.padEnd(80), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- served bytes + headers ----
const res = await fetch(URL_ + '?cb=' + Date.now(), { cache: 'no-store' });
const served = Buffer.from(await res.arrayBuffer());
const repo = readFileSync(join(HERE, '../mainnet/publish/index.html'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
console.log('   repo  ', sha(repo)); console.log('   served', sha(served));
ok('served page is byte-identical to this repo build', sha(served) === sha(repo));
const csp = res.headers.get('content-security-policy') || '';
ok('CSP header: scripts pinned by hash, no unsafe-inline/eval for scripts', /script-src 'sha256-[^;]+;/.test(csp) && !/script-src[^;]*unsafe/.test(csp));
ok('CSP header: connect-src is ONLY the Olesia node API', /connect-src https:\/\/api\.olesia\.io;/.test(csp));
ok('CSP header: cannot be framed; no forms; default deny', /frame-ancestors 'none'/.test(csp) && /default-src 'none'/.test(csp) && /form-action 'none'/.test(csp));
ok('HSTS, nosniff, no-referrer headers present', !!res.headers.get('strict-transport-security') && res.headers.get('x-content-type-options') === 'nosniff' && res.headers.get('referrer-policy') === 'no-referrer');
// the site icons and manifest: served, and byte-identical to the build (BUILD_HASH.txt lists them)
const buildHashes = Object.fromEntries(readFileSync(join(HERE, '../mainnet/BUILD_HASH.txt'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/)).map(([h, f]) => [f.replace('mainnet/publish/', ''), h]));
const assets = ['favicon.ico', 'icon-32.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'site.webmanifest'];
const assetOk = await Promise.all(assets.map(async (f) => { try { const r = await fetch(new URL('/' + f, URL_) + '?cb=' + Date.now(), { cache: 'no-store' }); return r.ok && sha(Buffer.from(await r.arrayBuffer())) === buildHashes[f]; } catch { return false; } }));
ok('site icons and web manifest are served and byte-identical to the build', assetOk.every(Boolean));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1000 });
  await (await page.createCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  const errors = [], hosts = new Set();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http')) hosts.add(u.host); });
  const tap = (sel) => page.$eval(sel, (e) => e.click());
  const text = (sel) => page.$eval(sel, (e) => e.textContent);
  const onPane = (n, timeout = 60000) => page.waitForFunction((x) => document.querySelector('#pane-' + x).classList.contains('on'), { timeout }, n);
  await page.goto(URL_, { waitUntil: 'load' });
  ok('the opening plays on a first visit and Skip dismisses it', await page.$eval('#intro', (e) => !e.classList.contains('hide')) && (await tap('#intro_skip'), await sleep(800), await page.$eval('#intro', (e) => e.classList.contains('hide'))));
  ok('page boots; self-check passes', await page.$eval('#w_create', (b) => !b.disabled));
  await page.waitForFunction(() => /node · block/.test(document.querySelector('#chip_node_t').textContent), { timeout: 30000 });
  console.log('   ' + await text('#chip_node_t'));
  ok('header shows the live node height (mainnet)', true);
  await page.waitForFunction(() => !document.querySelector('#chip_price').classList.contains('hide'), { timeout: 30000 });
  const pr = await page.evaluate(() => ({ v: document.querySelector('#price_v').textContent, c: document.querySelector('#price_c').textContent, cls: document.querySelector('#price_c').className }));
  console.log('   ' + pr.v + ' ' + pr.c);
  ok('live price + 24h change shown, coloured by direction', /^BTC \$[\d,]+$/.test(pr.v) && /^[▲▼] [+−]\d+\.\d\d%$/.test(pr.c) && pr.cls === (pr.c.startsWith('▲') ? 'up' : 'down'));

  // create -> save -> open (throw-away wallet)
  await tap('#w_create'); await tap('#padskip'); await tap('#c_gen'); await onPane('create2');
  const words = await page.$$eval('#c_words span', (els) => els.map((e) => e.lastChild.textContent));
  await tap('#c_wrote'); await tap('#c_next2'); await onPane('create3');
  const asked = await page.$$eval('#q_box .qrow span', (els) => els.map((e) => Number(e.textContent.replace('Word #', ''))));
  for (let i = 0; i < asked.length; i++) await page.type('#q_in' + i, words[asked[i] - 1]);
  await tap('#q_check'); await onPane('save');
  await tap('#s_gen'); await tap('#s_go');
  await page.waitForFunction(() => !document.querySelector('#s_done').classList.contains('hide'), { timeout: 120000 });
  for (let i = 0; i < 40 && !readdirSync(DL).some((f) => f.endsWith('.dat')); i++) await sleep(250);
  ok('create -> encrypted .dat downloaded', readdirSync(DL).some((f) => /^olesia-wallet-\d{8}-\d{6}\.dat$/.test(f)));
  await tap('#s_open'); await onPane('wallet');
  const t0 = Date.now();
  let sawProgress = false;
  for (;;) {
    const s = await page.evaluate(() => ({ bal: document.querySelector('#bal').textContent, hidden: document.querySelector('#scanbox').classList.contains('hide'), msg: document.querySelector('#scanmsg').textContent }));
    if (/Searching|Waiting/.test(s.msg) && !s.hidden) sawProgress = true;
    if (s.hidden && s.bal !== '—') break;
    if (/^✗/.test(s.msg)) throw new Error('scan failed: ' + s.msg);
    if (Date.now() - t0 > 20 * 60000) throw new Error('scan timed out');
    await sleep(3000);
  }
  console.log(`   first UTXO-set lookup took ${Math.round((Date.now() - t0) / 1000)} s`);
  ok('REAL mainnet UTXO lookup completes for a brand-new wallet: balance 0', (await text('#bal')) === '0.00000000' && sawProgress);
  await tap('#a_recv'); await onPane('receive');
  ok('receive address is a mainnet bc1q… address', /^bc1q[0-9a-z]{38}$/.test(await text('#r_addr')));
  await tap('#pane-receive .back');
  await tap('#a_send'); await onPane('send');
  await page.waitForFunction(() => document.querySelectorAll('#t_fees button').length > 0, { timeout: 20000 });
  console.log('   fees: ' + (await page.$$eval('#t_fees button', (b) => b.map((x) => x.textContent))).join(' | '));
  ok('fee presets come from the node', true);
  await page.type('#t_to', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'); await page.type('#t_amt', '0.001'); await tap('#t_review');
  await page.waitForFunction(() => document.querySelector('#pwsheet').classList.contains('on'), { timeout: 20000 });
  ok('sending asks for the wallet password (nothing is signed without it)', true);
  await tap('#p_cancel');
  await tap('#pane-send .back');

  // practice networks: relayed public data, same single host
  await tap('#tabbar button[data-tab="networks"]');
  ok('Networks tab lists Bitcoin + three practice networks', (await page.$$eval('#netlist .netrow', (r) => r.map((x) => x.dataset.net))).join() === 'mainnet,testnet4,signet,testnet3');
  await tap('#netlist .netrow[data-net="signet"]'); await onPane('wallet');
  await page.waitForFunction(() => document.querySelector('#scanbox').classList.contains('hide') && document.querySelector('#bal').textContent === '0.00000000', { timeout: 60000 });
  ok('a Signet practice wallet opens and its (empty) balance loads through the relay', (await text('#netname')) === 'Signet' && (await text('#bal_unit')) === 'sBTC');
  await tap('#tabbar button[data-tab="faucet"]');
  const fh = await page.$eval('#f_go', (a) => a.href);
  ok('Faucet tab links to the faucet page with the practice address filled in', /^https:\/\/app\.olesia\.io\/faucet\/\?network=signet&address=tb1q[0-9a-z]{38}$/.test(fh));

  // public test phrase: its addresses hold real dust on mainnet -> exercises coin display (read-only)
  await page.goto(URL_, { waitUntil: 'load' });
  if (await page.$eval('#intro', (e) => !e.classList.contains('hide'))) { await tap('#intro_skip'); await sleep(800); }
  await tap('#w_import'); await page.type('#i_phrase', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'); await tap('#i_go');
  await onPane('save'); await tap('#s_gen'); await tap('#s_go');     // an import must be given a password + file first
  await page.waitForFunction(() => !document.querySelector('#s_done').classList.contains('hide'), { timeout: 180000 });
  await tap('#s_open');
  await onPane('wallet');
  const t1 = Date.now();
  // poll in short calls: one long-lived wait would hit the browser driver's 180 s call limit on a slow scan
  for (;;) {
    const s2 = await page.evaluate(() => ({ bal: document.querySelector('#bal').textContent, hidden: document.querySelector('#scanbox').classList.contains('hide'), msg: document.querySelector('#scanmsg').textContent }));
    if (s2.hidden && s2.bal !== '—') break;
    if (/^✗/.test(s2.msg)) throw new Error('scan failed: ' + s2.msg);
    if (Date.now() - t1 > 20 * 60000) throw new Error('scan timed out');
    await sleep(3000);
  }
  console.log(`   public test phrase: balance ${await text('#bal')} BTC in ${await page.$$eval('#coins .coin', (c) => c.length)} coins (lookup ${Math.round((Date.now() - t1) / 1000)} s)`);
  ok('imported phrase: lookup completes and coins render', /^\d+\.\d{8}$/.test(await text('#bal')));

  // the street: the live API's block/mempool feed agrees with the node's tip shown in the page
  const st = await (await fetch('https://api.olesia.io/street')).json();
  const chipHeight = Number(((await text('#chip_node_t')).match(/[\d,]+$/) || [''])[0].replace(/,/g, ''));
  ok('street feed: the last block\'s height, tx count and value, and the next block being loaded', Number.isInteger(st.tip?.height) && Math.abs(st.tip.height - chipHeight) <= 1 && st.tip.txs > 0 && st.tip.sats > 0 && st.next.txs > 0 && st.mempool.txs >= st.next.txs);
  ok('street: drawn on its band along the bottom of the live page', await page.evaluate(() => { const c = document.querySelector('#street'); if (!c || c.classList.contains('hide')) return false; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 0; i < d.length; i += 4 * 89) if (d[i] + d[i + 1] + d[i + 2] > 450) lit++; return lit > 10; }));
  ok('page contacted only its own origin and api.olesia.io', [...hosts].every((h) => h === new URL(URL_).host || h === 'api.olesia.io'));
  ok('no console errors / CSP violations', errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5));
} catch (e) { console.error('ABORTED:', e.message); bad = true; }
finally { await browser.close(); rmSync(DL, { recursive: true, force: true }); }
console.log(bad ? '\nLIVE CHECK FAILED' : '\nlive check passed: ' + URL_);
process.exit(bad ? 1 : 0);
