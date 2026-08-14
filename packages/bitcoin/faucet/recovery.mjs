// RT-2 — recovery worker. On startup and periodically, drive every NON-terminal
// claim forward via processClaim(). This is what makes AUTHORISED claims
// auto-complete and UNCERTAIN/BROADCASTING claims reconcile — WITHOUT any client
// re-request and WITHOUT ever constructing a replacement transaction.
import { TERMINAL } from './ledger.mjs';
import { advanceClaim } from './advance.mjs';

// window for the periodic authoritative reorg-after-confirm re-check on recently-CONFIRMED
// claims (reorgs, if they happen at all, resolve within minutes of confirmation).
const REORG_RECHECK_MS = 6 * 3600 * 1000;

// One bounded recovery sweep over all non-terminal claims (+ a bounded reorg re-check on
// recently-confirmed claims when an authoritative reconciler is configured). Each claim is
// advanced a few passes (AUTHORISED->SIGNED->broadcast->reconcile can chain), stopping at a
// terminal or a no-progress state. advanceClaim() routes to the own-node authoritative
// reconciler where enabled, else to processClaim. Never throws (per-claim errors contained).
export async function recoverAll(deps, { passesPerClaim = 5, log = () => {} } = {}) {
  const claims = deps.ledger.nonTerminal();
  const out = { processed: 0, byState: {}, errors: 0 };
  for (const c of claims) {
    let cur = c;
    try {
      for (let i = 0; i < passesPerClaim; i++) {
        const next = await advanceClaim(deps, c.claim_id);
        if (!next) break;
        const done = next.state === cur.state || TERMINAL.has(next.state);
        cur = next;
        if (done) break;
      }
    } catch (e) { out.errors++; log('recover ' + c.claim_id + ': ' + String(e.message).slice(0, 120)); }
    out.processed++;
    out.byState[cur.state] = (out.byState[cur.state] || 0) + 1;
  }
  // Bounded reorg-after-confirm re-check (own-node authoritative only): terminal CONFIRMED
  // claims are NOT in nonTerminal(), so re-check the recently-confirmed ones for a reorg.
  if (deps.authReconcilers && Object.keys(deps.authReconcilers).length) {
    for (const c of deps.ledger.recentConfirmed(REORG_RECHECK_MS)) {
      if (!deps.authReconcilers[c.network]) continue;
      try { await advanceClaim(deps, c.claim_id); out.byState.CONFIRMED_rechecked = (out.byState.CONFIRMED_rechecked || 0) + 1; }
      catch (e) { out.errors++; log('reorg-recheck ' + c.claim_id + ': ' + String(e.message).slice(0, 120)); }
    }
  }
  return out;
}

// Periodic bounded worker. The interval IS the backoff — stuck UNCERTAIN/SEEN claims
// are re-reconciled once per interval, not hammered. Non-overlapping ticks.
export function startRecoveryWorker(deps, { intervalMs = 30_000, log = () => {} } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return null;
    running = true;
    try { return await recoverAll(deps, { log }); }
    catch (e) { log('recovery tick error: ' + String(e.message).slice(0, 120)); return null; }
    finally { running = false; }
  };
  const h = setInterval(tick, intervalMs); if (h.unref) h.unref();
  return { stop: () => clearInterval(h), tick };
}
