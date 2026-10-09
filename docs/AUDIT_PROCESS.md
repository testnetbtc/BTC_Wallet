# Audit process — how anyone (human or model) audits this wallet, and what "audited" may mean

The operator wants the wallet reviewed by several independent models (Claude Fable 5.1,
Claude Opus 5.5, ChatGPT 6, Kimi K3), the findings fixed, a final pass done, and the whole
thing provable to a visitor. This is the protocol. It is written so that the claim made on
the site stays *exactly as strong as the evidence* — a wallet that overstates its review is
worse than one that states none.

## 1. What is being audited must be pinned

An audit of "the code" is meaningless unless it says which code. Three identifiers, all public:

| identifier | what it pins | where it is |
|---|---|---|
| **git commit hash** | the entire source tree at one moment (a commit hash is a Merkle root of every file) | `git rev-parse HEAD`, GitHub |
| **build hash** | the exact bytes served at olesia.io (the page) and `olesia-vanity.mjs` | `packages/bitcoin/mainnet/BUILD_HASH.txt` at that commit, and shown in the page's Settings |
| **bundle hash** | the secrets-free source archive that was handed to the auditor | `olesia-audit-source.tar.gz` sha256 + `AUDIT_MANIFEST.sha256` (per-file hashes) |

The build is reproducible: `node mainnet/build.mjs` at the audited commit must produce the
`BUILD_HASH.txt` recorded in that commit, and `test/mainnet_live_check.mjs` proves the served
bytes equal it. That is the chain from "the auditor read commit X" to "the page you are
using is commit X".

## 2. The rounds

```
round N:  freeze commit C_N  →  bundle + hashes  →  each model gets the bundle (same brief)
          →  reports R_N,model (each report states C_N and the bundle hash in its header)
          →  triage: every finding gets an issue; fixes land as commits
          →  re-test (full suite: unit, regtest, browser e2e, live check)
          →  if anything changed: round N+1 on the new commit
final:    a round in which NO model finds anything that needs a code change
          → that commit is the "audited commit"; it is deployed; the site states it
```

Rules that make it honest:

* **Any code change after the audited commit voids the claim** for the changed version. The
  site shows the build hash; the audit page lists which build hashes were audited. A new
  deploy either goes through a new round or is labelled "changes since the last audit: …"
  with the diff linked. (A documentation-only change does not void it; the manifest shows
  which files changed.)
* Every model gets the **same bundle and the same brief** (`docs/AUDIT_BRIEF.md`), including
  the threat model, so reports are comparable.
* **Reports are published whole**, including the findings that were judged not to be bugs,
  with the triage decision next to each. Cherry-picking is what the hashes exist to prevent.
* **Models are not independent auditors in the human sense.** They share training data and
  blind spots, they do not run the code unless given a sandbox, and they can be wrong in both
  directions. Four models finding nothing is good evidence, not proof.

## 3. What the SHA-256s prove — and what they do not

The operator's plan: "upload the reports and prove via sha256". Correct in shape; here is
exactly what each hash buys:

* `sha256(report)` published in a git commit (and optionally time-stamped — see below) proves
  the report **has not been edited since publication**. It does not prove who wrote it or
  that the model actually read everything. Keep the raw chat exports / API transcripts for
  that; publish them if the vendor's terms allow.
* `sha256(bundle)` written **inside** each report proves which code the report is about.
* The **commit hash** proves which tree the bundle came from (`make-audit-bundle.sh` records
  it in the manifest header).
* **Time-stamping:** the wallet can put 80 bytes in an OP_RETURN output. One transaction
  carrying `sha256(bundle)` and `sha256(all reports)` is a proof-of-existence that even the
  operator cannot backdate. OpenTimestamps does the same thing for free (aggregated). Either
  is optional; both are cheap.

## 4. How a stranger audits the wallet themselves

```
git clone https://github.com/testnetbtc/BTC_Wallet && cd BTC_Wallet
git checkout <audited commit>
cd packages/bitcoin && npm ci
node mainnet/build.mjs                 # compare mainnet/BUILD_HASH.txt with the site's Settings
NODE_OPTIONS="--experimental-sqlite --no-warnings" npm test
node test/mainnet_e2e_regtest.mjs      # with bitcoind on the PATH
node test/mainnet_browser_e2e.mjs      # with Chrome
node test/mainnet_live_check.mjs https://olesia.io/
```
Then read: `docs/THREAT_MODEL.md`, `docs/AUDIT_BRIEF.md`, `docs/TESTING.md`,
`docs/WALLET_TOOLS.md`, `docs/VANITY_DESIGN.md`, and the previous reports in
`audit/`. The brief lists what a reviewer should try to break first.

## 5. Wording the site may use

Permitted, because each part is backed by an artefact a visitor can check:

> **Reviewed, not certified.** Build `<hash>` (commit `<hash>`) was reviewed in full by
> Claude Fable 5.1, Claude Opus 5.5, ChatGPT 6 and Kimi K3 on `<dates>`; every report, the
> code bundle they reviewed, and the fixes made are published with SHA-256 fingerprints at
> `<link>`. No human security firm has audited this software. Changes since the reviewed
> build: `<none | link to diff>`.

Not permitted (the repo's standing rule): "secure", "audited and safe", "verified", or any
phrasing that implies a professional audit took place. A model review is evidence; the
visitor decides what it is worth, and the page gives them what they need to decide.

## 6. Where things go

```
audit/
  ROUND-1_2026-xx-xx/
    BUNDLE.sha256                    the bundle hash + commit
    REPORT_fable-5.1.md              each report, header = commit + bundle hash
    REPORT_opus-5.5.md
    REPORT_chatgpt-6.md
    REPORT_kimi-k3.md
    TRIAGE.md                        every finding → accepted/rejected + fix commit
  ROUND-2_…/
  FINAL.md                           the audited commit, build hashes, the wording used on the site
```
The 2026-10-02 Kimi K3 report and its remediation already exist (currently kept outside the
repository on the operator's machine); moving them into `audit/ROUND-0_2026-10-02/` is the
first step of the process above.
