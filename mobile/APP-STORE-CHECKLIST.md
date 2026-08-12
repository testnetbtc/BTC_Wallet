# Olesia on the App Store — the full sequence

Everything below assumes **no local Mac**. Builds run on GitHub's macOS runners
(free for this public repo) and the signing material can be produced on Linux with
`openssl`, so a Mac is never required.

Legend: **[you]** = only you can do it · **[me]** = I do it on the server ·
⏳ = waiting on someone else.

---

## Stage 1 — Legal entity (≈ £50, ~24 h)

- [ ] **[you]** Check the name is free →
      <https://find-and-update.company-information.service.gov.uk/company-name-availability>
- [ ] **[you]** Incorporate at **gov.uk** (not a formation agent — same result, less money):
      <https://www.gov.uk/limited-company-formation> · **£50**, usually approved within 24 h.
      - You need: company name, registered address, at least one director (you),
        shareholder details, SIC code — **62012 “Business and domestic software development”** fits.
- [ ] **[you]** Save the **company number** and the exact **registered legal name** —
      Apple must match this *character for character*.

> The company name becomes the **seller name** shown publicly on your App Store
> listing. `Olesia Ltd` is the clean choice.

---

## Stage 2 — D-U-N-S number (free, ~5 working days ⏳)

Apple requires a D-U-N-S number for organization enrolment.

- [ ] **[you]** Apply through **Apple's own lookup** (free, and it's the path Apple
      accepts): <https://developer.apple.com/enroll/duns-lookup/>
- [ ] Search for your new company first — it may already exist from Companies House data.
- [ ] ⏳ If not, request one. Typically ~5 business days.
- [ ] **[you]** Confirm the D-U-N-S record's **name + address exactly match** Companies House.
      Mismatches here are the #1 cause of Apple enrolment rejections.

---

## Stage 3 — Apple Developer Program, as an *organization* ($99/yr, days–weeks ⏳)

⚠️ **This is the real gate.** App Review guideline **3.1.5(b)** requires crypto-wallet
apps to come from a developer enrolled as an **organization**, not an individual.

- [ ] **[you]** Enrol: <https://developer.apple.com/programs/enroll/> → choose
      **Company / Organization**. **$99/year**.
      - You'll need: legal entity name, D-U-N-S, company website (**olesia.io** ✅),
        a work email on your domain, and confirmation you can legally bind the company.
- [ ] ⏳ Apple verifies (they may phone the company's public number). Days to a few weeks.
- [ ] **[you]** Once approved, in **App Store Connect** → **Users and Access** → **Integrations**
      → **App Store Connect API** → create a key with role **App Manager**.
      Save: **Issuer ID**, **Key ID**, and the **`.p8` file** (downloadable once only).

---

## Stage 4 — Signing material (no Mac needed) **[me + you]**

- [ ] **[me]** Generate a private key + **CSR** on the server with `openssl`.
- [ ] **[you]** Upload the CSR at **developer.apple.com → Certificates → +** →
      *Apple Distribution* → download the resulting `.cer`.
- [ ] **[me]** Convert `.cer` + key → **`.p12`**, base64 it, ready for CI.
- [ ] **[you]** Register the App ID **`io.olesia.wallet`** and create an
      **App Store provisioning profile** for it; download the `.mobileprovision`.
- [ ] **[you]** Add these as **GitHub repo secrets**
      (*Settings → Secrets and variables → Actions*):
      | Secret | What it is |
      |---|---|
      | `APPSTORE_ISSUER_ID` | App Store Connect API issuer id |
      | `APPSTORE_KEY_ID` | API key id |
      | `APPSTORE_PRIVATE_KEY` | contents of the `.p8` |
      | `BUILD_CERTIFICATE_B64` | base64 of the `.p12` |
      | `P12_PASSWORD` | password you set on the `.p12` |
      | `PROVISIONING_PROFILE_B64` | base64 of the `.mobileprovision` |

> The workflow **auto-detects** these. Until they exist the TestFlight job skips and
> stays green; the moment they're set, pushes publish automatically.

---

## Stage 5 — App Store Connect record **[you]**

- [ ] Create the app: **App Store Connect → Apps → +** · Bundle ID `io.olesia.wallet`
      · Name **Olesia** (must be globally unique — have a backup like
      *Olesia Bitcoin Wallet* ready).
- [ ] Fill in: subtitle, description, keywords, support URL (**olesia.io**),
      privacy policy URL (**required** — needs writing), category *Finance* or *Education*.
- [ ] **Screenshots** — 6.7" iPhone required. I can generate these from the Simulator in CI.
- [ ] **Privacy “nutrition label”** — Olesia collects nothing; declare *Data Not Collected*.
- [ ] Export compliance: already declared exempt in `Info.plist` by the workflow ✅

---

## Stage 6 — First TestFlight build 🚀

- [ ] **[me]** Push → the workflow archives, signs, and uploads automatically.
- [ ] ⏳ Apple processes the build (~15–60 min).
- [ ] **[you]** Install **TestFlight** on your iPhone and run the real app.
- [ ] Invite testers (up to 100 internal, 10 000 external).

---

## Stage 7 — Submit for review ⏳

- [ ] **[you]** Submit from App Store Connect. Typical review: 24–48 h.
- [ ] **Expect wallet-specific questions.** Prepare these answers in advance:
      - **Non-custodial** — keys are generated and stored **only on the user's device**;
        Olesia never holds user funds and has no server that can move coins.
      - **Educational, testnet-first** — Testnet3/4 and Signet coins are worthless
        practice coins; mainnet is available but the app repeatedly warns against
        storing significant value in a hot wallet.
      - **No in-app purchases of crypto**, no exchange, no ICO/airdrop mechanics.
      - Guideline **3.1.5(b)** compliance: published by an enrolled **organization**.
      - Reviewer test notes: give them the **faucet** link so they can obtain test
        coins and exercise a send without spending anything.

---

## Costs — total

| Item | Cost | Recurring? |
|---|---|---|
| Company incorporation | **£50** | one-off |
| D-U-N-S number | **£0** | — |
| Apple Developer Program (org) | **$99** | yearly |
| Cloud iOS builds (GitHub Actions) | **£0** | public repo, unmetered |
| **Total to be live** | **≈ £130 first year** | ~$99/yr after |

---

## The critical path (what blocks what)

```
Incorporate (24h) → D-U-N-S (~5 days) → Apple org enrolment (days–weeks)
        → API key + certs → TestFlight → review (24–48h) → live
```

Realistically **3–6 weeks**, nearly all of it waiting on Apple and D&B — not on
building. The app itself **already compiles in the cloud today**.

## Meanwhile (needs nothing from Apple)

- ✅ iOS app builds on every push
- [ ] **[me]** Generate App Store screenshots from the Simulator
- [ ] **[me]** Add a native splash screen + app icons
- [ ] **[you/me]** Write the **privacy policy** page (olesia.io/privacy) — required for submission
- [ ] Keep improving the wallet — it ships as one bundled file, so updates are trivial
