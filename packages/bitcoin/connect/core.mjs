// Olesia wallet ↔ swap hand-off — the WALLET-SIDE bridge logic (runs on app.olesia.io, where the
// keys live). Pure engine over an already-unlocked seed; the page shell (index.html) owns the
// postMessage transport, origin allow-listing, unlock, and the human consent UI.
//
// Implements the two methods of the injected provider contract
// (docs/OLESIA_WALLET_HANDOFF_CONTRACT.md), non-custodially:
//   olesia_getAccount → { network, address, xpub }        (watch-only identity, NO key material)
//   olesia_signPsbt   → { signedTxHex }                    (P2WSH HTLC redeem/refund, SIGHASH_ALL)
// The signer reproduces the engine's immutable intent txid; the engine verifies + broadcasts.
import { normalizeMnemonic, accountXpub } from '../src/wallet.js';
import { deriveAt } from '../src/send.js';
import { describeHtlcSpend, signHtlcSpend } from '../src/htlc_sign.js';

// Contract §Scope: TESTNET ONLY. A mainnet request is refused (defense in depth — the swap page
// also refuses one). Mainnet HTLC custody is a later, separately-reviewed phase.
export const CONNECT_NETWORKS = new Set(['testnet4', 'signet']);

function assertNetwork(network) {
  if (!CONNECT_NETWORKS.has(network)) throw Object.assign(new Error(`Olesia swap connect is testnet-only (got ${network})`), { code: 4900 });
}

// The 32-byte swap secret for a redeem lands in describe.secret (hex) only when it is already
// safe to reveal (contract). Refund needs no secret. Accept it from describe or params.
function secretFrom(p) {
  const s = p?.secretHex || p?.secret || p?.describe?.secret || p?.describe?.secretHex || null;
  return s ? String(s).trim() : null;
}

// olesia_getAccount — watch-only identity for display + change. No key material leaves here.
export function getAccount({ mnemonic, passphrase = '', network }) {
  assertNetwork(network);
  const mn = normalizeMnemonic(mnemonic);
  const address = deriveAt(mn, network, 'p2wpkh', 0, 0, passphrase).address;
  const xpub = accountXpub(mn, passphrase || '', network);
  return { network, address, xpub };
}

// Independent WYSIWYS review of what a signPsbt request would authorise — derived from first
// principles (never trusting the swap's own describe). Feeds the consent screen.
export function review({ mnemonic, passphrase = '', network, params }) {
  assertNetwork(network);
  const p = Array.isArray(params) ? params[0] : params;
  const mn = normalizeMnemonic(mnemonic);
  const d = describeHtlcSpend({ psbtBase64: p.psbtBase64, network, mnemonic: mn, passphrase });
  const secretHex = secretFrom(p);
  return {
    branch: d.branch,                 // 'redeem' (claim) | 'refund' (reclaim after timeout)
    network: d.network,
    amount: d.amount,                 // sats spent from the HTLC
    outputs: d.outputs,               // where it goes
    locktime: d.locktime,
    refundHeight: d.refundHeight,
    intentTxid: d.intentTxid,
    mine: d.mine,                     // is the branch key in THIS wallet?
    haveSecret: d.branch === 'redeem' ? !!secretHex : true,
    safeToSign: d.mine && (d.branch === 'refund' || !!secretHex),
  };
}

// olesia_signPsbt — sign + finalize; returns { signedTxHex } for the engine to verify+broadcast.
export function sign({ mnemonic, passphrase = '', network, params }) {
  assertNetwork(network);
  const p = Array.isArray(params) ? params[0] : params;
  const mn = normalizeMnemonic(mnemonic);
  const out = signHtlcSpend({ psbtBase64: p.psbtBase64, network, mnemonic: mn, passphrase, secretHex: secretFrom(p) });
  return { signedTxHex: out.signedTxHex, txid: out.txid, branch: out.branch };
}
