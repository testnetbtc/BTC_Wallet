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

**Practice networks.** A recovery-phrase wallet also has a Testnet 4 wallet (and, behind the
Settings switch "Also show Signet and Testnet 3", two more): the same words on the coin-type-1
path (different keys), worthless coins. Because the words are ONE secret, the Networks and
Faucet tabs, the save note and Welcome all say so plainly. Alternatively a **practice wallet**
("Create a practice wallet" on Welcome, or "Open it as: Testnet 4 · practice only" on Import)
is a `.dat` file whose header network is `testnet4`: it opens on Testnet 4 and nowhere else
(`OM.lock({ network })`, `wallet.home`, `wallet.practiceOnly`; file name `olesia-practice-…`).
An old cold-generator backup made for a test network converts into a practice wallet. No nodes
are run for the practice networks — the node API relays a public Esplora API under
`/n/<network>/…`. Mainnet never uses that relay. The faucet's claim page is on a separate origin
(`app.olesia.io/faucet/`, `infra/faucet-page/`) because it runs a third-party human check; the
wallet only links to it.

**Address types.** Receive and change: native SegWit (`bc1q`), Taproot (`bc1p`, BIP-86 key path,
Schnorr) or Legacy (`1…`); nested SegWit is scanned for an imported wallet's coins. **P2PK** —
Satoshi's bare public key, no address — is a destination only the wallet itself can pay: Receive
→ P2PK shows the next unused key (BIP-44 keys, index rotated once used, the same path as the
earlier wallet's "P2PK lab" so its coins are found) and "Move coins into this P2PK output" opens
Send with a fixed raw-script destination (`prepare({ toScript })`, `buildRawScriptTx` — the
library's coin selector refuses a bare-pk output, so selection and the final-size fee are done
there; the audit checks the raw script like any address). A P2PK coin is listed with its tag and
spent through the legacy signer; "Spend this P2PK coin" ticks it and opens Send. Message signing
and verification cover `bc1p` too (BIP-322 simple, key path, SIGHASH_DEFAULT; verification also
accepts the "full" form and the 2025 `smp`/`ful` prefixes — all published vectors pass). Paper
wallets can be Taproot. Vanity search stays `bc1q` / `1…` (a Taproot vanity needs a point
multiplication per key, which defeats the batch-inversion search).

**Vanity addresses.** "Create a vanity address" (welcome screen / Settings) searches for an address
starting with chosen characters. The search runs in Web Workers inside the page or — recommended —
in `olesia-vanity.mjs`, the same engine as one offline Node.js file (`vanity/cli.mjs`, SHA-256 in
`BUILD_HASH.txt` and shown in the page) — or by the node API as a **split-key** job (`/vanity/jobs`):
the page sends only a public point and refuses any answer that does not produce the requested address. Keys come from the OS CSPRNG only; every result is re-derived
by a second path before it is shown; difficulty is exact. See `docs/VANITY_DESIGN.md` and
`docs/VANITY_OFFLINE_GUIDE.md`.

**Signed messages, privacy check, paper wallet.** Settings → Tools (verify and paper wallet also on
the welcome screen). See `docs/WALLET_TOOLS.md`; testing in `docs/TESTING.md`.

**The opening.** A minute-long animated sequence (randomness → 1971/2008 → the genesis block → the
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

**The street.** The Olesia node watching the next block being loaded (after txstreet), drawn in
two views from one world: a band along the bottom of every page (full scene, or a one-line
ticker — its own ▾ ▴ × controls; a phone starts as the ticker; once a wallet is open it starts as
the ticker unless the person chose otherwise, `localStorage` `olesia:mainnet:street:band`) and
the **Street tab** (`#pane-street`, also "Watch the street" on Welcome, no wallet needed): a
wide scene with a sky that follows the local clock, a lit skyline, lamps, the last six blocks
driving away on the far lane, a tooltip per figure (kind, amount, fee rate, size, coin age), the
live numbers (last block, loading now, waiting, last reward), a card per recent block, the legend
of figure families with two drawings each, and "How to read it". Figures walk faster the higher
their fee rate. An old Land Rover Defender waits on the road; every transaction that
reaches the node's mempool is a figure who walks up and climbs in the back, dressed for the kind of
coin it spends — hoodie and laptop for `bc1q`, long coat and fedora for `1…` legacy, suit and
briefcase for `3…` script, neon visor for `bc1p` Taproot, and a gold hooded Satoshi (after the
Budapest statue) for a P2PK spend or a coin created before block 100,000 (2009–2010); each figure
carries a tag and its amount, and a seeded wardrobe (colours, hats, glasses, masks, beards, items)
gives dozens of looks per family. The Defender's roof board shows the next block's number and its
bonnet the count and value loaded (crates on the roof = how full); the panel on the left says it in
words with the fiat value and the mempool queue. When the block is mined it drives off with the
block's exact numbers and the next one pulls in. On a phone the band is a one-line ticker; tap it
for the scene. Fed by `GET /street` on the node API every 6 s (`infra/nodeapi/lib.mjs`
`StreetWatch`: tip via `getblockstats`, the mempool diffed by txid so each transaction's fee/size
is read once, the highest-feerate transactions that fit a block valued by reading their outputs —
capped per poll, newest arrivals first; `classifyInput` reads the kind of coin from the spending
input alone; `gettxout` without the mempool view gives the coin's age). Public chain data only.
"Hide the street" on Welcome and the Settings checkbox (`localStorage` `olesia:mainnet:street`);
reduced motion gets a still picture; nothing is drawn or fetched while the tab is hidden or the
opening is showing. The page scrolls above the band, never under it.

**Languages.** The chip in the header (`#lang`) switches the whole page. English is built in;
every other language is `mainnet/i18n/<code>.json` — a map from the English string to its
translation — published next to the page as `i18n/<code>.json`, listed in `BUILD_HASH.txt` and
byte-checked by the live check. `mainnet/i18n.js` is the runtime: static text is found by walking
the page for "units" (an element whose children are text and simple inline elements; its key is
the English with the children numbered, `Load your encrypted <1>.dat</1> file`), a translation is
placed as text nodes plus the unit's *own* child elements moved back in — never as HTML — and
units the script has since written to are left alone. Script text goes through `tr('…', { n })`.
`mainnet/i18n/extract.mjs` builds `en.json` (814 strings: the page's markup walked in headless
Chrome, `tr()` keys, the street's family names and explanations, the engine's messages) and
checks every dictionary; `validate.mjs` / `merge.mjs` / `checkpart.mjs` / `addpart.mjs` are the
translators' tools (`TRANSLATING.md` is their brief; a new batch of strings goes out as one part
per language and `addpart.mjs` folds it in and prunes keys that left the catalogue). The browser test loads
every shipped dictionary and asserts nothing reachable is left untranslated. The saved choice
(`localStorage` `olesia:mainnet:lang`) or the browser's language is used on load; the offline copy
(opened from a file) stays English because it cannot fetch a dictionary.

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
