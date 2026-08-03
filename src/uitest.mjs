// Headless test of ui.js: shim a DOM, load the real bundle + real ui.js, drive it.
import { readFileSync } from 'fs';
const els = {};
const mk = () => ({ textContent:'', value:'', className:'', disabled:false,
  style:{}, _h:{}, addEventListener(k,f){this._h[k]=f;}, onclick:null,
  scrollIntoView(){}, });
for (const id of ['selfcheck','offline','pad','mousebar','net','dice','pass','pass2',
                  'passwarn','gen','out','words','addr','meta','vq1','vq2','va1','va2',
                  'vcheck','vresult','wipe']) els['#'+id] = mk();
els['#net'].value = 'testnet';

globalThis.window = globalThis;
globalThis.document = { querySelector: s => els[s] };
Object.defineProperty(globalThis,'navigator',{value:{onLine:false},configurable:true});
globalThis.performance = { now: () => Date.now() };
globalThis.addEventListener = () => {};
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

// 3. stir some mouse entropy, then generate
for (let i=0;i<50;i++) els['#pad']._h.mousemove({clientX:100+i, clientY:200+i});
els['#dice'].value='4 2 6 1 3 5';
els['#gen']._h.click();
const words = els['#words'].textContent.split(' ');
console.log('generated words  :', words.length, '| addr:', els['#addr'].textContent.slice(0,8)+'…');
if (words.length !== 24) fail('expected 24 words');
if (!els['#addr'].textContent.startsWith('tb1')) fail('expected testnet tb1 address');

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
console.log(process.exitCode ? '\nUI TEST FAILED' : '\nUI TEST PASS');
