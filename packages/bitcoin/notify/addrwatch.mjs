// RT-10 — one reorg-aware address-scan pass. Pure given injected deps, so the whole
// notify/reorg behaviour is unit-testable without the live Telegram bot or a real node.
//
// Deterministic notification identity: (subId, txid, direction) — height-INDEPENDENT — so a
// tx that reappears on a replacement branch at a different height never double-notifies. On a
// reorg, notifications derived from orphaned blocks are dropped; those that do NOT reappear on
// the canonical branch are surfaced as an explicit "reorged out" event, never silently wrong.
export async function scanAddressesOnce(deps) {
  const { tip, getBlockHash, scanBlock, tracker, notified, idxFor, watched, emit, emitReorgOut } = deps;
  const plan = await tracker.plan(tip, getBlockHash);
  const result = { reorg: plan.reorg, orphanedHeights: plan.orphanedHeights || [], scanned: [], notified: [], reorgOut: [] };

  // Reorg: note which notifications came from orphaned blocks. We do NOT remove them yet —
  // keeping them lets the idempotency check below suppress a duplicate if the SAME tx
  // reappears on the replacement branch. Only those that do NOT reappear are removed and
  // surfaced as explicit reorg-outs after the rescan.
  const orphaned = (plan.reorg && plan.orphanedHeights.length) ? notified.byHeights(plan.orphanedHeights) : [];

  const reSeen = new Set();
  if (plan.scanFrom != null) {
    for (let h = plan.scanFrom; h <= plan.scanTo; h++) {
      const { hash, hits } = await scanBlock(h, watched);
      tracker.record(h, hash);
      result.scanned.push(h);
      for (const hit of hits) {
        for (const sub of idxFor(hit.address)) {
          reSeen.add(`${sub.id}|${hit.txid}|${hit.direction}`);
          const already = notified.has(sub.id, hit.txid, hit.direction);
          notified.add(sub.id, hit.txid, hit.direction, h);              // upsert height (keeps reorg tracking accurate)
          if (already) continue;                                         // idempotent — no duplicate alert
          result.notified.push({ sub, hit, height: h });
          if (emit) emit(sub, hit, h);
        }
      }
    }
  }

  for (const o of orphaned) {
    if (reSeen.has(`${o.subId}|${o.txid}|${o.dir}`)) continue;           // reappeared on the new branch -> keep, no reorg-out
    notified.remove(o.subId, o.txid, o.dir);                            // truly orphaned -> drop + explicit notice
    result.reorgOut.push(o);
    if (emitReorgOut) emitReorgOut(o);
  }
  return result;
}
