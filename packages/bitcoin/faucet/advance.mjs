// NODE-2 PHASE B — route a claim to the right reconciler.
//
// For a network that has an AUTHORITATIVE own-node reconciler, a SEEN/UNCERTAIN/CONFIRMED claim
// is reconciled against our own node (this is where SEEN -> CONFIRMED + atomic retire-to-guard,
// and reorg-after-confirm quarantine, happen). An 'absent' authoritative result falls back to
// processClaim to rebroadcast the EXACT persisted bytes via the own-node broadcaster. Everything
// else (AUTHORISED/SIGNED/BROADCASTING, or networks without an own-node reconciler) uses
// processClaim as before. The single authoritative transaction build/sign path is unchanged.
//
// Fail-safe: if the node is not authoritative THIS attempt (unreachable / wrong chain / IBD /
// tip not current / malformed), we do NOT mutate the claim — it holds its current state and its
// reservation/guard. UNKNOWN is never turned into a release or a downgrade.
import { processClaim } from './claimflow.mjs';
import { S } from './ledger.mjs';
import { gatherFacts, applyAuthoritative } from './authreconcile.mjs';
import { decodeRawTx } from '../src/send.js';
import { withClaimLock } from './claimlock.mjs';

const AUTH_STATES = new Set([S.SEEN, S.UNCERTAIN, S.CONFIRMED]);

export function outVoutsOf(rawTx, network) {
  try { return (decodeRawTx({ hex: rawTx, network }).outputs || []).map((o) => o.vout); }
  catch { return []; }
}

// M4 — serialize all advancement of a single claim (server hot path + recovery worker share
// this one lock), so concurrent passes can never both sign and race the persisted raw_tx.
export function advanceClaim(deps, claimId) {
  return withClaimLock(claimId, () => advanceClaimInner(deps, claimId));
}

async function advanceClaimInner(deps, claimId) {
  const { ledger, authReconcilers = {}, minRetireConf = 2 } = deps;
  const c = ledger.get(claimId);
  if (!c) return null;
  const rec = authReconcilers[c.network];
  if (rec && AUTH_STATES.has(c.state) && c.local_txid) {
    let facts;
    try {
      facts = await gatherFacts(rec, {
        localTxid: c.local_txid,
        outVouts: c.raw_tx ? outVoutsOf(c.raw_tx, c.network) : [],
        reserved: JSON.parse(c.reserved_outpoints || '[]'),
      });
    } catch { facts = { authoritative: false }; }
    // Node not authoritative this attempt -> hold current state (never downgrade/release).
    if (!facts.authoritative) return c;
    const r = applyAuthoritative(ledger, claimId, facts, { minRetireConf });
    if (r.action === 'absent-rebroadcast') return processClaim(deps, claimId);   // rebroadcast EXACT bytes
    return ledger.get(claimId);
  }
  return processClaim(deps, claimId);
}
