# Quick Wallet + seed-length options (DESIGN / DRAFT)

A testnet-only convenience mode for fast, throwaway testing — spin up several wallets at once,
switch between them with a tab bar, auto-saved locally so they survive a reload. Hard-gated to
testnets: real value never touches this.

## Seed length
- Wallet creation defaults to **24 words** (256-bit).
- **12-word** option available (128-bit — still secure; offered for speed/compatibility).
- **Mainnet:** [DECISION #1] either 12-word only, or 24-word default with a 12-word option —
  either way with a clear warning shown to all users.

## Quick Wallet (testnet only)
- A distinct "Quick Wallet" entry on the home screen (alongside Create / Import).
- Opens a **tab bar** of up to **5** disposable wallets; each tab is one wallet.
- New-tab (＋) creates another; each tab shows a short label (e.g. first address / index).
- Switching tabs switches the active wallet instantly.
- Wallets are **auto-saved locally** (no manual backup step) so the tab set persists across
  reloads. Closing a tab discards that wallet.
- Every Quick Wallet is clearly marked **disposable — testnet, no real value**.

## Storage of the auto-saved seed  [DECISION #2]
- **Option A (recommended): in-browser (localStorage / IndexedDB).** "Auto-save" = the tab set
  and their seeds persist in this browser; reopening the app restores the tabs. Simple, matches
  the tab UX. Optional "export to file" per wallet if the user wants to carry one out.
- Option B: **download a seed file** per quick wallet to the computer. More portable, but a
  plaintext seed file on disk and no automatic tab restore.
- Either way it is a **plaintext key on the device** — acceptable ONLY because it is testnet /
  zero value. Enforced in CODE (not just UI): Quick Wallet + auto-save cannot run on mainnet.

## Mainnet rules
- **No Quick Wallet, no tabs, no auto-save.** Mainnet stays single-wallet, keys-off-the-hot-
  surface (P1 direction). Mainnet create = 12-word (see Decision #1) with a warning to all users.

## Warnings / education (testnets too)
- On testnet create AND on entering Quick Wallet: a short, clear explainer — "these are practice
  wallets on a test network; the coins have no value; seeds here are stored in this browser for
  convenience; never do this with real value." Educational tone, not alarming.
- Mainnet: the existing hot-wallet warning + the 12-word note.

## Gating & safety (must hold)
- `network === 'mainnet'` disables Quick Wallet, multi-tab, and any seed auto-save at the engine
  level — a UI bug must not be able to persist a mainnet seed automatically.
- Max 5 open tabs (configurable). Clear "close/discard" per tab.
- No change to the mainnet air-gap / watch-only direction (P1).

## Open decisions
1. Mainnet seed policy: 12-word only, or 24-default + 12-option (both with warning)?
2. Auto-save storage: in-browser persist (recommended) vs file download vs both?
3. Max quick wallets: 5 (confirm) or configurable?

## Build sketch (once decided)
- Seed-length selector in the create flow (24 default / 12).
- A lightweight wallet-session manager: N in-memory wallets + a persistence layer (Option A/B),
  testnet-gated, with a tab-bar UI in the app shell.
- Educational warning modals (testnet + mainnet variants).
- Tests: mainnet gating (no auto-save / no quick wallet), tab create/switch/close, 24/12
  generation + validation, persistence round-trip. Reuses the audited seed/derivation engine.
