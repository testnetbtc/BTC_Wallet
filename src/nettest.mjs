import { makeWallet, deriveFrom } from '/home/faucet/BTC_Wallet/src/app.js';
const out = {};
for (const testnet of [false, true]) {
  const w = makeWallet({ mouseBytes:new Uint8Array([1]), diceString:'', passphrase:'', testnet });
  const kind = w.descriptorReceive.match(/\](\w{4})/)[1];
  console.log(`${w.network.padEnd(8)} addr=${w.address.slice(0,6)}…  path=${w.path}  extkey=${kind}`);
  out[w.network] = { kind, addr: w.address, mn: w.mnemonic };
  // address must still round-trip through deriveFrom (version bytes must not change it)
  const d = deriveFrom(w.mnemonic, '', testnet);
  if (d.address !== w.address) { console.log('  !! address mismatch after version change'); process.exitCode=1; }
}
const ok = out.mainnet.kind==='xpub' && out.testnet.kind==='tpub'
        && out.mainnet.addr.startsWith('bc1') && out.testnet.addr.startsWith('tb1');
console.log(ok ? '\nNETWORK TEST PASS — mainnet=xpub/bc1, testnet=tpub/tb1' : '\nNETWORK TEST FAIL');
process.exit(ok && !process.exitCode ? 0 : 1);
