// Adversarial tests for the faucet velocity circuit-breaker.
//
// The central claim under test: the breaker CANNOT be bypassed by a burst of
// simultaneous requests at the threshold boundary. In single-process Node the
// event loop serialises the synchronous authorize() critical section, so we prove
// the property by (a) firing thousands of authorize() calls in a tight burst and
// (b) firing thousands via Promise.all with an await BEFORE each authorize (the
// realistic request shape: async parse, then the sync decision). In both cases the
// number of authorised payouts must be EXACTLY the limit — never limit+1.
import { VelocityBreaker, validateLimits } from '../faucet/breaker.mjs';

let bad = 0;
const ok = (label, cond) => { console.log(label.padEnd(62), cond ? '✓' : '✗ FAIL'); if (!cond) bad = true; };
const BIG = { maxSatsPerMin: 1e18, maxDistinctAddrPerMin: 1e9, maxUtxosPerMin: 1e18, maxFeePerMin: 1e18, maxFailuresPerMin: 1e9 };
const mk = (limits) => new VelocityBreaker({ persist: false, alert: () => {}, limits });
const T = 1_000_000;

// 1) Synchronous burst far past the limit — exactly `maxClaimsPerMin` authorised.
{
  const b = mk({ maxClaimsPerMin: 10, ...BIG });
  let allowed = 0;
  for (let i = 0; i < 5000; i++) if (b.authorize({ address: 'a' + i, sats: 1, utxos: 1, fee: 1 }, T).ok) allowed++;
  ok('1a. 5000-wide burst authorises EXACTLY the limit (10)', allowed === 10);
  ok('1b. breaker tripped after the burst', b.tripped === true);
  ok('1c. post-trip authorise is denied (fail-closed)', b.authorize({ address: 'z', sats: 1, utxos: 1, fee: 1 }, T).ok === false);
  ok('1d. trip records the breaching metric', b.trip && b.trip.metric === 'claimsPerMin');
}

// 2) THE RACE TEST — async-interleaved burst. Each "request" awaits before calling
//    authorize (models real async request handling); fired all at once via Promise.all.
{
  const b = mk({ maxClaimsPerMin: 25, ...BIG });
  const request = async (i) => { await Promise.resolve(); await Promise.resolve(); return b.authorize({ address: 'x' + i, sats: 1, utxos: 1, fee: 1 }, T).ok; };
  const results = await Promise.all(Array.from({ length: 3000 }, (_, i) => request(i)));
  const allowed = results.filter(Boolean).length;
  ok('2. 3000 async-interleaved requests authorise EXACTLY the limit (25) — no race bypass', allowed === 25);
}

// 3) Sats/min trips independently of claim count (few claims, big sats each).
{
  const b = mk({ maxClaimsPerMin: 1e9, maxSatsPerMin: 500_000, maxDistinctAddrPerMin: 1e9, maxUtxosPerMin: 1e18, maxFeePerMin: 1e18, maxFailuresPerMin: 1e9 });
  let allowed = 0;
  for (let i = 0; i < 20; i++) if (b.authorize({ address: 'a' + i, sats: 100_000, utxos: 1, fee: 1 }, T).ok) allowed++;
  ok('3. sats/min cap trips at 5×100k (=500k) regardless of claim count', allowed === 5 && b.trip.metric === 'satsPerMin');
}

// 4) Distinct-address cap trips; repeats of ONE address don't inflate the distinct count.
{
  const b = mk({ maxClaimsPerMin: 1e9, maxDistinctAddrPerMin: 4, maxSatsPerMin: 1e18, maxUtxosPerMin: 1e18, maxFeePerMin: 1e18, maxFailuresPerMin: 1e9 });
  for (let i = 0; i < 100; i++) b.authorize({ address: 'same', sats: 1, utxos: 1, fee: 1 }, T);   // 1 distinct
  ok('4a. 100 claims to ONE address do not trip the distinct-address cap', b.tripped === false);
  let allowed = 0;
  for (let i = 0; i < 20; i++) if (b.authorize({ address: 'addr' + i, sats: 1, utxos: 1, fee: 1 }, T).ok) allowed++;
  ok('4b. distinct-address cap (4) trips on the 5th new address', b.trip.metric === 'distinctAddrPerMin');
}

// 5) UTXO/min and fee/min caps.
{
  const b = mk({ maxClaimsPerMin: 1e9, maxUtxosPerMin: 6, maxSatsPerMin: 1e18, maxDistinctAddrPerMin: 1e9, maxFeePerMin: 1e18, maxFailuresPerMin: 1e9 });
  for (let i = 0; i < 10; i++) b.authorize({ address: 'u' + i, sats: 1, utxos: 2, fee: 1 }, T);   // 2 utxos each
  ok('5a. utxo/min cap (6) trips at 3×2 utxos → 4th claim', b.trip && b.trip.metric === 'utxosPerMin');
  const b2 = mk({ maxClaimsPerMin: 1e9, maxFeePerMin: 1000, maxSatsPerMin: 1e18, maxDistinctAddrPerMin: 1e9, maxUtxosPerMin: 1e18, maxFailuresPerMin: 1e9 });
  for (let i = 0; i < 10; i++) b2.authorize({ address: 'f' + i, sats: 1, utxos: 1, fee: 300 }, T);
  ok('5b. fee/min cap (1000) trips at 4×300', b2.trip && b2.trip.metric === 'feePerMin');
}

// 6) Failure-rate trips independently of any payout.
{
  const b = mk({ ...BIG, maxFailuresPerMin: 5, maxClaimsPerMin: 1e9 });
  for (let i = 0; i < 20; i++) b.recordReject('bad-address', T);
  ok('6a. failure-rate cap (5) trips on a flood of rejections', b.tripped && b.trip.metric === 'failuresPerMin');
  ok('6b. once tripped, authorise is denied even with no payouts yet', b.authorize({ address: 'q', sats: 1, utxos: 1, fee: 1 }, T).ok === false);
}

// 7) FAIL-CLOSED across time — no auto-resume when the window empties.
{
  const b = mk({ maxClaimsPerMin: 3, ...BIG });
  for (let i = 0; i < 10; i++) b.authorize({ address: 'a' + i, sats: 1, utxos: 1, fee: 1 }, T);
  ok('7a. tripped', b.tripped);
  // advance far beyond the window — the rolling counts would be empty now…
  const later = T + 10 * b.limits.windowMs;
  ok('7b. STILL denied long after the window empties (latched, no auto-resume)', b.authorize({ address: 'new', sats: 1, utxos: 1, fee: 1 }, later).ok === false);
}

// 8) Recovery requires an EXPLICIT reset; only then does it authorise again.
{
  const b = mk({ maxClaimsPerMin: 3, ...BIG });
  for (let i = 0; i < 10; i++) b.authorize({ address: 'a' + i, sats: 1, utxos: 1, fee: 1 }, T);
  ok('8a. tripped before reset', b.tripped);
  b.reset('operator investigated — cleared', 'test', T);
  ok('8b. reset clears the latch', b.tripped === false);
  ok('8c. authorises again after reset', b.authorize({ address: 'fresh', sats: 1, utxos: 1, fee: 1 }, T + 1).ok === true);
}

// 9) Accounting: authorise counts at RESERVE time (pending), so a burst that hasn't
//    settled yet still trips; fail() dispenses nothing but feeds the failure rate.
{
  const b = mk({ maxClaimsPerMin: 1e9, maxSatsPerMin: 300, maxDistinctAddrPerMin: 1e9, maxUtxosPerMin: 1e18, maxFeePerMin: 1e18, maxFailuresPerMin: 1e9 });
  const t1 = b.authorize({ address: 'a', sats: 100, utxos: 1, fee: 1 }, T);
  const t2 = b.authorize({ address: 'b', sats: 100, utxos: 1, fee: 1 }, T);
  const t3 = b.authorize({ address: 'c', sats: 100, utxos: 1, fee: 1 }, T);      // 300 total = at cap, still ok
  ok('9a. three unsettled (pending) 100-sat reservations reach the 300 cap without tripping', t1.ok && t2.ok && t3.ok && !b.tripped);
  ok('9b. the 4th pending reservation trips (pending counts, not just settled)', b.authorize({ address: 'd', sats: 100, utxos: 1, fee: 1 }, T).ok === false);
  const b2 = mk({ ...BIG, maxFailuresPerMin: 2, maxClaimsPerMin: 1e9 });
  const a = b2.authorize({ address: 'a', sats: 1, utxos: 1, fee: 1 }, T);
  b2.fail(a.token, 'broadcast rejected', T);
  b2.recordReject('bad-address', T);
  ok('9c. a broadcast fail() counts toward failure-rate (2 → still under 2? trips on >2)', b2.rejects.length === 2 && !b2.tripped);
  b2.recordReject('bad-address', T);
  ok('9d. one more failure trips the failure-rate cap', b2.tripped);
}

// ── RT-1 regression: a malformed limit must FAIL CLOSED, not disable the metric ──
{
  const MALFORMED = [
    ['string', { maxClaimsPerMin: 'abc' }],
    ['NaN', { maxClaimsPerMin: NaN }],
    ['Infinity', { maxClaimsPerMin: Infinity }],
    ['object', { maxClaimsPerMin: {} }],
    ['array', { maxClaimsPerMin: [30] }],
    ['null', { maxSatsPerMin: null }],
    ['negative', { maxUtxosPerMin: -1 }],
    ['zero', { maxFeePerMin: 0 }],
    ['float', { maxDistinctAddrPerMin: 30.5 }],
    ['boolean', { maxFailuresPerMin: true }],
  ];
  let allClosed = true, everAuthorised = false;
  for (const [label, limits] of MALFORMED) {
    const b = new VelocityBreaker({ persist: false, alert: () => {}, limits });
    if (!b.tripped) { allClosed = false; ok('RT-1: malformed [' + label + '] starts TRIPPED', false); }
    // even one authorise must be denied while config-invalid
    if (b.authorize({ address: 'a', sats: 1, utxos: 1, fee: 1 }, 1e6).ok) everAuthorised = true;
    // reset must NOT resume with the config still invalid
    b.reset('try to clear', 'test', 1e6);
    if (!b.tripped) allClosed = false;
  }
  ok('RT-1: every malformed-limit breaker starts + stays TRIPPED (fail-closed)', allClosed);
  ok('RT-1: a config-invalid breaker never authorises a payout', everAuthorised === false);
  ok('RT-1: a VALID config produces no offenders', validateLimits({ maxClaimsPerMin: 30, maxSatsPerMin: 3000000, maxDistinctAddrPerMin: 30, maxUtxosPerMin: 60, maxFeePerMin: 200000, maxFailuresPerMin: 60, windowMs: 60000 }).length === 0);
  ok('RT-1: reset refuses (returns false) while config invalid', new VelocityBreaker({ persist: false, alert: () => {}, limits: { maxClaimsPerMin: 'x' } }).reset() === false);
}

console.log(bad ? '\nBREAKER TEST FAILED' : '\nBREAKER TEST PASS — velocity breaker is atomic, fail-closed, and reset-gated');
process.exit(bad ? 1 : 0);
