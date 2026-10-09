// Privacy report: what the public blockchain reveals about this wallet, in plain language,
// with one concrete thing to do about each finding.
//
// It works from what the wallet really has — its UNSPENT coins and (fetched from the node)
// the transactions that created them. It cannot see spent history: the node has no address
// index, so the report says so instead of pretending. Pure function; no DOM, no network.
import * as btc from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

export const DUST_SATS = 1000;             // below this a coin is a "dust" coin whatever the fee rate
const INPUT_VBYTES = { p2wpkh: 68, 'p2sh-p2wpkh': 91, p2pkh: 148, p2tr: 58, p2pk: 114 };
const hash160 = (b) => ripemd160(sha256(b));

// The public keys an input reveals, as hash160 hex. Covers the script types this wallet makes
// (p2wpkh, p2pkh, p2sh-p2wpkh); anything else yields nothing (it is somebody else's input).
export function inputKeyHashes(input, witness) {
  const out = [];
  const w = witness || [];
  if (w.length === 2 && (w[1].length === 33 || w[1].length === 65)) out.push(bytesToHex(hash160(w[1])));
  const ss = input.finalScriptSig || new Uint8Array(0);
  if (ss.length) {
    // scriptSig is a sequence of pushes; take any 33/65-byte push that is a valid-looking key
    let o = 0;
    while (o < ss.length) {
      const op = ss[o++]; let n = 0;
      if (op >= 1 && op <= 75) n = op; else if (op === 76) { n = ss[o]; o += 1; } else if (op === 77) { n = ss[o] | (ss[o + 1] << 8); o += 2; } else break;
      const item = ss.slice(o, o + n); o += n;
      if ((n === 33 && (item[0] === 2 || item[0] === 3)) || (n === 65 && item[0] === 4)) out.push(bytesToHex(hash160(item)));
    }
  }
  return out;
}

// Decode a raw transaction hex into the shape the report needs.
export function parseTx(hex) {
  const t = btc.RawTx.decode(hexToBytes(hex));
  return {
    inputs: t.inputs.map((i, k) => ({ txid: bytesToHex(i.txid), vout: i.index, keyHashes: inputKeyHashes(i, t.witnesses ? t.witnesses[k] : null) })),
    outputs: t.outputs.map((o) => ({ value: Number(o.amount), script: bytesToHex(o.script) })),
  };
}

const sats = (n) => n.toLocaleString('en-US') + ' sats';
const short = (a) => a.slice(0, 10) + '…' + a.slice(-6);

// coins: [{ txid, vout, value, address, type, path, chain?, confirmations }]
// ourHashes: Set of hash160 hex for every address this wallet derived (its window)
// txs: Map txid -> parseTx() result for the transactions that created the coins (may be partial)
// feeRate: sat/vB used to judge whether a coin is worth spending
// kind: 'seed' | 'wif'
export function privacyReport({ kind = 'seed', coins = [], ourHashes = new Set(), txs = new Map(), feeRate = 10 } = {}) {
  const findings = [];
  const add = (f) => findings.push(f);
  const confirmed = coins.filter((c) => c.confirmations > 0);

  // 1. one key, one address
  if (kind !== 'seed') {
    add({ id: 'single-key', level: 'high', title: 'Every payment arrives at the same address',
      detail: 'This wallet is a single private key, so it has one address of each type. Everyone who pays you, and anyone who looks the address up, can see every other payment you ever received there, your current balance, and where the money goes when you spend it.',
      advice: 'For anything beyond a one-off, create a normal (recovery-phrase) wallet and move the funds: it gives every payment its own address automatically. Keep single-key wallets for vanity or paper-wallet fun.' });
  }

  // 2. reuse: several coins sitting on one address
  const byAddr = new Map();
  for (const c of coins) if (c.address) byAddr.set(c.address, [...(byAddr.get(c.address) || []), c]);
  const reused = [...byAddr].filter(([, cs]) => cs.length > 1);
  if (reused.length && kind === 'seed') {
    add({ id: 'reuse', level: 'medium', title: `${reused.length === 1 ? 'An address' : reused.length + ' addresses'} received more than one payment`,
      detail: reused.map(([a, cs]) => `${short(a)} holds ${cs.length} separate payments (${sats(cs.reduce((s, c) => s + c.value, 0))})`).join('; ') + '. Whoever sent any one of those payments can see the others, and the total. An address is meant to be used once.',
      advice: 'Give every payer a fresh address: the Receive screen shows a new one as soon as the previous one has been paid, and "Next address" gives you another any time. Nothing needs fixing on-chain; just stop handing out old ones.' });
  } else if (kind === 'seed' && coins.length) {
    add({ id: 'no-reuse', level: 'good', title: 'No address holds more than one payment', detail: `${byAddr.size} address${byAddr.size === 1 ? '' : 'es'} in use, each with a single coin.`, advice: null });
  }

  // 3. dust and uneconomic coins
  const dust = [], uneconomic = [];
  for (const c of confirmed) {
    const cost = (INPUT_VBYTES[c.type] || 110) * Math.max(1, feeRate);
    if (c.value < DUST_SATS) dust.push(c); else if (c.value <= cost) uneconomic.push({ ...c, cost });
  }
  if (dust.length) {
    add({ id: 'dust', level: 'medium', title: `${dust.length} tiny coin${dust.length === 1 ? '' : 's'} — possibly a "dust attack"`,
      detail: dust.map((c) => `${sats(c.value)} on ${short(c.address)}`).join(', ') + '. Attackers send tiny amounts to many addresses and watch which ones get spent together, to link addresses and identify wallets. A tiny coin you did not expect is very likely that.',
      advice: 'Never spend these together with your other coins. The simplest: leave them where they are forever. In Send, use the coin list to tick only the coins you mean to spend.' });
  }
  if (uneconomic.length) {
    add({ id: 'uneconomic', level: 'low', title: `${uneconomic.length} coin${uneconomic.length === 1 ? '' : 's'} cost more to spend than ${uneconomic.length === 1 ? 'it is' : 'they are'} worth right now`,
      detail: uneconomic.map((c) => `${sats(c.value)} would cost about ${sats(Math.round(c.cost))} in fees at ${feeRate} sat/vB`).join('; ') + '. Spending them merges them with your other coins for no gain.',
      advice: 'Leave them out of payments (coin control) unless fees drop a lot. They are not lost; they are just not worth moving today.' });
  }

  // 4. addresses provably linked by past spends (common-input-ownership): a transaction that
  //    created one of our coins and spent from several of our addresses
  const links = [];
  for (const [txid, t] of txs) {
    const ours = new Set();
    for (const i of t.inputs) for (const h of i.keyHashes) if (ourHashes.has(h)) ours.add(h);
    if (ours.size >= 2) links.push({ txid, count: ours.size, inputs: t.inputs.length });
  }
  if (links.length) {
    add({ id: 'linked', level: 'low', title: `${links.length} past payment${links.length === 1 ? '' : 's'} publicly joined several of your addresses`,
      detail: links.map((l) => `transaction ${short(l.txid)} spent from ${l.count} of your addresses at once`).join('; ') + '. Anyone can see that those addresses belong to the same wallet (the "common-input" rule every chain-analysis firm uses). This is normal — it is what spending looks like — but it is visible.',
      advice: 'When privacy matters for a particular payment, pay it from a single coin that covers it (coin control), so no other addresses get tied to it.' });
  }

  // 5. two address families in one wallet
  const types = new Set(confirmed.map((c) => c.type));
  if (types.has('p2wpkh') && types.has('p2pkh')) {
    add({ id: 'mixed-types', level: 'info', title: 'Coins on both SegWit (bc1q…) and Legacy (1…) addresses',
      detail: 'Spending a SegWit coin and a Legacy coin in the same payment ties the two families together on-chain, and Legacy inputs pay roughly double the fee.',
      advice: 'Prefer SegWit for receiving; if you spend Legacy coins, spend them on their own or move them to SegWit addresses in one go.' });
  }

  // 6. what this report cannot see
  add({ id: 'scope', level: 'info', title: 'What this check can and cannot see',
    detail: `It looked at ${coins.length} unspent coin${coins.length === 1 ? '' : 's'}${txs.size ? ` and the ${txs.size} transaction${txs.size === 1 ? '' : 's'} that created them` : ''}. Olesia's node keeps no address index, so coins you already spent, and payments to addresses that are now empty, are not part of it. A block explorer sees all of that — and so does anyone else.`,
    advice: null });

  const order = { high: 0, medium: 1, low: 2, info: 3, good: 4 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  const worst = findings.find((f) => f.level in { high: 1, medium: 1, low: 1 });
  return { findings, summary: !coins.length ? 'No coins yet — nothing is visible about this wallet beyond its existence.' : worst ? (worst.level === 'high' ? 'Something important to know.' : worst.level === 'medium' ? 'A few things worth changing.' : 'Mostly fine; small things to keep in mind.') : 'Nothing to worry about in what can be seen.' };
}
