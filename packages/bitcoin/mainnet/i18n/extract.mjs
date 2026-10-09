// Builds mainnet/i18n/en.json — every English string the page can show, as translation keys —
// and checks the other dictionaries against it. Run from packages/bitcoin after a build:
//   node mainnet/i18n/extract.mjs            # writes en.json, reports untranslated keys per language
//   node mainnet/i18n/extract.mjs --check    # exit 1 if any dictionary is incomplete or malformed
// Sources: the built page's markup (walked in headless Chrome by i18n.js itself, so the keys are
// exactly what the runtime will look up), tr('…') calls in ui.js, the figure tags, and the
// engine's user-facing messages (errors, notes, labels) in src/ and entry.js.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';

const DIR = 'mainnet/i18n';
const check = process.argv.includes('--check');

// 1. the markup units, by running the real walker in the real page
const require = createRequire(process.env.PUPPETEER_FROM || '/home/faucet/controlpoint/');
const puppeteer = require('puppeteer');
const CHROME = process.env.CHROME || '/home/faucet/.cache/puppeteer/chrome/linux-151.0.7922.77/chrome-linux64/chrome';
const html = readFileSync('mainnet/publish/index.html', 'utf8');
const web = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on('request', (r) => (r.url().startsWith('http://127.0.0.1:' + web.address().port) ? r.continue() : r.respond({ status: 502, body: '{}' })));
await page.goto(`http://127.0.0.1:${web.address().port}/`, { waitUntil: 'load' });
const { keys: markup, orphans } = await page.evaluate(() => window.OI18N.keys());
await browser.close(); web.close();
if (orphans.length) { console.error('text the walker cannot reach (wrap it in its own element):'); orphans.forEach((o) => console.error('  ', o)); if (check) process.exit(1); }

// 2. script strings
const ui = readFileSync('mainnet/ui.js', 'utf8');
const unq = (s) => s.replace(/\\(['"\\])/g, '$1');
const script = new Set();
for (const m of ui.matchAll(/\btr\((?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) script.add(unq(m[1] ?? m[2]));
for (const m of ui.matchAll(/\btag: '((?:[^'\\]|\\.)*)'/g)) script.add(unq(m[1]));
for (const m of ui.matchAll(/\b[kt]: '((?:[^'\\]|\\.)*)'/g)) script.add(unq(m[1]));              // the opening's chapter keys and titles
for (const m of ui.matchAll(/\bp: '((?:[^'\\]|\\.)*)'/g)) script.add(unq(m[1]));                 // and their paragraphs

// 3. the engine's messages: static Error strings and prose literals in the wallet sources
const engine = new Set();
const SRC = ['src/entropy.js', 'src/walletfile.js', 'src/account.js', 'src/session.js', 'src/locked.js', 'src/nodeapi.js', 'src/vanity.js', 'src/message.js', 'src/privacy.js', 'src/paper.js', 'mainnet/entry.js'];
const prose = (s) => /\p{L}{3,}/u.test(s) && /[ .]/.test(s) && !/^[\w./:-]+$/.test(s) && !/\$\{/.test(s) && s.length >= 4;
for (const f of SRC) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/new Error\((?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\)/g)) engine.add(unq(m[1] ?? m[2]));
  for (const m of src.matchAll(/(?:title|detail|advice|summary|note|why|label|long|hint|reason|lookalikes|text|typeLabel|TYPE_LABEL\[[^\]]+\]|issues\.push|notes\.push|errors\.push|suggestions\.push)\s*[:(=]\s*\(?\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) { const v = unq(m[1] ?? m[2]); if (prose(v)) engine.add(v); }
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.){12,})'/g)) { const v = unq(m[1]); if (prose(v) && !/[{}();=]|=>|\.\w+\(/.test(v)) engine.add(v); }
}
const TYPE_LABELS = ['Native SegWit', 'Legacy', 'P2PK', 'Legacy (uncompressed)', 'Taproot', 'Wrapped SegWit', 'bare public key'];
TYPE_LABELS.forEach((x) => engine.add(x));
['second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'under a second', 'less than a second', 'about {n} {unit}'].forEach((x) => engine.add(x));

const NEVER = new Set(['BTC', 'tBTC', 'sBTC', 'Bitcoin Signed Message:\n', 'sat/vB', 'Olesia']);   // protocol constants and names stay as they are
const junk = (k) => !k || !/\p{L}/u.test(k) || /^[\s,]/.test(k) || /\n/.test(k) || /: $/.test(k) || NEVER.has(k);
const all = [...new Set([...markup, ...script, ...engine])].filter((k) => !junk(k)).sort((a, b) => a.localeCompare(b, 'en'));
const en = Object.fromEntries(all.map((k) => [k, k]));
if (!check) writeFileSync(`${DIR}/en.json`, JSON.stringify(en, null, 1) + '\n');
console.log(`en.json: ${all.length} strings (markup ${markup.length}, script ${script.size}, engine ${engine.size}) · ${all.reduce((n, k) => n + k.split(/\s+/).length, 0)} words`);

// 4. every other dictionary: complete, strings only, placeholders and element numbers preserved
const tags = (s) => (s.match(/<\d+\/?>|<\/\d+>|\{\w+\}/g) || []).sort().join(' ');
let bad = false;
for (const f of readdirSync(DIR).filter((x) => /^[a-z]{2}(-[A-Za-z]+)?\.json$/.test(x) && x !== 'en.json').sort()) {
  let d; try { d = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')); } catch (e) { console.error(`${f}: not JSON (${e.message})`); bad = true; continue; }
  const missing = all.filter((k) => typeof d[k] !== 'string' || !d[k].trim());
  const extra = Object.keys(d).filter((k) => !(k in en));
  const broken = all.filter((k) => typeof d[k] === 'string' && tags(d[k]) !== tags(k));
  const same = all.filter((k) => d[k] === k && /\p{L}{4,}/u.test(k) && k.split(' ').length > 2);
  const line = `${f.padEnd(14)} ${String(Object.keys(d).length).padStart(5)} entries · missing ${missing.length} · extra ${extra.length} · placeholders broken ${broken.length} · identical to English ${same.length}`;
  console.log(line);
  if (missing.length || broken.length) bad = true;
  if (process.argv.includes('--verbose')) { missing.slice(0, 20).forEach((k) => console.log('   missing:', k)); broken.slice(0, 20).forEach((k) => console.log('   broken:', k, '→', d[k])); }
}
if (check && bad) { console.error('dictionaries incomplete'); process.exit(1); }
