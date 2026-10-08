// Assemble the mainnet wallet into ONE self-contained index.html (bundle + UI inline, no
// external resources). build.mjs then pins the inline scripts by hash in the CSP.
import { readFileSync, writeFileSync } from 'fs';
const bundle = readFileSync('mainnet/dist/mainnet.bundle.js', 'utf8');
const ui = readFileSync('mainnet/ui.js', 'utf8');
const icon = 'data:image/png;base64,' + readFileSync('web/olesia-icon.png').toString('base64');
const connect = process.env.OLESIA_API_BASE || 'https://api.olesia.io';
// IBM Plex (SIL OFL), latin subset, embedded so the page never loads a font from a server.
const font = (f) => 'data:font/woff2;base64,' + readFileSync('mainnet/fonts/' + f).toString('base64');
const fontRange = readFileSync('mainnet/fonts/unicode-range.txt', 'utf8').trim();
const svg = (d) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const IC = {
  recv: svg('<path d="M12 4v14"/><path d="M6 12l6 6 6-6"/><path d="M5 21h14"/>'),
  send: svg('<path d="M12 20V6"/><path d="M6 12l6-6 6 6"/><path d="M5 3h14"/>'),
  refresh: svg('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>'),
  wallet: svg('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.2"/>'),
  layers: svg('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
  drop: svg('<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  file: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'),
  imp: svg('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>'),
  star: svg('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z"/>'),
  dl: svg('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>'),
  cpu: svg('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
  cloud: svg('<path d="M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9H7z"/>'),
};
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src ${connect}; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>Olesia — Bitcoin wallet</title>
<meta name="description" content="Olesia: a non-custodial Bitcoin mainnet wallet that runs in your browser. Your keys stay on your computer in an encrypted wallet file.">
<meta name="theme-color" content="#171717">
<link rel="icon" href="${icon}">
<style>
@font-face{font-family:'IBM Plex Sans';font-style:normal;font-weight:100 700;font-display:swap;src:url(${font('IBMPlexSans-var-latin.woff2')}) format('woff2');unicode-range:${fontRange}}
@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:500;font-display:swap;src:url(${font('IBMPlexMono-500-latin.woff2')}) format('woff2');unicode-range:${fontRange}}
:root{--bg:#171717;--panel:#111111;--surface:#222222;--line:#3a3a3a;--line-soft:#2e2e2e;--text:#f4f4f4;--muted:#b3b3b3;--faint:#8f8f8f;
--accent:#ff6a00;--accent-ink:#171717;--accent-text:#ff8a33;--mint:#62d98a;--bad:#ff8f8f;--violet:#a99bff;--r:8px;
--sans:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--mono:'IBM Plex Mono',ui-monospace,"SF Mono",Menlo,Consolas,monospace;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font:15px/1.5 var(--sans);color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
#shell{max-width:600px;margin:0 auto;padding:0 16px 110px}
header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 0 12px;flex-wrap:wrap}
.logo{font-weight:700;font-size:22px;letter-spacing:-.01em}
.ldot{color:var(--accent)}
.hbtns{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:6px 10px;font-size:12px;font-weight:600;color:var(--muted);font-family:inherit;min-height:0}
.chip .sw{width:8px;height:8px;border-radius:50%;background:var(--faint)}
.chip.ok .sw{background:var(--mint)}.chip.warn .sw{background:var(--accent)}.chip.err .sw{background:var(--bad)}
button.chip{cursor:pointer}
.chip.main{color:var(--text)}.chip.main .sw{background:var(--accent)}.chip.main.test .sw{background:var(--violet)}
button.chip.price{color:var(--text);font-variant-numeric:tabular-nums}
button.chip.price .up{color:var(--mint)}button.chip.price .down{color:var(--bad)}
.pane{display:none}.pane.on{display:block}
h2{font-size:21px;font-weight:600;letter-spacing:-.01em;margin:8px 0 4px}
h3{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:20px 0 8px;font-weight:600}
.sub{color:var(--muted);font-size:13.5px;margin:0 0 14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:15px;margin:0 0 12px}
label{display:block;font-weight:600;margin:12px 0 6px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.card>label:first-child{margin-top:0}
label.inline{display:flex;align-items:flex-start;gap:9px;font-weight:400;font-size:13.5px;letter-spacing:0;text-transform:none;color:var(--text);cursor:pointer}
label.inline input{width:auto;margin:3px 0 0;flex:0 0 auto;accent-color:var(--accent)}
.hint{color:var(--muted);font-size:12.5px;margin:4px 0}
.mono{font-family:var(--mono);word-break:break-all;font-size:13px}
code{font-family:var(--mono);font-size:.92em}
input,select,textarea{width:100%;padding:11px 12px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);color:var(--text);font-family:inherit;font-size:16px;margin-bottom:6px}
input:focus,select:focus,textarea:focus,button:focus-visible{outline:2px solid var(--accent-text);outline-offset:1px}
input[type=file]{font-size:14px;padding:9px}
textarea{resize:vertical;min-height:76px;font-family:var(--mono);font-size:14px}
button{background:var(--accent);color:var(--accent-ink);border:0;border-radius:var(--r);padding:11px 16px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;min-height:44px}
button.sec{background:var(--surface);border:1px solid #4a4a4a;color:var(--text)}
button.sec:hover{border-color:var(--accent-text)}
button.wide{width:100%}
button.small{font-size:12px;padding:6px 12px;min-height:0}
button:disabled{opacity:.45;cursor:default}
.back{background:none;border:0;color:var(--accent-text);font-weight:600;font-size:13.5px;padding:6px 0;min-height:0}
.ok{color:var(--mint)}.bad{color:var(--bad)}
.row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1}
.warn{background:#2b1d0c;border:1px solid #6b4416;color:#ffcf99;border-radius:var(--r);padding:11px 13px;font-size:13px;margin:10px 0}
.warn b{color:#ffe0bd}
.danger{background:#331616;border:1px solid #6e2626;color:#ffb0b0;border-radius:var(--r);padding:11px 13px;font-size:13px;margin:10px 0}
.note{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:11px 13px;font-size:13px;color:var(--muted);margin:10px 0}
.note b{color:var(--text)}
a{color:var(--accent-text)}
.choice{display:flex;align-items:center;gap:14px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px;margin-bottom:10px;cursor:pointer;width:100%;text-align:left;color:var(--text);font-weight:400;min-height:0}
.choice:hover{border-color:var(--accent-text)}
.choice .ic{width:44px;height:44px;border-radius:var(--r);background:var(--panel);border:1px solid var(--line);display:grid;place-items:center;flex:0 0 auto;color:var(--accent-text)}
.choice b{display:block;font-size:15.5px;font-weight:600}.choice span{font-size:12.5px;color:var(--muted)}
.choice.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.choice.primary span{color:#3d1c00}.choice.primary .ic{background:rgba(23,23,23,.14);border:0;color:var(--accent-ink)}
.seg{display:flex;gap:8px;margin:4px 0 10px}
.seg button{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--text);font-weight:600;font-size:13px;min-height:44px;padding:8px 6px}
.seg button.on{background:#2b1a0c;border-color:var(--accent);color:var(--accent-text)}
#pad{position:relative;height:150px;background:var(--panel);border:1px dashed #555;border-radius:var(--r);display:grid;place-items:center;color:var(--faint);font-size:13.5px;touch-action:none;cursor:crosshair;user-select:none;overflow:hidden;text-align:center;padding:0 12px}
#pad.done{border-color:#2f7a4b;color:var(--mint)}
.bar{height:6px;background:var(--panel);border:1px solid var(--line);border-radius:3px;overflow:hidden;margin:8px 0 4px}
.bar i{display:block;height:100%;width:0%;background:var(--accent);transition:width .12s}
.seedgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin:10px 0}
@media(max-width:460px){.seedgrid{grid-template-columns:1fr 1fr}}
.seedgrid span{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:8px 10px;font-family:var(--mono);font-size:13.5px}
.seedgrid span i{color:var(--faint);font-style:normal;margin-right:7px;font-size:10.5px}
.qrow{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.qrow span{flex:0 0 78px;font-size:13px;font-weight:600;color:var(--muted)}
.qrow input{margin:0;font-family:var(--mono)}
.hero{background:var(--surface);border:1px solid var(--line);border-top:3px solid var(--accent);border-radius:var(--r);padding:18px 18px 14px;margin:6px 0 12px}
.hero.test{border-top-color:var(--violet)}
.hero .lbl{font-size:11px;letter-spacing:.09em;font-weight:600;color:var(--muted);text-transform:uppercase;display:flex;align-items:center;gap:8px}
.bal{font-family:var(--mono);font-size:30px;font-weight:500;letter-spacing:-.02em;margin:6px 0 2px;font-variant-numeric:tabular-nums}
.bal .u{font-size:15px;margin-left:6px;color:var(--muted)}
.balsub{font-size:12.5px;color:var(--muted);min-height:18px}
.acts{display:flex;gap:8px;margin-bottom:14px}
.acts button{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-height:62px;padding:8px 6px}
.coin{display:flex;align-items:flex-start;gap:10px;padding:11px 0;border-top:1px solid var(--line-soft);font-size:13px}
.coin:first-child{border-top:0;padding-top:2px}
.coin input{width:auto;margin:3px 0 0;accent-color:var(--accent)}
.coin .m{flex:1;min-width:0}
.coin .a{font-family:var(--mono);font-weight:500;font-variant-numeric:tabular-nums}
.coin .d{font-size:11.5px;color:var(--faint);word-break:break-all;font-family:var(--mono)}
.tag{display:inline-block;font-family:var(--sans);font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;padding:2px 7px;border-radius:4px;background:#2c2c2c;color:#cfcfcf;border:1px solid var(--line);margin-left:6px;vertical-align:middle}
.tag.bad{color:var(--bad);border-color:#6e2626;background:#331616}.tag.okk{color:var(--mint);border-color:#2f7a4b;background:#14301f}
.tag.real{color:#ffb37a;border-color:#6b4416;background:#3a2208}
.netrow{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:14px;margin-bottom:10px;color:var(--text);font-weight:400;min-height:0}
.netrow:hover{border-color:var(--accent-text)}
.netrow.on{border-color:var(--accent)}
.netrow .dot{width:12px;height:12px;border-radius:50%;flex:0 0 auto;background:var(--violet)}
.netrow .dot.main{background:var(--accent)}
.netrow .m{flex:1;min-width:0}
.netrow .n{font-size:15.5px;font-weight:600;display:flex;align-items:center;flex-wrap:wrap;gap:2px}
.netrow .s{font-size:12px;color:var(--muted)}
.netrow .v{font-family:var(--mono);font-size:14px;text-align:right;color:var(--text)}
.netrow .v small{display:block;font-family:var(--sans);font-size:11px;color:var(--muted)}
.steps{display:flex;flex-direction:column;gap:12px;margin:14px 2px}
.step{display:flex;gap:12px;align-items:flex-start;font-size:13px;color:var(--muted)}
.step i{flex:0 0 26px;height:26px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-size:12px;font-weight:600;background:#2c2c2c;color:var(--text);border:1px solid var(--line)}
.step b{display:block;color:var(--text);font-size:14px;font-weight:600}
a.btn{display:flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:var(--accent-ink);border-radius:var(--r);padding:12px 16px;font-size:15px;font-weight:600;text-decoration:none;min-height:48px}
a.btn.off{opacity:.45;pointer-events:none}
.qrbox{display:inline-block;background:#eef2f6;padding:12px;border-radius:var(--r);margin:6px 0 12px;line-height:0}
.qrbox img{width:190px;height:190px;display:block}
#confirm,#pwsheet{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.72);display:none;align-items:flex-end;justify-content:center}
#pwsheet{z-index:80}
#confirm.on,#pwsheet.on{display:flex}
.sheet{width:100%;max-width:600px;max-height:92vh;overflow:auto;background:var(--surface);border:1px solid var(--line);border-top:3px solid var(--accent);border-bottom:0;border-radius:12px 12px 0 0;padding:20px}
.sheet h3{margin:0 0 6px;font-size:18px;text-transform:none;letter-spacing:0;color:var(--text)}
.crow{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid var(--line-soft);font-size:13.5px}
.crow .k{color:var(--muted);flex:0 0 auto}
.crow .v{text-align:right;word-break:break-all;font-variant-numeric:tabular-nums}
.crow .v small{display:block;color:var(--faint);font-size:11.5px}
#toast{pointer-events:none;position:fixed;left:50%;transform:translateX(-50%);top:14px;width:max-content;max-width:min(92vw,540px);background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:10px 15px;font-size:13px;z-index:90;display:none;box-shadow:0 12px 30px -12px #000}
#toast.ok{border-color:#2f7a4b;color:var(--mint)}#toast.bad{border-color:#6e2626;color:var(--bad)}
#tabbar{position:fixed;left:0;right:0;bottom:0;z-index:40;background:var(--panel);border-top:1px solid var(--line);display:flex;justify-content:center}
#tabbar .in{display:flex;width:100%;max-width:600px;padding:4px 8px calc(6px + env(safe-area-inset-bottom))}
#tabbar button{flex:1;background:none;border:0;color:var(--muted);font-size:11.5px;font-weight:400;display:flex;flex-direction:column;align-items:center;gap:3px;min-height:52px;padding:6px 0}
#tabbar button.on{color:var(--accent-text);font-weight:600}
footer{margin-top:26px;color:var(--faint);font-size:12px;line-height:1.6}
footer a{color:var(--muted)}
.hide{display:none!important}
.vin{display:flex;align-items:stretch;margin-bottom:6px}
.vin .fx{display:flex;align-items:center;padding:0 10px;background:#1c1c1c;border:1px solid var(--line);border-right:0;border-radius:var(--r) 0 0 var(--r);font-family:var(--mono);font-size:16px;color:var(--muted);white-space:nowrap}
.vin input{margin:0;border-radius:0 var(--r) var(--r) 0;font-family:var(--mono)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 2px}
.chips button{background:var(--panel);border:1px solid var(--line);color:var(--text);font-family:var(--mono);font-size:13px;font-weight:500;padding:7px 11px;min-height:0;border-radius:var(--r)}
.chips button:hover{border-color:var(--accent-text)}
.chips button small{display:block;font-family:var(--sans);font-size:11px;color:var(--muted);font-weight:400}
.est{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
@media(max-width:460px){.est{grid-template-columns:1fr}}
.est div{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:10px 12px}
.est .k{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600}
.est .v{font-family:var(--mono);font-size:17px;margin-top:2px}
.est .s{font-size:12px;color:var(--muted)}
.addr{font-family:var(--mono);font-size:17px;word-break:break-all;line-height:1.4;padding:12px 14px;background:var(--panel);border:1px solid #2f7a4b;border-radius:var(--r);margin:8px 0}
.addr b{color:var(--accent-text);font-weight:500}
.stat{display:flex;justify-content:space-between;gap:10px;font-size:13px;color:var(--muted);margin:6px 0;flex-wrap:wrap}
.stat span b{color:var(--text);font-family:var(--mono);font-weight:500}
</style></head>
<body><div id="shell">
<header>
  <div class="logo">Olesia<span class="ldot">.</span></div>
  <div class="hbtns">
    <button class="chip main" id="netbtn" type="button" title="The network this wallet is showing. Tap to switch."><span class="sw"></span><span id="netname">Bitcoin mainnet</span></button>
    <button class="chip price hide" id="chip_price" type="button" title="Bitcoin price and 24-hour change. Tap to change currency."><span id="price_v"></span><span id="price_c"></span></button>
    <span class="chip" id="chip_node" style="min-width:150px"><span class="sw"></span><span id="chip_node_t">node…</span></span>
    <button class="sec small hide" id="lockbtn" type="button">Lock</button>
  </div>
</header>
<div id="selfcheck" class="danger hide"></div>

<!-- ===================== WELCOME ===================== -->
<section class="pane on" id="pane-welcome">
  <h2>Your Bitcoin wallet</h2>
  <p class="sub">Your keys are created on this computer and stay on it, inside an encrypted wallet file that only you hold.</p>
  <button class="choice primary" id="w_create" type="button"><span class="ic">${IC.plus}</span><span><b>Create a new wallet</b><span>12 or 24 words · your own randomness mixed in</span></span></button>
  <button class="choice" id="w_open" type="button"><span class="ic">${IC.file}</span><span><b>Open a wallet file</b><span>Load your encrypted <code>.dat</code> file and enter its password</span></span></button>
  <button class="choice" id="w_import" type="button"><span class="ic">${IC.imp}</span><span><b>Import a wallet</b><span>Recovery phrase (12 or 24 words) or a private key (WIF)</span></span></button>
  <button class="choice" id="w_vanity" type="button"><span class="ic">${IC.star}</span><span><b>Create a vanity address</b><span>An address that starts with characters you choose · <code>bc1qjon…</code></span></span></button>
  <div class="warn"><b>This is a hot wallet for real bitcoin.</b> Keep here only an amount you could afford to lose. Olesia cannot recover a lost password or recovery phrase — nobody can. No independent security firm has audited this software.</div>
</section>

<!-- ===================== CREATE 1: entropy ===================== -->
<section class="pane" id="pane-create1">
  <button class="back" data-go="welcome" type="button">‹ Back</button>
  <h2>Create a wallet</h2>
  <p class="sub">A wallet is a very large secret number. It is made here, on your device, from randomness.</p>
  <div class="card">
    <label>Recovery phrase length</label>
    <div class="seg" id="c_len"><button type="button" data-words="24" class="on">24 words · 256-bit</button><button type="button" data-words="12">12 words · 128-bit</button></div>
    <p class="hint">Both are considered safe. 24 words is the stronger choice and the default.</p>
    <label>Address type</label>
    <div class="seg" id="c_type"><button type="button" data-type="p2wpkh" class="on">SegWit · bc1…</button><button type="button" data-type="p2pkh">Legacy · 1…</button></div>
    <p class="hint">SegWit is the modern standard with lower fees. Choose Legacy only if you must receive from very old software. You can switch later.</p>
  </div>
  <div class="card">
    <label>1 · System randomness <span class="ok" style="font-weight:500">— automatic</span></label>
    <p class="hint">256 bits are drawn from your device's cryptographic random number generator the moment you press Generate. <b style="color:var(--text)">This is what makes the wallet strong.</b> The steps below are mixed in on top — they can only add, never weaken.</p>
    <p class="hint" id="rngmsg"></p>
  </div>
  <div class="card">
    <label>2 · Move your mouse</label>
    <p class="hint">Move the pointer around inside the box (on a phone, drag a finger). The positions and timings are hashed into your wallet together with the system randomness.</p>
    <div id="pad"><span id="padhint">move your mouse in here</span></div>
    <div class="bar"><i id="padbar"></i></div>
    <p class="hint" id="padmsg">0% collected</p>
    <label class="inline"><input type="checkbox" id="padskip"><span>Skip this step — use system randomness only</span></label>
  </div>
  <div class="card">
    <label>3 · Dice rolls <span style="color:var(--muted);font-weight:500">— optional</span></label>
    <p class="hint">Roll a real die and type each result (1–6). Dice are randomness you can see and that no software can influence.</p>
    <textarea id="dice" autocomplete="off" spellcheck="false" placeholder="4 2 6 1 3 5 2 6 …"></textarea>
    <p class="hint" id="dicemsg">no rolls entered</p>
    <label class="inline"><input type="checkbox" id="diceonly"><span>Use <b>only</b> my dice — no computer randomness at all (needs <span id="diceneed">99</span> rolls; you can reproduce the result by hand with SHA-256)</span></label>
  </div>
  <button class="wide" id="c_gen" type="button" disabled>Move your mouse to continue</button>
</section>

<!-- ===================== CREATE 2: words ===================== -->
<section class="pane" id="pane-create2">
  <button class="back" id="c_back2" type="button">‹ Start again</button>
  <h2>Write these words down</h2>
  <p class="sub">On paper, in order. These words <b>are</b> the wallet: anyone who has them can spend the funds, and they can restore the wallet in any standard Bitcoin software if you ever lose your file or password.</p>
  <div class="seedgrid" id="c_words"></div>
  <p class="hint" id="c_sources"></p>
  <div class="danger">Never photograph the words, store them in a cloud note, or type them into any other website. Nobody from Olesia will ever ask for them.</div>
  <label class="inline"><input type="checkbox" id="c_wrote"><span>I have written all the words down on paper, in order.</span></label>
  <button class="wide" id="c_next2" type="button" disabled style="margin-top:12px">Continue</button>
</section>

<!-- ===================== CREATE 3: quiz ===================== -->
<section class="pane" id="pane-create3">
  <button class="back" id="c_back3" type="button">‹ See the words again</button>
  <h2>Check your paper</h2>
  <p class="sub">Type the requested words from your <b>paper</b> copy.</p>
  <div class="card" id="q_box"></div>
  <button class="wide" id="q_check" type="button">Check</button>
</section>

<!-- ===================== SAVE: encrypt to .dat ===================== -->
<section class="pane" id="pane-save">
  <button class="back" id="s_back" type="button">‹ Cancel</button>
  <h2 id="s_title">Save your wallet file</h2>
  <p class="sub" id="s_sub"></p>
  <div class="card" id="s_passbox">
    <label>Passphrase <span style="color:var(--muted);font-weight:500">— optional</span></label>
    <p class="hint">An extra secret of your choosing, added on top of your words (the BIP-39 "25th word"). With it, the words alone are not enough to spend — someone would need the passphrase too.</p>
    <label class="inline"><input type="checkbox" id="s_usepass"><span>Protect this wallet with a passphrase</span></label>
    <div id="s_passfields" class="hide">
      <div class="danger" style="margin-top:8px">If you forget this passphrase or mistype it later, the funds are gone. It cannot be reset or recovered by anyone. Write it down and keep it apart from your words.</div>
      <div class="row"><input id="s_pass" type="password" autocomplete="off" spellcheck="false" placeholder="passphrase"><input id="s_pass2" type="password" autocomplete="off" spellcheck="false" placeholder="confirm passphrase"></div>
    </div>
  </div>
  <div class="card hide" id="s_storebox">
    <label class="inline"><input type="checkbox" id="s_storepass"><span>Also store the passphrase inside the encrypted wallet file. Off (recommended): you type it each time you open the wallet, so a stolen file and password are still not enough.</span></label>
  </div>
  <div class="card">
    <label>File password</label>
    <p class="hint">Anyone who copies this file can try to guess its password offline for as long as they like, so the password must be strong. The generator makes one for you — <b style="color:var(--text)">write it down</b>.</p>
    <button class="sec wide" id="s_gen" type="button">Generate a strong password (6 random words)</button>
    <input id="s_pw" type="password" autocomplete="new-password" spellcheck="false" placeholder="password" style="margin-top:8px">
    <input id="s_pw2" type="password" autocomplete="new-password" spellcheck="false" placeholder="confirm password">
    <button class="sec small" id="s_show" type="button">Show</button>
    <p class="hint" id="s_policy"></p>
  </div>
  <button class="wide" id="s_go" type="button" disabled>Encrypt &amp; download wallet file</button>
  <div class="bar hide" id="s_progbar"><i id="s_prog"></i></div>
  <div class="note hide" id="s_done"></div>
  <button class="wide hide" id="s_open" type="button" style="margin-top:8px">Open my wallet</button>
  <button class="sec wide hide" id="s_again" type="button" style="margin-top:8px">Download the file again</button>
</section>

<!-- ===================== OPEN ===================== -->
<section class="pane" id="pane-open">
  <button class="back" data-go="welcome" type="button">‹ Back</button>
  <h2>Open a wallet file</h2>
  <p class="sub">Choose your Olesia wallet file. It is read and decrypted on this computer — it is never uploaded.</p>
  <div class="card">
    <label>Wallet file</label>
    <input id="o_file" type="file" accept=".dat,.json,application/octet-stream,application/json">
    <p class="hint" id="o_info"></p>
    <label>Password</label>
    <input id="o_pw" type="password" autocomplete="off" spellcheck="false" placeholder="file password">
    <div id="o_passrow" class="hide">
      <label>Wallet passphrase</label>
      <p class="hint">This wallet is protected by a passphrase that is not stored in the file. Enter it exactly.</p>
      <input id="o_pass" type="password" autocomplete="off" spellcheck="false" placeholder="passphrase">
    </div>
    <button class="wide" id="o_go" type="button">Open wallet</button>
    <div class="bar hide" id="o_progbar"><i id="o_prog"></i></div>
    <p class="hint" id="o_msg"></p>
  </div>
</section>

<!-- ===================== IMPORT ===================== -->
<section class="pane" id="pane-import">
  <button class="back" data-go="welcome" type="button">‹ Back</button>
  <h2>Import a wallet</h2>
  <div class="seg" id="i_mode"><button type="button" data-mode="seed" class="on">Recovery phrase</button><button type="button" data-mode="wif">Private key (WIF)</button></div>
  <div class="card" id="i_seedbox">
    <label>Recovery phrase</label>
    <textarea id="i_phrase" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="12, 15, 18, 21 or 24 words"></textarea>
    <label>BIP-39 passphrase <span style="color:var(--muted);font-weight:500">— only if this wallet has one</span></label>
    <input id="i_pass" type="password" autocomplete="off" spellcheck="false" placeholder="leave blank if unsure">
    <p class="hint">New addresses will be SegWit (bc1…) or Legacy (1…). Coins this phrase already holds on other standard address types are still found and can be spent.</p>
  </div>
  <div class="card hide" id="i_wifbox">
    <label>Private key (WIF)</label>
    <input id="i_wif" type="password" autocomplete="off" spellcheck="false" placeholder="starts with K, L or 5">
    <p class="hint">A single key from a paper wallet or older software. Keys starting with <b>5</b> (uncompressed) are supported.</p>
  </div>
  <div class="warn">Typing a recovery phrase or private key into a web page makes it a <b>hot</b> wallet. Only do this on a computer you trust, and only for amounts you could afford to lose. Next you will choose a password and save the wallet as an encrypted file.</div>
  <button class="wide" id="i_go" type="button">Continue</button>
  <p class="hint bad" id="i_msg"></p>
</section>

<!-- ===================== WALLET ===================== -->
<section class="pane" id="pane-wallet">
  <div class="hero" id="hero">
    <div class="lbl"><span>Balance</span><span class="tag hide" id="testtag">practice coins · no value</span></div>
    <div class="bal"><span id="bal">—</span><span class="u" id="bal_unit">BTC</span></div>
    <div class="balsub" id="bal_fiat"></div>
    <div class="balsub" id="bal_sub"></div>
    <div id="scanbox" class="hide"><div class="bar"><i id="scanbar"></i></div><div class="balsub" id="scanmsg"></div></div>
  </div>
  <div class="acts"><button id="a_recv" type="button">${IC.recv}<span>Receive</span></button><button id="a_send" type="button">${IC.send}<span>Send</span></button><button class="sec" id="a_refresh" type="button">${IC.refresh}<span>Refresh</span></button></div>
  <div class="note hide" id="oldfmt"></div>
  <h3>Coins <span id="coins_n" style="text-transform:none;letter-spacing:0;font-weight:400"></span></h3>
  <div class="card" id="coins"><p class="hint">Loading…</p></div>
  <p class="hint" id="coins_hint">Tick coins to spend only those. With none ticked, Send uses all spendable coins.</p>
  <h3 id="act_h" class="hide">Sent in this session</h3>
  <div class="card hide" id="activity"></div>
  <p class="hint" id="w_hint"></p>
</section>

<!-- ===================== NETWORKS ===================== -->
<section class="pane" id="pane-networks">
  <h2>Your wallets</h2>
  <p class="sub" id="net_sub">One recovery phrase, four networks.</p>
  <div id="netlist"></div>
  <p class="hint">Practice wallets come from the same words on a separate path, so trying things out never touches your real coins. Practice coins have no value. Their balances are looked up through a public data service relayed by the Olesia server — not through the Olesia Bitcoin node, which is mainnet only.</p>
</section>

<!-- ===================== FAUCET ===================== -->
<section class="pane" id="pane-faucet">
  <h2>Faucet</h2>
  <p class="sub">Free practice coins, so you can try sending and receiving with nothing at stake.</p>
  <div id="f_body">
    <div class="seg" id="f_nets"></div>
    <div class="card">
      <label>Your <span id="f_netname">Testnet 4</span> address</label>
      <div class="mono" id="f_addr" style="font-size:14px;margin-bottom:12px"></div>
      <a class="btn" id="f_go" href="#" target="_blank" rel="noopener noreferrer">${IC.drop}<span>Get test coins</span></a>
      <p class="hint" style="margin-top:10px">This opens the Olesia faucet in a new tab with your address filled in. It runs a quick human check, then sends the coins.</p>
    </div>
    <div class="steps">
      <div class="step"><i>1</i><div><b>Claim</b>The faucet sends coins to the address above.</div></div>
      <div class="step"><i>2</i><div><b>Come back and refresh</b>They show in your practice wallet within moments, and can be spent after one confirmation.</div></div>
      <div class="step"><i>3</i><div><b>Practise</b>Send them, add a message, try a fee. Mistakes cost nothing.</div></div>
    </div>
    <button class="sec wide" id="f_open" type="button">Open this practice wallet</button>
  </div>
  <div class="note hide" id="f_none">Practice wallets and the faucet need a wallet made from a recovery phrase. This wallet is a single private key, which only exists on Bitcoin mainnet.</div>
</section>

<!-- ===================== SETTINGS ===================== -->
<section class="pane" id="pane-settings">
  <h2>Settings</h2>
  <h3>Wallet</h3>
  <div class="card">
    <div class="crow"><span class="k">Type</span><span class="v" id="w_kind"></span></div>
    <div class="crow"><span class="k">Fingerprint</span><span class="v mono" id="w_fp"></span></div>
    <div class="crow" style="border-bottom:0"><span class="k">Data source</span><span class="v" id="w_source">Olesia node · block <span id="w_height">—</span></span></div>
    <div class="row" style="margin-top:10px"><button class="sec" id="a_savefile" type="button">Download wallet file</button><button class="sec" id="a_reveal" type="button">Show recovery phrase</button></div>
    <div id="reveal_box" class="hide"><div class="seedgrid" id="reveal_words"></div><p class="mono hide" id="reveal_wif"></p><p class="hint" id="reveal_note"></p></div>
    <p class="hint" style="margin-top:10px">This wallet is held <b style="color:var(--text)">encrypted</b> while it is open. Your password is asked for each time a payment is signed or the secret is shown.</p>
  </div>
  <h3>Address search</h3>
  <div class="card" id="deeper_row">
    <p class="hint" id="depth" style="margin-top:0"></p>
    <button class="sec wide" id="a_deeper" type="button">Search more addresses</button>
    <p class="hint">Use this if you restored a heavily used wallet and coins seem to be missing.</p>
  </div>
  <h3>More</h3>
  <button class="sec wide" id="set_vanity" type="button" style="margin-bottom:10px">Create a vanity address</button>
  <button class="sec wide" id="set_lock" type="button">Lock wallet</button>
</section>

<!-- ===================== VANITY ===================== -->
<section class="pane" id="pane-vanity">
  <button class="back" id="v_back" type="button">‹ Back</button>
  <h2>Create a vanity address</h2>
  <p class="sub">A vanity address is a normal address that happens to start with characters you chose, like <code>bc1qjon…</code>. There is no shortcut: keys are generated at random until one fits. <b>The key is made on your device and is never sent anywhere.</b></p>
  <div class="card">
    <label>Address type</label>
    <div class="seg" id="v_type"><button type="button" data-type="p2wpkh" class="on">SegWit · bc1q…</button><button type="button" data-type="p2pkh">Legacy · 1…</button></div>
    <p class="hint" id="v_typehint">SegWit is the modern standard: lower fees, and each character is only 32× harder than the last (Legacy: 58×). Always lower-case.</p>
    <label>The characters you want</label>
    <div class="vin"><span class="fx" id="v_fixed">bc1q</span><input id="v_text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="12" placeholder="jon"></div>
    <p class="hint" id="v_alpha"></p>
    <label class="inline hide" id="v_icrow"><input type="checkbox" id="v_ic"><span>Any capitalisation is fine (<code>1jon</code>, <code>1JON</code>, <code>1Jon</code>…) — usually much easier</span></label>
  </div>
  <div class="card" id="v_status">
    <div class="danger hide" id="v_errors"></div>
    <div id="v_notes"></div>
    <div id="v_suggwrap" class="hide"><p class="hint" style="margin:6px 0 0">Nearest possible versions — tap one:</p><div class="chips" id="v_sugg"></div></div>
    <div id="v_okwrap" class="hide">
      <div class="stat"><span>Looking for <b id="v_display"></b></span><span>about 1 in <b id="v_diff"></b> keys</span></div>
      <div class="est">
        <div><div class="k">In this browser</div><div class="v" id="v_est_here">measuring…</div><div class="s" id="v_est_here_s"></div></div>
        <div><div class="k">Offline script</div><div class="v" id="v_est_script"></div><div class="s">on a computer with <select id="v_cores" style="width:auto;padding:2px 6px;font-size:12px;margin:0;display:inline"><option>4</option><option selected>8</option><option>16</option><option>32</option></select> CPU threads</div></div>
      </div>
      <p class="hint" style="margin-top:8px">Expected times. The search is random: half of all runs finish sooner, 95% within 3× the expected time, and one run in 150 takes longer than 5×.</p>
    </div>
  </div>

  <div id="v_choose" class="hide">
    <h3>How to run it</h3>
    <button class="choice primary" id="v_pick_script" type="button"><span class="ic">${IC.dl}</span><span><b>Offline script — recommended</b><span>Download one small file and run it on your own computer, disconnected. Safest, and uses all your CPU.</span></span></button>
    <button class="choice" id="v_pick_browser" type="button"><span class="ic">${IC.cpu}</span><span><b>In this browser</b><span>Starts right here. Fine for short patterns — keep this tab open and the device plugged in.</span></span></button>
    <button class="choice" id="v_pick_server" type="button"><span class="ic">${IC.cloud}</span><span><b>Let the Olesia server search</b><span>Split-key: your browser keeps a secret, the server only gets a public key and can never learn your private key. Shared and queued.</span></span></button>
  </div>

  <div id="v_server" class="hide">
    <h3>Olesia server · split-key</h3>
    <div class="card">
      <p class="hint" style="margin-top:0"><b style="color:var(--text)">How it stays safe.</b> Your browser makes a secret number and sends the server only the matching <i>public</i> key. The server searches for an offset that makes the address start with your text and sends the offset back. Your browser adds the offset to its secret — that sum is your private key. The server never had the secret, so it cannot compute or steal the key, and your browser checks the answer before accepting it.</p>
      <div class="note"><b>What the server does learn:</b> the public key it searched from and the final address — so it can tell that this address was made for someone who used this service. If that matters to you, use the offline script. The server is shared: jobs run one at a time, longer texts are refused (<span id="v_srv_limit">…</span>), and a job nobody asks about for 10 minutes is dropped.</div>
      <p class="hint" id="v_srv_status"></p>
      <button class="wide" id="v_srv_start" type="button">Submit to the server</button>
      <div id="v_srv_running" class="hide">
        <div class="bar"><i id="v_srv_bar"></i></div>
        <div class="stat"><span id="v_srv_state"></span><span><b id="v_srv_tried">0</b> keys tried</span><span><b id="v_srv_rate">0</b> keys/s</span></div>
        <div class="stat"><span>Elapsed <b id="v_srv_elapsed">0s</b></span><span>Chance found by now: <b id="v_srv_chance">0%</b></span></div>
        <p class="hint">You can leave this screen open and come back; closing the tab abandons the job (nothing is lost — nothing exists yet).</p>
        <button class="sec wide" id="v_srv_stop" type="button">Cancel</button>
      </div>
    </div>
  </div>

  <div id="v_script" class="hide">
    <h3>Offline script</h3>
    <div class="card">
      <p class="hint" style="margin-top:0">The script is the same search code as this page, in one file with no dependencies. It needs <b style="color:var(--text)">Node.js</b> (free, nodejs.org). Nothing is sent anywhere; you run it with the network off.</p>
      <div class="steps">
        <div class="step"><i>1</i><div><b>Download the file and check it</b>Its SHA-256 must be exactly<br><code class="mono" id="v_sha" style="font-size:11.5px"></code><br>Linux/macOS: <code>sha256sum olesia-vanity.mjs</code> · Windows: <code>certutil -hashfile olesia-vanity.mjs SHA256</code>. The script also prints its own hash when it starts.</div></div>
        <div class="step"><i>2</i><div><b>Go offline</b>Turn off Wi-Fi / unplug the network. The script never needs it.</div></div>
        <div class="step"><i>3</i><div><b>Run it</b><code class="mono" id="v_cmd"></code><br>It checks itself, shows the expected time, searches on all your CPU threads, and writes the result to <code>olesia-vanity-result.txt</code> (readable only by you).</div></div>
        <div class="step"><i>4</i><div><b>Import</b>Back here: <span style="font-weight:600;color:var(--text)">Import a wallet → Private key (WIF)</span>, choose a password, save the <code>.dat</code> file. Then delete the result file securely.</div></div>
      </div>
      <a class="btn" id="v_dl" href="/olesia-vanity.mjs" download="olesia-vanity.mjs">${IC.dl} Download olesia-vanity.mjs <span id="v_size" style="font-weight:400;opacity:.8"></span></a>
      <p class="hint" style="margin-top:10px">Full guide with screenshots and troubleshooting: <a id="v_guide" href="https://github.com/testnetbtc/BTC_Wallet/blob/main/docs/VANITY_OFFLINE_GUIDE.md" target="_blank" rel="noopener noreferrer">docs/VANITY_OFFLINE_GUIDE.md</a>. The source is open — read it before you run it.</p>
    </div>
  </div>

  <div id="v_browser" class="hide">
    <h3>In this browser</h3>
    <div class="card">
      <div class="warn" style="margin-top:0"><b>Keep this tab open</b> until it finishes — closing it abandons the search (nothing is saved anywhere, so nothing is lost either). On a laptop or phone, plug in: this uses all the CPU it can.</div>
      <button class="wide" id="v_start" type="button">Start searching</button>
      <div id="v_running" class="hide">
        <div class="bar"><i id="v_bar"></i></div>
        <div class="stat"><span><b id="v_tried">0</b> keys tried</span><span><b id="v_rate">0</b> keys/s</span><span><b id="v_elapsed">0s</b> elapsed</span></div>
        <div class="stat"><span>Chance it would have been found by now: <b id="v_chance">0%</b></span><span>Expected: <b id="v_remaining"></b></span></div>
        <button class="sec wide" id="v_stop" type="button">Stop</button>
      </div>
    </div>
  </div>

  <div id="v_result" class="hide">
    <h3>Found</h3>
    <div class="card">
      <div class="addr" id="v_addr"></div>
      <p class="hint ok" style="margin:0 0 10px">✓ Re-derived from the private key by the wallet's own code — the address and key belong together.</p>
      <p class="hint" id="v_found_stats"></p>
      <button class="wide" id="v_save" type="button">Save as an encrypted wallet file</button>
      <p class="hint" style="margin:10px 0 6px">The address becomes a normal Olesia wallet: you choose a password, the key is encrypted into a <code>.dat</code> file on this computer, and you can receive and send from it like any other.</p>
      <div class="row"><button class="sec" id="v_showkey" type="button">Show private key</button><button class="sec" id="v_discard" type="button">Discard</button></div>
      <p class="mono hide" id="v_wif" style="margin-top:10px"></p>
      <div class="danger hide" id="v_wifwarn">This is the private key. Anyone who sees it can spend everything the address ever receives. Nothing has been saved — if you leave this screen without saving, the address is gone for good.</div>
    </div>
  </div>
</section>

<!-- ===================== RECEIVE ===================== -->
<section class="pane" id="pane-receive">
  <button class="back" data-go="wallet" type="button">‹ Wallet</button>
  <h2>Receive</h2>
  <div class="card" style="text-align:center">
    <div id="r_typebox"><select id="r_type"></select></div>
    <div class="qrbox"><img id="r_qr" alt="address QR code"></div>
    <div class="mono" id="r_addr" style="font-size:14px"></div>
    <p class="hint" id="r_path"></p>
    <div class="row"><button id="r_copy" type="button">Copy address</button><button class="sec" id="r_next" type="button">New address</button></div>
  </div>
  <p class="hint">Use a new address for each payment where you can. Every address shown here belongs to this wallet and is restored by your recovery phrase.</p>
</section>

<!-- ===================== SEND ===================== -->
<section class="pane" id="pane-send">
  <button class="back" data-go="wallet" type="button">‹ Wallet</button>
  <h2>Send</h2>
  <div class="card">
    <label>To address</label>
    <input id="t_to" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="bc1…, 3… or 1…">
    <label>Amount</label>
    <div class="row"><input id="t_amt" inputmode="decimal" autocomplete="off" placeholder="0.00000000" style="flex:2"><select id="t_unit" style="flex:1"><option value="btc" id="t_unit_coin">BTC</option><option value="sat">sats</option></select></div>
    <label class="inline"><input type="checkbox" id="t_all"><span>Send everything (the fee is taken from the amount)</span></label>
    <p class="hint" id="t_avail"></p>
    <label>Network fee</label>
    <div class="seg" id="t_fees"></div>
    <input id="t_fee" inputmode="numeric" autocomplete="off" placeholder="custom sat/vB">
    <p class="hint" id="t_feehint">Fee estimates come from the Olesia node. A higher rate confirms sooner.</p>
  </div>
  <div class="card">
    <label>Message <span style="color:var(--muted);font-weight:500">— optional (OP_RETURN)</span></label>
    <input id="t_note" autocomplete="off" spellcheck="false" placeholder="a short note written into the transaction">
    <p class="hint"><span id="t_notecount">0 / 80 bytes</span> · <b style="color:var(--text)">Public and permanent:</b> anyone can read it on the blockchain, forever, and it cannot be removed. Leave empty for a normal payment.</p>
    <button class="sec small" id="t_self" type="button">Only write a message: send to my own address</button>
  </div>
  <button class="wide" id="t_review" type="button">Review transaction</button>
  <p class="hint" id="t_msg"></p>
  <div class="card hide" id="t_result"></div>
</section>

<nav id="tabbar" class="hide" aria-label="Sections"><div class="in">
  <button type="button" data-tab="wallet">${IC.wallet}<span>Wallet</span></button>
  <button type="button" data-tab="networks">${IC.layers}<span>Networks</span></button>
  <button type="button" data-tab="faucet">${IC.drop}<span>Faucet</span></button>
  <button type="button" data-tab="settings">${IC.gear}<span>Settings</span></button>
</div></nav>
<div id="confirm"><div class="sheet">
  <h3>Send this transaction?</h3>
  <p class="hint" id="c_note">Shown from the signed transaction itself. Bitcoin payments cannot be reversed.</p>
  <div id="c_rows"></div>
  <div class="danger hide" id="c_warn"></div>
  <label class="inline hide" id="c_ackrow" style="margin-top:10px"><input type="checkbox" id="c_ack"><span>I have checked the fee and want to send anyway.</span></label>
  <div class="row" style="margin-top:14px"><button class="sec" id="c_cancel" type="button">Cancel</button><button id="c_go" type="button">Confirm &amp; send</button></div>
</div></div>
<div id="pwsheet"><div class="sheet">
  <h3 id="p_title">Enter your wallet password</h3>
  <p class="hint" id="p_note"></p>
  <input id="p_pw" type="password" autocomplete="off" spellcheck="false" placeholder="wallet file password">
  <div class="bar hide" id="p_progbar"><i id="p_prog"></i></div>
  <p class="hint bad" id="p_msg"></p>
  <div class="row" style="margin-top:10px"><button class="sec" id="p_cancel" type="button">Cancel</button><button id="p_go" type="button">Unlock</button></div>
</div></div>
<div id="toast"></div>

<footer>
  <p><b style="color:var(--muted)">How this works.</b> This page is one self-contained file. It talks to a single server — the Olesia Bitcoin node — to look up coins, estimate fees and broadcast. That server sees which addresses you ask about, never your keys. While a wallet is open this tab holds it only in encrypted form; your password decrypts it for the moment a payment is signed. Nothing secret is stored in the browser.</p>
  <p>Software served by a website can be changed by whoever controls the website. You can <a href="/" download="olesia-wallet.html">download this page</a> and run your own unchanging copy from disk.</p>
  <p>Olesia · non-custodial</p>
</footer>
</div>
<script>${bundle}</script>
<script>${ui}</script>
</body></html>`;
writeFileSync('mainnet/index.html', html);
console.log('mainnet/index.html bytes:', html.length);
