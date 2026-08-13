// RT-10 — reorg-aware chain tracker for the notify bot.
//
// The old scanner advanced a single `lastScanned` height monotonically and alerted at 1
// confirmation, so a reorg that evicted a block left a stale "confirmed" alert and was never
// rescanned. This tracker keeps a BOUNDED window of recent {height: hash}, detects reorgs by
// comparing stored hashes to the node's current hashes, rolls back to the fork point, and only
// releases blocks for notification once they are buried at least `minConf` deep. All logic is
// pure given an injected `store` and `getBlockHash`, so it is fully unit-testable.
//
// This is DISPLAY/notification correctness only — no payout, signing or accounting depends on it.

export const DEFAULT_MIN_CONF = 2;      // alert only when a block is >= this many deep

// A minimal in-memory store (the bot supplies a SQLite-backed one with the same shape).
export function memoryStore() {
  const m = new Map();
  return {
    get: (h) => m.get(h),
    set: (h, hash) => { m.set(h, hash); },
    delete: (h) => { m.delete(h); },
    heights: () => [...m.keys()].sort((a, b) => a - b),
  };
}

export class ChainTracker {
  // store: { get(h)->hash|undefined, set(h,hash), delete(h), heights()->number[] asc }
  constructor(store, { minConf = DEFAULT_MIN_CONF, maxTrack = 24 } = {}) {
    this.store = store;
    this.minConf = Math.max(1, minConf | 0);
    this.maxTrack = Math.max(this.minConf + 1, maxTrack | 0);
    const hs = store.heights();
    this.lastScanned = hs.length ? hs[hs.length - 1] : null;
  }

  // Highest tracked height whose stored hash still matches the node. Everything above it is
  // orphaned. If every tracked height diverges, the fork is below the lowest tracked height.
  async _detectReorg(getBlockHash) {
    const hs = this.store.heights();          // ascending
    if (!hs.length) return { reorg: false, forkHeight: this.lastScanned };
    let reorg = false;
    for (let i = hs.length - 1; i >= 0; i--) {
      const h = hs[i];
      let nodeHash = null;
      try { nodeHash = await getBlockHash(h); } catch { nodeHash = null; }
      if (nodeHash && nodeHash === this.store.get(h)) return { reorg, forkHeight: h };
      reorg = true;                            // this height no longer on the canonical chain
    }
    return { reorg, forkHeight: hs[0] - 1 };    // deep reorg: rescan from below our window
  }

  // Plan the next scan. Returns { scanFrom, scanTo, reorg, orphanedHeights }. `scanTo`
  // respects confirmation depth (only blocks buried >= minConf are eligible). On a reorg the
  // orphaned heights are removed from the store and lastScanned rolls back to the fork.
  async plan(tip, getBlockHash) {
    const safeTip = tip - (this.minConf - 1);
    if (this.lastScanned == null) {            // first run: adopt the safe tip, no history
      this.lastScanned = Math.max(-1, safeTip);
      return { scanFrom: null, scanTo: null, reorg: false, orphanedHeights: [] };
    }
    const { reorg, forkHeight } = await this._detectReorg(getBlockHash);
    let orphanedHeights = [];
    if (reorg) {
      orphanedHeights = this.store.heights().filter((h) => h > forkHeight);
      for (const h of orphanedHeights) this.store.delete(h);
      this.lastScanned = forkHeight;
    }
    const scanFrom = this.lastScanned + 1;
    const scanTo = safeTip;
    if (scanTo < scanFrom) return { scanFrom: null, scanTo: null, reorg, orphanedHeights };
    return { scanFrom, scanTo, reorg, orphanedHeights };
  }

  // Record a block as scanned: store its hash, advance lastScanned, prune the window.
  record(height, hash) {
    this.store.set(height, hash);
    if (this.lastScanned == null || height > this.lastScanned) this.lastScanned = height;
    for (const h of this.store.heights()) if (h <= this.lastScanned - this.maxTrack) this.store.delete(h);
  }
}
