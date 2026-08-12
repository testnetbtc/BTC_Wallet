// LIVE deterministic-recovery test (testnet4). Funds several receive- and change-
// chain indices of a THROWAWAY seed from the faucet, then proves discoverAccount —
// given the SEED ALONE, no browser metadata — rediscovers every funded index, and
// documents the gap-limit boundary honestly (a fund beyond the gap is not found at
// the default gap, but is at a larger gap).
//
// Throwaway testnet seed (worthless coins, published only for reproducibility):
//   oxygen kangaroo system lady gun wine front fashion paddle render emerge motion
import { createRequire } from 'node:module';
import { deriveAt, discoverAccount, prepareAndSend } from '../src/send.js';
import { getBalance } from '../src/esplora.js';

const require = createRequire(import.meta.url);
const FAUCET = require('../.secrets/faucet.json').mnemonic;
const SEED = 'oxygen kangaroo system lady gun wine front fashion paddle render emerge motion';
const NET = 'testnet4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = false;
const ok = (l, c) => { console.log(l.padEnd(60), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

// indices to fund: within-gap on both chains, plus one FAR index (50) to show the limit
const RECEIVE = [0, 1, 2, 5, 19, 20, 21];
const CHANGE = [0, 3];
const FAR = 50;
const AMT = 2000;

async function main() {
  // Is it already funded from a previous run? (idempotent-ish)
  const d0 = deriveAt(SEED, NET, 'p2wpkh', 0, 0, '');
  const pre = await getBalance(d0.address, NET);
  if (!pre.used) {
    const recipients = [
      ...RECEIVE.map((i) => ({ address: deriveAt(SEED, NET, 'p2wpkh', 0, i, '').address, amount: AMT })),
      ...CHANGE.map((i) => ({ address: deriveAt(SEED, NET, 'p2wpkh', 1, i, '').address, amount: AMT })),
      { address: deriveAt(SEED, NET, 'p2wpkh', 0, FAR, '').address, amount: AMT },
    ];
    console.log(`funding ${recipients.length} addresses from the faucet…`);
    const r = await prepareAndSend({ source: FAUCET, network: NET, scriptType: 'p2wpkh', recipients, feeRate: 2, broadcast: true, allowUnconfirmed: true });
    console.log('  fund txid', r.broadcastTxid);
    await sleep(6000); // let the API index the outputs
  } else {
    console.log('addresses already funded from a previous run — discovering.');
  }

  // DISCOVERY from the seed alone, default gap 20
  const disc = await discoverAccount({ source: SEED, network: NET, scriptType: 'p2wpkh', gap: 20 });
  const foundRecv = disc.receive.map((e) => e.index).sort((a, b) => a - b);
  const foundChg = disc.change.map((e) => e.index).sort((a, b) => a - b);
  console.log('  discovered receive indices:', foundRecv.join(','));
  console.log('  discovered change indices :', foundChg.join(','));

  for (const i of RECEIVE) ok(`receive index ${i} rediscovered from seed alone`, foundRecv.includes(i));
  for (const i of CHANGE) ok(`change index ${i} rediscovered from seed alone`, foundChg.includes(i));
  ok('aggregated balance is tracked across all discovered addresses', disc.balance.total > 0);
  // next* must be strictly past the highest USED index on each chain (>= because
  // later HD sends may have added change addresses beyond the originally funded set).
  ok('nextReceive is past the highest used receive index', disc.nextReceive >= Math.max(...RECEIVE) + 1);
  ok('nextChange is past the highest used change index', disc.nextChange >= Math.max(...CHANGE) + 1);

  // GAP LIMIT (honest boundary): index 50 sits >20 past index 21, so a gap-20 scan
  // stops before it. A larger gap finds it. This is the documented BIP-44 behaviour.
  ok('index 50 is NOT found at gap 20 (documented gap-limit boundary)', !foundRecv.includes(FAR));
  const wide = await discoverAccount({ source: SEED, network: NET, scriptType: 'p2wpkh', gap: 40 });
  ok('index 50 IS found at gap 40 (proves it is only a scan-window limit)', wide.receive.map((e) => e.index).includes(FAR));

  console.log(bad ? '\nRECOVERY TEST FAILED' : '\nRECOVERY TEST PASS — funds at any rotated index are found from the seed alone');
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error('recovery test error:', e.message); process.exit(1); });
