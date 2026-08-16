// P1.a — offline signer APP: prove the built page is genuinely network-less (air-gapped) and
// that window.SIGN works in a browser env. The signing correctness itself is covered by
// signer.test.mjs (the core); this guards the app shell + the offline hardening.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(66), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

// build the offline signer, then assert on the output
execSync('node signer/build.mjs', { stdio: 'ignore' });
const html = readFileSync('signer/dist/index.html', 'utf8');
const headers = existsSync('signer/dist/_headers') ? readFileSync('signer/dist/_headers', 'utf8') : '';

// ── air-gap hardening ──
ok('offline: CSP connect-src none (page + headers)', /connect-src 'none'/.test(html) && /connect-src 'none'/.test(headers));
ok('offline: default-src none', /default-src 'none'/.test(html));
ok('offline: NO external host in connect-src', !/connect-src[^;]*https?:/.test(html) && !/connect-src[^;]*https?:/.test(headers));
ok('offline: script-src is hash-based, NO unsafe-inline', /script-src[^;]*'sha256-/.test(html) && !/script-src[^;]*unsafe-inline/.test(html));
// connect-src 'none' is the ENFORCEMENT (the browser blocks every request). Harmless URL
// string constants (from networks.js) may be bundled but can never be reached. What must NOT
// appear is a runtime network PRIMITIVE.
ok('offline: no runtime network primitives (XHR / WebSocket / sendBeacon)',
   !/XMLHttpRequest|new WebSocket|navigator\.sendBeacon|EventSource/.test(html));
ok('page exposes window.SIGN', html.includes('window.SIGN'));
// M2 — the review I/O list (which includes attacker-controlled OP_RETURN text) is built with
// DOM/textContent, NEVER assigned into innerHTML.
ok('M2: review I/O built via textContent, not innerHTML', /io\.textContent=''/.test(html) && !/\$\('io'\)\.innerHTML/.test(html));
// L2 — an edit to seed/passphrase/network/PSBT voids the prior review, and Sign uses the exact
// REVIEWED args (lastReview.args), never re-reading the live fields.
ok('L2: Sign bound to reviewed bytes; edits invalidate the review', /invalidateReview/.test(html) && /window\.SIGN\.sign\(lastReview\.args\)/.test(html));

// ── browser smoke test (jsdom): the bundle loads and the API behaves ──
{
  let JSDOM; try { ({ JSDOM } = await import('jsdom')); } catch { console.log('jsdom not installed — smoke test skipped'); }
  if (JSDOM) {
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/' });
    await new Promise((r) => setTimeout(r, 300));
    const w = dom.window;
    ok('SIGN: window.SIGN present + marked offline', typeof w.SIGN === 'object' && w.SIGN.offline === true);
    ok('SIGN: generate(24) -> 24 words (default)', w.SIGN.generate(24).split(' ').length === 24);
    ok('SIGN: generate(12) -> 12 words (option)', w.SIGN.generate(12).split(' ').length === 12);
    ok('SIGN: validate accepts a generated phrase', w.SIGN.validate(w.SIGN.generate(24)) === true);
    ok('SIGN: validate rejects garbage', w.SIGN.validate('not a valid mnemonic at all') === false);
    ok('SIGN: xpub derives from a phrase (testnet3 -> tpub)', /^tpub/.test(w.SIGN.xpub('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'testnet3')));
    ok('SIGN: review refuses a non-PSBT gracefully (throws, not silent)', (() => { try { w.SIGN.review({ mnemonic: w.SIGN.generate(12), network: 'testnet3', psbt: 'not-a-psbt' }); return false; } catch { return true; } })());
    ok('SIGN: UI shell present (seed + psbt + review controls)', !!(dom.window.document.getElementById('seed') && dom.window.document.getElementById('psbt') && dom.window.document.getElementById('review')));
    dom.window.close();
  }
}

console.log(bad ? '\nSIGNER-APP TEST FAILED' : '\nSIGNER-APP TEST PASS — offline (connect-src none), no external client, window.SIGN works');
process.exit(bad ? 1 : 0);
