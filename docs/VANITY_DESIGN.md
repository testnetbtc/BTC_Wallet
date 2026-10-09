# Olesia Vanity — design (2026-10-08)

A vanity address is an ordinary Bitcoin address whose text begins with characters you chose
(`bc1qjon…`, `1Jon…`). There is no shortcut: the only way to get one is to generate random keys and
keep the first whose address matches. Each extra character multiplies the work (×32 for `bc1q…`,
×58 for `1…`). Olesia Vanity does that search in a way where **the private key only ever exists on
the user's device**, and then saves the result as a normal encrypted Olesia wallet file.

## Why this design (what the VanitySearch audit taught)

The audit of the most popular vanity tool (`/home/faucet/vanity/audit_2026-10-08/`) found keys made
from a timestamp, addresses miscompiled by the compiler, and short prefixes silently missed. The
rules below follow from it:

1. **Randomness:** every worker starts from 32 bytes of the OS CSPRNG (`crypto.getRandomValues` /
   `node:crypto`), reduced mod n. No seeds, no passphrases, no "rekey", no PRNG anywhere.
2. **No custom cryptography:** curve and field arithmetic are `@noble/curves` (already in the wallet),
   hashes are `@noble/hashes`. The fast search uses the standard "batch of independent points, one
   inversion" structure on noble's audited field ops — no hand-written big-number code.
3. **Every result is re-derived by a second path** (`secp256k1.getPublicKey(k)` → hash160 → encode,
   none of the incremental code) and compared with the requested pattern before it is shown. A wrong
   reconstruction is impossible to display.
4. **Exact difficulty**, computed from the true distribution of addresses (including the `1…` second-
   character band and the `1`-run / zero-byte cases), never a 58ⁿ guess; the matcher is proven on
   generated data to find the theoretical rate.
5. **A differential test rig from day one** (`test/vanity.test.mjs`, `test/vanity_diff.mjs`): thousands
   of generated keys re-derived independently; the efficiency measured against theory.

## Three ways to run — the key never leaves the user's device in any of them

| mode | grinding happens | who learns the key | notes |
|---|---|---|---|
| In this browser | Web Workers in the tab | the user only | nothing sent anywhere; tab must stay open; good to ~6 chars |
| Offline script (**recommended**) | the user's own computer, offline | the user only | one self-contained `.mjs` file, runs with Node.js, SHA-256 published; see the guide |
| Server-assisted — **split-key** | the VPS, queued and capped | the user only; the server learns the public point and the final address | built 2026-10-08, see below |

### Split-key, and why "via the Internet" is not a key-theft risk here
The browser makes a secret `a` and sends only `A = a·G`. The server searches `A + i·G` for the
pattern and returns the offset `i`. The browser computes `k = a + i mod n`, re-derives the address,
and refuses the answer if it does not match. The server never sees `a` or `k`; the worst a hostile
server can do is return a useless `i`. What it does learn: that this public point / this address
belongs to whoever submitted it (privacy, not security). Implementation: `infra/nodeapi/lib.mjs VanityQueue` (FIFO, one job running, one job per client,
queue ≤ 20, difficulty cap as *expected seconds* at the measured rate — `OLESIA_VANITY_MAX_SECONDS`,
900 — a hard limit of 5× expected per job, abandonment after 10 minutes without a poll, results
kept 30 minutes); `infra/nodeapi/vanity_runner.mjs` (one child process per job under `nice -n 19`,
`OLESIA_VANITY_THREADS` = 8 worker threads of the same engine); routes `GET /vanity`,
`POST /vanity/jobs`, `GET /vanity/jobs/<id>`, `POST /vanity/jobs/<id>/cancel`; client side
`src/vanity.js splitKeyStart/splitKeyFinish` and `OM.vanity.serverStart` (secret made and zeroed in
the page; the answer is refused unless `a + offset` produces the requested address). Measured on
the VPS: ~250–280k keys/s, so the 15-minute cap admits five SegWit characters (~2 min) and refuses
six (~70 min expected). The service unit's `CPUQuota` is 900 % so the runner can use its 8 threads
while the trading research keeps the other cores.

## Product flow (one screen, progressive)
1. **Type**: `bc1q…` (SegWit, recommended: cheaper per character, lowercase) or `1…` (Legacy).
2. **Text**: live validation as you type — allowed characters, case rules, the `1…` second-character
   band (`2`–`Q` in the usual 34-character form; others only in the rarer 33-character form), exact
   difficulty, estimated time *on this device* (2-second benchmark) and for the offline script
   (per core × cores). Impossible → says why, offers the nearest legal versions (substitutions such as
   `O→o`, `I→i`, `l→L` for Legacy; `b→6`, `i→j`, `o→0`, `1→l` for SegWit; ignore-case; shorter; the
   other type). Optional "ignore case" for Legacy.
3. **Run**: in this browser (progress, keys/s, ETA, cancel) or download the offline script, with the
   how-to guide and the file's SHA-256 beside the button.
4. **Result**: address, "verified by a second path" badge, then the wallet's normal **Save as encrypted
   .dat** step (password, file, fingerprint). The private key is shown only on request and never stored.
   Only `bc1q` / `1` — the two types the wallet issues.
5. **One key at a time** (2026-10-09, after the operator found an earlier key still on screen under a
   new result): while a found key is unsaved the pattern form is locked; every search start, discard,
   completed save and screen change goes through `vanityForget()`, which wipes the key from memory
   and from every element that held it. Discard is two clicks (a slip must not throw away hours of
   work); "‹ Back" from the save screen returns to the unsaved result instead of dropping it.
6. **Phones and tablets**: an explicit warning (full-CPU search → heat, battery, pauses on screen
   lock); past 10 minutes expected on the device it turns red and the in-browser Start needs a ticked
   acknowledgement. Desktops get a nudge towards the offline script past 10 minutes.

## Files
- `packages/bitcoin/src/vanity.js` — pattern parser/validator/suggester, exact difficulty, matcher,
  the search core (`VanitySearchJob`), result verification. Pure, testable, no DOM.
- `packages/bitcoin/mainnet/vanity_worker.js` — Web Worker wrapper (bundled into the page as a blob).
- `packages/bitcoin/mainnet/ui.js` / `assemble.mjs` — the Vanity screen (Ember design).
- `packages/bitcoin/vanity/cli.mjs` → built to `mainnet/publish/olesia-vanity.mjs` — the offline script
  (same engine, `node:worker_threads`), SHA-256 in `BUILD_HASH.txt` and shown in the page.
- `docs/VANITY_OFFLINE_GUIDE.md` — the how-to (verify the file, go offline, run, import, destroy).
- Tests: `test/vanity.test.mjs` (unit + differential), `test/vanity_diff.mjs` (efficiency vs theory),
  browser e2e additions.

## CSP
The page's hash-pinned CSP gains `worker-src blob:` only (workers are created from the page's own code).
No new network destinations: the vanity feature makes no requests in modes 1 and 2.
