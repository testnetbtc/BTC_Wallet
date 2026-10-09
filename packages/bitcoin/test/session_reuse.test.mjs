// Address rotation must be permanent: once an address has held a coin, the wallet must never
// hand it out again — even after the coin is spent and the node (which reports only UNSPENT
// coins) no longer shows anything on it. Plus the signed-message address helpers.
import { Session } from '../src/session.js';
import { openWatchAccount, describeSeed } from '../src/account.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(84), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const pub = describeSeed({ mnemonic: M, network: 'mainnet' });
const mkStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
// a node that answers with whatever coins the test puts on `utxos`
const node = { utxos: [], async scan(scripts) { return { height: 800000, utxos: this.utxos.filter((u) => scripts.includes(u.script)) }; } };
const store = mkStore();
const s = new Session({ account: openWatchAccount(pub), api: node, store, scriptType: 'p2wpkh' });
const addrAt = (i) => s.account.entry('p2wpkh', 0, i);

(async () => {
  await s.refresh();
  ok('fresh wallet: receive address is index 0', s.receive('p2wpkh').index === 0);
  // a payment lands on address #0
  node.utxos = [{ txid: 'a'.repeat(64), vout: 0, value: 50000, height: 799990, confirmations: 11, script: addrAt(0).script }];
  await s.refresh();
  ok('after a payment on #0 the wallet moves on to #1 by itself', s.receive('p2wpkh').index === 1);
  // the coin is spent: the node no longer reports anything on #0
  node.utxos = [];
  await s.refresh();
  ok('REGRESSION: after that coin is spent, #0 is NOT offered again (was: fell back to #0)', s.receive('p2wpkh').index === 1 && s.receive('p2wpkh').address === addrAt(1).address);
  // the memory survives a reload on the same device (stored counters)
  const s2 = new Session({ account: openWatchAccount(pub), api: node, store, scriptType: 'p2wpkh' });
  await s2.refresh();
  ok('the used-address memory survives reopening the wallet in the same browser', s2.receive('p2wpkh').index === 1);
  // a payment far ahead (#7) and a change coin at change #2 push both counters past them
  node.utxos = [{ txid: 'b'.repeat(64), vout: 0, value: 1000, height: 799990, confirmations: 11, script: addrAt(7).script },
                { txid: 'c'.repeat(64), vout: 1, value: 2000, height: 799990, confirmations: 11, script: s.account.entry('p2wpkh', 1, 2).script }];
  await s.refresh(); node.utxos = []; await s.refresh();
  ok('receive and change counters both remember the highest used index', s.receive('p2wpkh').index === 8 && s.changeIndex() === 3);
  // ---- signed-message helpers
  node.utxos = [{ txid: 'd'.repeat(64), vout: 0, value: 7000, height: 799990, confirmations: 11, script: addrAt(3).script }];
  await s.refresh();
  const list = s.signableAddresses();
  ok('signable addresses: the current receive address of each type comes first', list[0].address === s.receive('p2wpkh').address && list.some((x) => x.type === 'p2pkh'));
  ok('signable addresses: an address holding coins is listed with its balance', list.some((x) => x.address === addrAt(3).address && /7,000 sats/.test(x.note)));
  ok('findEntry: finds a wallet address and returns its script', (await s.findEntry(addrAt(3).address))?.script === addrAt(3).script);
  ok('findEntry: a foreign address gives null', (await s.findEntry('bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l')) === null && (await s.findEntry('')) === null);
  console.log(bad ? '\nSESSION REUSE TESTS FAILED' : '\nsession address rotation: all checks passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
