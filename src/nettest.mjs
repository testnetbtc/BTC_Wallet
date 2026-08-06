import { makeWallet, deriveFrom } from './app.js';
const out = {};
for (const network of ['mainnet', 'testnet3', 'testnet4']) {
  const w = makeWallet({ mouseBytes:new Uint8Array([1]), diceString:'', passphrase:'', network });
  const kind = w.descriptorReceive.match(/\](\w{4})/)[1];
  console.log(`${w.network.padEnd(8)} addr=${w.address.slice(0,6)}…  path=${w.path}  extkey=${kind}`);
  out[w.network] = { kind, addr: w.address, mn: w.mnemonic };
  // address must still round-trip through deriveFrom (version bytes must not change it)
  const d = deriveFrom(w.mnemonic, '', network !== 'mainnet');
  if (d.address !== w.address) { console.log('  !! address mismatch after version change'); process.exitCode=1; }
}
// legacy boolean API must still work and map to testnet3 (back-compat)
const legacy = makeWallet({ mouseBytes:new Uint8Array([1]), diceString:'', passphrase:'', testnet:true });
if (legacy.network !== 'testnet3' || !legacy.address.startsWith('tb1')) {
  console.log('  !! legacy testnet:true mapping broke'); process.exitCode=1;
}
const ok = out.mainnet.kind==='xpub' && out.testnet3.kind==='tpub' && out.testnet4.kind==='tpub'
        && out.mainnet.addr.startsWith('bc1') && out.testnet3.addr.startsWith('tb1') && out.testnet4.addr.startsWith('tb1');
console.log(ok ? '\nNETWORK TEST PASS — mainnet=xpub/bc1, testnet3/4=tpub/tb1, legacy testnet→testnet3'
              : '\nNETWORK TEST FAIL');
process.exit(ok && !process.exitCode ? 0 : 1);
