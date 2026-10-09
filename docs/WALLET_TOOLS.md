# Olesia wallet tools (2026-10-09)

Three tools beside the vanity generator. All three run entirely in the page; none sends a key
anywhere. Code: `packages/bitcoin/src/message.js`, `privacy.js`, `paper.js`; screens in
`mainnet/assemble.mjs` / `mainnet/ui.js`; tests listed at the end.

## 1. Signed messages — prove you own an address

**What it is.** A signature proves that whoever controls an address's key wrote a given text,
without moving coins and without revealing the key. Exchanges ask for it ("prove this
withdrawal address is yours"), buyers and auditors ask for it (proof of reserves: "the funds on
this address are mine"), and it is how you say "yes, this address is really me" in public.

**Formats — chosen by the address type, so the proof is checkable by the most software:**

| address | format produced | who can verify it |
|---|---|---|
| Legacy `1…` | the original "Bitcoin Signed Message" (recoverable ECDSA, 65 bytes, base64) | **Bitcoin Core** (`bitcoin-cli verifymessage`), Electrum, Sparrow, nearly everything since 2011 |
| SegWit `bc1q…` | **BIP-322** "simple" (the witness of a virtual spend of a virtual output committing to the message) | Sparrow, BlueWallet, Ledger Live, bip322 libraries. Not Bitcoin Core (as of 2026) |

Tip the page gives: for a proof that a sceptic can check on their own Core node, sign with a
Legacy address. The page prints the exact `bitcoin-cli verifymessage` command.

**Verification** (needs no wallet): accepts the legacy format, BIP-137 variants (Electrum/
Trezor signing a bc1q address with header bytes 35–42), BIP-322 simple and full, with or
without the 2025 `smp`/`ful` prefix. It never trusts a header byte: it recovers the public key
and checks it really produces the stated address. A whole
`-----BEGIN BITCOIN SIGNED MESSAGE-----` block pasted into the message box is split into the
three fields automatically. Taproot (`bc1p`) is refused with a plain reason.

**Advice built into the screen:** put the date and the recipient in the message so a proof
cannot be replayed elsewhere.

**Proven against:** the BIP's own vector file (`test/fixtures/bip322_basic_test_vectors.json`,
message hashes, to_spend/to_sign txids, both published signatures per message — ours is
byte-identical to the RFC-6979 one), a long-published legacy reference signature, 50 fresh-key
round trips, and **Bitcoin Core's `verifymessage` on a regtest node** in the browser e2e.

## 2. Privacy check — what the chain shows about this wallet

Every payment is public forever. The check looks at what a chain-analysis company or a nosy
payer sees about *this* wallet and says what to do about each item, in plain language:

| finding | level | the one thing to do |
|---|---|---|
| single-key wallet: every payment lands on one address | important | use a recovery-phrase wallet for anything beyond one-off fun |
| an address received more than one payment | worth fixing | hand out a fresh address each time (the Receive screen already does) |
| tiny coins — possible dust attack | worth fixing | never spend them with your other coins; leave them |
| coins that cost more to spend than they are worth | minor | leave them out (coin control) until fees drop |
| a past payment joined several addresses (common-input rule) | minor | pay from a single coin when a payment is sensitive |
| SegWit and Legacy coins in one wallet | good to know | prefer SegWit; spend Legacy coins on their own |
| no address holds more than one payment | good | — |

**What it works from, honestly:** the wallet's *unspent* coins and the transactions that
created them (read from the node, at most 30 per check). Olesia's node has no address index,
so coins already spent and payments to now-empty addresses are outside the check; the report
says so in its last item. The "linked" finding works by recovering the public keys in each
input of a creating transaction and matching their hash160 against the wallet's own addresses.

**Why address reuse matters (the operator asked):** nothing is "posted" anywhere. The chain is
a public ledger of payments *to addresses*. If every payment to you goes to the same address,
then everyone who ever paid you — and anyone who looks the address up — sees every other
payment, your running balance, and where it all goes when you spend. Fresh addresses put each
payment in its own compartment; a payer sees only their own. (Spending from an address also
publishes its public key; that is the minor part.)

**A bug fixed alongside:** once a received coin was spent, the wallet could offer the same
address again (the node reports only unspent coins, and the stored counter was never bumped).
`Session._rememberUsed()` now records the highest used index on every refresh;
`test/session_reuse.test.mjs` fails without it.

## 3. Paper wallet

One fresh private key and its address, printed. The oldest cold storage; still sound for a
gift, a long-term stash or a bit of fun if it is made and read back carefully. The screen
walks through: go offline → make → print → **read-back check** → fund → spend all at once.

* Key from `crypto.getRandomValues` only; the WIF is decoded again and re-derived before it is
  shown (second path); the key exists in the page only until "Done", a save, or leaving the
  screen (same wipe discipline as vanity keys).
* Two QR codes (address, key), a fold line, the look-alike legend ("never contains 0 O I l"),
  the date, a "read-back check done ☐" box. `@media print` hides everything but the sheet.
* **Read-back check:** the user types the key from the paper; the page proves it gives the
  printed address. A wrong-but-valid key is told which address it would really control. A
  paper wallet whose key cannot be read back is money gone — this step is the whole point.
* Optional "also save an encrypted .dat copy" (a digital backup is not a paper wallet, but
  people lose paper).
* A found vanity key can be printed as a paper wallet from the vanity result card.
* Making and checking a paper wallet makes no network request (asserted in the e2e).

## Tests

| file | what |
|---|---|
| `test/message.test.mjs` | BIP-322 vectors, legacy reference, round trips, BIP-137 and "full" forms, refusals (59 checks) |
| `test/privacy.test.mjs` | every finding from constructed coins and real serialised transactions |
| `test/paper.test.mjs` | key source, second path, read-back verification |
| `test/session_reuse.test.mjs` | address rotation is permanent; signable-address helpers |
| `test/mainnet_browser_e2e.mjs` | the three screens end to end, Core as oracle, print media, the secret sweep |
