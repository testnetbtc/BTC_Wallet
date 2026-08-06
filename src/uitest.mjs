// Headless test of ui.js: shim a DOM, load the real bundle + real ui.js, drive it.
import { readFileSync } from 'fs';
const els = {};
const mk = () => ({ textContent:'', value:'', className:'', disabled:false,
  style:{}, _h:{}, addEventListener(k,f){this._h[k]=f;}, onclick:null,
  scrollIntoView(){}, });
for (const id of ['selfcheck','offline','rngtest','rngresult','pad','mousebar','mousestat','mousereset','net','dice',
                  'pass','pass2','passshow','passwarn','gen','out','words','addr','meta','entropy',
                  'advtoggle','adv','ehex','vq1','vq2','va1','va2',
                  'vcheck','vresult','wipe','dr','fpass','fpass2','genpw','fpstrength','fpwarn','savebk','savedesc',
                  'saveinfo','bkfile','rpass','rbip39','restore','rinfo','rout','rwords','raddr','netwarn'])
  els['#'+id] = mk();
els['#net'].value = 'testnet3';

globalThis.window = globalThis;
globalThis.document = { querySelector: s => els[s] };
Object.defineProperty(globalThis,'navigator',{value:{onLine:false},configurable:true});
globalThis.performance = { now: () => Date.now() };
globalThis.addEventListener = () => {};
// shims for file download / upload
let lastDownload = null;
globalThis.Blob = class { constructor(parts){ this.text = parts.join(''); } };
globalThis.URL = { createObjectURL(b){ lastDownload = b.text; return 'blob:x'; }, revokeObjectURL(){} };
globalThis.setTimeout = (f)=>{};
globalThis.document.createElement = () => ({ set href(v){}, set download(v){}, click(){} });
globalThis.FileReader = class {
  readAsText(f){ this.result = f._text; this.onload && this.onload(); }
};
globalThis.scrollTo = () => {};

await import('../dist/alea.bundle.js');
eval(readFileSync('src/ui.js','utf8'));

const fail = m => { console.log('FAIL:', m); process.exitCode = 1; };
console.log('self-check badge :', els['#selfcheck'].textContent.slice(0,30));
if (els['#selfcheck'].className !== 'badge ok') fail('self-check not ok');

// 1. passphrase mismatch must disable generate
els['#pass'].value='hunter2'; els['#pass2'].value='hunter3';
els['#pass']._h.input();
if (!els['#gen'].disabled) fail('mismatched passphrase did NOT disable generate');
console.log('mismatch blocks  :', els['#gen'].disabled, '|', els['#gen'].textContent);

// 2. matching passphrase re-enables
els['#pass2'].value='hunter2'; els['#pass2']._h.input();
if (els['#gen'].disabled) fail('matching passphrase left generate disabled');
console.log('match re-enables :', !els['#gen'].disabled);

// 3. stir some mouse entropy; the reset button must clear it; then generate
for (let i=0;i<50;i++) els['#pad']._h.mousemove({clientX:100+i, clientY:200+i});
if (els['#mousebar'].style.width === '0%' || els['#mousestat'].textContent === 'optional stir: 0%')
  fail('mouse stir readout did not update on movement');
els['#mousereset']._h.click();
if (els['#mousebar'].style.width !== '0%' || els['#mousestat'].textContent !== 'optional stir: 0%')
  fail('reset button did not clear the mouse stir');
console.log('mouse reset      : ✓ ('+els['#mousestat'].textContent+')');
for (let i=0;i<50;i++) els['#pad']._h.mousemove({clientX:100+i, clientY:200+i});
els['#dice'].value='4 2 6 1 3 5';
els['#pass'].value=''; els['#pass2'].value=''; els['#pass']._h.input();  // no passphrase for this run
els['#gen']._h.click();
const words = els['#words'].textContent.split(' ');
console.log('generated words  :', words.length, '| addr:', els['#addr'].textContent.slice(0,8)+'…');
if (words.length !== 24) fail('expected 24 words');
if (!els['#addr'].textContent.startsWith('tb1')) fail('expected testnet tb1 address');
// raw entropy must be shown and consistent (64 hex chars = 256 bits)
if (!/^[0-9a-f]{64}$/.test(els['#ehex'].textContent)) fail('raw entropy hex not shown / malformed');
console.log('entropy hex shown:', els['#ehex'].textContent.slice(0,12)+'… (64 hex)');
// entropy summary must be honest: always 256 bits, and reflect the sources used
const esum = els['#entropy'].textContent;
if (!/256 bits/.test(esum)) fail('entropy summary missing the 256-bit strength statement');
if (!/mouse ✓/.test(esum) || !/dice ✓/.test(esum)) fail('entropy summary did not mark used sources');
if (!/passphrase –/.test(esum)) fail('entropy summary marked an unused source as used');
console.log('entropy summary  : ✓', JSON.stringify(esum.slice(0,46)+'…'));

// 3b. RNG smoke test button must run and pass on a healthy CSPRNG
els['#rngtest']._h.click();
if (els['#rngresult'].className !== 'badge ok') fail('RNG smoke test did not pass on a healthy RNG');
console.log('rng smoke test   : ✓', JSON.stringify(els['#rngresult'].textContent.slice(0,34)+'…'));

// 3c. testnet3 vs testnet4 vs mainnet: labels differ, tb1/bc1 correct, and both
//     testnets share BIP-44 coin type 1 (identical derivation family).
const w3 = window.Alea.makeWallet({ network:'testnet3' });
const w4 = window.Alea.makeWallet({ network:'testnet4' });
const wm = window.Alea.makeWallet({ network:'mainnet'  });
if (w3.network!=='testnet3' || w4.network!=='testnet4' || wm.network!=='mainnet') fail('network label not recorded');
if (!w3.address.startsWith('tb1') || !w4.address.startsWith('tb1')) fail('testnet3/4 must yield tb1 addresses');
if (!wm.address.startsWith('bc1')) fail('mainnet must yield a bc1 address');
if (!w3.path.startsWith("m/84'/1'/") || !w4.path.startsWith("m/84'/1'/")) fail('testnet3/4 must use coin type 1');
if (!wm.path.startsWith("m/84'/0'/")) fail('mainnet must use coin type 0');
console.log('testnet3/4/main  : ✓ tb1/tb1/bc1, coin 1/1/0');

// 4. backup verification: wrong answer rejected, right answer accepted
const n1 = parseInt(els['#vq1'].textContent.replace(/\D/g,''),10);
const n2 = parseInt(els['#vq2'].textContent.replace(/\D/g,''),10);
els['#va1'].value='wrongword'; els['#va2'].value=words[n2-1];
els['#vcheck'].onclick();
if (els['#vresult'].className !== 'badge bad') fail('wrong backup answer was accepted!');
console.log('wrong answer     : rejected ✓');
els['#va1'].value=words[n1-1].toUpperCase(); els['#va2'].value=' '+words[n2-1]+' ';
els['#vcheck'].onclick();
if (els['#vresult'].className !== 'badge ok') fail('correct backup answer was rejected');
console.log('right answer     : accepted ✓ (case/space tolerant)');

// 5. wipe clears secrets
els['#wipe']._h.click();
if (els['#words'].textContent !== '' || els['#pass'].value !== '') fail('wipe did not clear');
console.log('wipe clears      : ✓');
// 6. encrypted backup: mismatched file password blocks the button
els['#fpass'].value='filepw'; els['#fpass2'].value='nope'; els['#fpass']._h.input();
if (!els['#savebk'].disabled) fail('mismatched file password did not disable save');
els['#fpass2'].value='filepw'; els['#fpass2']._h.input();
if (els['#savebk'].disabled) fail('matching file password left save disabled');
console.log('file pw guard    : ✓');

// regenerate (wipe cleared state) then save a backup
els['#pass'].value=''; els['#pass2'].value=''; els['#pass']._h.input();
els['#gen']._h.click();
const gen = els['#words'].textContent;
els['#fpass'].value='filepw'; els['#fpass2'].value='filepw'; els['#fpass']._h.input();
els['#savebk']._h.click();
if (!lastDownload) fail('no backup file produced');
const blob = JSON.parse(lastDownload);
console.log('backup written   :', blob.format, 'v'+blob.version, '| kdf', blob.kdf.name+' N='+blob.kdf.N);
if (lastDownload.includes(gen.split(' ')[0])) fail('MNEMONIC LEAKED IN PLAINTEXT');
console.log('plaintext leak   : none ✓');

// descriptor download
els['#savedesc']._h.click();
if (!/^wpkh\(\[/m.test(lastDownload.split('receive: ')[1]||'')) fail('descriptor export malformed');
console.log('descriptor file  : ✓');

// 7. restore: wrong password rejected, right password restores + verifies
els['#bkfile']._h.change({ target:{ files:[{ _text: JSON.stringify(blob) }] } });
els['#rpass'].value='WRONG'; els['#restore']._h.click();
if (els['#rinfo'].className !== 'badge bad') fail('wrong file password was accepted on restore');
console.log('restore wrong pw : rejected ✓');
els['#rpass'].value='filepw'; els['#rbip39'].value=''; els['#restore']._h.click();
if (els['#rwords'].textContent !== gen) fail('restored mnemonic does not match');
if (els['#rinfo'].className !== 'badge ok') fail('restore did not verify address');
console.log('restore correct  : words match + address verified ✓');

// 8. F-03: one-click strong password generator fills + mirrors both fields
els['#genpw']._h.click();
if (!/^[a-z]+(-[a-z]+){5}$/.test(els['#fpass'].value)) fail('generated password is not 6 hyphenated words');
if (els['#fpass'].value !== els['#fpass2'].value) fail('generated password not mirrored to confirm field');
console.log('gen strong pw    : ✓ ('+els['#fpass'].value.slice(0,20)+'…)');

// 9. F-01: mainnet generation is BLOCKED while online, ALLOWED while offline
els['#pass'].value=''; els['#pass2'].value=''; els['#pass']._h.input();
Object.defineProperty(globalThis,'navigator',{value:{onLine:true},configurable:true});
els['#net'].value='mainnet'; els['#net']._h.change();
if (!els['#gen'].disabled) fail('mainnet generation was NOT blocked while online');
console.log('mainnet online   : blocked ✓ ('+els['#gen'].textContent+')');
Object.defineProperty(globalThis,'navigator',{value:{onLine:false},configurable:true});
els['#net']._h.change();
if (els['#gen'].disabled) fail('mainnet blocked even while offline (should be allowed)');
console.log('mainnet offline  : allowed ✓');

console.log(process.exitCode ? '\nUI TEST FAILED' : '\nUI TEST PASS');
