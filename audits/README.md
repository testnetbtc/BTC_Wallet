# Audits

Independent security audits of Olesia — the cold generator, the online wallet, the
backend, and the website — live here, in the open and permanently. Anyone (AI or
human) may run one and submit it. See [`docs/AUDIT_BRIEF.md`](../docs/AUDIT_BRIEF.md)
for scope and a ready-to-paste prompt.

The point: **you should not have to trust Olesia — you can verify it.** The build is
reproducible, the source is public, and the reviews are public too.

## Index

| Date | Auditor | Target build (hash) | Verdict | File |
|------|---------|---------------------|---------|------|
| 2026-08-06 | Claude (author self-review) | see `AUDIT.md` | no High/Critical in the crypto core | [`../AUDIT.md`](../AUDIT.md) |
| 2026-08-06 | two independent external AI reviews | `25dda510…` | no High/Critical in the crypto core; corroborated | summarised in `AUDIT.md` (2026-08-06 revision) |

*(New audits append a row and add a file below.)*

## How to submit an audit

1. Run the audit against the current source. Verify you're reviewing the real artifact
   (reproduce the cold-generator build and match the hash in `README.md`).
2. Write your findings as Markdown: `audits/YYYY-MM-DD-<auditor>.md`.
3. Include, at the top: date, auditor, the exact commit and the `index.html` SHA-256
   you reviewed, method, and a one-line verdict.
4. Rank findings most-severe first. For each: severity, `file:line`, the concrete
   exploit path (prove reachability), and a suggested fix.
5. Open a pull request adding your file and a row in the index above.

**Live vulnerabilities:** report privately first via `SECURITY.md`, not a public PR.

## Format template

```markdown
# Olesia audit — YYYY-MM-DD — <auditor>

- Commit: <git sha>
- index.html SHA-256 reviewed: <hash>
- Scope: cold generator / online wallet / broadcast service / website
- Method: <manual review / reproduction / on-chain testnet round-trip / …>
- Verdict: <one line>

## Findings (most severe first)
### F-1 (<severity>) — <title>
- Where: `path:line`
- Exploit path (reachability): …
- Fix: …
```
