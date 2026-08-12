// Pure, side-effect-free helpers for olesia-notify — safe to import in tests.
// The watch-only input classifier is the single most safety-critical function
// in the bot: it must reject every private-key shape BEFORE anything is logged
// or stored. Over-rejecting is acceptable; under-rejecting is not.
import * as btc from '@scure/btc-signer';
import { net } from '../src/networks.js';
import { deriveAt } from '../src/send.js';
import { parseExtendedKey } from '../src/wallet.js';

export const XPUB_GAP = 20;
const NETWORKS = ['mainnet', 'testnet4', 'testnet3', 'signet'];

// seed-phrase shape: 12/15/18/21/24 lowercase words (BIP-39 words are 3-8 chars)
const WORDS_SHAPE = /^(\s*[a-z]{3,8}(\s+|$)){12,}$/i;
const WIF = /^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/;
const PRIV_XKEY = /^[xytzuv]prv[1-9A-HJ-NP-Za-km-z]+$/;
const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;

export function detectNetwork(addr) {
  for (const nw of NETWORKS) {
    try { btc.Address(net(nw).btc).decode(addr); return nw; } catch { /* next */ }
  }
  return null;
}

export function classifyInput(raw) {
  const s = (raw || '').trim();
  if (!s) return { kind: 'INVALID', why: 'empty' };

  // --- reject secrets first (do not echo the value anywhere) ---
  const words = s.split(/\s+/).filter(Boolean).length;
  if ([12, 15, 18, 21, 24].includes(words) && WORDS_SHAPE.test(s))
    return { kind: 'SECRET', why: 'seed phrase (BIP-39 mnemonic)' };
  if (WIF.test(s)) return { kind: 'SECRET', why: 'WIF private key' };
  if (PRIV_XKEY.test(s)) return { kind: 'SECRET', why: 'private extended key (xprv)' };
  if (HEX64.test(s)) return { kind: 'SECRET', why: 'raw private key' };

  // --- accept watch-only public material ---
  if (/^[xyztuv]pub[1-9A-HJ-NP-Za-km-z]+$/.test(s)) {
    for (const nw of NETWORKS) {
      try { parseExtendedKey(s, nw); return { kind: 'XPUB', value: s, network: nw }; } catch { /* next */ }
    }
    return { kind: 'INVALID', why: 'looks like an extended key but did not parse' };
  }
  const nw = detectNetwork(s);
  if (nw) return { kind: 'ADDRESS', value: s, network: nw };
  return { kind: 'INVALID', why: 'not a recognised Bitcoin address or xpub' };
}

export function xpubAddresses(xpub, network, gap = XPUB_GAP) {
  const out = [];
  for (const chain of [0, 1])
    for (let i = 0; i < gap; i++)
      try { out.push(deriveAt(xpub, network, 'p2wpkh', chain, i).address); } catch { /* skip */ }
  return out;
}
