# Security Policy

Alea is an **offline BIP-39 seed generator** (not a full wallet, no signing). A bug
in it can cost real funds, so security reports are very welcome.

## Reporting a vulnerability

Please report privately first — do **not** open a public issue for a real
vulnerability. Use GitHub's **"Report a vulnerability"** (Security → Advisories) on
this repository, which opens a private advisory thread.

Please include: affected file(s)/line(s), the concrete exploit path (how it reaches
key / nonce / backup material), severity, and a suggested fix if you have one.

## Scope

**In scope (highest value first):**
- `src/app.js` — entropy sourcing and BIP-39/32/84 derivation
- `src/backup.js` — scrypt + XChaCha20-Poly1305 backup, restore, descriptor checksum
- `src/ui.js` — DOM handling (no crypto of its own)
- `assemble.mjs` / `build.mjs` — the deterministic build

The shipped `index.html` is **generated** from the above — review the source, not the
bundle.

**Especially interested in:** any path where weak/predictable randomness reaches key
material; derivation or version-byte errors; backup crypto weaknesses (nonce/salt/AAD
handling, params); secret leakage (network/storage/URL/console); fail-open bugs
(generating despite a failed self-check).

## The reachability bar

A weak primitive is a **lead, not a finding** — please demonstrate it actually reaches
key/nonce/backup material with a concrete exploit path, or note that it does not. This
keeps signal high.

## Verifying you're reviewing the real artifact

The build is byte-deterministic. Reproduce it and check the hash (see `VERIFY.md`); the
published `index.html` SHA-256 is in `README.md`. CI re-checks reproducibility, runs the
test suite, and scans for secrets on every push.

## Not in scope

Endpoint compromise (malware, malicious browser extensions, screen recorders) defeats
any browser wallet and is out of scope. So is the inherent inability of JavaScript to
guarantee memory zeroing. Both are documented in `AUDIT.md`.

## No bug-bounty (yet)

There is no paid bounty at this time; this is a hobby/testnet project. Credit is given
in the changelog for valid reports. Please act in good faith — testnet only, no attacks
against the hosted deployment or other users.
