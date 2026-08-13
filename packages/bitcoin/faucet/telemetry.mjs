// Pure telemetry helpers for the read-only dashboard. No I/O here — everything is
// a deterministic function so it can be unit-tested. The dashboard server wires
// these to the actual files / RPC.

// Warning levels for a value against its configured limit. DISPLAY ONLY — these
// never feed back into the breaker's own decision (which uses strict > limit).
export function warningLevel(value, limit, tripped = false) {
  if (tripped) return 'tripped';
  if (!(limit > 0)) return 'normal';
  const r = value / limit;
  if (r >= 1) return 'over';
  if (r >= 0.8) return 'near';
  if (r >= 0.5) return 'elevated';
  return 'normal';
}

// Defensive redaction: strip any key whose NAME looks secret, at any depth. This is
// belt-and-suspenders on top of building the payload from an allowlist — if an
// upstream source ever gains a secret field, it still can't surface. Over-redacting
// a harmless key is acceptable; leaking a secret is not.
const SECRET_KEY = /pass|secret|token|mnemonic|seed|privkey|priv_|xprv|apikey|api_key|cookie|authorization|rpcuser|rpcpassword|credential/i;

// RT-9 — SECONDARY, defence-in-depth value scrubbing. The key-name allowlist above is the
// PRIMARY protection; this only catches a secret that reached a benignly-named field (e.g. a
// token embedded in a future error string). It matches ONLY unmistakable secret SHAPES and
// masks just the matched substring, so surrounding legitimate text stays visible. It is
// deliberately CONSERVATIVE and biased toward under-scrubbing: a bare hex string is NEVER
// treated as secret (txids and block hashes are 64-hex), and addresses / public keys /
// ordinary hashes are left intact. Only clearly-marked private material is masked.
const SECRET_VALUE = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g, // PEM private key blocks
  /\b(?:xprv|yprv|zprv|tprv|uprv|vprv)[1-9A-HJ-NP-Za-km-z]{100,}/g,               // BIP32 extended PRIVATE keys
  /\bnsec1[02-9ac-hj-np-z]{58,}/g,                                                // Nostr secret key (bech32)
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,                                             // Telegram-style bot token id:secret
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._=-]{16,}/gi,                                // HTTP auth credential blobs
];
// Exported for tests: does this string CONTAIN unmistakable secret material?
export function scrubValue(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  for (const re of SECRET_VALUE) out = out.replace(re, '[redacted]');
  return out;
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v);
    return out;
  }
  if (typeof value === 'string') return scrubValue(value);   // RT-9 defence-in-depth
  return value;
}

// Map the breaker's status() into per-metric view rows (value, limit, level).
const METRICS = [
  ['claims', 'maxClaimsPerMin', 'Claims / min'],
  ['sats', 'maxSatsPerMin', 'Sats / min'],
  ['distinctAddrs', 'maxDistinctAddrPerMin', 'Distinct destinations / min'],
  ['utxos', 'maxUtxosPerMin', 'UTXOs / min'],
  ['fee', 'maxFeePerMin', 'Fees (sat) / min'],
  ['failures', 'maxFailuresPerMin', 'Rejected+failed / min'],
];
export function breakerView(status) {
  const s = status || {};
  const m = s.metrics || {}, L = s.limits || {};
  const tripped = !!s.tripped;
  const rows = METRICS.map(([mk, lk, label]) => {
    const value = Number(m[mk] || 0), limit = Number(L[lk] || 0);
    return { key: mk, label, value, limit, level: warningLevel(value, limit, tripped && s.trip && s.trip.metric === mk) };
  });
  return { state: tripped ? 'TRIPPED' : 'RUNNING', tripped, trip: s.trip || null, metrics: rows };
}

// RT-3: the dashboard must NOT fail open to RUNNING when it cannot trust the
// telemetry. Distinguish four states so "can't read state" and "faucet is down"
// never look healthy:
//   UNKNOWN  — telemetry missing/unreadable/unparseable
//   STALE    — telemetry older than staleMs (faucet stopped writing / is down)
//   TRIPPED  — breaker latched
//   RUNNING  — fresh, readable, not tripped
export function dashboardStatus({ readable, ageMs, tripped, ledgerHealthy }, staleMs) {
  if (!readable) return 'UNKNOWN';
  if (ageMs == null || ageMs > staleMs) return 'STALE';
  if (tripped) return 'TRIPPED';
  // RT-2 §24/§25: a claim ledger that is down means payouts are stopped — it must
  // NEVER read as healthy RUNNING.
  if (ledgerHealthy === false) return 'DEGRADED';
  return 'RUNNING';
}

// Heartbeat freshness. `beat` is { t: ms } (or a file mtime in ms). Stale if older
// than staleMs. Returns age + booleans; the dashboard colours from these.
export function heartbeatStatus(beat, staleMs, now) {
  // Accept { t: <ms> } (our bots), { ts: "<ISO>" } (the trading-project heartbeats),
  // or a raw numeric file mtime in ms.
  let t = null;
  if (typeof beat === 'number') t = beat;
  else if (beat && Number(beat.t)) t = Number(beat.t);
  else if (beat && beat.ts) { const p = Date.parse(beat.ts); if (!Number.isNaN(p)) t = p; }
  if (t == null) return { present: false, ageMs: null, stale: true };
  const ageMs = Math.max(0, now - t);
  return { present: true, ageMs, stale: ageMs > staleMs };
}

// Human-friendly compact age, e.g. 3s / 4m / 2h / 1d.
export function humanAge(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.round(s / 60); if (m < 60) return m + 'm';
  const h = Math.round(m / 60); if (h < 48) return h + 'h';
  return Math.round(h / 24) + 'd';
}

// HTML-escape (used only for the rare server-emitted string; the client renders via
// textContent). Kept here so it is covered by the same tests.
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const READONLY_RPC = new Set(['getblockchaininfo', 'getnetworkinfo', 'getmempoolinfo', 'getblockcount', 'uptime']);
