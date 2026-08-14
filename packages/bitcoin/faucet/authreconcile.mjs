// NODE-2 — authoritative testnet4 reconciliation + safe reservation retirement.
//
// Our OWN synced testnet4 Core node is the authoritative arbiter; external explorers stay
// advisory. Authority is established PER ATTEMPT (chain, not-IBD, tip-current, valid result);
// if it cannot be established the claim stays UNCERTAIN and its reservation is HELD. Pruned
// history that cannot be established is UNCERTAIN, never guessed. CONFIRMED stays TERMINAL
// (RT-2 exactly-once preserved); a reorg that un-confirms an already-CONFIRMED claim is
// surfaced as a separate review FLAG, never a state mutation and never a replacement payout.
//
// Retirement = removing a reserved outpoint from active coin-selection locking while KEEPING
// the durable audit linkage (reserved_outpoints + local_txid + state) on the claim. It happens
// ONLY on an authoritative CONFIRMED at >= minRetireConf depth, or an authoritative CONFLICTED
// (a reserved input proven spent by a DIFFERENT confirmed tx). This module is NOT wired into
// the live recovery path — it is enabled only behind the operator's NODE-2 production gate.
import { S } from './ledger.mjs';
import { readFileSync } from 'node:fs';

export const DEFAULT_MIN_RETIRE_CONF = 2;   // reservation retirement waits this deep (reorg cushion)

// ── PURE decision function (exhaustively testable) ──
// facts: { authoritative, confirmations|null, inMempool, reservedAnyUnspent, reservedAnySpent,
//          differentConfirmedSpender|null, height? }
export function classifyAuthoritative(facts, { minRetireConf = DEFAULT_MIN_RETIRE_CONF } = {}) {
  if (!facts || !facts.authoritative) return { state: S.UNCERTAIN, retire: false, reason: 'own node not authoritative this attempt' };
  const conf = facts.confirmations;
  if (conf != null && conf >= 1) {
    if (conf >= minRetireConf) return { state: S.CONFIRMED, retire: true, height: facts.height ?? null };
    return { state: S.SEEN, retire: false, reason: `confirmed but only ${conf} conf (< ${minRetireConf}) — hold` };
  }
  if (facts.inMempool) return { state: S.SEEN, retire: false };
  if (facts.differentConfirmedSpender) return { state: S.CONFLICTED, retire: true, by: facts.differentConfirmedSpender, review: true };
  if (facts.reservedAnyUnspent && !facts.reservedAnySpent) return { state: S.ABSENT, retire: false };   // rebroadcast exact bytes
  if (facts.reservedAnySpent) return { state: S.UNCERTAIN, retire: false, reason: 'reserved input consumed but spender undeterminable (pruned/ambiguous) — held' };
  return { state: S.UNCERTAIN, retire: false, reason: 'indeterminate' };
}

// Reorg-after-confirm: for a claim ALREADY CONFIRMED (and possibly retired), authoritative
// POSITIVE evidence of a reorg. It requires the reserved input to be UNSPENT again — the input
// that TX-A consumed has come back — not merely the inability to re-prove confirmation. For an
// OLD confirmed claim whose outputs were spent onward and whose history is pruned, the node
// cannot re-prove confirmation, but the reserved input is (still) spent, so this is correctly
// NOT treated as a reorg (absence of proof != proof of reorg). We never mutate the terminal
// state — this only drives the guard/review flag.
export function isReorgAfterConfirm(facts) {
  return !!(facts && facts.authoritative && (facts.confirmations == null || facts.confirmations < 1)
    && !facts.inMempool && facts.reservedAnyUnspent === true);
}

// ── fact gathering (impure; node primitives injected so it is testable) ──
// node: { ready()->{blocks}|throws, confirmationsOf(txid,outVouts)->number,
//         inMempool(txid)->bool, utxoUnspent(txid,vout)->bool,
//         confirmedSpenderOf(reserved, localTxid)->txid|null }
export async function gatherFacts(node, { localTxid, outVouts = [], reserved = [] }) {
  let ready;
  try { ready = await node.ready(); }
  catch (e) { return { authoritative: false, reason: String(e.message).slice(0, 140) }; }
  const confirmations = await node.confirmationsOf(localTxid, outVouts);
  const inMempool = confirmations >= 1 ? false : await node.inMempool(localTxid);
  let reservedAnyUnspent = false, reservedAnySpent = false;
  for (const op of reserved) { (await node.utxoUnspent(op.txid, op.vout)) ? (reservedAnyUnspent = true) : (reservedAnySpent = true); }
  const differentConfirmedSpender = (confirmations < 1 && !inMempool && reservedAnySpent)
    ? await node.confirmedSpenderOf(reserved, localTxid) : null;
  return {
    authoritative: true, confirmations, inMempool, reservedAnyUnspent, reservedAnySpent,
    differentConfirmedSpender, height: confirmations >= 1 ? (ready.blocks - confirmations + 1) : null,
  };
}

// ── apply an authoritative result to the ledger (retirement lives here; GATED off in prod) ──
// Preserves RT-2: CONFIRMED terminal, no replacement on CONFLICTED/UNCERTAIN, reservations held
// unless authoritatively retire-able. Returns a summary of what it did.
export function applyAuthoritative(ledger, claimId, facts, { minRetireConf = DEFAULT_MIN_RETIRE_CONF } = {}) {
  const claim = ledger.get(claimId);
  if (!claim) return { action: 'missing' };

  // Already-terminal CONFIRMED: never mutate the state. NODE-2A — a reorg that un-confirms it
  // must durably RE-LOCK (quarantine) the original outpoints so coin selection cannot reuse them
  // while the old tx's fate is unresolved. Resolution happens ONLY from authoritative current
  // state; never a replacement payout.
  if (claim.state === S.CONFIRMED) {
    // NODE-2B: a retired CONFIRMED claim ALREADY holds a durable 'retired-confirmed' guard on
    // its outpoints (created atomically at retirement), so X was never selectable in the gap.
    const gReason = ledger.guardReason(claimId);
    if (gReason !== 'reorg-after-confirm') {
      if (isReorgAfterConfirm(facts)) {
        if (gReason) ledger.setGuardReason(claimId, 'reorg-after-confirm');            // flip the existing guard
        else ledger.quarantineOutpoints(claimId, JSON.parse(claim.reserved_outpoints || '[]'), 'reorg-after-confirm');  // legacy: pre-guard claim -> create
        ledger.flagReview(claimId, 'reorg-after-confirm', 'authoritative node no longer shows this tx confirmed');
        return { action: 'reorg-quarantine' };
      }
      return { action: 'noop-terminal' };
    }
    // Already in reorg-hold: resolve ONLY from authoritative current state; the guard is RETAINED
    // (conservative — a guard row is tiny and X is spent, so keeping it is free and reorg-safe).
    if (!facts || !facts.authoritative) return { action: 'quarantine-held-unauthoritative' };
    if (facts.confirmations != null && facts.confirmations >= minRetireConf) {
      ledger.setGuardReason(claimId, 'retired-confirmed');               // TX-A reconfirmed -> back to a normal retirement guard
      ledger.flagReview(claimId, 'reorg-resolved-reconfirmed', 'authoritative reconfirmation');
      return { action: 'quarantine-resolved-reconfirmed' };
    }
    if (facts.differentConfirmedSpender) {
      ledger.setGuardReason(claimId, 'reorg-resolved-conflicting-spend'); // X definitively spent by another; keep guard, no replacement
      ledger.flagReview(claimId, 'reorg-resolved-conflicting-spend', 'input spent by ' + facts.differentConfirmedSpender);
      return { action: 'quarantine-resolved-conflict', by: facts.differentConfirmedSpender };
    }
    return { action: 'quarantine-held' };                                // mempool / unspent+absent / shallow / unprovable
  }
  if (claim.state === S.CONFLICTED || claim.state === S.FAILED_SAFE) return { action: 'noop-terminal' };

  const r = classifyAuthoritative(facts, { minRetireConf });
  switch (r.state) {
    case S.CONFIRMED:
      ledger.markConfirmed(claimId, { height: r.height });
      // NODE-2B: atomic reservation -> durable guard (never an unguarded window). Audit linkage
      // (reserved_outpoints + local_txid) stays on the claim.
      if (r.retire) ledger.retireToGuard(claimId, JSON.parse(claim.reserved_outpoints || '[]'), 'retired-confirmed');
      return { action: 'confirmed', retired: !!r.retire, guarded: !!r.retire };
    case S.CONFLICTED:
      ledger.markConflicted(claimId, 'authoritative: reserved input spent by ' + r.by);
      ledger.retireToGuard(claimId, JSON.parse(claim.reserved_outpoints || '[]'), 'conflicted-retired');  // guard, not bare delete
      ledger.flagReview(claimId, 'conflicted-manual-review', 'no automatic replacement');
      return { action: 'conflicted', retired: true, by: r.by };  // NEVER a replacement payout
    case S.SEEN:
      if (claim.state !== S.SEEN) ledger.markSeen(claimId);
      return { action: 'seen', retired: false };
    case S.ABSENT:
      return { action: 'absent-rebroadcast', retired: false };   // caller rebroadcasts EXACT bytes
    default:
      ledger.markUncertain(claimId, r.reason || 'authoritative reconcile: undeterminable');
      return { action: 'uncertain-held', retired: false };
  }
}

// ── live own-node primitives (cookie RPC to our testnet4 Core node) ──
// gettxout reads the UTXO set (pruned-safe); getmempoolentry is the mempool signal; a bounded
// recent-block scan establishes confirmation/conflict without txindex. Anything it cannot
// establish returns the conservative value so classify falls through to UNCERTAIN.
export function ownNodeReconciler({ rpc, expectedChain, scanDepth = 12 }) {
  const ready = async () => {
    let info;
    try { info = await rpc('getblockchaininfo', []); }
    catch (e) { throw new Error('own node unreachable: ' + String(e.message).slice(0, 120)); }
    if (!info || typeof info.chain !== 'string') throw new Error('own node returned no chain info (ambiguous)');
    if (info.chain !== expectedChain) throw new Error(`own node wrong chain: got "${info.chain}", want "${expectedChain}"`);
    if (info.initialblockdownload) throw new Error('own node still in IBD — not authoritative');
    if (info.headers !== info.blocks || !(info.verificationprogress > 0.999)) throw new Error('own node tip not current — not authoritative');
    return { blocks: info.blocks };
  };
  const confirmationsOf = async (txid, outVouts) => {
    let best = 0;
    for (const v of outVouts) {
      try { const o = await rpc('gettxout', [txid, v, false]); if (o && o.confirmations >= 1) best = Math.max(best, o.confirmations); } catch {}
    }
    if (best >= 1) return best;
    // fallback: bounded recent-block scan (outputs may already be spent onward)
    try {
      const tip = (await rpc('getblockchaininfo', [])).blocks;
      for (let h = tip; h > tip - scanDepth && h >= 0; h--) {
        const hash = await rpc('getblockhash', [h]);
        const blk = await rpc('getblock', [hash, 1]);
        if ((blk.tx || []).includes(txid)) return tip - h + 1;
      }
    } catch {}
    return 0;
  };
  const inMempool = async (txid) => { try { await rpc('getmempoolentry', [txid]); return true; } catch { return false; } };
  const utxoUnspent = async (txid, vout) => { try { const o = await rpc('gettxout', [txid, vout, true]); return !!o; } catch { return false; } };
  const confirmedSpenderOf = async (reserved, localTxid) => {
    // bounded recent-block scan: a confirmed tx (!= local) spending a reserved input.
    try {
      const tip = (await rpc('getblockchaininfo', [])).blocks;
      const want = new Set(reserved.map((o) => `${o.txid}:${o.vout}`));
      for (let h = tip; h > tip - scanDepth && h >= 0; h--) {
        const hash = await rpc('getblockhash', [h]);
        const blk = await rpc('getblock', [hash, 2]);
        for (const tx of blk.tx || []) {
          if (tx.txid === localTxid) continue;
          for (const vin of tx.vin || []) { if (vin.txid && want.has(`${vin.txid}:${vin.vout}`)) return tx.txid; }
        }
      }
    } catch {}
    return null;   // could not prove a different confirmed spender -> caller stays UNCERTAIN
  };
  return { ready, confirmationsOf, inMempool, utxoUnspent, confirmedSpenderOf };
}

export function cookieRpcFromPath(url, cookiePath) {
  return async (method, params = []) => {
    const cookie = readFileSync(cookiePath, 'utf8').trim();
    const auth = 'Basic ' + Buffer.from(cookie).toString('base64');
    const r = await fetch(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'authrecon', method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
}
