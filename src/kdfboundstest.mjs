import { makeWallet } from './app.js';
import { encryptBackup, decryptBackup } from './backup.js';
const w = makeWallet({ mouseBytes:new Uint8Array([1]), diceString:'', passphrase:'', testnet:true });
const good = encryptBackup(w.mnemonic, 'pw', w);

function rejects(mut, label){
  const bad = JSON.parse(JSON.stringify(good)); mut(bad.kdf);
  let threw=false, ranScrypt=false;
  const t=Date.now();
  try { decryptBackup(bad, 'pw'); } catch(e){ threw = /out of range|must be 32/.test(e.message); }
  ranScrypt = (Date.now()-t) > 3000;   // if it actually ran heavy scrypt, it wasn't rejected fast
  console.log(`${label.padEnd(34)} rejected-fast:${threw && !ranScrypt ? 'YES ✓' : 'NO ✗'}`);
  return threw && !ranScrypt;
}
let ok=true;
ok &= rejects(k=>k.N=1073741824, 'N=2^30 (memory bomb)');
ok &= rejects(k=>k.N=65537,      'N not power of 2');
ok &= rejects(k=>k.r=9999,       'r absurd');
ok &= rejects(k=>k.p=9999,       'p absurd');
ok &= rejects(k=>k.dkLen=64,     'dkLen wrong');
// legitimate file still restores
const rt = decryptBackup(good,'pw').mnemonic === w.mnemonic;
console.log('legit backup still restores       ', rt?'YES ✓':'NO ✗');
console.log(ok && rt ? '\nKDF-BOUNDS TEST PASS' : '\nKDF-BOUNDS TEST FAIL');
process.exit(ok && rt ? 0 : 1);
