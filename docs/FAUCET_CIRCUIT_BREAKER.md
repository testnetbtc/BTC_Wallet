# Faucet velocity circuit-breaker

A last-line **aggregate safety control** for the faucet. It is deliberately *separate*
from the per-claimant rate limits (Turnstile, per-IP, per-address, global daily cap):
those shape individual behaviour; this watches the **whole faucet** and, on any
anomaly, **stops paying out entirely** until a human clears it.

Files: [`faucet/breaker.mjs`](../packages/bitcoin/faucet/breaker.mjs) (control),
[`faucet/server.mjs`](../packages/bitcoin/faucet/server.mjs) (integration),
[`test/breaker.test.mjs`](../packages/bitcoin/test/breaker.test.mjs) (adversarial tests).

## What it watches (rolling 60 s window)

| Metric | Default cap | Why |
|---|---|---|
| claims / min | 30 | runaway loop / drain |
| sats dispensed / min | 3,000,000 (30 × 0.001) | drain rate, independent of claim count |
| distinct destination addresses / min | 30 | Sybil burst / fan-out |
| UTXOs consumed / min | 60 | wallet-set destruction / fragmentation |
| fee spent / min | 200,000 sat | fee-exhaustion attack |
| failed / rejected claims / min | 60 | probing / attack signal (bad addresses, human-check fails, cap hits, broadcast failures) |

Override any default in `.secrets/breaker.json`, e.g. `{ "maxClaimsPerMin": 20 }`.
Defaults sit far above legitimate use (normal load is well under 1 claim/min through
Turnstile + caps) but catch a runaway, a key/token compromise, or a coordinated drain.

## Behaviour

- **Fail closed.** When a projected metric would exceed its cap, the breaker **trips**:
  it stops authorising payouts (`/claim` returns `503`), persists the trip, writes a
  diagnostic record, alerts, and logs the breaching metric/value/threshold.
- **No auto-resume.** The trip is a **latch**. It does *not* clear when traffic drops or
  the window empties, and it **survives restarts** (persisted to `.secrets/breaker-state.json`).
  Recovery requires an explicit admin action (below).
- **Applies to internal claims too** (the Nostr bot path): a compromised internal token or
  buggy bot is exactly what an aggregate-spend breaker exists to catch.
- **Diagnosis preserved.** Each trip appends a JSON record to `.secrets/breaker-trips.log`
  with the metric, the aggregate snapshot, and the last 50 payouts/rejections.
- **Alerting.** Loud `console.error` (captured by journald) + the trip log always fire.
  If `.secrets/telegram.json` carries an `adminChatId`, the operator is also DM'd.
- `/info` exposes `paused: <bool>` so the UI / ops can see the state.

## Concurrency safety (the core guarantee)

The accounting **and** the allow/deny decision are one **synchronous** operation
(`authorize()` contains no `await`), invoked *before* any `await` in the request handler.
Node runs a single thread and the event loop runs JS to completion between awaits, so a
burst of simultaneous requests is **serialised**: each request's `authorize()` runs
start-to-finish — check *and* reserve — before the next begins. There is no read-then-write
gap, so requests cannot both observe "under the limit" and both proceed; the (threshold+1)th
request trips. Reservations are counted at **authorise** time (not at settle), so a burst
that hasn't finished broadcasting still counts against the caps.

`test/breaker.test.mjs` proves this empirically: firing 3,000 requests each with an `await`
*before* `authorize()` (the realistic async request shape), fired together via `Promise.all`,
authorises **exactly** the limit — never one more. It also covers each metric's cap, the
failure-rate trip, fail-closed persistence across an emptied window, and reset-gated recovery.

## Operator runbook

**See status:**
```
node faucet/breaker.mjs status        # tripped?, limits, current window metrics
curl -s localhost:8790/info           # { …, "paused": true|false }
```

**When it trips:** investigate first — read the diagnosis:
```
tail -n 5 packages/bitcoin/.secrets/breaker-trips.log
journalctl -u olesia-faucet | grep 'CIRCUIT BREAKER'
```
Confirm whether it was a real attack/bug or a threshold set too low.

**Reset (explicit, two-step so it can't happen by accident):**
```
node faucet/breaker.mjs reset "why you are clearing it"   # clears the persisted latch + logs who/why
sudo systemctl reload olesia-faucet                        # SIGHUP -> running process re-reads the latch
```
`reload` sends `SIGHUP` (see the unit's `ExecReload`); the process calls `reloadState()` and
drops the latch. A full `restart` also works (it reloads the cleared state on boot). The
breaker never resumes on its own.

## Design notes / limits

- **Single process.** The atomicity argument relies on one Node process (which the faucet
  is). If ever horizontally scaled, the counter + latch must move to a shared store with a
  fencing lock; the module is structured so only the state backend would change.
- Reservation estimates (2 UTXOs, `feeRate × 250 vB`) are replaced with actuals on `settle`;
  they are conservative (fail-closed) until then.
- The breaker's own `503` denials are **not** fed back into the failure-rate metric (that
  would be a self-sustaining loop).
