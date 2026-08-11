# Olesia iOS — set-up on your Mac

The iOS app is a **Capacitor** shell that bundles the exact web wallet locally
(offline-capable, no server to trust — same code as app.olesia.io, pinned inside
the app). You build and submit it from your Mac with Xcode.

## 1. Install the tools (once)
- **Xcode** — from the **Mac App Store** (free, ~15 GB). This is the only App-Store
  app you need; it brings the iOS SDK, Simulator, and the build/submit tooling.
- Then in Terminal:
  ```sh
  xcode-select --install            # command-line tools
  sudo xcodebuild -license accept   # accept the licence
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"  # Homebrew
  brew install node cocoapods       # Node (for Capacitor) + CocoaPods (iOS deps)
  ```

## 2. Get the project
```sh
git clone https://github.com/testnetbtc/BTC_Wallet.git
cd BTC_Wallet/mobile
npm install
npm run prepare-www        # builds the wallet into www/
```

## 3. Create + open the iOS project (Mac only)
```sh
npx cap add ios            # generates ios/ (runs pod install — needs the Mac)
npx cap sync ios
npx cap open ios           # opens the project in Xcode
```

## 4. In Xcode
- Select the **Olesia** target → **Signing & Capabilities**.
- Set **Team** to your Apple Developer account; confirm Bundle Identifier
  `io.olesia.wallet`.
- Pick a Simulator (e.g. iPhone 15) and press **▶ Run** — the wallet launches.
- To run on your own iPhone: plug it in, select it, Run (a free account allows
  7-day on-device builds; TestFlight needs the paid program).

## 5. Ship it (later)
- **Apple Developer Program** — developer.apple.com, **$99/yr**. Important: a
  crypto wallet must be published by an account enrolled as an **organization**
  (App Store guideline 3.1.5(b)), which needs a legal entity + D-U-N-S number.
  You can build and TestFlight-test long before this; it only gates public release.
- Product → **Archive** → **Distribute App** → App Store Connect → submit for review.

## Updating the app after wallet changes
```sh
npm run sync               # rebuilds www/ from the wallet + cap sync ios
```
Then Archive again. The whole wallet lives in one file, so updates are just a
re-bundle — no server migration.

## Notes
- `appId` / `appName` / colours live in `capacitor.config.json`.
- The web wallet's CSP already allows mempool.space / blockstream.info / api.olesia.io;
  WKWebView honours it. No exchange keys, no signing server — same safety model.
