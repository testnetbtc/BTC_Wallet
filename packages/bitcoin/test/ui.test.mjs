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
    // no real network: every fetch resolves non-ok so engine calls fail cleanly
    w.fetch = () => Promise.resolve({ ok: false, status: 599, text: async () => 'no network in UI test', json: async () => ({}) });
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

// 6) FREEZE REGRESSION — the user must approve the EXACT transaction broadcast.
// Open a wallet, drive a real send through the real confirm sheet with a stubbed
// engine, and prove: (a) the engine builds exactly ONCE, (b) the broadcast
// receives byte-for-byte the hex that was built BEFORE the confirm screen —
// so a fee-provider (or UTXO-set) change after confirmation cannot alter it.
const SEED = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';
$('#mnemonic').value = SEED;
click('#load');                                   // open wallet (network calls fail cleanly)
await new Promise((r) => setTimeout(r, 300));

// ---- Home per-script-type balance selector + back links (this session) ----
ok('Home has a script-type selector', !!$('#type_sel'));
const pills = () => [...$('#type_sel').querySelectorAll('.typepill')];
ok('selector renders a pill per script type', pills().length === window.OW.scriptTypes().length);
ok('headline label reflects the active type', /NATIVE SEGWIT/i.test($('#bal_label').textContent));
ok('all-accounts combined line is present', /All accounts/i.test($('#bal_all').textContent));
ok('every non-home tab has a ‹ Home back link', window.document.querySelectorAll('.back[data-nav="home"]').length >= 3);
const taprootPill = pills().find((p) => /taproot/i.test(p.textContent));
taprootPill && taprootPill.click();               // switch active type (sync re-label; async discovery fails cleanly)
ok('tapping a type pill switches the headline', /TAPROOT/i.test($('#bal_label').textContent));
const segwitPill = pills().find((p) => /native segwit/i.test(p.textContent));
segwitPill && segwitPill.click();                 // back to native SegWit for the send flow below
await new Promise((r) => setTimeout(r, 60));
ok('switching back restores the SegWit headline', /NATIVE SEGWIT/i.test($('#bal_label').textContent));

const HEX_A = 'aa'.repeat(60), HEX_B = 'bb'.repeat(60);   // "first build" vs "post-confirm rebuild"
let buildCalls = 0, broadcastGot = null;
const stubTx = (hex) => ({ txHex: hex, txid: 'f1'.repeat(32), fee: 300, feeRate: 2, vsize: 141, broadcastTxid: null });
window.OW.send = async () => { buildCalls++; return stubTx(buildCalls === 1 ? HEX_A : HEX_B); };
window.OW.decodeTx = ({ hex }) => ({ txid: 'f1'.repeat(32), vsize: 141, inputs: [], totalOut: 9700,
  outputs: [{ vout: 0, address: 'tb1qexternal', amount: 9000, type: 'wpkh', opReturn: null },
            { vout: 1, address: 'tb1qchange', amount: 700, type: 'wpkh', opReturn: null }] });
window.OW.broadcastHex = async ({ hex }) => { broadcastGot = hex; return { txid: 'f1'.repeat(32), explorer: null }; };

$('#to').value = 'tb1qexternal'; $('#amt').value = '9000';
click('#send');
// wait for the confirm sheet, then approve
let waited = 0;
while (!$('#confirm').classList.contains('on') && waited < 3000) { await new Promise((r) => setTimeout(r, 50)); waited += 50; }
ok('confirm sheet opened from the BUILT transaction', $('#confirm').classList.contains('on'));
ok('confirm sheet shows the frozen txid', $('#confirm').textContent.includes('f1f1f1f1'));
click('#c_go');
waited = 0;
while (broadcastGot === null && waited < 3000) { await new Promise((r) => setTimeout(r, 50)); waited += 50; }
ok('engine build was called exactly ONCE', buildCalls === 1);
ok('broadcast received the EXACT pre-confirmation bytes', broadcastGot === HEX_A);
ok('a post-confirm rebuild (different tx) can never be sent', broadcastGot !== HEX_B);

console.log(bad ? '\nUI TEST FAILED' : '\nUI TEST PASS — real DOM, real clicks, frozen-bytes broadcast');
window.close();
process.exit(bad ? 1 : 0);
