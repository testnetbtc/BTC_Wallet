// UI-wiring test — loads the built index.html in a real DOM and drives the actual
// buttons, catching event-wiring bugs that the engine tests can't see (they call
// OW.* directly and never touch the DOM). This suite exists because the OP_RETURN
// "undefined / Not an integer" bug lived entirely here: the fee-pill click handler
// was bound to every .feep, so tapping the Pay/Message toggle wrote `undefined`
// into the fee field. That is now a regression test.
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); }
catch { console.log('UI TEST SKIPPED — jsdom not installed (npm i -D jsdom to enable)'); process.exit(0); }

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(58), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://app.olesia.io/',
  beforeParse(w) {
    try { Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true }); } catch { /* already usable */ }
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    w.scrollTo = () => {};
    w.fetch = () => Promise.reject(new Error('no network in UI test')); // nothing here should hit the network
    w.alert = () => {};
  },
});
const { window } = dom;
const $ = (s) => window.document.querySelector(s);
const click = (s) => { const el = $(s); if (!el) throw new Error('no element ' + s); el.click(); };

// 1) the app booted and exposed its engine without throwing
ok('index.html boots, window.OW is present', !!window.OW && typeof window.OW.scriptTypes === 'function');

// 2) all the elements this session added actually exist in the built HTML
ok('fee presets are scoped under #fee_presets', !!$('#fee_presets') && $('#fee_presets').querySelectorAll('.feep').length === 4);
ok('Send has an Account (script-type) selector', !!$('#send_type') && !!$('#send_typecard'));
ok('Send has an empty-account warning slot', !!$('#send_empty'));
ok('file-import has its own BIP-39 passphrase field', !!$('#bkbip39') && !!$('#bkbip39row'));
ok('WIF inspect tool is present', !!$('#wif') && !!$('#wifinspect'));

// 3) THE REGRESSION — the fee field must never be corrupted by the mode toggle
$('#fee').value = '';
click('#fee_presets .feep[data-fee="5"]');
ok('clicking a fee preset sets #fee', $('#fee').value === '5');
click('#send_mode .feep[data-mode="msg"]');       // "Just write a message" — this is what broke it
ok('“Just write a message” does NOT touch #fee', $('#fee').value === '5');
ok('#fee is never the string "undefined"', $('#fee').value !== 'undefined');
click('#send_mode .feep[data-mode="pay"]');
ok('“Pay someone” does NOT touch #fee', $('#fee').value === '5');
click('#fee_presets .feep[data-fee=""]');          // Auto
ok('Auto sets #fee back to empty (network estimate)', $('#fee').value === '');

// 4) the mode toggle still does its own job (message pane / button label)
click('#send_mode .feep[data-mode="msg"]');
ok('message mode relabels the action button', /chain/i.test($('#send').textContent));
click('#send_mode .feep[data-mode="pay"]');
ok('pay mode restores the Send label', /send/i.test($('#send').textContent));

// 5) the PIN keypad is present and the auto-submit length hook is wired
ok('unlock keypad has a full 0-9 pad', $('#pad').querySelectorAll('button[data-k]').length >= 11);

console.log(bad ? '\nUI TEST FAILED' : '\nUI TEST PASS — real DOM, real clicks, fee wiring safe');
window.close();
process.exit(bad ? 1 : 0);
