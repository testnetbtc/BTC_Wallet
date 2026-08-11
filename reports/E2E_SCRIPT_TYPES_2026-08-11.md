# Olesia — end-to-end script-type test report

_Automated run · 2026-08-11T15:10:48Z → 2026-08-11T15:11:12Z · all coins are **worthless testnet/signet**._

**What was tested:** two throwaway wallets (A, B) were created and funded from the Olesia faucet wallet, then A sent to B across **every script type**, including a send carrying an **OP_RETURN** message and the **P2PK museum** flow (mint a bare-pubkey output, then spend it with a Satoshi-style note) — on **testnet4**, **testnet3**, and a **signet** demonstration sweep. Everything was built and signed by the same engine that powers app.olesia.io.

> ⚠️ **These are throwaway TEST wallets holding worthless coins, published only so the test is reproducible and inspectable. Never send real bitcoin to them and never reuse these seeds.**

## Test wallets
| | 12-word seed |
|---|---|
| **Wallet A** (sender) | `immense rain burden meat one stock cigar dice enhance post jacket aerobic` |
| **Wallet B** (receiver) | `like youth surface loop fire bulk push repair riot scan blame tilt` |

## testnet4

**Addresses (same seed, every script type):**

| Script type | Wallet A | Wallet B |
|---|---|---|
| Native SegWit (bc1q/tb1q) | `tb1q4r7k0429pawju9yz3egma3rulqg69efe97rtkf` | `tb1qw2yu74j97dlc6fzc7256lt5wvh47kjjhcmjs23` |
| Taproot (bc1p/tb1p) | `tb1p9cccndsqwwxfht209ujhuw27f080qagydk5f6netkw08nmnn3yws5cwpt8` | `tb1pqym646y0q34xqt8ddan9v4cg08mkp9ezqwzgutatjzzdy0cuv94q5kje49` |
| Nested SegWit (3/2) | `2MvpbeAYHhB9LFEp9UXP8ZatrroiBvzwJQH` | `2N8binJAq8jgMBDPDAXD5HRM8wUhsTq1Fj9` |
| Legacy (1/m,n) | `n1VAuusG9GZytLQKrD1aSpBZphf2eMLaEV` | `mtf73CziiHytwyuwtHbA6LpwpUVShoK3T8` |
| P2PK — bare pubkey (no address) | `(P2PK — no address)` | `(P2PK — no address)` |

**Transactions:**

| Step | Script type | Amount (sat) | Fee (sat) | OP_RETURN | Result | txid |
|---|---|---|---|---|---|---|
| FUND A (faucet → A×4 types) |  | 126000 | 500 | — | ✅ | [63a6cc949f2d50…](https://mempool.space/testnet4/tx/63a6cc949f2d50337ec72131f6afdee82012a2047a2575e6c91ab16ecd1dfcb1) |
| A→B Native SegWit | p2wpkh | 9000 | 282 | — | ✅ | [ece8d862b3f3ac…](https://mempool.space/testnet4/tx/ece8d862b3f3aced915f6e869ee983f160d9c484b8a317727d4455a2b6b41d53) |
| A→B Taproot | p2tr | 9000 | 308 | — | ✅ | [35e13260a8542f…](https://mempool.space/testnet4/tx/35e13260a8542f75b69eb8cbbf60d0288b38a17aaff606275cc9903e680dd3f0) |
| A→B Nested SegWit | p2sh-p2wpkh | 9000 | 332 | — | ✅ | [1bed151d611a80…](https://mempool.space/testnet4/tx/1bed151d611a80a42f3e561ca2c38f4ca53dd210d5e84c7770796a738da63ae3) |
| A→B Legacy | p2pkh | 9000 | 452 | — | ✅ | [db734aac72ae7e…](https://mempool.space/testnet4/tx/db734aac72ae7e2359cf5506b016d1129eb50d589eab1025aa4a6ea04dd45ee0) |
| A→B SegWit + OP_RETURN | p2wpkh | 7000 | 376 | “Olesia e2e · testnet4 · 2026-08-11” | ✅ | [34c153d3052822…](https://mempool.space/testnet4/tx/34c153d3052822e785e10c38595779ee52269649029d9632aead9817af8031e4) |
| A SegWit→P2PK (mint museum output) | p2pk | 8000 | 308 | — | ✅ | [01c25309e2e2f2…](https://mempool.space/testnet4/tx/01c25309e2e2f2f73172ebfda57fea92a949a2683afa1ccfa093ed0176131a86) |
| A P2PK→B + OP_RETURN (rarest tx) | p2pk | 7608 | 392 | “Satoshi-style note · testnet4” | ✅ | [41a3bd2b4651af…](https://mempool.space/testnet4/tx/41a3bd2b4651afc9284c46a57c57807ca256c1e102b2ce4508502f3502145309) |

## testnet3

**Addresses (same seed, every script type):**

| Script type | Wallet A | Wallet B |
|---|---|---|
| Native SegWit (bc1q/tb1q) | `tb1q4r7k0429pawju9yz3egma3rulqg69efe97rtkf` | `tb1qw2yu74j97dlc6fzc7256lt5wvh47kjjhcmjs23` |
| Taproot (bc1p/tb1p) | `tb1p9cccndsqwwxfht209ujhuw27f080qagydk5f6netkw08nmnn3yws5cwpt8` | `tb1pqym646y0q34xqt8ddan9v4cg08mkp9ezqwzgutatjzzdy0cuv94q5kje49` |
| Nested SegWit (3/2) | `2MvpbeAYHhB9LFEp9UXP8ZatrroiBvzwJQH` | `2N8binJAq8jgMBDPDAXD5HRM8wUhsTq1Fj9` |
| Legacy (1/m,n) | `n1VAuusG9GZytLQKrD1aSpBZphf2eMLaEV` | `mtf73CziiHytwyuwtHbA6LpwpUVShoK3T8` |
| P2PK — bare pubkey (no address) | `(P2PK — no address)` | `(P2PK — no address)` |

**Transactions:**

| Step | Script type | Amount (sat) | Fee (sat) | OP_RETURN | Result | txid |
|---|---|---|---|---|---|---|
| FUND A (faucet → A×4 types) |  | 126000 | 500 | — | ✅ | [a1a53d0794d43b…](https://mempool.space/testnet/tx/a1a53d0794d43b56caaac6bd0b79cfde03db79a72d7b8ed5e0f0f7b6ca266066) |
| A→B Native SegWit | p2wpkh | 9000 | 282 | — | ✅ | [1c36080a5f69b9…](https://mempool.space/testnet/tx/1c36080a5f69b9cc91ad99e733274da73716e07429940c061b62f7a7115d752b) |
| A→B Taproot | p2tr | 9000 | 308 | — | ✅ | [6eb71ab0fe80dd…](https://mempool.space/testnet/tx/6eb71ab0fe80dd711de58c652966ae65ce3aaa7dd5111d5e69f9fe96fe03059a) |
| A→B Nested SegWit | p2sh-p2wpkh | 9000 | 332 | — | ✅ | [bc477d3339c5e1…](https://mempool.space/testnet/tx/bc477d3339c5e12f1e5ea6cdf273d1c5190c3c46bb5f8c3de502fd887637ade3) |
| A→B Legacy | p2pkh | 9000 | 452 | — | ✅ | [935e94804ceef6…](https://mempool.space/testnet/tx/935e94804ceef6c2fdc67d430d0ac25feb8e0e727761e4cbe2624e6a90fc2107) |
| A→B SegWit + OP_RETURN | p2wpkh | 7000 | 366 | “Olesia e2e · testnet3 · rerun” | ✅ | [f5982af25fdafa…](https://mempool.space/testnet/tx/f5982af25fdafab52b45f17f001f594d717ba56422972ff8f427de3079d522ca) |
| A SegWit→P2PK (mint museum output) | p2pk | 8000 | 308 | — | ✅ | [58b77afc6dde5f…](https://mempool.space/testnet/tx/58b77afc6dde5fa54a01aa96d437c5672aaf67f0a7e916fc10c4b352c03ad029) |
| A P2PK→B + OP_RETURN (rarest tx) | p2pk | 7608 | 392 | “Satoshi-style note · testnet3” | ✅ | [4fde87e0c8b163…](https://mempool.space/testnet/tx/4fde87e0c8b163d3f81c7fe04c5b9f2701d8632cd1efbba4262044547828ca55) |

## signet

Swept from `tb1qeq5tcdqmusje32r8rtzqrksqdzdzm20mrzgdp2` → `tb1qw2yu74j97dlc6fzc7256lt5wvh47kjjhcmjs23` (balance 1000 sat).

**Transactions:**

| Step | Script type | Amount (sat) | Fee (sat) | OP_RETURN | Result | txid |
|---|---|---|---|---|---|---|
| signet sweep + OP_RETURN | p2wpkh | 888 | 112 | “Olesia · signet lives” | ✅ | [a70a47f1129270…](https://mempool.space/signet/tx/a70a47f1129270918b364042851f4dfd6f0c042fa7d3071163d90585fcaee78d) |

## Summary

- **17 transactions broadcast and accepted**, 0 failed.
- ✅ Send + receive verified for **all five script types** on **testnet3 and testnet4**.
- ✅ **OP_RETURN** verified — including the rarest form, an OP_RETURN spent **from a P2PK output**.
- ✅ **P2PK museum** verified end-to-end (mint a bare-pubkey output, then spend it).
- ✅ **Signet** demonstrated with a sweep + OP_RETURN.

_Reproduce any line by pasting Wallet A or B’s seed into app.olesia.io on the matching network, or by opening the txid in the linked explorer._