# Olesia — Red-Team Master Report (assessment only)

**Status: ASSESSMENT COMPLETE — NO remediation performed.** Only a red-team harness
(`test/redteam/harness.mjs`) and this document were added. No production security behaviour
was changed. Findings await operator review before any fix.

- Date: 2026-08-13 · Baseline commit: post-`a931845`
- Method: offline adversarial harness (synthetic/testnet only) + differential vs our own
  Bitcoin Core node + targeted code review where dynamic testing would require crashing a
  production service or risking funds (noted per finding).
- Boundary chain assessed: KEYS → WALLET → SIGNING → SCRIPT/ADDRESS PARSING → TX CONSTRUCTION
  → MEMPOOL → NODE/RPC → FAUCET → UTXO RESERVATION → CIRCUIT BREAKER → TELEMETRY → DASHBOARD
  → NOSTR/NOTIFY.

## Overall verdict

**No Critical findings.** The cryptographic/signing core held under adversarial input: every
hostile destination address was rejected, duplicate inputs are rejected by the signer, output
values are validated, and the WYSIWYS freeze-and-broadcast guarantee (decode-the-exact-bytes +
txid-verify) survived. There is **no discovered path to key loss, unauthorised signing, or
direct fund theft.**

The findings are concentrated in **operational safety and integrity**: the velocity breaker
can be silently disabled by a malformed config (fail-open), several components fail open on
missing/corrupt state (dashboard status; breaker latch across a crash-during-write), the faucet
keeps no persistent claim ledger (restart resets all limits → re-claim), and the faucet trusts
the external explorer's returned txid. These are testnet-scoped today but several would rise in
severity on any mainnet-custody deployment.

## Summary table

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 1 | RT-1 |
| Medium | 4 | RT-2, RT-3, RT-4, RT-5 |
| Low | 5 | RT-6, RT-7, RT-8, RT-9, RT-10 |
| Informational | 5 | RT-11, RT-12, RT-13, RT-14, RT-15 |

## Test harnesses executed

- `test/redteam/harness.mjs` — §1 wallet hostile addresses/values/duplicate in-out, §8 breaker
  malformed-config fail-open, §9/§15 telemetry+dashboard robustness/fail-open, §11 redaction canaries.
- Live dashboard HTTP probes (path traversal, methods, oversized, query reflection).
- Differential vs Bitcoin Core via the existing `scripttypes.test.mjs` (every type decodes and
  its txid matches Core) and `p2pk_vectors.test.mjs` (hand-rolled P2PK verified vs Core).
- Code review of: `faucet/server.mjs`, `faucet/breaker.mjs`, `faucet/dashboard.mjs`,
  `faucet/telemetry.mjs`, `src/send.js`/`esplora.js` (broadcast), `infra/broadcast/server.mjs`,
  `nostr/bot.mjs`, `notify/*`.

---

## Findings

### RT-1 — Velocity breaker fails OPEN on a malformed limit (High)
- **Affected:** `packages/bitcoin/faucet/breaker.mjs` (`authorize`, constructor), `.secrets/breaker.json`
- **Condition:** a configured limit that coerces to `NaN`/`Infinity` (a non-numeric string,
  object, `NaN`, or `Infinity`) — e.g. a typo in `breaker.json`.
- **Repro:** `node test/redteam/harness.mjs` → §8. With `{maxClaimsPerMin:"abc"}` (or `NaN`,
  `{}` , `Infinity`) a 200-request burst authorises **200/200 and never trips**.
- **Expected:** malformed breaker state fails **closed** (the operator explicitly asked for this).
- **Observed:** the check is `metrics > limit`; `1 > NaN` and `1 > Infinity` are `false`, so the
  metric is **silently disabled** — the safety control fails open. (Values that coerce to a
  number — `null→0`, `true→1`, `[30]→30`, negatives — correctly trip/fail-closed.)
- **Impact:** a mistyped config removes an aggregate spend-safety guarantee with no error.
- **Exploitability:** Low — `breaker.json` is operator-controlled (`.secrets`, 600, gitignored);
  no external attacker can write it, and the *default* (no file) uses valid limits. But it defeats
  the stated "fail-closed on malformed state" property, hence High **impact**.
- **Evidence:** harness §8 lines `VULN claims limit=string/NaN/object/Infinity … authorised 200/200`.
- **Suggested remediation:** validate each limit at load — require a finite number `> 0`; on any
  invalid value, refuse to start (or fall back to the safe default) rather than silently disable.
- **Regression test:** assert a breaker built with each non-finite/NaN limit either throws at
  construction or trips the burst (never authorises 200/200).

### RT-2 — No persistent claim ledger: restart resets all rate limits → re-claim / double payout (Medium)
- **Affected:** `faucet/server.mjs` (`hits` Maps, `reserved` Set — all in-memory; no DB)
- **Condition:** the faucet process restarts (deploy, crash, `Restart=on-failure`) after payouts.
- **Repro:** claim to address A (per-address limit recorded in memory) → `systemctl restart
  olesia-faucet` → claim to A again → **succeeds again**. Observed indirectly this session: the
  per-address "already got coins today" only holds within a single PID; each restart clears it.
- **Expected:** an already-paid address stays rate-limited across restarts; the daily global cap
  is durable.
- **Observed:** per-IP, per-address, and global caps live in in-memory `Map`/array and reset on
  restart; the breaker's 60 s window also resets (only its trip **latch** persists). So every
  restart yields fresh limits and lets paid addresses re-claim.
- **Impact:** limit bypass and repeated payouts across restarts; the "500/day" global cap is not
  actually per-day. Testnet coins are worthless (Medium); on mainnet this is High.
- **Exploitability:** Medium — restarts are not directly attacker-triggerable but occur routinely.
- **Evidence:** `server.mjs:103` `hits = { ip:Map, addr:Map, global:[] }`; `:56` `reserved = new Set()`;
  no `sqlite`/ledger present.
- **Remediation:** a durable idempotent claim store (address+day key with a unique constraint) and
  durable global counter; reconcile against chain on start.
- **Regression test:** simulate restart (new breaker/limit state) and assert a same-address second
  claim is refused when a persistent ledger is present.

### RT-3 — Dashboard fails OPEN on missing/corrupt/stale telemetry (shows RUNNING) (Medium)
- **Affected:** `faucet/telemetry.mjs` (`breakerView`), `faucet/dashboard.mjs` (`apiPayload`),
  non-atomic telemetry write in `faucet/server.mjs`
- **Condition:** telemetry file missing, empty, truncated (partial write), or stale (faucet down/tripped-but-not-yet-written).
- **Repro:** harness §9 — `breakerView(undefined|null|{}|malformed).state === 'RUNNING'`. Live:
  the faucet writes the telemetry file with a **non-atomic** `writeFileSync` every 3 s; a reader
  that catches it mid-write JSON-parse-fails → `apiPayload` defaults `tel={}` → dashboard shows
  **RUNNING**.
- **Expected:** inability to read faucet state → **UNKNOWN/STALE**, not RUNNING.
- **Observed:** the pill reads RUNNING for absent/corrupt/stale telemetry; a **down or
  just-tripped faucet can display as healthy** (the small "telemetry Ns old" line is the only hint).
- **Impact:** misleading security status — the operator can misread a down/tripped faucet as fine.
- **Exploitability:** N/A (not attacker-driven) but a real integrity/observability defect, and one
  the brief explicitly called out ("make stale services look healthy").
- **Evidence:** harness §9 `breakerView(undefined) -> state=RUNNING`; `server.mjs:73` plain
  `writeFileSync(TELEMETRY_FILE, …)`.
- **Remediation:** treat missing/stale/unparseable telemetry as an explicit `UNKNOWN` state; write
  atomically (`write tmp + rename`); flag `telemetryAgeMs > N` as STALE in the pill itself.
- **Regression test:** `breakerView(undefined)` must yield `UNKNOWN`; a stale `telemetryAgeMs`
  must not render RUNNING.

### RT-4 — Breaker trip latch can be lost by a crash during its non-atomic state write (Medium)
- **Affected:** `faucet/breaker.mjs` (`_save` non-atomic; `_load` swallows parse errors → untripped)
- **Condition:** process crash/kill during `_save()` (partial `breaker-state.json`), or a corrupted
  latch file.
- **Repro (code-path):** `_save` uses plain `writeFileSync` (truncate+write); an interrupted write
  leaves invalid JSON. On restart `_load`'s `try/catch` swallows the parse error and **keeps the
  in-memory (untripped) state** → the persisted "PAUSED" latch is lost → **fail-open**. (Not
  dynamically reproduced to avoid corrupting the live latch — documented as a limitation.)
- **Expected:** an unreadable/partial latch fails **closed** (assume tripped) until an admin clears it.
- **Observed:** unreadable latch → untripped (payouts resume).
- **Impact:** the "no auto-resume / survives restart" guarantee of the breaker can be defeated by a
  crash at the worst instant.
- **Exploitability:** Low (needs a crash during the sub-millisecond write window or FS corruption).
- **Evidence:** `breaker.mjs:159` `_save` plain write; `:150-157` `_load` catch keeps current state.
- **Remediation:** atomic write (tmp+rename); on unreadable latch, default to **tripped**
  (fail-closed) and require explicit reset.
- **Regression test:** feeding `_load` a corrupt state file must leave the breaker tripped.

### RT-5 — Faucet trusts the external explorer's returned txid unverified (Medium)
- **Affected:** `src/send.js` (`prepareAndSend` → `broadcast()`), `src/esplora.js` (testnet POST /tx)
- **Condition:** faucet broadcasts a testnet tx via mempool.space and reports the txid the API returns.
- **Repro (code-path):** `prepareAndSend` does `broadcastTxid = await broadcast(built.txHex)` and
  returns it directly — **no comparison to the locally-computed `built.txid`**. Contrast the
  wallet's `broadcastRaw` (`send.js:271-273`) which recomputes `expected = decodeRawTx(hex).txid`
  and **aborts on mismatch**. The faucet path lacks this check.
- **Expected:** the reported txid is the one the signed bytes actually hash to.
- **Observed:** a hostile/buggy explorer could return an arbitrary txid string; the faucet would
  report it. (Coins still go to the correct destination — `txHex` is locally built — so no fund loss.)
- **Impact:** misreported txid (user can't find their tx); external explorer influences reported
  state. Testnet-scoped; mainnet faucet broadcast uses our own node (`testmempoolaccept`), so this
  is testnet-only.
- **Exploitability:** Low (requires a malicious/broken explorer).
- **Evidence:** `send.js:75` unverified vs `send.js:271-273` verified.
- **Remediation:** apply the `broadcastRaw` txid-verification on the faucet path too.
- **Regression test:** stub `broadcast()` to return a wrong txid and assert the faucet send rejects it.

### RT-6 — Nostr replay window across a bot crash (Low)
- **Affected:** `nostr/bot.mjs` (`seen`/`state.claims` persisted only via periodic `saveState`)
- **Condition:** the Nostr bot crashes after processing an event but before `saveState`; the relay
  re-delivers the event.
- **Observed:** dedup (`seen.add(ev.id)`) and the per-npub 24 h limit are held in memory and saved
  to `nostr-state.json` at checkpoints; a crash before the save can lose the record, letting a
  re-delivered event be reprocessed. The faucet's per-address cap blocks a repeat to the *same*
  address, but a *different* address from the same npub could double-claim across the crash window.
- **Impact:** at most one extra testnet drip per npub across a crash. **Signature verification
  (`verify(ev)`) and event-ID dedup are present** (not bypassable without a valid signature).
- **Exploitability:** Low.
- **Evidence:** `nostr/bot.mjs:57-60` (dedup+verify), `:27` (`saveState` checkpointed).
- **Remediation:** persist `seen`/`claims` synchronously before the payout call.

### RT-7 — Unbounded breaker trip log (Low)
- **Affected:** `faucet/breaker.mjs` `_logTrip`/reset → `appendFileSync(TRIP_LOG …)` never rotated.
- **Impact:** slow unbounded growth of `.secrets/breaker-trips.log` (each trip/reset appends,
  including up to 50 recent payouts). Rare events, but no cap/rotation.
- **Remediation:** cap/rotate the log; the ring buffers (payouts/rejects ≤25, breaker window 60 s)
  are already bounded.

### RT-8 — Builder accepts dust and string-typed recipient amounts (Low)
- **Affected:** `src/tx.js` `buildSignedTx`
- **Observed:** harness §1 — a **1-sat recipient output is accepted** (below dust; the network
  rejects it at broadcast, not the builder), and a **string amount `"20000"` is silently coerced**
  to a value. Zero/negative/float/NaN are correctly rejected.
- **Impact:** a user could build an unbroadcastable dust tx; type looseness on amounts. No fund risk.
- **Remediation:** reject recipient outputs below the dust threshold at build time; require integer
  amounts.

### RT-9 — `redact()` covers secret-shaped key *names*, not secret *values* under benign keys (Low)
- **Affected:** `faucet/telemetry.mjs` `redact`
- **Observed:** harness §11 — a canary placed under `note`/`address` is **not** redacted (only keys
  matching the secret regex are). This is by design (the `/api` payload is an allowlist and never
  puts secrets in benign fields), but it means the redaction net wouldn't catch a secret that
  reached a benignly-named field (e.g. a token embedded in a future error string).
- **Impact:** defence-in-depth gap only; **no live leak found** (the live `/api` secret scan showed
  0 occurrences of the node RPC password).
- **Remediation:** keep the allowlist as primary; optionally add value-shaped scrubbing for known
  secret formats in free-text fields.

### RT-10 — No reorg awareness in notifications / confirmation display (Low)
- **Affected:** `notify/node.mjs` (`scanBlock`), wallet/faucet confirmation handling
- **Observed:** the notify bot alerts on block hits with no rollback; a reorged tx would leave a
  stale "received" notification. The faucet returns a txid immediately and never asserts "confirmed"
  (safe). The wallet reads balances **live from chain each time** (no latched "confirmed forever" —
  a genuine strength, see RT-15).
- **Impact:** notification correctness only; no payout/accounting impact.
- **Remediation:** re-scan/rollback recent blocks on reorg before considering an alert final.

### RT-11 — Ambiguous mainnet send is treated as FAILURE, not success (Informational — safe direction)
- `infra/broadcast/server.mjs` runs `testmempoolaccept` then `sendrawtransaction`; a timeout/
  "already-in-mempool" surfaces as an **error**. The system therefore interprets uncertainty as
  **failure** (fail-closed), which can misreport a real success as a failure but never the reverse —
  the safe direction the brief asked for. No fix needed; noted for completeness.

### RT-12 — `/info` publicly exposes breaker `paused` state + balances (Informational)
- The public faucet `/info` now includes `paused` and per-network balances. Balances are public
  on-chain; `paused` reveals whether the safety control is active — a minor reconnaissance aid.
  Consider gating `paused` behind the internal path if that matters.

### RT-13 — Script-type differential surface is minimal; no disagreement found (Informational)
- The wallet constructs only P2PKH/P2SH-P2WPKH/P2WPKH/P2TR/P2PK (+OP_RETURN). `scripttypes.test.mjs`
  asserts each built tx decodes in Bitcoin Core with a **matching txid**, and `p2pk_vectors.test.mjs`
  cross-checks the hand-rolled P2PK against Core. CLTV/CSV/bare-multisig/non-standard scripts are
  **not constructible** by the wallet, so there is little frontend↔library↔Core divergence surface.
  No disagreement observed. The dashboard/notify display addresses/amounts, not custom-script labels.

### RT-14 — WYSIWYS / input validation verified robust (Informational — validated strength)
- Harness §1: **all** hostile destination addresses rejected (wrong-network, bad Bech32 checksum,
  mixed-case, unknown witness version, unicode-confusable, oversized, whitespace, script-as-address);
  **duplicate inputs rejected** by `@scure/btc-signer`; zero/negative/float/NaN amounts rejected.
  The confirm flow decodes the exact signed bytes and `broadcastRaw` aborts on any txid mismatch.
  No finding — recorded as a validated guarantee.

### RT-15 — Chain-derived state (no "confirmed = forever") (Informational — validated strength)
- Wallet/faucet/dashboard read balances and UTXO/mempool state **live from chain each time**; there
  is no latched confirmation that a reorg could falsify. Reorg-safe by construction on the display side.

---

## Cross-component contradiction checks (§15)

| Attempted contradiction | Result |
|---|---|
| breaker TRIPPED but dashboard says RUNNING | **Reproducible** transiently — see RT-3 (stale/partial telemetry → RUNNING). |
| breaker TRIPPED but claim endpoint still pays | **Not** reproducible — `authorize()` denies in-process the moment it trips; the dashboard is a passive mirror. |
| faucet says paid / node says unknown | Possible via RT-5 (explorer returns bad txid) — reported txid can diverge from the real one; coins still land correctly. |
| double payout without a restart | **Not** reproducible — synchronous caps + UTXO reservation (proven in `breaker.test.mjs` 3000-request race test). |
| double payout **across** a restart | **Reproducible** — RT-2 (in-memory limits reset). |

## Things not tested / limitations

- **Live crash-injection at each payout stage (§4)** was done by code review, not by killing the
  production service mid-broadcast (would disrupt the live faucet and risk corrupting the live
  breaker latch). RT-2/RT-4 are argued from the in-memory/non-atomic-write code paths.
- **Regtest reorg simulation (§6)** was not stood up (no regtest node configured here; our node is
  mainnet-pruned). Reorg handling assessed by review (RT-10/RT-15).
- **Live RBF/conflict/eviction on-chain (§5 mempool)** not executed against the stuck testnet3
  chain to avoid further entanglement; RBF signalling itself is covered by `tx.test`/`scripttypes.test`.
- **Disk-full / FS-permission fault injection (§8/§13)** not simulated destructively; the relevant
  code paths (`try/catch` around `writeFileSync`/`appendFileSync`) are reviewed — they swallow
  errors (which is what makes RT-4 fail-open).
- No attempt to exfiltrate real credentials; canaries were synthetic and the live `/api` secret scan
  (node RPC password) returned **0** occurrences.
