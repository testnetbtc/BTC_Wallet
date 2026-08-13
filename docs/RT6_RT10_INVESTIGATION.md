# RT-6 … RT-10 — Investigation & Remediation Notes (pre-implementation)

Written for per-item approval BEFORE any code change, matching the RT-2 design-first
discipline. Each item is re-verified against the CURRENT code (line refs below), not just
the original report. `RED_TEAM_MASTER_REPORT.md` stays intact as the pre-remediation record.

Order proposed: RT-7 → RT-9 → RT-6 → RT-10 → RT-8. Rationale: do the ops/telemetry-only
items first (zero payout/signing risk), then the Nostr replay window, then the two that touch
payout/confirmation behaviour LAST (RT-10 confirmation display, RT-8 tx construction) — and
**stop before production** on those two per the auditor's rule.

Legend — **Blast radius**: 🟢 ops/telemetry only · 🟡 notification/UX only · 🔴 touches
tx-construction / payout path (stop before production).

---

## RT-7 — Unbounded breaker trip log 🟢
**Confirmed:** `faucet/breaker.mjs:202` `_logTrip()` and `:165` (reset) `appendFileSync(this.tripLog…)`
with no size cap or rotation; each trip also appends up to 50 recent payouts + 50 rejects.
`.secrets/breaker-trips.log` grows unbounded (slowly — trips are rare).

**Fix:** before appending, `statSync` the log; if it exceeds a cap (propose **1 MiB**), rotate
once to `breaker-trips.log.1` (single generation, `renameSync`) then start fresh. Injectable cap
+ path so it's testable. No behavioural change to the breaker itself.

**Tests:** append past the cap → assert rotation happened, `.1` exists, current file reset, latest
entry present. Regression: full `breaker.test.mjs` stays green.

**Commit:** `RT-7: rotate the breaker trip log at a size cap`. No stop-before-prod needed.

---

## RT-9 — `redact()` scrubs secret key *names*, not secret *values* 🟢
**Confirmed:** `faucet/telemetry.mjs:24-30` redacts a value only when its KEY matches `SECRET_KEY`
(`:21`). A secret-shaped VALUE under a benign key (e.g. a token pasted into a future `error`/`note`
string) would pass through. By design today the `/api` payload is an allowlist and the live secret
scan shows 0 leaks — this is a defence-in-depth gap, not a live leak.

**Fix:** keep the allowlist/key-name redaction as PRIMARY; add a secondary value-scrubber that runs
on string leaves and masks known secret SHAPES: PEM blocks (`BEGIN … PRIVATE KEY`), Telegram bot
tokens (`\d{6,}:[A-Za-z0-9_-]{30,}`), long hex/base64 blobs (≥ 32 hex / ≥ 40 base64 chars), and
`xprv…`/`nsec1…` prefixes. Conservative thresholds so legit fields (addresses ~42 chars bech32,
txids 64 hex) are NOT clobbered — **note:** txids are 64-hex and MUST stay visible, so the hex rule
must exempt exactly-64-hex or be scoped to free-text fields only. This is the one design nuance to
get right; I'll bias toward under-scrubbing (never hide a txid) since there's no live leak.

**Tests:** canary secret embedded in a benign `note`/`error` field → masked; address, txid, drip
amount, block height → preserved verbatim; existing `dashboard.test.mjs` redaction cases stay green.

**Commit:** `RT-9: add value-shaped secret scrubbing to redact() (defence in depth)`. No stop-before-prod.

---

## RT-6 — Nostr replay window across a bot crash 🟡
**Confirmed:** `nostr/bot.mjs` — `seen.add(ev.id)` at `:60` is in-memory; `saveState()` (`:27`)
runs only at end-of-handler (`:79`), on a 60 s interval (`:102`), or on SIGTERM (`:107`). A hard
crash (OOM/kill -9) between `:60` and the next save loses the event-ID dedup; the relay re-delivers
the event on restart → reprocessed. Signature `verify(ev)` (`:59`) and per-event dedup exist, so
this is not a signature bypass; the faucet's per-address/day ledger blocks a repeat to the SAME
address, but a re-delivered event to a DIFFERENT address could yield at most one extra testnet drip
per npub across the crash window.

**Fix (auditor's):** persist dedup SYNCHRONOUSLY before the payout. Concretely: after `verify` +
`seen.add(ev.id)` (`:60`), call `saveState()` **before** `await claim(...)` (`:71`). A re-delivered
event is then skipped after any crash. (Optional hardening: also treat the faucet ledger as the
real exactly-once authority — the bot is best-effort — and note that in a comment.) Keep the
existing end-of-handler save for the `state.claims[pubkey]` timestamp.

**Risk of the fix:** writing `seen` before a failed payout means a genuinely failed claim's event
won't be retried by the relay. Acceptable: testnet coins, user can send a NEW message; and it fails
in the safe direction (no double-pay). I'll state this trade-off in the commit.

**Tests:** simulate handler crash after `seen.add`+save, reload state, re-deliver same event →
assert skipped (no second `claim()` call). Add a small `nostr` unit test harness (the bot has none
today — I'll add a minimal one that imports the handler with injected fakes).

**Commit:** `RT-6: persist Nostr event-dedup before payout (close crash replay window)`. No
stop-before-prod (no signing/faucet-payout logic changes; bot-side dedup only) — but I'll flag it
since it changes when state is written.

---

## RT-10 — No reorg awareness in notifications 🟡 (confirmation display)
**Confirmed:** `notify/node.mjs:52` `scanBlock` reads block-at-height and emits hits; `notify/bot.mjs:472`
scans `lastScanned+1 … tip` and advances `lastScanned` monotonically, alerting "Confirmed in block h"
at 1 confirmation with no rollback. A reorg that evicts block h leaves a stale "received"/"confirmed"
alert and the bot never rescans h. **No payout/accounting impact** — the faucet never latches
"confirmed" and the wallet reads balances live (RT-15 strength); this is notification correctness only.

**Fix:** two parts. (1) Store a small ring of recent `{height: hash}` (last ~12). Before scanning
forward, verify the stored hash for `lastScanned` still equals `getblockhash(lastScanned)`; on
mismatch, walk back to the fork point and rescan from there (re-emit corrected state / suppress
stale). (2) Alert at a small confirmation depth (propose **2**) instead of 1, so a 1-block reorg
resolves before the user is notified. Wording already says "Confirmed in block N" — keep, but only
after depth ≥ 2.

**Tests:** feed a fake `rpc` a reorg (height h hash A then hash B) → assert rollback + rescan and no
duplicate/stale alert; a normal linear extension → unchanged behaviour. The notify bot has test
coverage gaps; I'll add a focused `scanBlock`/reorg unit test with an injected rpc.

**Commit:** `RT-10: reorg-aware block scanning + confirmation depth for notifications`.
**STOP BEFORE PRODUCTION** (changes confirmation semantics) — report for your review before deploy.

---

## RT-8 — Builder accepts dust + string-typed recipient amounts 🔴 (tx construction)
**Confirmed:** `src/tx.js` — `buildSignedTx` (`:149-152`) and `buildSignedTxMulti` (`:97-100`) guard
only `!(Number(r.amount) > 0)`. So `"20000"` (string) coerces and is accepted, and `amount: 1`
(1 sat, below dust) is accepted at build time (network rejects it at broadcast, not the builder).
Floats already throw at `BigInt()`, NaN/zero/negative already rejected. `dust: 546n` in `selectUTXO`
governs CHANGE dust, not recipient outputs. The faucet drip (100 000 sats) is well above dust and
uses `p2wpkh` prepareAndSend, so **the live faucet payout is unaffected** — this is a wallet-builder
hardening item.

**Fix:** in the recipient loop of BOTH builders, require an integer NUMBER amount
(`typeof r.amount === 'number' && Number.isInteger(r.amount)` — reject strings, non-integers) and
require `amount >= DUST` (propose 546 sats, conservative across script types). Do NOT touch the
0-value OP_RETURN output (added outside the recipient loop) or sweep logic. Introduce a shared
`DUST_SAT = 546n` constant + clear error messages (`recipient amount must be an integer number of
sats`, `recipient amount below dust (546)`).

**Tests:** extend `tx.test.mjs`: 1-sat recipient → rejected; `"20000"` string → rejected; 546 →
accepted; 545 → rejected; float/NaN/0/neg → still rejected; OP_RETURN-only + normal sends still
build; existing `freeze`/`fee`/`scripttypes` tests stay green.

**Commit:** `RT-8: reject sub-dust and non-integer recipient amounts at build time`.
**STOP BEFORE PRODUCTION** (touches tx construction) — report for your review before any wallet
redeploy.

---

## Summary for approval
| RT | Area | Blast radius | Stop before prod? | New tests |
|---|---|---|---|---|
| RT-7 | breaker trip-log rotation | 🟢 ops | no | breaker.test |
| RT-9 | redact value-scrubbing | 🟢 telemetry | no | dashboard.test |
| RT-6 | Nostr dedup-before-payout | 🟡 bot | no (flagged) | new nostr test |
| RT-10 | reorg-aware notifications | 🟡 notify | **yes** | new notify test |
| RT-8 | dust/integer recipient guard | 🔴 tx build | **yes** | tx.test |

Discipline for all: one item at a time · its own commit(s) · full regression (434+ checks) after
each · `RED_TEAM_MASTER_REPORT.md` untouched · stop-and-report before production on RT-10 and RT-8.
Awaiting your per-item go-ahead (all five, a subset, or reordered).
