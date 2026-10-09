// An open wallet: a WATCH-ONLY account (public keys only), the coins the node reported for
// it, and the small amount of state needed to use it — which address to show next, which
// coins to spend, what was just sent. It never holds a private key: prepare() is handed a
// short-lived signer for the one transaction being built. The ONLY thing ever persisted is a
// pair of non-secret counters (next receive / change index) so addresses are not reused.
import { coinsFromScan, buildSpend, outpointOf, DEFAULT_RANGE, HD_TYPES, RECEIVE_TYPES, TYPE_LABEL } from './account.js';
import { privacyReport, parseTx } from './privacy.js';

// Address window per chain: the types this wallet creates addresses on are scanned deeper
// than the two that are only scanned for an imported wallet's existing coins. The window
// grows automatically when a coin sits near its end, and can be grown by hand (scanDeeper).
const SPENT_GRACE_MS = 120_000;
// mainnet: one node scan covers any number of addresses, so the window is generous.
export const MAINNET_WINDOW = Object.freeze({ range: 200, rangeOther: DEFAULT_RANGE, margin: 20, step: 100, max: 1000 });
// practice networks: every address is one request to a public API, so the window is small,
// only the two address types this wallet issues are looked at, and it grows in small steps.
export const TEST_WINDOW = Object.freeze({ range: 10, rangeOther: 0, margin: 4, step: 10, max: 200 });
const memoryStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };

export class Session {
  constructor({ account, api, store = memoryStore(), explorer = 'https://mempool.space/tx/', scriptType = null, window: win = MAINNET_WINDOW }) {
    this.account = account; this.api = api; this.store = store || memoryStore(); this.explorer = explorer;
    this.win = win; this.range = win.range; this.rangeOther = win.rangeOther; this.coins = []; this.height = null; this.scanned = false;
    this.sent = [];                       // this visit's broadcasts (memory only)
    // Coins THIS wallet just spent, with the time of the broadcast. For a short grace period
    // they are treated as spent whatever the node says, so a stale answer can never offer a
    // coin for spending twice (wallet transactions signal RBF: a second spend would REPLACE
    // the first payment).
    this.spentLocal = new Map();
    this.meta = this._loadMeta();
    // preferred address type (SegWit or Legacy): used for receiving AND for change
    const types = account.receiveTypes();
    this.pref = types.includes(scriptType) ? scriptType : types.includes(this.meta.pref) ? this.meta.pref : types[0];
  }
  get info() {
    const a = this.account;
    return { kind: a.kind, fingerprint: a.fingerprint, words: a.words || null, hasPassphrase: !!a.hasPassphrase,
             compressed: a.kind === 'wif' ? a.compressed : null, network: a.network, scriptType: this.pref };
  }

  // ---- non-secret counters ----
  _metaKey() { return this.account.network === 'mainnet' ? `olesia:mainnet:idx:${this.account.id}` : `olesia:${this.account.network}:idx:${this.account.id}`; }
  _loadMeta() {
    try {
      const o = JSON.parse(this.store.getItem(this._metaKey()) || '{}');
      const n = (v) => (Number.isInteger(v) && v >= 0 && v < this.win.max ? v : 0);
      const recv = {}, change = {};
      for (const t of RECEIVE_TYPES) { recv[t] = n(o.recv?.[t]); change[t] = n(o.change?.[t]); }
      return { recv, change, pref: RECEIVE_TYPES.includes(o.pref) ? o.pref : null };
    } catch { const z = () => Object.fromEntries(RECEIVE_TYPES.map((t) => [t, 0])); return { recv: z(), change: z(), pref: null }; }
  }
  _saveMeta() { try { this.store.setItem(this._metaKey(), JSON.stringify(this.meta)); } catch { /* storage unavailable: counters stay in memory */ } }

  async _entries() {
    if (this.account.kind !== 'seed') return this.account.entries();
    return this.account.entriesAsync ? this.account.entriesAsync(this.range, this.rangeOther) : this.account.entries(this.range, this.rangeOther);
  }
  _hi(type, chain) { let hi = -1; for (const c of this.coins) if (c.entry.type === type && c.entry.chain === chain && c.entry.index > hi) hi = c.entry.index; return hi; }

  // ---- coins ----
  // Ask the node for every coin this wallet controls. Extends the address window
  // automatically if coins are found near its end.
  async refresh({ force = false, onProgress = () => {} } = {}) {
    for (;;) {
      const entries = await this._entries();
      const scan = await this.api.scan(entries.map((e) => e.script), { force, onProgress });
      this.coins = coinsFromScan(entries, scan);
      this.height = scan.height; this.scanned = true;
      this._applyLocalSpends();
      this._rememberUsed();
      if (this.account.kind !== 'seed') break;
      const { margin, step, max } = this.win;
      const near = (types, range) => range > 0 && this.coins.some((c) => types.includes(c.entry.type) && c.entry.index >= range - margin);
      const others = HD_TYPES.filter((t) => !RECEIVE_TYPES.includes(t));
      const growRecv = this.range < max && (near(RECEIVE_TYPES, this.range)
        || Math.max(...RECEIVE_TYPES.map((t) => Math.max(this.meta.recv[t], this.meta.change[t]))) >= this.range - margin);
      const growOther = this.rangeOther < max && near(others, this.rangeOther);
      if (!growRecv && !growOther) break;
      if (growRecv) this.range = Math.min(max, this.range + step);
      if (growOther) this.rangeOther = Math.min(max, this.rangeOther + step);
    }
    this._reconcileSent();
    return this.summary();
  }
  // The user asks for more addresses to be searched (e.g. a restored, heavily used wallet).
  scanDeeper(step = this.win.step * 2) {
    if (this.account.kind !== 'seed') return this.range;
    this.range = Math.min(this.win.max, this.range + step); if (this.rangeOther > 0) this.rangeOther = Math.min(this.win.max, this.rangeOther + step);
    return this.range;
  }
  get depth() { return this.account.kind === 'seed' ? { range: this.range, rangeOther: this.rangeOther, max: this.win.max } : null; }

  _applyLocalSpends(now = Date.now()) {
    const present = new Set(this.coins.map(outpointOf));
    for (const [op, at] of this.spentLocal) if (!present.has(op) || now - at > SPENT_GRACE_MS) this.spentLocal.delete(op);
    for (const c of this.coins) if (this.spentLocal.has(outpointOf(c))) { c.spentInMempool = true; c.spendable = false; }
  }

  summary() {
    const sum = (f) => this.coins.filter(f).reduce((a, c) => a + c.value, 0);
    const pendingChange = this.sent.filter((s) => s.status === 'pending').reduce((a, s) => a + (s.change || 0), 0);
    return {
      scanned: this.scanned, height: this.height, coins: this.coins.length,
      confirmed: sum((c) => !c.spentInMempool),         // on-chain and not being spent
      spendable: sum((c) => c.spendable),
      outgoing: sum((c) => c.spentInMempool),           // being spent by an unconfirmed transaction
      immature: sum((c) => c.immature && !c.spentInMempool),
      pendingChange,                                     // change from this visit's sends, not yet confirmed
      oldFormat: sum((c) => c.spendable && c.entry.group === 'raw'),
    };
  }
  coinList() {
    return this.coins.map((c) => ({ id: outpointOf(c), txid: c.txid, vout: c.vout, value: c.value, confirmations: c.confirmations, height: c.height,
      type: c.entry.type, typeLabel: TYPE_LABEL[c.entry.type] || c.entry.type, group: c.entry.group, address: c.entry.address, path: c.entry.path,
      spendable: c.spendable, spentInMempool: c.spentInMempool, immature: c.immature, coinbase: c.coinbase }))
      .sort((a, b) => b.value - a.value);
  }

  // ---- receiving ----
  receiveTypes() { return this.account.receiveTypes(); }
  setPref(type) {
    if (!this.receiveTypes().includes(type)) throw new Error('unsupported address type');
    this.pref = type; this.meta.pref = type; this._saveMeta();
  }
  receiveIndex(type) { return this.account.kind === 'seed' ? Math.max(this.meta.recv[type] || 0, this._hi(type, 0) + 1) : 0; }
  receive(type = this.pref, index = null) {
    if (!this.receiveTypes().includes(type)) throw new Error('unsupported address type');
    if (this.account.kind !== 'seed') { const e = this.account.entry(type); return { address: e.address, path: e.path, type, index: 0, single: true }; }
    const i = index == null ? this.receiveIndex(type) : index;
    const e = this.account.entry(type, 0, i);
    return { address: e.address, path: e.path, type, index: i, single: false };
  }
  // move on to a fresh address (the user handed the current one out)
  nextReceive(type) {
    if (this.account.kind !== 'seed') return this.receive(type);
    this.meta.recv[type] = Math.min(this.win.max - 1, this.receiveIndex(type) + 1);
    this._saveMeta();
    return this.receive(type);
  }
  changeIndex() { return this.account.kind === 'seed' ? Math.max(this.meta.change[this.pref] || 0, this._hi(this.pref, 1) + 1) : 0; }
  // Once an address has held a coin it is used for good: record that, so the receive and change
  // counters never fall back to it after the coin is spent (the node only reports UNSPENT coins,
  // so without this the wallet would forget the address was ever used and hand it out again).
  _rememberUsed() {
    if (this.account.kind !== 'seed') return;
    let changed = false;
    for (const t of RECEIVE_TYPES) {
      const r = Math.min(this.win.max - 1, this._hi(t, 0) + 1), c = Math.min(this.win.max - 1, this._hi(t, 1) + 1);
      if (r > (this.meta.recv[t] || 0)) { this.meta.recv[t] = r; changed = true; }
      if (c > (this.meta.change[t] || 0)) { this.meta.change[t] = c; changed = true; }
    }
    if (changed) this._saveMeta();
  }

  // ---- privacy report ----
  // What the chain shows about this wallet: its unspent coins plus (fetched one by one from the
  // node, bounded so the API's rate limit is never hit) the transactions that created them.
  async privacy({ feeRate = 10, onProgress = () => {}, maxTx = 30 } = {}) {
    const entries = await this._entries();
    const ourHashes = new Set();
    for (const e of entries) {
      if (e.script.length === 44 && e.script.startsWith('0014')) ourHashes.add(e.script.slice(4));
      else if (e.script.length === 50 && e.script.startsWith('76a914')) ourHashes.add(e.script.slice(6, 46));
    }
    const txs = new Map();
    const byTx = new Map(); for (const c of this.coins) if (c.height != null && c.confirmations > 0 && !byTx.has(c.txid)) byTx.set(c.txid, c);
    const want = this.api.prevTx ? [...byTx.values()].slice(0, maxTx) : [];
    let done = 0;
    for (const c of want) {
      try { txs.set(c.txid, parseTx(await this.api.prevTx(c.txid, c.height))); } catch { /* reported as not looked at */ }
      onProgress(++done, want.length);
    }
    return { ...privacyReport({ kind: this.account.kind, coins: this.coinList(), ourHashes, txs, feeRate }), fetched: txs.size, wanted: want.length, coins: this.coins.length };
  }

  // ---- addresses this wallet can prove it owns (signed messages) ----
  // The entry behind one of this wallet's addresses, or null. Looks through the scanned window.
  async findEntry(address) {
    const a = String(address || '').trim();
    if (!a) return null;
    const entries = await this._entries();
    return entries.find((e) => e.address === a) || null;
  }
  // Addresses worth offering for a signature: the current receive address of each type, and
  // every address currently holding a coin (those are the ones an auditor can see funds on).
  signableAddresses() {
    const out = [], seen = new Set();
    const add = (address, type, note) => { if (address && !seen.has(address)) { seen.add(address); out.push({ address, type, typeLabel: TYPE_LABEL[type] || type, note }); } };
    for (const t of this.receiveTypes()) { const r = this.receive(t); add(r.address, t, this.account.kind === 'seed' ? 'current receive address' : 'this wallet\'s address'); }
    for (const c of [...this.coins].sort((x, y) => y.value - x.value)) if (c.entry.address && c.entry.group !== 'raw') add(c.entry.address, c.entry.type, `holds ${c.value.toLocaleString('en-US')} sats`);
    return out;
  }

  // ---- sending ----
  // Which coins a spend draws from: the caller's selection, else every spendable standard
  // coin, else (a key holding only old-format coins) every spendable old-format coin.
  _pick(coinIds) {
    const spendable = this.coins.filter((c) => c.spendable);
    if (coinIds && coinIds.length) {
      const want = new Set(coinIds);
      const picked = spendable.filter((c) => want.has(outpointOf(c)));
      if (picked.length !== want.size) throw new Error('a selected coin is no longer spendable — refresh and try again');
      return picked;
    }
    const std = spendable.filter((c) => c.entry.group === 'std');
    return std.length ? std : spendable;
  }
  // Build + sign + audit, WITHOUT broadcasting. The result is frozen: broadcast() sends
  // exactly these bytes.
  async prepare({ to, amount = null, sweep = false, feeRate, coinIds = null, message = null, signer = null }) {
    if (this.account.watchOnly && !signer) throw new Error('the wallet is locked — a password is needed to sign');
    if (!this.scanned) throw new Error('the wallet has not finished loading its coins yet');
    const coins = this._pick(coinIds);
    if (!coins.length) throw new Error('no confirmed coins available to spend');
    const changeType = this.pref, changeIndex = this.changeIndex();
    const changeEntry = this.account.changeEntry(changeIndex, changeType);
    const built = await buildSpend({ account: this.account, coins, to: String(to || '').trim(), amount, sweep, feeRate, changeEntry, message, signer,
                                     fetchPrevTx: (txid, height) => this.api.prevTx(txid, height) });
    return { ...built, changeIndex: built.change ? changeIndex : null, changeType, changePath: built.change ? changeEntry.path : null, inTotal: built.sent + built.change + built.fee };
  }
  async broadcast(built) {
    const txid = await this.api.broadcast(built.txHex);
    if (String(txid) !== built.txid) throw new Error(`the node reported a different transaction id (${String(txid).slice(0, 16)}…) than the one this wallet built — check an explorer before retrying`);
    const used = new Set(built.inputs);
    for (const op of used) this.spentLocal.set(op, Date.now());
    for (const c of this.coins) if (used.has(outpointOf(c))) { c.spentInMempool = true; c.spendable = false; }
    if (built.change && this.account.kind === 'seed') { this.meta.change[built.changeType] = Math.min(this.win.max - 1, built.changeIndex + 1); this._saveMeta(); }
    this.sent.unshift({ txid, to: built.to, sent: built.sent, fee: built.fee, change: built.change, inputs: built.inputs, message: built.message, status: 'pending', time: Date.now(), explorer: this.explorer + txid });
    return { txid, explorer: this.explorer + txid };
  }
  // After a refresh: a send whose inputs have left the UTXO set is confirmed; one whose
  // inputs are back and unspent was dropped from the mempool.
  _reconcileSent() {
    const byOp = new Map(this.coins.map((c) => [outpointOf(c), c]));
    for (const s of this.sent) {
      const ins = s.inputs.map((op) => byOp.get(op));
      if (ins.every((c) => !c)) s.status = 'confirmed';
      else if (ins.some((c) => c && !c.spentInMempool)) s.status = 'dropped';
      else s.status = 'pending';
    }
  }
}
