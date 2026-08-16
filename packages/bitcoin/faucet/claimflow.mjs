// RT-2 — claim processor + reconciliation (exactly-once payout engine).
//
// Drives ONE claim through the durable state machine. Every irreversible external
// effect (broadcast) is preceded by a durable write (write-ahead). After SIGNED the
// EXACT persisted raw_tx is the only thing ever (re)broadcast — recovery NEVER builds
// a second transaction. Ambiguous broadcast -> UNCERTAIN; a conflicting input ->
// CONFLICTED (never an automatic replacement). The chain (not the RPC return) is the
// arbiter: SEEN/CONFIRMED come from reconciliation, not from a successful send call.
//
// Deps are injected so the same engine is used live (real esplora/signer) and in the
// crash-injection tests (fakes). `crashAfter(stage)` lets a test abort at any boundary.
import { S, TERMINAL } from './ledger.mjs';
import { decodeRawTx, prepareAndSend } from '../src/send.js';
import { getTx, getOutspend, broadcast as esploraBroadcast } from '../src/esplora.js';

export class CrashInjected extends Error { constructor(stage) { super('CRASH@' + stage); this.stage = stage; } }
const noHook = () => {};

// Resolve the on-chain status of a claim's local tx.
// -> { r:'confirmed', height, blockHash } | { r:'seen' } | { r:'conflicted', by } | { r:'absent' }
// Throws if the reconciliation source is unavailable (caller -> UNCERTAIN).
//
// RT-2A — an EXTERNAL explorer (chain.authoritative === false) is ADVISORY only. Its
// results here can drive SEEN (observational) or trigger a rebroadcast of the EXACT
// stored bytes (idempotent — same txid), but they must NEVER: release a reserved input,
// justify a second/replacement payment, or turn "explorer hasn't indexed it yet" into
// "never broadcast". Absence therefore resolves to a same-bytes rebroadcast and, once
// attempts are exhausted, to UNCERTAIN (held) — not to failure and not to a new tx. Only
// an AUTHORITATIVE source (our own node) may later retire a reservation via the ledger.
export async function reconcileState(chain, network, localTxid, reserved) {
  const tx = await chain.lookup(network, localTxid);        // may throw
  if (tx && tx.found) return tx.confirmed ? { r: 'confirmed', height: tx.height, blockHash: tx.blockHash } : { r: 'seen' };
  // not found by txid: examine the reserved inputs. Spent by a DIFFERENT tx -> conflict;
  // spent by OUR txid -> our tx exists (seen) even if the txid index lags.
  let spentByUs = false;
  for (const op of (reserved || [])) {
    const os = await chain.outspend(network, op.txid, op.vout);   // may throw
    if (os && os.spent && os.txid) { if (os.txid !== localTxid) return { r: 'conflicted', by: os.txid }; else spentByUs = true; }
  }
  if (spentByUs) return { r: 'seen' };
  return { r: 'absent' };
}

// Advance a single claim as far as it can safely go in one call. Returns the claim row.
export async function processClaim(deps, claimId, { maxBroadcasts = 3 } = {}) {
  const { ledger, signer, chain, txidOf, crashAfter = noHook } = deps;
  const authoritative = !!(chain && chain.authoritative);   // L5 — only an own-node source may drive terminal states
  let c = ledger.get(claimId);
  if (!c || TERMINAL.has(c.state)) return c;

  // AUTHORISED -> build+sign the EXACT tx, persist SIGNED (write-ahead).
  if (c.state === S.AUTHORISED) {
    const reserved = JSON.parse(c.reserved_outpoints || '[]');
    let signed;
    try { signed = await signer({ network: c.network, address: c.address, amountSat: c.amount_sat, reservedOutpoints: reserved }); }
    catch (e) { if (e instanceof CrashInjected) throw e; ledger.markUncertain(claimId, 'sign failed: ' + String(e.message).slice(0, 100)); return ledger.get(claimId); }
    crashAfter('after-sign-before-persist');
    // I4/I5: the signer's txid must equal the txid recomputed from the raw bytes.
    if (txidOf(signed.rawTx) !== signed.localTxid) { ledger.markFailedSafe(claimId, 'sign-txid-mismatch', 'signer txid != bytes txid'); return ledger.get(claimId); }
    // M3 — defense in depth: the signer must only spend coins this claim durably reserved. If
    // the built tx pulls in ANY unreserved input, fail safe rather than pay.
    const reservedSet = new Set(reserved.map((o) => `${o.txid}:${o.vout}`));
    if (reserved.length && (signed.inputs || []).some((i) => !reservedSet.has(`${i.txid}:${i.vout}`))) {
      ledger.markFailedSafe(claimId, 'unreserved-input', 'signed tx spends an input outside the reservation');
      return ledger.get(claimId);
    }
    ledger.markSigned(claimId, { rawTx: signed.rawTx, localTxid: signed.localTxid, feeSat: signed.feeSat, reservedOutpoints: signed.inputs || reserved });
    crashAfter('after-signed-persist');
    c = ledger.get(claimId);
  }

  // I4 guard on every start with a stored tx: recompute txid == stored local_txid.
  if (c.raw_tx && txidOf(c.raw_tx) !== c.local_txid) { ledger.markFailedSafe(claimId, 'stored-txid-mismatch', 'raw_tx txid != stored local_txid'); return ledger.get(claimId); }

  const reserved = JSON.parse(c.reserved_outpoints || '[]');
  const doBroadcast = async () => {
    if ((ledger.get(claimId).broadcast_attempt_count || 0) >= maxBroadcasts) return ledger.markUncertain(claimId, 'max broadcast attempts reached; tx absent from chain');
    ledger.markBroadcasting(claimId);
    crashAfter('after-broadcasting-persist-before-send');
    let returned;
    // Pass the authoritative local_txid so an own-node broadcaster can verify testmempoolaccept
    // and the returned txid against it. The EXACT persisted raw_tx is what is broadcast — the
    // broadcaster is transport-only and never reconstructs the transaction.
    try { returned = await chain.broadcast(c.network, c.raw_tx, c.local_txid); }
    catch (e) {
      if (e instanceof CrashInjected) throw e;
      // 'already known / in mempool' == our exact tx is out there -> SEEN.
      if (/already|in.?mempool|txn-already/i.test(String(e.message))) return ledger.markSeen(claimId);
      // any other broadcast error is AMBIGUOUS (node may have accepted) -> UNCERTAIN.
      return ledger.markUncertain(claimId, 'broadcast ambiguous: ' + String(e.message).slice(0, 120));
    }
    crashAfter('after-broadcast-before-verify');
    // I5: a returned txid must equal the local txid, else it is a safety failure.
    if (returned && String(returned).trim() && String(returned).trim() !== c.local_txid) return ledger.markFailedSafe(claimId, 'broadcast-txid-mismatch', 'network returned a different txid');
    // The mempool accepted our EXACT txid -> observed (SEEN). CONFIRMED still requires
    // an on-chain confirmation via reconciliation (§17: broadcast is not final truth).
    return ledger.markSeen(claimId);
  };
  const reconcileThenMaybeBroadcast = async () => {
    let rec; try { rec = await reconcileState(chain, c.network, c.local_txid, reserved); }
    catch (e) { return ledger.markUncertain(claimId, 'reconcile source unavailable: ' + String(e.message).slice(0, 100)); }
    // RT-2A / L5 — only an AUTHORITATIVE source (our own node) may drive a TERMINAL state. An
    // advisory external explorer can only OBSERVE (SEEN) or HOLD (UNCERTAIN): a glitchy explorer
    // must never terminally CONFIRM/CONFLICT a claim (which would also strand its reservation).
    if (rec.r === 'confirmed') return authoritative ? ledger.markConfirmed(claimId, { height: rec.height, blockHash: rec.blockHash }) : ledger.markSeen(claimId);
    if (rec.r === 'seen') return ledger.markSeen(claimId);
    if (rec.r === 'conflicted') return authoritative ? ledger.markConflicted(claimId, 'input spent by ' + rec.by) : ledger.markUncertain(claimId, 'advisory: input appears spent by ' + rec.by + ' — awaiting authoritative check');
    return doBroadcast();   // absent -> safe to (re)broadcast the EXACT stored raw_tx
  };

  switch (c.state) {
    case S.SIGNED:
      // Reconcile before broadcasting — even the first send — so a pre-existing input
      // conflict (or an already-present tx) is caught before a doomed broadcast (§13).
      return await reconcileThenMaybeBroadcast();
    case S.BROADCASTING:  // outcome is ambiguous -> reconcile FIRST (§13)
    case S.UNCERTAIN:
      return await reconcileThenMaybeBroadcast();
    case S.SEEN: {        // reconcile only for confirmation / conflict
      ledger.bumpReconcile(claimId);
      let rec; try { rec = await reconcileState(chain, c.network, c.local_txid, reserved); } catch { return ledger.get(claimId); }
      // L5 — advisory sources cannot promote a SEEN claim to a terminal state; only our own node can.
      if (rec.r === 'confirmed') return authoritative ? ledger.markConfirmed(claimId, { height: rec.height, blockHash: rec.blockHash }) : ledger.get(claimId);
      if (rec.r === 'conflicted') return authoritative ? ledger.markConflicted(claimId, 'input spent by ' + rec.by) : ledger.get(claimId);
      if (rec.r === 'absent') return ledger.markUncertain(claimId, 'previously seen tx no longer observable');
      return ledger.get(claimId);   // still 'seen'
    }
    default:
      return ledger.get(claimId);
  }
}

// ── live adapters ──
export const txidOf = (rawTxHex, network = 'testnet4') => decodeRawTx({ hex: rawTxHex, network }).txid;

// Real chain adapter over our esplora layer (mempool.space for testnet; own node
// for mainnet broadcast). lookup/outspend translate 404/absence into {found:false}.
// RT-2A: authoritative=false marks this as an ADVISORY external explorer — the ledger
// must not retire reservations on its say-so. An own-node adapter would set true.
export function realChain() {
  return {
    authoritative: false,
    async lookup(network, txid) {
      try { const t = await getTx(txid, network); return { found: true, confirmed: !!t.status?.confirmed, height: t.status?.block_height ?? null, blockHash: t.status?.block_hash ?? null }; }
      catch (e) { if (/not found|404|no such/i.test(String(e.message))) return { found: false }; throw e; }
    },
    async outspend(network, txid, vout) {
      const os = await getOutspend(txid, vout, network); return { spent: !!os?.spent, txid: os?.txid || null };
    },
    async broadcast(network, rawTx) { return esploraBroadcast(rawTx, network); },
  };
}

// Real signer: build+sign the EXACT tx (no broadcast) using the reserved coins.
export function realSigner(mnemonic, feeRateFor) {
  return async ({ network, address, amountSat, reservedOutpoints }) => {
    const opts = { source: mnemonic, network, scriptType: 'p2wpkh', recipients: [{ address, amount: amountSat }], feeRate: feeRateFor(network), broadcast: false };
    if (reservedOutpoints && reservedOutpoints.length) opts.utxos = reservedOutpoints.map((op) => ({ txid: op.txid, vout: op.vout, value: op.value }));
    else opts.allowUnconfirmed = true;
    const built = await prepareAndSend(opts);           // { txHex, txid, fee, ... } (not broadcast)
    const inputs = decodeRawTx({ hex: built.txHex, network }).inputs.map((i) => ({ txid: i.txid, vout: i.vout }));
    return { rawTx: built.txHex, localTxid: built.txid, feeSat: built.fee ?? null, inputs };
  };
}
