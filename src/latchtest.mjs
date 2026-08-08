// Regression test: if the crypto self-check FAILS, no interaction may re-enable
// wallet generation. (Previously, typing in the passphrase field re-enabled it.)
import { readFileSync } from 'fs';
const els = {};
const mk = () => ({ textContent:'', value:'', className:'', disabled:false, style:{},
  _h:{}, addEventListener(k,f){this._h[k]=f;}, onclick:null, scrollIntoView(){} });
for (const id of ['selfcheck','offline','rngtest','rngresult','pad','mousebar','mousestat','mousereset',
  'net','dice','pass','pass2','passshow','passwarn',
  'gen','out','words','addr','meta','entropy','advtoggle','adv','ehex','vq1','vq2','va1','va2','vcheck','vresult','wipe','dr',
  'fpass','fpass2','genpw','fpstrength','fpwarn','savebk','savedesc','saveinfo','bkfile','rpass','rbip39','restore',
  'rinfo','rout','rwords','raddr','netwarn']) els['#'+id] = mk();
els['#net'].value='testnet3';
globalThis.window = globalThis;
globalThis.document = { querySelector:s=>els[s], createElement:()=>({click(){},set href(v){},set download(v){}}) };
Object.defineProperty(globalThis,'navigator',{value:{onLine:false},configurable:true});
globalThis.performance = { now:()=>Date.now() };
globalThis.addEventListener = ()=>{}; globalThis.scrollTo = ()=>{};
globalThis.Blob = class { constructor(p){ this.text=p.join(''); } };
globalThis.URL = { createObjectURL:()=> 'blob:x', revokeObjectURL(){} };
globalThis.setTimeout = ()=>{};
globalThis.FileReader = class { readAsText(f){ this.result=f._text; this.onload&&this.onload(); } };

await import('../dist/olesia.bundle.js');
// SABOTAGE the self-check to simulate a broken/tampered build
window.Olesia._vectorCheck = () => ({ ok:false, addr:'wrong', expected:'right' });
eval(readFileSync('src/ui.js','utf8'));

let bad = false;
const chk = (label, cond) => { console.log(label.padEnd(34), cond?'✓':'✗ BYPASSED'); if(!cond) bad=true; };

chk('disabled after failed self-check', els['#gen'].disabled === true);
els['#pass'].value='a'; els['#pass2'].value='a'; els['#pass']._h.input();
chk('still disabled after typing pass', els['#gen'].disabled === true);
els['#net'].value='mainnet'; els['#net']._h.change();
chk('still disabled after net switch', els['#gen'].disabled === true);
els['#pass']._h.input();
chk('label warns why', els['#gen'].textContent.includes('self-check failed'));
els['#gen']._h.click();
chk('click produces NO wallet', els['#words'].textContent === '');
console.log(bad ? '\nLATCH TEST FAILED' : '\nLATCH TEST PASS — broken build cannot generate wallets');
process.exit(bad?1:0);
