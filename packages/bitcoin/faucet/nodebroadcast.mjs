// NODE-1 — own-node broadcast for the faucet (fail-closed, no external fallback).
//
// Build+sign happens elsewhere; this module ONLY broadcasts the exact signed bytes through our
// OWN Bitcoin Core node and returns the txid, which MUST equal the locally-computed txid. Every
// uncertainty throws so the caller keeps the claim UNCERTAIN (never a silent success, never a
// fallback to mempool.space or any other external broadcaster):
//   * node unreachable / RPC error            -> throw
//   * wrong chain (not the expected network)   -> throw
//   * node still in IBD (not authoritative)    -> throw
//   * testmempoolaccept rejects the tx         -> throw (do NOT send)
//   * ambiguous/absent returned txid           -> throw
//   * returned txid != locally-computed txid   -> throw (assertBroadcastTxid)
// "Already in mempool / already known" is idempotent success (our exact tx is already out).
import { readFileSync } from 'node:fs';
import { assertBroadcastTxid } from '../src/send.js';

// Cookie-authenticated JSON-RPC client for a local Core node. The cookie is re-read on EVERY
// call so a node restart (which rotates the cookie) does not wedge the client.
export function cookieRpc({ url, cookiePath, timeoutMs = 8000 }) {
  return async (method, params = []) => {
    const cookie = readFileSync(cookiePath, 'utf8').trim();          // "__cookie__:<random>"
    const auth = 'Basic ' + Buffer.from(cookie).toString('base64');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '1.0', id: 'faucet', method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
      return j.result;
    } finally { clearTimeout(timer); }
  };
}

const ALREADY = /already|txn-already|in.?mempool|duplicate/i;

export function makeNodeBroadcaster({ rpc, expectedChain }) {
  const assertReady = async () => {
    let info;
    try { info = await rpc('getblockchaininfo', []); }
    catch (e) { throw new Error('own node unreachable: ' + String(e.message).slice(0, 140)); }
    if (!info || typeof info.chain !== 'string') throw new Error('own node returned no chain info (ambiguous) — failing closed');
    if (info.chain !== expectedChain) throw new Error(`own node wrong chain: got "${info.chain}", want "${expectedChain}"`);
    if (info.initialblockdownload) throw new Error('own node still in IBD — not authoritative yet');
    return info;
  };

  return {
    authoritative: true,
    assertReady,
    // Broadcast the EXACT signed bytes; return the txid (== expectedTxid) or THROW (fail closed).
    async broadcast(network, rawTx, expectedTxid) {
      await assertReady();

      // 1) testmempoolaccept — refuse to send something the node would reject.
      let res;
      try { res = await rpc('testmempoolaccept', [[rawTx]]); }
      catch (e) { throw new Error('testmempoolaccept failed (ambiguous): ' + String(e.message).slice(0, 140)); }
      const a = Array.isArray(res) ? res[0] : null;
      if (!a) throw new Error('testmempoolaccept returned no result (ambiguous) — failing closed');
      if (a.allowed !== true) {
        const reason = a['reject-reason'] || 'not allowed';
        if (ALREADY.test(reason)) return expectedTxid;                 // already ours in the mempool
        throw new Error('own node rejected tx: ' + reason);            // fail closed (do not send)
      }
      if (expectedTxid && a.txid && a.txid !== expectedTxid) throw new Error(`testmempoolaccept txid ${a.txid} != local ${expectedTxid}`);

      // 2) sendrawtransaction — the actual broadcast.
      let returned;
      try { returned = await rpc('sendrawtransaction', [rawTx]); }
      catch (e) {
        const m = String(e.message);
        if (ALREADY.test(m)) return expectedTxid;                      // idempotent: already broadcast
        throw new Error('sendrawtransaction failed (ambiguous): ' + m.slice(0, 140));  // fail closed -> UNCERTAIN
      }
      if (!returned || !String(returned).trim()) throw new Error('sendrawtransaction returned no txid (ambiguous) — failing closed');

      // 3) returned txid MUST equal the locally-computed txid.
      return assertBroadcastTxid(expectedTxid, returned);
    },
  };
}
