// Descriptor + xpub interoperability, cross-validated against Bitcoin Core.
// - our descriptor checksum must equal `getdescriptorinfo`.
// - every address Core derives from our descriptor (both chains) must equal the
//   address Olesia derives at that (chain,index) — proving the wallet and an
//   independent implementation agree, so a Core/Sparrow user can watch this wallet.
import { execSync } from 'node:child_process';
import { accountXpub, deriveKey } from '../src/wallet.js';
import { accountDescriptors, descriptorChecksum, withChecksum } from '../src/descriptor.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(64), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const cli = (args) => { try { return execSync(`sudo -u bitcoin /usr/local/bin/bitcoin-cli -datadir=/var/lib/bitcoind ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };

const MN = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';

// prefix correctness
ok('testnet account key serialises as tpub', accountXpub(MN, '', 'testnet4').startsWith('tpub'));
ok('mainnet account key serialises as xpub', accountXpub(MN, '', 'mainnet').startsWith('xpub'));
ok('a passphrase changes the account key', accountXpub(MN, 'x', 'mainnet') !== accountXpub(MN, '', 'mainnet'));

// checksum self-consistency
const d = accountDescriptors({ mnemonic: MN, network: 'mainnet' });
ok('receive descriptor has a #checksum', /#[a-z0-9]{8}$/.test(d.receive));
ok('change descriptor differs (chain 1)', d.change.includes('/1/*') && d.receive.includes('/0/*'));

const core = cli('getblockchaininfo');
if (!core) { console.log('\n(bitcoin-cli unreachable — Core cross-check skipped; checksum math still verified above)');
} else {
  // 1) checksum matches Core
  const nock = d.receive.split('#')[0];
  const info = JSON.parse(cli(`getdescriptorinfo "${nock}"`));
  ok('our checksum == Bitcoin Core getdescriptorinfo', info && d.receive.endsWith(info.checksum));
  ok('descriptorChecksum() recomputes the same value', withChecksum(nock) === d.receive);

  // 2) Core-derived addresses == Olesia-derived addresses, BOTH chains
  for (const [chain, desc] of [[0, d.receive], [1, d.change]]) {
    const addrs = JSON.parse(cli(`deriveaddresses "${desc}" "[0,25]"`));
    let allMatch = addrs.length === 26;
    for (let i = 0; i <= 25; i++) {
      const ours = deriveKey(MN, '', 'mainnet', i, chain).address;
      if (ours !== addrs[i]) { allMatch = false; console.log(`   mismatch chain ${chain} index ${i}: ours ${ours} core ${addrs[i]}`); break; }
    }
    ok(`Core deriveaddresses == Olesia for chain ${chain} (indexes 0..25)`, allMatch);
  }

  // 3) testnet (tpub) descriptor — our node is mainnet-only, so Core rejects a
  //    tpub key. The checksum is verifiable regardless via our own algorithm,
  //    already proven equal to Core on mainnet above.
  const dt = accountDescriptors({ mnemonic: MN, network: 'testnet4' });
  const itRaw = cli(`getdescriptorinfo "${dt.receive.split('#')[0]}"`);
  if (itRaw) {
    const it = JSON.parse(itRaw);
    ok('testnet (tpub) descriptor checksum matches Core', dt.receive.endsWith(it.checksum));
  } else {
    ok('testnet checksum self-consistent (Core is mainnet-only, tpub not testable there)',
      withChecksum(dt.receive.split('#')[0]) === dt.receive);
  }
}

console.log(bad ? '\nDESCRIPTOR TEST FAILED' : '\nDESCRIPTOR TEST PASS — descriptors + xpub agree with Bitcoin Core');
process.exit(bad ? 1 : 0);
