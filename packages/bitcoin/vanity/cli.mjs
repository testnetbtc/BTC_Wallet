#!/usr/bin/env node
// Olesia Vanity — offline script. Built by mainnet/build.mjs into ONE self-contained file
// (mainnet/publish/olesia-vanity.mjs) with no dependencies beyond Node.js itself.
//
//   node olesia-vanity.mjs bc1qjon              SegWit address starting bc1qjon
//   node olesia-vanity.mjs 1Jon --ignore-case   Legacy address, any capitalisation of "Jon"
//   node olesia-vanity.mjs 1Jon --threads 4 --out my-key.txt
//   node olesia-vanity.mjs --estimate bc1qolesja
//   node olesia-vanity.mjs --check               self-test, then exit
//
// The result is written to a file only you can read (mode 0600) — never printed unless --print.
// Randomness: node:crypto randomBytes (the OS CSPRNG). Nothing is sent anywhere; run it offline.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { analyzePattern, createSearch, benchmark, estimate, humanTime, addressOf, addressFromHash160, hash160 } from '../src/vanity.js';
import { secp256k1 } from '@noble/curves/secp256k1';

const VERSION = '1.0';

// ---------------------------------------------------------------- worker side
if (!isMainThread) {
  const { type, text, ignoreCase } = workerData;
  const analysis = analyzePattern({ type, text, ignoreCase });
  const search = createSearch({ analysis, randomBytes });
  let reported = 0n, last = Date.now();
  for (;;) {
    const r = search.step(8192);
    if (r) { parentPort.postMessage({ found: { wif: r.found.wif, address: r.found.address }, tried: Number(search.tried - reported) }); break; }
    if (Date.now() - last > 500) { parentPort.postMessage({ progress: Number(search.tried - reported) }); reported = search.tried; last = Date.now(); }
  }
}

// ---------------------------------------------------------------- main side
function selfTest() {
  const results = [];
  const t = (name, f) => { let ok = false; try { ok = !!f(); } catch { ok = false; } results.push([name, ok]); };
  const one = new Uint8Array(32); one[31] = 1;
  const pub = secp256k1.getPublicKey(one, true);
  t('known key → Legacy address', () => addressOf(pub, 'p2pkh') === '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH');
  t('known key → SegWit address', () => addressOf(pub, 'p2wpkh') === 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  t('hash160 of G', () => Buffer.from(hash160(pub)).toString('hex') === '751e76e8199196d454941c45d1b3a323f1433bd6');
  t('finds a SegWit pattern and the result re-derives', () => {
    const a = analyzePattern({ type: 'p2wpkh', text: 'q' }); const s = createSearch({ analysis: a, randomBytes });
    let r = null; while (!r) r = s.step(1024);
    return r.found.address.startsWith('bc1qq') && addressOf(secp256k1.getPublicKey(r.found.privKey, true), 'p2wpkh') === r.found.address;
  });
  t('finds a Legacy pattern (ignore case) and the result re-derives', () => {
    const a = analyzePattern({ type: 'p2pkh', text: 'a', ignoreCase: true }); const s = createSearch({ analysis: a, randomBytes });
    let r = null; while (!r) r = s.step(1024);
    return /^1[Aa]/.test(r.found.address) && addressOf(secp256k1.getPublicKey(r.found.privKey, true), 'p2pkh') === r.found.address;
  });
  t('exact difficulty agrees with sampling (Legacy "1A")', () => {
    const a = analyzePattern({ type: 'p2pkh', text: 'A' }); let hits = 0; const n = 20000;
    for (let i = 0; i < n; i++) { if (addressFromHash160(randomBytes(20), 'p2pkh').startsWith('1A')) hits++; }
    const want = n * a.probability; return Math.abs(hits - want) < 6 * Math.sqrt(want);
  });
  return results;
}

function usage() {
  console.log(`Olesia Vanity ${VERSION} — offline vanity address search
usage: node olesia-vanity.mjs <pattern> [--ignore-case] [--threads N] [--out FILE] [--print]
       node olesia-vanity.mjs --estimate <pattern>
       node olesia-vanity.mjs --check | --bench
pattern: bc1q… (SegWit, lower-case) or 1… (Legacy). Default --out: olesia-vanity-result.txt (mode 0600).`);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, (v && !v.startsWith('--')) ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
  const own = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  console.log(`Olesia Vanity ${VERSION}   this file's SHA-256: ${own}`);
  console.log('Compare it with the hash shown on olesia.io before trusting this file.\n');
  if (flag('--help') || flag('-h')) return usage();
  if (flag('--check')) {
    const res = selfTest(); for (const [n, ok] of res) console.log((ok ? '  ✓ ' : '  ✗ ') + n);
    const bad = res.filter((r) => !r[1]).length; console.log(bad ? `\n${bad} check(s) FAILED — do not use this file` : '\nall checks passed'); process.exit(bad ? 1 : 0);
  }
  if (flag('--bench')) { console.log('measuring (one thread)…'); console.log(`${benchmark({ randomBytes, ms: 3000 })} keys/s per thread · ${cpus().length} CPU threads on this machine`); return; }
  const estimateOnly = flag('--estimate');
  const ignoreCase = !!flag('--ignore-case');
  const threads = Math.max(1, parseInt(flag('--threads') || String(Math.max(1, cpus().length - 1)), 10) || 1);
  const out = flag('--out') || 'olesia-vanity-result.txt';
  const print = !!flag('--print');
  const pattern = (estimateOnly !== true && estimateOnly) || args.find((a) => !a.startsWith('--'));
  if (!pattern) return usage();
  const type = /^bc1q/i.test(pattern) ? 'p2wpkh' : pattern.startsWith('1') ? 'p2pkh' : null;
  if (!type) { console.error('the pattern must start with bc1q (SegWit) or 1 (Legacy)'); process.exit(2); }
  const a = analyzePattern({ type, text: type === 'p2pkh' ? pattern.slice(1) : pattern, ignoreCase });
  if (!a.ok) {
    console.error('✗ ' + a.errors.join('\n✗ '));
    for (const s of a.suggestions || []) console.error(`  try instead: ${s.text}   (${s.why}; about 1 in ${Math.round(s.difficulty).toLocaleString()} keys)`);
    process.exit(2);
  }
  for (const n of a.notes || []) console.log('note: ' + n);
  console.log(`searching for ${a.display}${a.ignoreCase ? ' (any capitalisation)' : ''} — about 1 in ${a.difficultyHuman} keys match`);
  const rate1 = benchmark({ randomBytes, ms: 1500 });
  const est = estimate(a.difficulty, rate1 * threads);
  console.log(`this machine: ~${rate1.toLocaleString()} keys/s per thread × ${threads} threads → expected ${est.expected}, very likely within ${est.likely}`);
  console.log(est.note);
  if (estimateOnly) return;
  console.log('\nrunning — press Ctrl-C to stop. The key is written only to the result file.\n');
  const t0 = Date.now(); let tried = 0; let done = false;
  const workers = [];
  const finish = (found) => {
    if (done) return; done = true;
    for (const w of workers) w.terminate();
    const secs = (Date.now() - t0) / 1000;
    console.log(`\n\nfound after ${tried.toLocaleString()} keys in ${humanTime(secs)}`);
    console.log(`address: ${found.address}`);
    const body = `Olesia Vanity ${VERSION} result\naddress: ${found.address}\nprivate key (WIF): ${found.wif}\n\nImport: olesia.io → Import a wallet → Private key (WIF). Then delete this file securely.\n`;
    if (print) { console.log(`private key (WIF): ${found.wif}`); console.log('(this key is now in your terminal history — clear it)'); }
    else { writeFileSync(out, body, { mode: 0o600 }); console.log(`private key written to ${out} (readable only by you). Import it, then delete the file.`); }
  };
  for (let i = 0; i < threads; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { type, text: a.text, ignoreCase } });
    w.on('message', (m) => { if (m.progress) tried += m.progress; if (m.found) { tried += m.tried; finish(m.found); } });
    w.on('error', (e) => { console.error('worker error:', e.message); });
    workers.push(w);
  }
  const tick = setInterval(() => {
    if (done) return clearInterval(tick);
    const secs = (Date.now() - t0) / 1000, rate = tried / Math.max(secs, 0.001);
    const p = 1 - Math.exp(-tried / a.difficulty);
    process.stdout.write(`\r  ${tried.toLocaleString()} keys · ${Math.round(rate).toLocaleString()} keys/s · ${humanTime(secs)} elapsed · ${(100 * p).toFixed(1)}% chance it would have been found by now   `);
  }, 1000);
}
if (isMainThread) main().catch((e) => { console.error(e.message || e); process.exit(1); });
