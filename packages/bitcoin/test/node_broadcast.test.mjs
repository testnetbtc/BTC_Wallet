// NODE-1 — own-node broadcast adapter tests (fail-closed, no external fallback).
//
// A scriptable fake RPC exercises every path. Invariants proven:
//   * happy: testmempoolaccept(allowed) -> sendrawtransaction -> returns the local txid
//   * node unreachable / wrong chain / IBD / no-result -> THROW (never a silent success)
//   * testmempoolaccept reject -> THROW and NEVER call sendrawtransaction
//   * ambiguous sendrawtransaction error or empty txid -> THROW (caller stays UNCERTAIN)
//   * returned txid != local txid -> THROW (assertBroadcastTxid)
//   * "already in mempool" (either stage) -> idempotent success (our exact tx)
import { makeNodeBroadcaster } from '../faucet/nodebroadcast.mjs';

let bad = 0;
const ok = (l, c) => { console.log(l.padEnd(72), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };

const RAW = 'raw-signed-bytes';
const TXID = 'a'.repeat(64);

// Build a fake rpc from a world config; records calls so we can assert send is/ isn't reached.
function fakeRpc(world) {
  return async (method, params) => {
    world.calls.push(method);
    if (method === 'getblockchaininfo') {
      if (world.chainThrows) throw new Error('connect ECONNREFUSED');
      return { chain: world.chain ?? 'testnet4', initialblockdownload: world.ibd ?? false };
    }
    if (method === 'testmempoolaccept') {
      if (world.tmaThrows) throw new Error('RPC timeout');
      if (world.tmaNoResult) return [];
      return [world.tma ?? { txid: TXID, allowed: true }];
    }
    if (method === 'sendrawtransaction') {
      if (world.sendThrows) throw new Error(world.sendThrows);
      return world.sendReturns !== undefined ? world.sendReturns : TXID;
    }
    throw new Error('unexpected method ' + method);
  };
}
const mk = (world) => makeNodeBroadcaster({ rpc: fakeRpc(world), expectedChain: 'testnet4' });

// ── happy path ──
{
  const world = { calls: [] };
  const b = mk(world);
  const got = await b.broadcast('testnet4', RAW, TXID);
  ok('happy: returns the local txid', got === TXID);
  ok('happy: testmempoolaccept ran BEFORE sendrawtransaction', world.calls.indexOf('testmempoolaccept') < world.calls.indexOf('sendrawtransaction'));
}

// ── fail-closed: node unreachable ──
{
  const world = { calls: [], chainThrows: true };
  ok('node unreachable -> throws (no send)', await rejects(() => mk(world).broadcast('testnet4', RAW, TXID)) && !world.calls.includes('sendrawtransaction'));
}
// ── fail-closed: wrong chain ──
{
  const world = { calls: [], chain: 'signet' };
  ok('wrong chain -> throws (no send)', await rejects(() => mk(world).broadcast('testnet4', RAW, TXID)) && !world.calls.includes('sendrawtransaction'));
}
// ── fail-closed: still in IBD ──
{
  const world = { calls: [], ibd: true };
  ok('node in IBD -> throws (not authoritative)', await rejects(() => mk(world).broadcast('testnet4', RAW, TXID)) && !world.calls.includes('sendrawtransaction'));
}
// ── fail-closed: testmempoolaccept throws / no result ──
{
  ok('testmempoolaccept RPC error -> throws (no send)', await (async () => { const w = { calls: [], tmaThrows: true }; return await rejects(() => mk(w).broadcast('testnet4', RAW, TXID)) && !w.calls.includes('sendrawtransaction'); })());
  ok('testmempoolaccept empty result -> throws (ambiguous)', await (async () => { const w = { calls: [], tmaNoResult: true }; return await rejects(() => mk(w).broadcast('testnet4', RAW, TXID)) && !w.calls.includes('sendrawtransaction'); })());
}
// ── fail-closed: testmempoolaccept REJECTS -> never send ──
{
  const world = { calls: [], tma: { txid: TXID, allowed: false, 'reject-reason': 'min relay fee not met' } };
  ok('tma reject -> throws AND never calls sendrawtransaction', await rejects(() => mk(world).broadcast('testnet4', RAW, TXID)) && !world.calls.includes('sendrawtransaction'));
}
// ── fail-closed: tma txid disagrees with local ──
{
  const world = { calls: [], tma: { txid: 'b'.repeat(64), allowed: true } };
  ok('tma txid != local -> throws', await rejects(() => mk(world).broadcast('testnet4', RAW, TXID)));
}
// ── fail-closed: sendrawtransaction ambiguous error / empty txid ──
{
  ok('send ambiguous error -> throws (UNCERTAIN)', await rejects(() => mk({ calls: [], sendThrows: 'timed out waiting for RPC' }).broadcast('testnet4', RAW, TXID)));
  ok('send returns empty txid -> throws (ambiguous)', await rejects(() => mk({ calls: [], sendReturns: '' }).broadcast('testnet4', RAW, TXID)));
}
// ── fail-closed: returned txid != local txid ──
{
  ok('returned txid != local -> throws (assertBroadcastTxid)', await rejects(() => mk({ calls: [], sendReturns: 'c'.repeat(64) }).broadcast('testnet4', RAW, TXID)));
}
// ── idempotent: already in mempool at either stage -> success (our exact tx) ──
{
  ok('tma "already in mempool" -> idempotent success', (await mk({ calls: [], tma: { allowed: false, 'reject-reason': 'txn-already-in-mempool' } }).broadcast('testnet4', RAW, TXID)) === TXID);
  ok('send "already known" -> idempotent success', (await mk({ calls: [], sendThrows: 'txn-already-known' }).broadcast('testnet4', RAW, TXID)) === TXID);
}
// ── NO external fallback: the adapter has no CODE path to an external broadcaster ──
{
  const src = (await import('node:fs')).readFileSync(new URL('../faucet/nodebroadcast.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');   // strip comments
  ok('adapter imports NO esplora/external broadcaster', !/esplora|esploraBroadcast/i.test(code));
  ok('adapter contains NO external URL literal (only the injected node rpc)', !/https?:\/\//i.test(code));
}

console.log(bad ? '\nNODE-1 BROADCAST TEST FAILED' : '\nNODE-1 BROADCAST TEST PASS — own-node, fail-closed, txid-matched, no external fallback');
process.exit(bad ? 1 : 0);
