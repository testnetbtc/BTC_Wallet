# Olesia Vanity — running the offline script safely

A vanity address is an ordinary Bitcoin address that starts with characters you chose
(`bc1qjon…`, `1Jon…`). Finding one means generating random keys until one fits. The safest way
to do that is **on your own computer, offline**, with a program you have checked. This guide is
that procedure. It takes about ten minutes the first time.

The script is the same search code as the page at olesia.io, bundled into one file,
`olesia-vanity.mjs`, with no dependencies beyond Node.js. It makes no network connections.
The source is `packages/bitcoin/vanity/cli.mjs` + `packages/bitcoin/src/vanity.js` in this
repository; the build that produces the file is `packages/bitcoin/mainnet/build.mjs`.

## Why offline, and why a script

* **Your private key is produced where the search runs.** In your browser that is your device —
  fine for short patterns. On a computer with the network cable out, nothing can leave at all.
* A page served by a website can be changed by whoever controls the website (or breaks into it).
  A file you downloaded, hashed and kept cannot change under you.
* The script uses every CPU core; a browser tab is slower and must stay open.

## What you need

* A computer you trust (the one you keep your wallet files on is ideal).
* **Node.js** 18 or newer — <https://nodejs.org>. Check with `node --version`.
* The file `olesia-vanity.mjs` from olesia.io (the "Download olesia-vanity.mjs" button), or built
  yourself from this repository (`cd packages/bitcoin && npm ci && node mainnet/build.mjs` →
  `mainnet/publish/olesia-vanity.mjs`).

## Step 1 — check the file

The page shows the file's SHA-256 fingerprint next to the download button. It is also the second
line of [`packages/bitcoin/mainnet/BUILD_HASH.txt`](../packages/bitcoin/mainnet/BUILD_HASH.txt).
Compute the fingerprint of the file you have:

```
# Linux
sha256sum olesia-vanity.mjs
# macOS
shasum -a 256 olesia-vanity.mjs
# Windows (PowerShell)
Get-FileHash olesia-vanity.mjs -Algorithm SHA256
```

The 64-character result must be **identical** to the published one. If it is not, delete the
file and do not run it. (The script also prints its own hash on every start, so you can compare
again later.)

If you can read JavaScript, open the file: it is not minified. Look for `randomBytes` (the only
source of randomness), the absence of `http`, `https`, `net`, `fetch` and `child_process`, and
the `selfTest` function.

## Step 2 — go offline

Turn Wi-Fi off, unplug the cable, or switch on airplane mode. The script never needs the
network. It stays off until Step 6.

## Step 3 — run the self-test

```
node olesia-vanity.mjs --check
```

Every line must show ✓ and the last line `all checks passed`. The checks prove, on your machine,
that key → address is computed correctly (against known Bitcoin test vectors), that the search
finds what it claims, and that the difficulty arithmetic agrees with random sampling.

## Step 4 — choose your text and see the cost

```
node olesia-vanity.mjs --estimate bc1qjon
node olesia-vanity.mjs --estimate 1Jon --ignore-case
```

The script tells you whether the text is possible (and the nearest possible versions if not),
how many keys match on average ("about 1 in N"), and the expected time on *your* machine.

Rules of the two address types:

| | SegWit `bc1q…` | Legacy `1…` |
|---|---|---|
| allowed characters | `qpzry9x8gf2tvdw0s3jn54khce6mua7l` — lower-case only; no `b i o 1` | digits and letters except `0 O I l` |
| cost per extra character | ×32 | ×58 |
| notes | the modern standard, lowest fees | `--ignore-case` accepts any capitalisation and is usually far cheaper; the second character is normally `2`–`Q` (others are ~60× rarer); each extra leading `1` is ~256× harder |

The search is random, so the time is an *expectation*: half of all runs finish sooner, 95 %
within three times the expected time, and about one run in 150 takes longer than five times.
Five characters after the prefix is minutes on a laptop; seven is a day or more; nine is years.

## Step 5 — run the search

```
node olesia-vanity.mjs bc1qjon
node olesia-vanity.mjs 1Jon --ignore-case --threads 8 --out my-vanity.txt
```

It prints progress once a second (keys tried, speed, elapsed time, and the probability that a
match would already have been found). Press Ctrl-C to stop at any time; nothing is kept.

When it finds a match it prints the **address** and writes the **private key** (WIF) to the
result file — `olesia-vanity-result.txt` unless you chose `--out` — with permissions so that only
your user can read it. It is never printed to the screen unless you pass `--print` (then it is in
your terminal history: avoid this).

## Step 6 — import it into Olesia, then destroy the file

1. Reconnect to the network, open <https://olesia.io>.
2. **Import a wallet → Private key (WIF)**, paste the line from the result file.
3. Choose a strong password (the generator makes one — write it down) and save the encrypted
   `.dat` file. That file is now your wallet; back it up like any other.
4. Open the wallet; under **Receive** choose SegWit or Legacy to see your vanity address.
5. Delete the result file securely (`shred -u my-vanity.txt` on Linux; on other systems,
   delete it and empty the trash; the encrypted `.dat` is the copy that matters).

Anyone who ever sees the WIF can spend everything the address receives. The `.dat` file and
its password are the only things you should keep.

## Troubleshooting

* `node: command not found` — install Node.js and open a new terminal.
* `SyntaxError` on start — your Node.js is too old (needs 18+).
* "SegWit addresses never contain …" — see the character table above; the script lists the
  nearest possible texts.
* It runs much slower than estimated — close other programs; on laptops plug in the charger
  (CPU throttling). `--threads N` sets how many cores to use.
* The hash does not match — do not run it. Download again from olesia.io; if it still differs,
  stop and report it.

## What the script will never do

Connect to the network. Read any file other than itself. Write anywhere except the result file
you chose. Use any randomness other than the operating system's generator. Print a private key
unless you ask with `--print`.
