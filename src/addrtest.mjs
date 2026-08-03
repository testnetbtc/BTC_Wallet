import { _vectorCheck } from './app.js';
const r = _vectorCheck();
console.log('BIP-84 address vector:', r.ok ? 'PASS' : 'FAIL', r.addr);
process.exit(r.ok ? 0 : 1);
