# Website Integration

Current public address:
https://alea-wallet.pages.dev

Custom domain:
Not yet purchased.

The existing offline generator must remain operational and independent from
the VPS backend.

---

## Rules this document enforces

- The public website stays at **https://alea-wallet.pages.dev**. Do not add a
  custom domain, change DNS, rename the Cloudflare Pages project (`alea-wallet`),
  remove the current deployment, or redirect the address.
- The hosted key generator (`index.html`) **must not** depend on the VPS. It makes
  no network calls, and it must keep working with the machine physically offline.
  No API URLs, analytics, trackers, or remote scripts may be added to it.
- No VPS credentials belong in Cloudflare Pages environment variables.
- The backend (Chainwatch) listens on `127.0.0.1` only during this phase. Public
  API exposure and any website↔backend integration happen **later**, after
  authentication, TLS, and the owner-designed website are agreed.

## Intended separation (future)

**Alea Offline** (the current page — unchanged): seed generation, backup restore,
descriptor export, and (future) PSBT signing. Standalone, offline, no backend.

**Alea Watch** (future, separate surface): watch-only display — balances, UTXOs,
transactions, alerts, and unsigned PSBT preparation — served by the Chainwatch
backend. It is logically distinct from Alea Offline and never turns the offline
generator into an online hot-wallet signer.

## Integration status

Not integrated. The website and the VPS backend are, deliberately, two separate
concerns until the owner adds a domain and approves an authenticated, TLS-fronted
API. Until then this file is the single source of truth for "what may touch the
public site" — answer: nothing new.
