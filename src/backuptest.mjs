import { makeWallet, deriveFrom } from './app.js';
import { encryptBackup, decryptBackup } from './backup.js';
const w = makeWallet({ mouseBytes:new Uint8Array([9,9]), diceString:'1 2 3', passphrase:'my-25th-word', testnet:true });
console.log('wallet addr      :', w.address);
console.log('descriptor       :', w.descriptorReceive.slice(0,46)+'…'+w.descriptorReceive.slice(-9));

const blob = encryptBackup(w.mnemonic, 'file-password-123', w);
console.log('backup fields    :', Object.keys(blob).join(','));
console.log('mnemonic in file?:', JSON.stringify(blob).includes(w.mnemonic.split(' ')[0]) ? 'LEAKED!' : 'no (encrypted) ✓');
console.log('bip39 pass in file?:', JSON.stringify(blob).includes('my-25th-word') ? 'LEAKED!' : 'no (by design) ✓');

const back = decryptBackup(JSON.parse(JSON.stringify(blob)), 'file-password-123');
console.log('round-trip words :', back.mnemonic === w.mnemonic ? 'MATCH ✓' : 'MISMATCH ✗');

let bad=false; try { decryptBackup(blob,'wrong-password'); } catch(e){ bad=true; }
console.log('wrong password   :', bad ? 'rejected ✓' : 'ACCEPTED ✗');

// restore must reproduce the address only with the right BIP-39 passphrase
const right = deriveFrom(back.mnemonic, 'my-25th-word', true).address;
const wrong = deriveFrom(back.mnemonic, 'typo',         true).address;
console.log('restore w/ pass  :', right === w.address ? 'address matches ✓' : 'MISMATCH ✗');
console.log('restore w/ typo  :', wrong !== w.address ? 'differs (correctly detected) ✓' : 'SILENTLY SAME ✗');

// v3: metadata is authenticated as AEAD associated data — tampering must fail restore.
const vt = blob.version === 3;
function tamper(mut){ const b=JSON.parse(JSON.stringify(blob)); mut(b);
  try { decryptBackup(b,'file-password-123'); return false; } catch { return true; } }
const t1 = tamper(b=>b.network='mainnet');
const t2 = tamper(b=>b.addressHash='00'.repeat(32));
const t3 = tamper(b=>b.path="m/84'/0'/0'/0/0");
console.log('v3 format        :', vt ? 'YES ✓' : 'NO ✗');
console.log('tamper network   :', t1 ? 'rejected ✓' : 'ACCEPTED ✗');
console.log('tamper addr-hash :', t2 ? 'rejected ✓' : 'ACCEPTED ✗');
console.log('tamper path      :', t3 ? 'rejected ✓' : 'ACCEPTED ✗');

const ok = back.mnemonic===w.mnemonic && bad && right===w.address && wrong!==w.address
        && vt && t1 && t2 && t3;
console.log(ok ? '\nBACKUP TEST PASS' : '\nBACKUP TEST FAIL'); process.exit(ok?0:1);
