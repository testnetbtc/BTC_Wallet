// Bitcoin output descriptors — the unambiguous watch-only interchange format.
// A descriptor states the script type, master fingerprint, derivation path,
// extended key, and receive/change branch in one string, e.g.
//   wpkh([a1b2c3d4/84h/0h/0h]xpub.../0/*)#checksum
// far less ambiguous than a naked xpub. The checksum is Bitcoin Core's descriptor
// checksum (a bech32-style polymod); this implementation is cross-checked against
// `bitcoin-cli getdescriptorinfo` in test/descriptor.test.mjs.
import { accountXpub, masterFingerprint } from './wallet.js';
import { net } from './networks.js';

const INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(c, val) {
  const c0 = Number(c >> 35n);
  c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(val);
  if (c0 & 1) c ^= 0xf5dee51989n;
  if (c0 & 2) c ^= 0xa9fdca3312n;
  if (c0 & 4) c ^= 0x1bab10e32dn;
  if (c0 & 8) c ^= 0x3706b1677an;
  if (c0 & 16) c ^= 0x644d626ffdn;
  return c;
}

// Compute the "#xxxxxxxx" checksum for a descriptor string (without checksum).
export function descriptorChecksum(desc) {
  let c = 1n, cls = 0, clscount = 0;
  for (const ch of desc) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos === -1) throw new Error('invalid character in descriptor: ' + JSON.stringify(ch));
    c = polymod(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    if (++clscount === 3) { c = polymod(c, cls); cls = 0; clscount = 0; }
  }
  if (clscount > 0) c = polymod(c, cls);
  for (let j = 0; j < 8; ++j) c = polymod(c, 0);
  c ^= 1n;
  let ret = '';
  for (let j = 0; j < 8; ++j) ret += CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - j))) & 31n)];
  return ret;
}

export function withChecksum(descNoChecksum) {
  return `${descNoChecksum}#${descriptorChecksum(descNoChecksum)}`;
}

// Native-SegWit (BIP-84) receive + change descriptors for an account.
// `source` is the seed (fingerprint + xpub derivable) or an account xpub alone
// (then no fingerprint prefix — still valid, just less rich).
export function accountDescriptors({ mnemonic, passphrase = '', accountXpub: xpubIn, network }) {
  const n = net(network);
  const xpub = xpubIn || accountXpub(mnemonic, passphrase, network);
  const origin = mnemonic ? `[${masterFingerprint(mnemonic, passphrase, network)}/84h/${n.coin}h/0h]` : '';
  const body = (chain) => `wpkh(${origin}${xpub}/${chain}/*)`;
  return {
    receive: withChecksum(body(0)),
    change: withChecksum(body(1)),
    xpub,
  };
}
