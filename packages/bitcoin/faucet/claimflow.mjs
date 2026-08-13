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
export async function reconcileState(chain, network, localTxid, reserved) {
  const tx = await chain.lookup(network, localTxid);        // may throw
  if (tx && tx.found) return tx.confirmed ? { r: 'confirmed', height: tx.height, blockHash: tx.blockHash } : { r: 'seen' };
  // not found: is any reserved input spent by a DIFFERENT tx? -> conflict
  for (const op of (reserved || [])) {
    const os = await chain.outspend(network, op.txid, op.vout);   // may throw
    if (os && os.spent && os.txid && os.txid !== localTxid) return { r: 'conflicted', by: os.txid };
  }
  return { r: 'absent' };
}

// Advance a single claim as far as it can safely go in one call. Returns the claim row.
export async function processClaim(deps, claimId, { maxBroadcasts = 3 } = {}) {
  const { ledger, signer, chain, txidOf, crashAfter = noHook } = deps;
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
    ledger.markSigned(claimId, { rawTx: signed.rawTx, localTxid: signed.localTxid, feeSat: signed.feeSat, reservedOutpoints: signed.inputs || reserved });
    crashAfter('after-signed-persist');
    c = ledger.get(claimId);
  }

  // I4 guard on every start with a stored tx: recompute txid == stored local_txid.
  if (c.raw_tx && txidOf(c.raw_tx) !== c.local_txid) { ledger.markFailedSafe(claimId, 'stored-txid-mismatch', 'raw_tx txid != stored local_txid'); return ledger.get(claimId); }

  const reserved = JSON.parse(c.reserved_outpoints || '[]');
  const settleAfterBroadcast = async () => {
    // §17: don't trust the send return -> reconcile to reach SEEN/CONFIRMED.
    let post; try { post = await reconcileState(chain, c.network, c.local_txid, reserved); }
    catch { return ledger.markUncertain(claimId, 'post-broadcast reconcile source unavailable'); }
    if (post.r === 'confirmed') return ledger.markConfirmed(claimId, { height: post.height, blockHash: post.blockHash });
    if (post.r === 'seen') return ledger.markSeen(claimId);
    if (post.r === 'conflicted') return ledger.markConflicted(claimId, 'input spent by ' + post.by);
    return ledger.markUncertain(claimId, 'broadcast sent but tx not yet observed');
  };
  const doBroadcast = async () => {
    if ((ledger.get(claimId).broadcast_attempt_count || 0) >= maxBroadcasts) return ledger.markUncertain(claimId, 'max broadcast attempts reached; tx absent from chain');
    ledger.markBroadcasting(claimId);
    crashAfter('after-broadcasting-persist-before-send');
    let returned;
    try { returned = await chain.broadcast(c.network, c.raw_tx); }
    catch (e) {
      if (e instanceof CrashInjected) throw e;
      // 'already known / in mempool' == our tx is out there -> reconcile to SEEN.
      if (/already|in.?mempool|txn-already/i.test(String(e.message))) return settleAfterBroadcast();
      // any other broadcast error is AMBIGUOUS (node may have accepted) -> UNCERTAIN.
      return ledger.markUncertain(claimId, 'broadcast ambiguous: ' + String(e.message).slice(0, 120));
    }
    crashAfter('after-broadcast-before-verify');
    // I5: a returned txid must equal the local txid, else it is a safety failure.
    if (returned && String(returned).trim() && String(returned).trim() !== c.local_txid) return ledger.markFailedSafe(claimId, 'broadcast-txid-mismatch', 'network returned a different txid');
    return settleAfterBroadcast();
  };
  const reconcileThenMaybeBroadcast = async () => {
    let rec; try { rec = await reconcileState(chain, c.network, c.local_txid, reserved); }
    catch (e) { return ledger.markUncertain(claimId, 'reconcile source unavailable: ' + String(e.message).slice(0, 100)); }
    if (rec.r === 'confirmed') return ledger.markConfirmed(claimId, { height: rec.height, blockHash: rec.blockHash });
    if (rec.r === 'seen') return ledger.markSeen(claimId);
    if (rec.r === 'conflicted') return ledger.markConflicted(claimId, 'input spent by ' + rec.by);
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
      if (rec.r === 'confirmed') return ledger.markConfirmed(claimId, { height: rec.height, blockHash: rec.blockHash });
      if (rec.r === 'conflicted') return ledger.markConflicted(claimId, 'input spent by ' + rec.by);
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
export function realChain() {
  return {
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
