# How the wallet is tested — and how a bug still got through (2026-10-09)

The operator found a real bug by hand on a phone: after making a vanity address and leaving
its private key on screen, making a second one left the first key sitting in a hidden element
under the new result. The automated suite had 988 green checks at the time. This document
says what the tests do, why that bug escaped, and what changed so the same *class* of bug
cannot escape again.

## The layers

| layer | what it proves | oracle | where |
|---|---|---|---|
| **Unit / differential** (`npm test`, ~1,100 checks) | each engine does what its spec says | independent re-derivation: coincurve/base58 in Python, `@noble` second paths, published test vectors (BIP-32/39/84/86/49/44, BIP-322, legacy signed messages), random sampling vs exact probability | `packages/bitcoin/test/*.test.mjs` |
| **Regtest stack** (58 checks) | the engine + the node API against a real Bitcoin Core | **Bitcoin Core** accepts every transaction we build, rejects what it should, reports what we expect | `test/mainnet_e2e_regtest.mjs` |
| **Browser** (150 checks) | the *built page* — real CSP, real Web Workers, real API process, real nice'd vanity child process — driven as a user would click it | Core (broadcast, `verifymessage`), the page's own second paths, request capture (which hosts, which bodies) | `test/mainnet_browser_e2e.mjs` |
| **Live check** | the deployed bytes are the built bytes; headers; a real lookup | served sha256 == `BUILD_HASH.txt` | `test/mainnet_live_check.mjs` |

## Why the lingering-key bug escaped

Every automated journey did **one** vanity search per session. The assertions after it were
about *that* result. Nothing asked "is anything from a previous step still here?" — a
state-transition gap, not a logic gap. Hand testing found it in minutes because a person
naturally does things twice.

## What changed

1. **A secret sweep after every click** (`sweep()` in the browser e2e). After each of the
   ~185 clicks in a run it reads every text node of the page (hidden elements included —
   where the bug lived), every form field value, and all of localStorage/sessionStorage, and
   fails the run if a private-key-shaped string is present that the test has not declared as
   deliberately shown at that moment (`shownKeys`). Declared keys are removed from the set
   the moment the user action that should wipe them happens, so the very next click proves
   the wipe. This is an *invariant*, not a journey: it holds across every feature, including
   ones written later.
2. **Repeat journeys.** Vanity: result → discard → second search → the second key is new and
   the first is nowhere. Paper: make → done → make again → leave → wiped. Sign: two
   signatures in a row with different address types.
3. **Regression tests with teeth.** Each bug gets a test that is checked to fail without the
   fix (`session_reuse.test.mjs` fails 4 checks with the fix commented out).
4. **Flaky assertions fixed.** Two pre-existing checks searched the wallet file / storage for
   the 24 recovery words but matched JSON field names (`network`, `version`, `change` are
   BIP-39 words too) — a ~5 % random failure. They now check values only. A split-key test
   could pass by luck 1 in 29 times; it now pins the expected address.

## What only a person can test (the operator's checklist)

Automation cannot judge heat, readability, or whether a sentence makes sense to a newcomer.
Ten minutes per release, on a phone and on a laptop:

* Phone: open each tool; does every warning read right, does nothing overflow?
* Vanity: 4 characters in-browser on the phone — does it get hot, does the estimate hold?
* Paper wallet: print one on a real printer; do the read-back with the sheet in hand.
* Sign: make a proof, verify it in another wallet (Sparrow for bc1q, Electrum/Core for 1…).
* Privacy check on your real wallet: is every sentence true and understandable?
* Try to break it: do everything twice, go back mid-way, lock in the middle, reload.

Report anything odd with the build hash from Settings; a test will be written for it first.

## Running everything

```
cd packages/bitcoin
node mainnet/build.mjs
NODE_OPTIONS="--experimental-sqlite --no-warnings" npm test
node test/mainnet_e2e_regtest.mjs        # needs bitcoind
node test/mainnet_browser_e2e.mjs        # needs bitcoind + Chrome (puppeteer)
node test/mainnet_live_check.mjs https://olesia.io/
```
