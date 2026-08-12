// Data layer for olesia-notify — everything on-chain comes from OUR OWN full
// node via local RPC. No third-party block explorer ever sees a watched
// address. Price is the sole exception (fiat is not on-chain) and comes from an
// exchange ticker, clearly separated below.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(join(HERE, '..', '.secrets', 'notify-node.json'), 'utf8'));
const AUTH = 'Basic ' + Buffer.from(`${CFG.rpcUser}:${CFG.rpcPassword}`).toString('base64');
export const NODE_NETWORK = CFG.network || 'mainnet';

export async function rpc(method, params = []) {
  const r = await fetch(CFG.rpcUrl, {
    method: 'POST',
    headers: { authorization: AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'notify', method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// --- blocks -------------------------------------------------------------
export const tipHeight = () => rpc('getblockcount');

// --- fees (sat/vB) from the node's own estimator -----------------------
export async function fastestFee() {
  // estimatesmartfee returns BTC/kvB for the target confirmation window
  const est = await rpc('estimatesmartfee', [1]);       // ~next block
  if (!est || !est.feerate) {
    // fall back to mempool minimum if the estimator has no data
    const info = await rpc('getmempoolinfo', []);
    return Math.max(1, Math.round((info.mempoolminfee || 0.00001) * 1e8 / 1000));
  }
  return Math.max(1, Math.round(est.feerate * 1e8 / 1000));
}
export const mempoolInfo = () => rpc('getmempoolinfo');

// --- address activity: scan a single block for watched addresses -------
// Returns hits: [{ address, txid, direction: 'in'|'out' }]. Uses the block's
// own undo data (verbosity 3) so spends resolve to their input addresses —
// all from our node, nothing leaves the box.
function addrOf(spk) {
  if (!spk) return null;
  return spk.address || (spk.addresses || [null])[0];
}
export async function scanBlock(height, watched) {
  if (!watched.size) return [];
  const hash = await rpc('getblockhash', [height]);
  const blk = await rpc('getblock', [hash, 3]);
  const hits = [];
  for (const tx of blk.tx || []) {
    for (const vin of tx.vin || []) {
      const a = addrOf(vin.prevout && vin.prevout.scriptPubKey);
      if (a && watched.has(a)) hits.push({ address: a, txid: tx.txid, direction: 'out' });
    }
    for (const vout of tx.vout || []) {
      const a = addrOf(vout.scriptPubKey);
      if (a && watched.has(a)) hits.push({ address: a, txid: tx.txid, direction: 'in' });
    }
  }
  return hits;
}

// --- price: the ONE off-chain feed. A node cannot know fiat price. ------
// Sourced directly from an exchange ticker (Kraken), not a block explorer.
export async function btcUsd() {
  const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD').then((x) => x.json());
  const v = Number(r?.result?.XXBTZUSD?.c?.[0]);
  return Number.isFinite(v) ? v : null;
}
