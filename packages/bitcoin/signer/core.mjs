// P1.a — OFFLINE SIGNER core (air-gap PSBT signing). Pure engine, no I/O, no network. Reuses
// the audited packages/bitcoin engine: describePSBT (ownership + INDEPENDENT fee, never trusted
// from PSBT metadata) for the WYSIWYS review + safety gates, and per-input BIP-84 key derivation
// so a spend that pulls UTXOs from several addresses/paths is fully signed (the older
// signUnsigned only signed a single path).
//
// Hard safety rules (a single-sig air-gap signer must never violate these):
//   - refuse if NO input belongs to this wallet (wrong seed/passphrase/network)
//   - refuse to co-sign a PSBT that ALSO spends inputs that are not ours
//   - refuse if input amounts are missing (fee cannot be independently verified)
//   - refuse if outputs exceed inputs, or the fee exceeds a sane fraction of the inputs
import * as btc from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils';
import { accountXpub, deriveKey, normalizeMnemonic } from '../src/wallet.js';
import { describePSBT } from '../src/psbt.js';

export const MAX_FEE_FRACTION = 0.2;   // fee must not exceed 20% of the inputs

// Review a PSBT with the seed's own account xpub. Returns the full WYSIWYS breakdown plus a
// safety verdict — NEVER signs. `summary.fee` is computed as inputs-minus-outputs, so a tampered
// output amount changes the displayed fee and is caught here and by the gates below.
export function reviewPSBT({ mnemonic, passphrase = '', network, psbtB64 }) {
  const mn = normalizeMnemonic(mnemonic);
  const axpub = accountXpub(mn, passphrase || '', network);
  const summary = describePSBT((psbtB64 || '').trim(), { accountXpub: axpub, network });
  const reasons = [];
  if (!summary.anyInputMine) reasons.push('no input belongs to this wallet (wrong seed, passphrase, or network)');
  else if (!summary.allInputsMine) reasons.push('this PSBT also spends coins that are NOT this wallet\'s — a single-sig wallet must never co-sign foreign inputs');
  if (summary.fee == null) reasons.push('input amounts are missing from the PSBT — the fee cannot be independently verified');
  else if (summary.fee < 0) reasons.push('outputs exceed inputs — malformed or malicious PSBT');
  else if (summary.inTotal > 0 && summary.fee > summary.inTotal * MAX_FEE_FRACTION) reasons.push(`fee (${summary.fee} sat) exceeds ${MAX_FEE_FRACTION * 100}% of the inputs (${summary.inTotal} sat)`);
  return { summary, safeToSign: reasons.length === 0, reasons };
}

// Sign EVERY owned input at its own BIP-84 path, finalize, and return the signed PSBT + the
// broadcastable raw tx. Throws (never partial-signs) if the review gates fail.
export function signPSBT({ mnemonic, passphrase = '', network, psbtB64 }) {
  const review = reviewPSBT({ mnemonic, passphrase, network, psbtB64 });
  if (!review.safeToSign) throw new Error('refusing to sign: ' + review.reasons.join('; '));
  const mn = normalizeMnemonic(mnemonic);
  const tx = btc.Transaction.fromPSBT(base64.decode((psbtB64 || '').trim()), { allowUnknownOutputs: true });

  // Derive a key for each DISTINCT (chain,index) among our inputs and sign with it. btc.sign()
  // only touches inputs whose script matches that key, so this signs exactly our inputs.
  const done = new Set();
  for (const inp of review.summary.inputs) {
    if (!inp.mine || !inp.path) continue;
    const m = inp.path.match(/\/(\d+)\/(\d+)$/);          // .../chain/index
    if (!m) continue;
    const chain = Number(m[1]), index = Number(m[2]);
    const tag = chain + ':' + index;
    if (done.has(tag)) continue; done.add(tag);
    const k = deriveKey(mn, passphrase || '', network, index, chain);
    tx.sign(k.privKey);
  }
  tx.finalize();   // throws if any input remained unsigned — we never emit a partially-signed spend as final
  return { signedPsbtB64: base64.encode(tx.toPSBT()), txid: tx.id, txHex: bytesToHex(tx.extract()), summary: review.summary };
}
