# Translating the Olesia wallet

`en.json` is the catalogue: every English string the page can show, as `"English": "English"`.
A language is a file `<code>.json` with the **same keys** and the translation as the value.
The runtime (`i18n.js`) places a translation as plain text only — it can never add markup.

## Rules (the validator enforces the mechanical ones)

1. **Every key must be present and translated.** Do not drop, add or alter keys.
2. **Keep the numbered element tags exactly:** `<1>…</1>`, `<2/>`. They stand for the page's own
   elements (bold, code, a link, a line break). You may move them to where the language needs
   them, but every tag that is in the English must appear once in the translation, and the text
   inside `<n>…</n>` is translated too — unless it is code (see 4).
3. **Keep placeholders exactly:** `{n}`, `{amount}`, `{network}`, `{error}` … are filled in at
   run time. Move them where the grammar needs them; never translate or remove them.
4. **Do not translate** product and protocol names or technical tokens: Olesia, Bitcoin (use the
   language's normal form), BTC, sat/vB, bc1q / bc1p / tb1 / 1… / 3…, SegWit, Taproot, Legacy
   (as an address type — translate if the language has an established term), P2PK, P2PKH, P2SH,
   P2WPKH, BIP-39, BIP-322, OP_RETURN, WIF, SHA-256, UTXO, `.dat`, file names, shell commands
   (`node olesia-vanity.mjs …`, `sha256sum …`), `Bitcoin Core`, `Electrum`, `Sparrow`,
   `Ledger Live`, `mempool`, `Satoshi`, `Satoshi Nakamoto`, the Times headline inside quotes.
   Keep ✓ ✗ · — ‹ › ↗ ₿ ☐ and the ellipsis … as they are.
5. **Terminology, used consistently:** recovery phrase (the 12/24 words) · passphrase (the
   optional BIP-39 extra word) · password (what encrypts the wallet file) · wallet file · address
   · coin (a UTXO) · network fee · practice network · the Olesia node. Password and passphrase
   must never be confused — the wallet relies on the distinction.
6. **Register:** clear, calm, plain language for ordinary people; no slang; the page's tone is
   direct and honest. Buttons and labels stay short. Keep the capitalisation rules of the language
   (e.g. German nouns). Keep sentence case where English uses it.
7. **Plurals:** English has separate keys for 1 and many (e.g. `1 roll …` / `{n} rolls …`). Use
   the natural plural form for "many" and phrase so it reads well for any number.
8. Strings that are pure code or symbols (e.g. `4`, `8`, `BTC`) are not in the catalogue; a key
   that is an address-type label like `Legacy (1…)` keeps the `(1…)` part.
9. No machine-translation feel: read each sentence back as a native speaker would.

## Workflow

Work from the four parts `parts/en.1.json` … `parts/en.4.json` (about 180 keys each). Write
each translated part to `parts/<code>.<k>.json` (same keys, translated values), then run

    cd packages/bitcoin && node mainnet/i18n/merge.mjs <code>

which writes `<code>.json` and validates it. Fix every problem it prints until it says OK.
