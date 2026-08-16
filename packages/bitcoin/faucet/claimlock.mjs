// M4 — per-claim in-process serialization.
//
// The server's /claim handler and the recovery worker can both call advanceClaim(claimId)
// concurrently: each awaits network/RPC, so two passes could read the SAME AUTHORISED state,
// both build+sign, and the loser's bytes could overwrite the winner's persisted raw_tx. This
// chains same-claim calls so at most one runs at a time; different claims still run in parallel.
//
// This lock is an in-process optimisation. The DURABLE guard in ledger.transition()
// (immutable-once-set raw_tx/local_txid) is the true last line if a lock is ever bypassed
// (a crash mid-flight, or a second process), so exactly-once holds even without this.
const tails = new Map();

export function withClaimLock(claimId, fn) {
  const prev = tails.get(claimId) || Promise.resolve();
  const run = prev.then(fn, fn);          // run fn regardless of the previous call's outcome
  const tail = run.catch(() => {});       // the chain never rejects, so the next waiter still runs
  tails.set(claimId, tail);
  tail.then(() => { if (tails.get(claimId) === tail) tails.delete(claimId); });  // GC settled chains
  return run;
}
