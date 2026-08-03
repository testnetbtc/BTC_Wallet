import { makeWallet } from './app.js';
import { encryptBackup, decryptBackup, verifyAddress } from './backup.js';
const w = makeWallet({ mouseBytes:new Uint8Array([5]), diceString:'', passphrase:'', testnet:true });
const f = encryptBackup(w.mnemonic, 'pw', w);
const s = JSON.stringify(f);
console.log('version                :', f.version);
console.log('address in file?       :', s.includes(w.address) ? 'LEAKED ✗' : 'no ✓');
console.log('mnemonic in file?      :', s.includes(w.mnemonic.split(' ')[0]) ? 'LEAKED ✗' : 'no ✓');
console.log('verify right address   :', verifyAddress(f, w.address) ? 'ok ✓' : 'FAIL ✗');
console.log('verify wrong address   :', verifyAddress(f, 'tb1qwrong') ? 'ACCEPTED ✗' : 'rejected ✓');
const v1 = { format:'alea-backup', version:1, address:w.address };
console.log('v1 back-compat verify  :', verifyAddress(v1, w.address) ? 'ok ✓' : 'FAIL ✗');
const rt = decryptBackup(JSON.parse(s), 'pw');
console.log('round-trip             :', rt.mnemonic===w.mnemonic ? 'MATCH ✓' : 'FAIL ✗');
const ok = !s.includes(w.address) && verifyAddress(f,w.address) && !verifyAddress(f,'tb1qwrong')
        && verifyAddress(v1,w.address) && rt.mnemonic===w.mnemonic;
console.log(ok ? '\nPRIVACY TEST PASS' : '\nPRIVACY TEST FAIL'); process.exit(ok?0:1);
