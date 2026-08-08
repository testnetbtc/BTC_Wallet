# How to verify Olesia is genuine and untampered

Olesia's honesty rests on one property: **you never have to take our word for it.**
The whole program is a single readable text file, the build is reproducible, and
the official hash is published below. Pick the level of checking you're
comfortable with — each one is stronger than the last.

**The official SHA-256 of `index.html` for this release:**

```
8a28ce4a92cf421bd332fbffd053fbddb6ea18b76d1eab255d7039285ac3a668
```

The same hash is published in three independent places, so tampering with one is
not enough — an attacker would have to forge all of them:
- this file (`VERIFY.md`) and `AUDIT.md`, in the Git repository
- the `README.md`
- the Git tag for the release (`git show` the tag)

---

## Level 1 — Check the hash (anyone, ~2 minutes)

This proves the file you have is **exactly** the audited one, bit for bit.

**1. Download the file.** From the repository, save `index.html`.

**2. Compute its SHA-256:**

- **Windows (PowerShell):**
  ```powershell
  Get-FileHash index.html -Algorithm SHA256
  ```
- **Windows (Command Prompt):**
  ```
  certutil -hashfile index.html SHA256
  ```
- **macOS:**
  ```
  shasum -a 256 index.html
  ```
- **Linux:**
  ```
  sha256sum index.html
  ```

**3. Compare** the result to the official hash above (case-insensitive).
- **Matches** → the file is authentic and unmodified. ✅
- **Differs by even one character** → do NOT use it. Re-download from the
  official repository; if it still differs, stop. ❌

**What this catches:** corrupted downloads, a man-in-the-middle swapping the file,
and casual tampering.
**What it does NOT catch (be honest with yourself):** it trusts that the *hash
above* wasn't also changed by the same attacker. That's why the hash is published
in several places, and why Level 2 exists.

---

## Level 2 — Rebuild it yourself (removes all trust in the file)

This is the strongest practical check. Instead of trusting the published file,
you rebuild it from the readable source and confirm you get **the identical
file**. After this, you only need to trust the source code (which you can read)
and the audited libraries — not any binary anyone handed you.

Requires **Node.js** (from nodejs.org). Then:

```
git clone https://github.com/testnetbtc/BTC_Wallet
cd BTC_Wallet
npm install
npm run build
npm test                 # runs 8 correctness gates against official test vectors
```

Now compare your freshly-built file to the one you'd otherwise trust:

```
sha256sum index.html     # (Windows: Get-FileHash index.html)
```

If it equals the official hash above, you have **proven** the published file is
exactly what this source produces — nothing hidden was inserted. The build is
deterministic, so this will match to the byte.

---

## Level 3 — Confirm the wallet actually works (independent software)

Correct-looking output isn't proof the *keys* are right. Prove it with a wallet
made by someone else entirely:

1. In Olesia, set the network to **Testnet** and generate a wallet.
2. Write down the 24 words.
3. Open **Sparrow Wallet** (sparrowwallet.com), create a new wallet, choose
   "Import" → enter the 24 words, keep the derivation on **Native SegWit (bip84)**.
4. Check that Sparrow shows the **same first receive address** (`tb1...`) that
   Olesia showed.

If Sparrow — which shares no code with Olesia — derives the identical address, the
recovery phrase is genuinely standards-correct. This is the one check that no
self-test can provide, and it's worth doing before any real use.

---

## Can I run it completely offline? — Yes.

Olesia makes **zero network requests** and needs no server. To run it fully offline:

1. Download `index.html` (and verify its hash, Level 1).
2. **Disconnect from the internet** (airplane mode, or unplug).
3. Double-click the file to open it in your browser. It runs entirely locally
   from `file://`.

Confirmed by inspection: the only browser-crypto call is `getRandomValues`, which
works offline; nothing uses `crypto.subtle` (which browsers disable offline), and
there are no external scripts, fonts, images, or fetches. The on-page indicator
turns red while you're online and green once you've disconnected — for a wallet
you intend to fund, generate it **offline**.

---

## Why you can trust this more than a typical "wallet generator"

Most of the dangerous tools we've seen share one trait: **you can't see what they
do.** They ship a compiled `.exe`, or load code from a CDN, or minify everything
into an unreadable blob. Olesia is the opposite:

- **It's readable.** `index.html` is plain text; the logic is ~360 lines you (or
  anyone) can inspect.
- **It's reproducible.** Anyone can rebuild it and get the identical file.
- **It's self-contained.** No external code, no network, no telemetry.
- **It uses audited crypto**, not home-made primitives.
- **It comes with an honest audit** (`AUDIT.md`) that states its own limitations.

That combination — readable, reproducible, self-contained, honestly documented —
is exactly what a genuine tool looks like and what a scam cannot easily fake.
