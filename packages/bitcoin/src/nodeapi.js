// Client for the Olesia node API (api.olesia.io) — the operator's own Bitcoin Core node.
// This is the ONLY network endpoint the mainnet wallet talks to: coins (UTXO-set lookup),
// fee estimates, previous transactions for legacy inputs, and broadcast all go through it.
//
// Everything it returns is treated as UNTRUSTED input by the wallet: scripts are matched
// against locally-derived ones, legacy previous transactions are hash-verified, and a
// broadcast txid is compared with the locally-computed one.
export const DEFAULT_API = 'https://api.olesia.io';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `network`: 'mainnet' talks to the operator's own node. A practice network ('testnet4',
// 'signet', 'testnet3') uses the same calls under /n/<network>/ — the server relays public
// data for those, because no node is run for them.
export function makeNodeApi({ base = DEFAULT_API, network = 'mainnet', fetchFn = (...a) => fetch(...a) } = {}) {
  const prefix = network === 'mainnet' ? '' : `/n/${network}`;
  async function call(method, rawPath, body) {
    const path = rawPath === '/price' ? rawPath : prefix + rawPath;
    let r;
    try {
      r = await fetchFn(base + path, {
        method, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Error('could not reach the Olesia node — check your connection and try again'); }
    let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
    if (!r.ok) throw new Error((j && j.error) || `the Olesia node returned an error (${r.status})`);
    if (!j || typeof j !== 'object') throw new Error('the Olesia node returned an unreadable response');
    return j;
  }

  return {
    base, network,
    status: () => call('GET', '/status'),
    fees: () => call('GET', '/fees'),
    // display-only market price; never used when building a transaction
    price: () => call('GET', '/price'),

    // Look up every unspent coin locked to any of `scripts` (hex scriptPubKeys). The node
    // walks its UTXO set, which can take minutes the first time; progress is reported via
    // onProgress({ state, progress, position }). Resolves to { height, bestblock, utxos }.
    async scan(scripts, { force = false, onProgress = () => {}, signal, pollMs = 2500, maxWaitMs = 40 * 60_000 } = {}) {
      const started = Date.now();
      let job = await call('POST', '/scan', { scripts, force });
      for (;;) {
        if (signal && signal.aborted) throw new Error('cancelled');
        const v = await call('GET', '/scan/' + job.id);
        if (v.state === 'done') return v;
        if (v.state === 'error') throw new Error(v.error || 'the scan failed — try again');
        onProgress(v);
        if (Date.now() - started > maxWaitMs) throw new Error('the scan is taking too long — try again later');
        await sleep(pollMs);
      }
    },

    txout: (outpoints) => call('POST', '/txout', { outpoints }).then((j) => j.outpoints),
    prevTx: (txid, height) => call('POST', '/prevtx', { txid, height }).then((j) => j.hex),
    broadcast: (txHex) => call('POST', '/broadcast', { txHex }).then((j) => j.txid),
  };
}
