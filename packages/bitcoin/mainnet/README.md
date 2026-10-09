# Olesia mainnet wallet — the opening page of olesia.io

A single self-contained HTML page: a non-custodial Bitcoin **mainnet** hot wallet. Keys are made
in the browser tab and saved only as an encrypted `.dat` file on the user's computer. The page's
one network endpoint is the operator's own node API (`https://api.olesia.io`).

**Where the secret lives.** A plaintext recovery phrase or private key exists in the page only
between creating/typing it and writing its encrypted file, and then for the moment of each
signature. An OPEN wallet holds public keys (to show addresses and find coins) and the wallet in
encrypted form; the password is asked for every time a payment is signed or the recovery words
are shown. Nothing secret is written to browser storage. A wallet cannot be used until it has a
password and a saved file.

**Practice networks.** A recovery-phrase wallet also has Testnet 4, Signet and Testnet 3 wallets:
the same words on the coin-type-1 path (different keys), worthless coins. No nodes are run for
them — the node API relays a public Esplora API under `/n/<network>/…`. Mainnet never uses that
relay. The faucet's claim page is on a separate origin (`app.olesia.io/faucet/`,
`infra/faucet-page/`) because it runs a third-party human check; the wallet only links to it.

**Vanity addresses.** "Create a vanity address" (welcome screen / Settings) searches for an address
starting with chosen characters. The search runs in Web Workers inside the page or — recommended —
in `olesia-vanity.mjs`, the same engine as one offline Node.js file (`vanity/cli.mjs`, SHA-256 in
`BUILD_HASH.txt` and shown in the page) — or by the node API as a **split-key** job (`/vanity/jobs`):
the page sends only a public point and refuses any answer that does not produce the requested address. Keys come from the OS CSPRNG only; every result is re-derived
by a second path before it is shown; difficulty is exact. See `docs/VANITY_DESIGN.md` and
`docs/VANITY_OFFLINE_GUIDE.md`.

**Signed messages, privacy check, paper wallet.** Settings → Tools (verify and paper wallet also on
the welcome screen). See `docs/WALLET_TOOLS.md`; testing in `docs/TESTING.md`.

**The opening.** A half-minute animated sequence (randomness → 1971/2008 → the genesis block → the
21 million → your keys → Olesia) shown the first time a browser opens the page, then remembered
(`localStorage` `olesia:mainnet:opening`). Skip button from the first frame, Esc/Enter keys, tap to
jump a chapter; Enter at the end; "Watch the opening again" on Welcome and in Settings;
`prefers-reduced-motion` goes straight to the final frame. It is drawn on a canvas by `ui.js`
(section THE OPENING) — no video file, no image, nothing fetched, so the page stays one file with one
hash. The genesis chapter shows the real hashes of blocks 0–5. A honey badger ("bitcoin is the
honey badger of money", drawn after the operator's angular print of one) walks right to left along
the bottom through the chapters and stops under the name at the end. It has its own canvas layer
(`#intro_b`) and its own clock, so chapter swaps never blank it; a tap that jumps the story ahead
makes it hurry rather than teleport.

**The street.** A band along the bottom of the page (after txstreet): the Olesia node watching the
next block being loaded. An old Land Rover Defender waits on a road at sunset; every transaction
that reaches the node's mempool is a hooded figure who walks up and climbs in the back; the
Defender carries the next block's number on its roof board and the count and value of what is loaded
along its side (crates on the roof show how full it is); when the block is mined it drives off into
the sunset with the block's exact numbers, and the next one pulls in. Fed by `GET /street` on the
node API every 6 s (`infra/nodeapi/lib.mjs` `StreetWatch`: tip via `getblockstats`, the mempool
diffed by txid so each transaction's fee/size is read once, the highest-feerate transactions that
fit a block valued by reading their outputs — capped per poll, newest arrivals first). Public chain
data only. "Hide the street" on Welcome and the Settings checkbox (`localStorage`
`olesia:mainnet:street`); reduced motion gets a still picture; nothing is drawn or fetched while the
tab is hidden or the opening is showing. The page scrolls above the band, never under it.

**Site identity.** `mainnet/icons/` (drawn by a script from the Olesia mark) is published as
`favicon.ico`, `icon-32/192/512.png`, `icon-512-maskable.png`, `apple-touch-icon.png` and
`site.webmanifest` (name "Olesia", `display: browser` — switching to `standalone` is the first PWA
step and must be tested on a real iPhone because the wallet relies on file downloads). Their hashes
are listed in `BUILD_HASH.txt` and checked by the live check; CSP gains `manifest-src 'self'`.

## Layout

| File | Role |
|---|---|
| `entry.js` | `window.OM` — the API the UI calls (bundled with the engine) |
| `ui.js` | DOM + state only; no cryptography |
| `assemble.mjs` | HTML + CSS ("Ember" look); inlines the bundle, `ui.js` and the fonts into one file |
| `fonts/` | IBM Plex Sans / Mono (OFL), embedded as `data:` URIs — the page loads no font from a server |
| `build.mjs` | esbuild → assemble → hash-pinned CSP (`tools/csp.mjs`) → `publish/` + `BUILD_HASH.txt` |
| `../src/entropy.js` | wallet-creation entropy (CSPRNG root + mouse + dice; dice-only mode) |
| `../src/walletfile.js` | the encrypted `.dat` wallet file |
| `../src/account.js` | seed/WIF → scripts; coin matching; build + audit of transactions |
| `../src/session.js` | an open wallet (watch-only): coins, address window, send, non-secret counters |
| `../src/locked.js` | the wallet held encrypted while open; password → short-lived signer |
| `../src/legacy_sign.js` | signer for uncompressed-key P2PKH and bare P2PK |
| `../src/nodeapi.js` | client for the node API |
| `../src/vanity.js` | vanity search: pattern analysis, exact difficulty, batch-inversion search, second-path verification |
| `../src/message.js` | signed messages: legacy "Bitcoin Signed Message" (1…), BIP-322 (bc1q), verification of all common forms |
| `../src/privacy.js` | privacy report from unspent coins + their creating transactions (reuse, dust, linked inputs) |
| `../src/paper.js` | paper wallets: CSPRNG key, second-path check, read-back verification |
| `vanity_worker.js` | the Web Worker wrapper (bundled into the page, started from a `blob:` URL) |
| `icons/` | site icons (favicon, PNG sizes, Apple touch icon, maskable) copied into `publish/` with the generated `site.webmanifest` |
| `../vanity/cli.mjs` | the offline script, bundled to `publish/olesia-vanity.mjs` |
| `../../../infra/nodeapi/` | the node API server (`olesia-nodeapi.service`): coins, fees, prev-tx, broadcast, and the display-only price feed |

Reused unchanged from the existing engine: `tx.js`, `scripts.js`, `wallet.js`, `networks.js`,
`coldbackup.js`. Cryptography is `@noble` / `@scure` only.

## Build, test, deploy

```
cd packages/bitcoin
export PATH=/home/faucet/.nvm/versions/node/v22.22.3/bin:$PATH
node mainnet/build.mjs                                   # -> mainnet/publish, mainnet/BUILD_HASH.txt
NODE_OPTIONS="--experimental-sqlite --no-warnings" npm test          # whole suite (unit)
node test/mainnet_e2e_regtest.mjs                        # engine + node API vs a private regtest Bitcoin Core
node test/mainnet_browser_e2e.mjs                        # the built page in headless Chrome, real CSP, vs regtest
set -a; . .secrets/cloudflare.env; set +a                # never echo the token
npx wrangler@3.114.0 pages deploy mainnet/publish --project-name=olesia-landing --branch=mainnet-preview   # preview
npx wrangler@3.114.0 pages deploy mainnet/publish --project-name=olesia-landing --branch=main              # olesia.io
node test/mainnet_live_check.mjs https://olesia.io/      # served bytes == repo build, headers, real node lookup
```

`mainnet_browser_e2e.mjs` and `mainnet_live_check.mjs` need puppeteer + Chrome (defaults point at
`/home/faucet/controlpoint/node_modules` and `~/.cache/puppeteer`; override with `PUPPETEER_FROM`,
`CHROME`). The regtest tests need `bitcoind` on the PATH.

## Rules for changing this code

1. Any change to signing or derivation must be proven against Bitcoin Core (the two e2e tests).
2. The page must make no request to any host except `api.olesia.io` (asserted by the browser test).
   The CSP additionally allows `worker-src blob:` for the vanity search workers — code the page built itself.
3. Nothing secret is ever written to `localStorage`/`sessionStorage`, and no plaintext secret is
   kept in a variable, form field or DOM node once a wallet is open (asserted by the browser test).
4. Untrusted text goes into the DOM with `textContent` only.
5. Do not describe the wallet as "secure", "audited" or "verified". No independent human audit exists.
6. The price is display-only. It is fetched by the node API, never by the page, and must never be
   used when a transaction is built.
