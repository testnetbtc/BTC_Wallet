import { readFileSync, writeFileSync } from 'fs';
const bundle = readFileSync('web/dist/online.bundle.js', 'utf8');
const ui = readFileSync('web/ui.js', 'utf8');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src https://mempool.space https://blockstream.info https://api.olesia.io; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>Olesia Wallet — online (testnet)</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#0e1116;color:#e6edf3}
.wrap{max-width:720px;margin:0 auto;padding:26px 20px 90px}
h1{font-size:28px;margin:0 0 2px}h1 span{color:#f0a020}
.sub{color:#9aa7b4;margin:0 0 16px}
.card{background:#161b22;border:1px solid #2b333c;border-radius:10px;padding:16px;margin:14px 0}
label{display:block;font-weight:600;margin:10px 0 6px}
.hint{color:#9aa7b4;font-size:13px;margin:4px 0}
input,select,textarea{width:100%;padding:9px 11px;background:#0e1116;border:1px solid #2b333c;border-radius:7px;color:#e6edf3;font:inherit;margin-bottom:6px}
textarea{resize:vertical;min-height:64px;font-family:ui-monospace,monospace}
button{background:#f0a020;color:#111;border:0;border-radius:8px;padding:10px 16px;font-weight:700;cursor:pointer;margin:4px 6px 4px 0}
button.sec{background:#2b333c;color:#e6edf3;font-weight:600}
.mono{font-family:ui-monospace,monospace;word-break:break-all}
.row{display:flex;gap:10px;flex-wrap:wrap}.row>div{flex:1;min-width:120px}
.ok{color:#7ee2a8}.bad{color:#ff9ca0}
.warn{background:#2a1e08;border:1px solid #6b4e12;color:#f0cd8a;border-radius:8px;padding:12px;font-size:14px;margin:12px 0}
#addr,#bal,#utxos,#result{background:#0e1116;border:1px solid #2b333c;border-radius:8px;padding:10px;margin:4px 0}
#result{display:none}#recv,#actions{display:none}
a{color:#7ee2a8}
</style></head>
<body><div class="wrap">
<h1>Olesia Wallet<span>.</span></h1>
<p class="sub">Online send / receive — <b>testnet</b>. A companion to the offline generator.</p>

<div class="warn">
<b>Hot wallet — testnet only.</b> Your seed is typed into this page and used to sign in your browser.
It is <b>never stored and never leaves this tab</b>, but a web page is not cold storage. <b>Do not enter a
mainnet seed here.</b> For real funds, generate and sign offline.
</div>

<div class="card">
<label>Network</label>
<select id="net"></select>
<div id="mainwarn" class="warn" style="display:none">⚠ <b>Mainnet.</b> Do <b>not</b> paste a mainnet seed here. Load your <b>account xpub</b> (watch-only), build an unsigned PSBT below, sign it <b>offline</b>, then broadcast the signed PSBT here. Hot send/sweep are disabled on mainnet.</div>
<label>24-word seed <span class="hint">— or an account xpub for watch-only</span></label>
<textarea id="mnemonic" placeholder="word1 word2 … word24   —or—   xpub…/tpub…" autocomplete="off" spellcheck="false"></textarea>
<button id="gen" class="sec">Generate new</button>
<button id="load">Load</button>
<span id="mode" class="hint"></span>
</div>

<div class="card" id="recv">
<label>Wallet label <span class="hint">(optional — saved in this browser only)</span></label>
<input id="label" placeholder="e.g. testnet spending" autocomplete="off">
<label>Receive address</label>
<div id="addr" class="mono"></div>
<img id="qr" alt="receive address QR" style="display:none;margin:8px 0;border-radius:8px">
<p class="hint">Send testnet coin here, then Refresh. Same BIP-84 derivation as the offline Olesia generator.</p>
<label>Balance</label>
<div id="bal" class="mono"></div>
<div id="utxos" class="hint"></div>
<button id="refresh" class="sec">Refresh</button>
<button id="expxpub" class="sec" style="display:none">Show account xpub</button>
<div id="xpubout" class="mono" style="display:none;margin-top:6px"></div>
<label style="margin-top:16px">Recent transactions</label>
<div id="history" class="hint">—</div>
</div>

<div class="card" id="actions">
<label>Send</label>
<div class="row">
<div><input id="to" placeholder="destination address (tb1… or m/n…)" autocomplete="off"></div>
<div><input id="amt" placeholder="amount (sats)" inputmode="numeric"></div>
</div>
<input id="msg" placeholder="optional OP_RETURN message (≤80 bytes)" autocomplete="off">
<div class="row"><div><input id="fee" placeholder="fee rate (sat/vB, default 2)" inputmode="numeric"></div></div>
<button id="dryrun" class="sec">Build (dry run)</button>
<button id="send">Send</button>
<div><span id="hotnote" class="hint"></span></div>

<label style="margin-top:18px;border-top:1px solid #2b333c;padding-top:12px">Sweep (send everything, minus fee)</label>
<input id="sweepto" placeholder="destination address for the full balance" autocomplete="off">
<button id="sweepdry" class="sec">Build sweep</button>
<button id="sweep">Sweep all</button>

<div id="result" class="mono" style="margin-top:12px"></div>
</div>

<div class="card" id="airgap" style="display:none">
<label>Air-gap / PSBT tools <span class="hint">— the mainnet-safe path</span></label>
<p class="hint">Watch-only online: <b>Build unsigned</b> here (fills from the Send fields above) → sign it <b>offline</b> → <b>Broadcast signed</b> here. The seed never needs to be online.</p>
<button id="buildunsigned" class="sec">Build unsigned PSBT (from Send fields)</button>
<textarea id="unsignedout" placeholder="unsigned PSBT (base64) — copy to your offline signer" readonly></textarea>
<label style="margin-top:12px">Sign a PSBT <span class="hint">(needs the seed — run this page offline for mainnet)</span></label>
<textarea id="signin" placeholder="paste an unsigned PSBT (base64)" autocomplete="off" spellcheck="false"></textarea>
<button id="signbtn" class="sec">Sign PSBT</button>
<textarea id="signedout" placeholder="signed PSBT (base64) appears here" readonly></textarea>
<label style="margin-top:12px">Broadcast a signed PSBT</label>
<textarea id="bcin" placeholder="paste a signed PSBT (base64)" autocomplete="off" spellcheck="false"></textarea>
<button id="bcbtn">Broadcast signed PSBT</button>
<div id="agresult" class="mono" style="display:none;margin-top:10px"></div>
</div>

<div style="margin-top:10px"><span id="status" class="hint"></span></div>
<p class="hint" style="margin-top:20px">Balances/broadcast via mempool.space. No analytics, no storage. Source: the <code>packages/bitcoin</code> module, signing with <code>@scure/btc-signer</code>.</p>
</div>
<script>${bundle}</script>
<script>${ui}</script>
</body></html>`;
writeFileSync('web/index.html', html);
console.log('web/index.html bytes:', html.length);
