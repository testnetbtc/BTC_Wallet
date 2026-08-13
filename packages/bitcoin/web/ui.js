// Olesia app shell — Home · Accounts · Learn · Settings. All signing/derivation
// lives in window.OW (entry.js); this file is pure UI state + wiring.
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  // HTML-escape for the rare cases where non-constant text lands in an innerHTML
  // template. Explorer-derived strings (txids, addresses) are charset-constrained
  // in practice, but we never trust a remote source to stay well-formed.
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- state ----------
  let source = '', mode = '', network = 'testnet4', scriptType = 'p2wpkh', passphrase = '';
  let gen = 0;                 // stale-response guard
  let hideBal = false, sweepMode = false, forgetArmed = false;
  const balances = {};         // scriptType -> {confirmed, pending}
  const TYPES = window.OW.scriptTypes();
  const BADGE = { p2wpkh: 'bc1q', p2tr: 'bc1p', 'p2sh-p2wpkh': '3···', p2pkh: '1···', p2pk: 'pk' };
  const SHORT = { p2wpkh: 'Native SegWit', p2tr: 'Taproot', 'p2sh-p2wpkh': 'Nested SegWit', p2pkh: 'Legacy', p2pk: 'P2PK' };
  const ONELINE = {
    p2wpkh: 'Cheapest fees · the modern default', p2tr: 'Schnorr signatures · better privacy',
    'p2sh-p2wpkh': 'Wrapped · old-wallet compatible', p2pkh: 'The classic “1…” address',
    p2pk: 'Satoshi’s original · no address at all',
  };
  const unit = () => (network === 'mainnet' ? 'BTC' : 'tBTC');
  const coins = (sats) => (sats / 1e8).toFixed(8).replace(/0{3}$/, '');
  const sum = (o) => Object.values(o).reduce((a, b) => a + (b?.confirmed || 0), 0);

  // ---------- USD price (mempool.space, cached 5 min) ----------
  let priceCache = { usd: null, t: 0 };
  async function usdPrice() {
    if (priceCache.usd && Date.now() - priceCache.t < 300000) return priceCache.usd;
    try {
      const r = await fetch('https://mempool.space/api/v1/prices');
      const d = await r.json();
      priceCache = { usd: d.USD, t: Date.now() };
      return d.USD;
    } catch { return priceCache.usd; }
  }
  const usdOf = (sats, px) => (px == null ? null : (sats / 1e8) * px);
  const fmtUsd = (sats, px) => {
    const v = usdOf(sats, px);
    if (v == null) return '';
    const s = v >= 0.01 ? '$' + v.toFixed(2) : '<$0.01';
    return network === 'mainnet' ? s : `≈ ${s} at mainnet prices · no real value`;
  };

  // ---------- confirm sheet (every broadcast passes through here) ----------
  let confirmResolve = null;
  function confirmSheet(title, rows, btnLabel = 'Confirm & send') {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      $('#c_title').textContent = title; $('#c_go').textContent = btnLabel;
      $('#c_net').textContent = network === 'mainnet' ? '⚠ mainnet — REAL bitcoin' : `${network} — practice coins, no real value`;
      const box = $('#c_rows'); box.textContent = '';
      rows.forEach(([k, v, sub]) => {
        const d = document.createElement('div'); d.className = 'crow';
        const kk = document.createElement('span'); kk.className = 'k'; kk.textContent = k;
        const vv = document.createElement('span'); vv.className = 'v'; vv.textContent = v;
        if (sub) { const s = document.createElement('small'); s.textContent = sub; vv.appendChild(s); }
        d.append(kk, vv); box.appendChild(d);
      });
      $('#confirm').classList.add('on');
    });
  }
  const closeConfirm = (val) => { $('#confirm').classList.remove('on'); if (confirmResolve) { confirmResolve(val); confirmResolve = null; } };
  $('#c_cancel').addEventListener('click', () => closeConfirm(false));
  $('#c_go').addEventListener('click', () => closeConfirm(true));
  $('#confirm').addEventListener('click', (e) => { if (e.target.id === 'confirm') closeConfirm(false); });

  // ---------- set-a-PIN sheet (keypad, not the OS keyboard; choose + confirm) ----------
  let pinResolve = null, psBuf = '', psFirst = null, psText = false, psMainnet = false;
  const psMin = 6;
  function psDots() {
    const d = $('#ps_dots'); d.textContent = '';
    const n = Math.max(psBuf.length, psMin);
    for (let i = 0; i < n; i++) { const s = document.createElement('i'); if (i < psBuf.length) s.className = 'fill'; d.appendChild(s); }
  }
  function psTitle() {
    $('#ps_title').textContent = psFirst == null ? 'Choose a PIN' : 'Confirm your PIN';
    $('#ps_sub').textContent = psFirst == null ? `${psMin}+ digits — you'll enter this to unlock` : 'type it once more';
  }
  // opts.mainnet: a mainnet seed must not persist behind a weak PIN — start in
  // passphrase mode with the strong-passphrase generator, and enforce the bar.
  function askPin(opts = {}) {
    return new Promise((res) => {
      pinResolve = res; psBuf = ''; psFirst = null; psMainnet = !!opts.mainnet;
      psText = psMainnet; // mainnet defaults to a passphrase, not a PIN
      $('#ps_text').value = ''; $('#ps_msg').textContent = '';
      $('#ps_textrow').style.display = psText ? 'flex' : 'none';
      $('#ps_genrow').style.display = psMainnet ? 'block' : 'none';
      $('#ps_strength').textContent = '';
      $('#ps_pad').style.display = psText ? 'none' : 'grid';
      $('#ps_dots').style.display = psText ? 'none' : 'flex';
      $('#ps_abc').textContent = psText ? '123' : 'abc';
      psTitle(); psDots();
      $('#pinsheet').classList.add('on');
      if (psText) setTimeout(() => $('#ps_text').focus(), 30);
    });
  }
  const psClose = (val) => { $('#pinsheet').classList.remove('on'); if (pinResolve) { pinResolve(val); pinResolve = null; } };
  function psSubmit() {
    const val = psText ? $('#ps_text').value : psBuf;
    if (!val || val.length < psMin) { $('#ps_msg').textContent = `at least ${psMin} characters`; return; }
    // enforce the mainnet strength bar on the FIRST entry (before confirm)
    if (psMainnet && psFirst == null && !window.OW.vault.strongEnoughForMainnet(val)) {
      $('#ps_msg').textContent = 'too weak for a mainnet wallet — use a generated passphrase or a 12+ char mixed password';
      return;
    }
    if (psFirst == null) { // move to confirm phase
      psFirst = val; psBuf = ''; $('#ps_text').value = ''; $('#ps_msg').textContent = ''; $('#ps_genrow').style.display = 'none'; psTitle(); psDots();
    } else if (val === psFirst) { psClose(val); }
    else { $('#ps_msg').textContent = "those didn't match — start again"; psFirst = null; psBuf = ''; $('#ps_text').value = ''; if (psMainnet) $('#ps_genrow').style.display = 'block'; psTitle(); psDots(); }
  }
  function psShowStrength() {
    if (!psMainnet || psFirst != null) return;
    const s = window.OW.vault.strength($('#ps_text').value);
    const okBar = window.OW.vault.strongEnoughForMainnet($('#ps_text').value);
    $('#ps_strength').innerHTML = !$('#ps_text').value ? '' :
      s.verifiable ? `${s.words}-word passphrase · <b>${s.bits} bits</b> ${okBar ? '✓' : '— add more words'}`
                   : `typed password · strength unverifiable ${okBar ? '✓ (meets the length/variety floor)' : '— need 12+ chars, mixed'}`;
  }
  $('#ps_gen').addEventListener('click', () => {
    const g = window.OW.vault.suggest(6);
    psText = true; $('#ps_text').type = 'text'; $('#ps_text').value = g.phrase;
    $('#ps_textrow').style.display = 'flex'; $('#ps_pad').style.display = 'none'; $('#ps_dots').style.display = 'none'; $('#ps_abc').textContent = '123';
    psShowStrength();
    toast('Write this passphrase down — it protects your wallet and is not recoverable.', 'bad');
  });
  $('#ps_text').addEventListener('input', psShowStrength);
  $('#ps_pad').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !b.dataset.k) return;
    if (b.dataset.k === 'back') psBuf = psBuf.slice(0, -1); else if (psBuf.length < 12) psBuf += b.dataset.k;
    $('#ps_msg').textContent = ''; psDots();
  });
  $('#ps_abc').addEventListener('click', () => {
    psText = !psText;
    $('#ps_abc').textContent = psText ? '123' : 'abc';
    $('#ps_textrow').style.display = psText ? 'flex' : 'none';
    $('#ps_pad').style.display = psText ? 'none' : 'grid';
    $('#ps_dots').style.display = psText ? 'none' : 'flex';
    psBuf = ''; psDots(); if (psText) $('#ps_text').focus();
  });
  $('#ps_ok').addEventListener('click', psSubmit);
  $('#ps_cancel').addEventListener('click', () => psClose(null));
  $('#ps_text').addEventListener('keydown', (e) => { if (e.key === 'Enter') psSubmit(); });
  document.addEventListener('keydown', (e) => {
    if (!$('#pinsheet').classList.contains('on') || psText) return;
    if (/^[0-9]$/.test(e.key) && psBuf.length < 12) { psBuf += e.key; psDots(); }
    else if (e.key === 'Backspace') { psBuf = psBuf.slice(0, -1); psDots(); }
    else if (e.key === 'Enter') psSubmit();
  });

  // ---------- toast ----------
  let toastT;
  function toast(msg, cls) {
    const t = $('#toast'); t.textContent = msg; t.className = cls || ''; t.style.display = 'block';
    clearTimeout(toastT); toastT = setTimeout(() => { t.style.display = 'none'; }, cls === 'bad' ? 6000 : 3200);
  }

  // ---------- panes / nav ----------
  function showPane(name) {
    if (!source && ['home', 'accounts', 'account', 'send'].includes(name)) name = 'welcome';
    $$('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + name));
    // onboarding panes (welcome/wizard/import) anchor the Home tab
    const navName = ['welcome', 'create1', 'create2', 'create3', 'create4', 'import'].includes(name) ? 'home'
      : name === 'account' ? 'accounts' : name === 'send' ? 'home' : name;
    $$('nav button').forEach((b) => b.classList.toggle('on', b.dataset.nav === navName));
    // never leave the seed on screen or a stale confirm open when navigating
    try { if (typeof hideBackup === 'function') { hideBackup(); $('#backup_body').classList.remove('on'); } } catch {}
    try { closeConfirm(false); } catch {}
    window.scrollTo(0, 0);
  }
  $$('nav button').forEach((b) => b.addEventListener('click', () => showPane(b.dataset.nav)));
  $('#back_accounts').addEventListener('click', () => showPane('accounts'));
  $('#back_home').addEventListener('click', () => showPane('home'));
  // generic back links (‹ Home on Accounts / Learn / Settings, etc.)
  $$('.back[data-nav]').forEach((b) => b.addEventListener('click', () => showPane(b.dataset.nav)));

  // ---------- global helpers: tooltips, copy, paste ----------
  document.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('help')) {
      const t = document.getElementById(e.target.dataset.target);
      if (t) t.style.display = t.style.display === 'block' ? 'none' : 'block';
      e.stopPropagation();
    }
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.copy'); if (!b || !b.dataset.copy) return;
    const el = document.getElementById(b.dataset.copy); if (!el) return;
    const text = ('value' in el) ? el.value : el.textContent; if (!text) return;
    navigator.clipboard.writeText(text).then(() => { const o = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = o; }, 1200); }).catch(() => {});
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('.paste'); if (!b || !b.dataset.paste) return;
    const el = document.getElementById(b.dataset.paste); if (!el) return;
    try {
      const t = await navigator.clipboard.readText(); if (!t) return;
      el.value = t.trim(); el.dispatchEvent(new Event('input'));
      const o = b.textContent; b.textContent = 'Pasted ✓'; setTimeout(() => { b.textContent = o; }, 1200);
    } catch { toast("Couldn't read clipboard — long-press the field to paste manually", 'bad'); }
  });

  // ---------- network ----------
  const NETLABEL = { testnet3: 'Testnet 3', testnet4: 'Testnet 4', signet: 'Signet', mainnet: 'Mainnet' };
  const netpills = $('#netpills');
  window.OW.networks.forEach((n) => {
    for (const sel of [$('#net'), $('#set_net')]) { const o = document.createElement('option'); o.value = n; o.textContent = NETLABEL[n] || n; sel.appendChild(o); }
    const p = document.createElement('button'); p.type = 'button'; p.className = 'netpill'; p.dataset.net = n;
    p.innerHTML = `<span class="nd"></span>${NETLABEL[n] || n}`;
    p.addEventListener('click', () => setNetwork(n));
    if (netpills) netpills.appendChild(p);
  });
  $('#net').value = network; $('#set_net').value = network;
  function updateChips() {
    $('#netname').textContent = NETLABEL[network] || network;
    $$('#netpills .netpill').forEach((p) => p.classList.toggle('on', p.dataset.net === network));
    $('#netchip').classList.toggle('main', network === 'mainnet');
    const c = $('#chip_net');
    if (network === 'mainnet') { c.className = 'practice main'; c.textContent = '⚠ REAL bitcoin — small amounts only'; }
    else { c.className = 'practice'; c.textContent = `Practice mode — ${NETLABEL[network] || network} coins have no value`; }
    $('#bal_unit').textContent = unit();
  }
  function setNetwork(n) {
    network = n; $('#net').value = n; $('#set_net').value = n; updateChips();
    if (source) { Object.keys(balances).forEach((k) => delete balances[k]); initWallet(); }
  }
  $('#net').addEventListener('change', () => setNetwork($('#net').value));
  $('#set_net').addEventListener('change', () => setNetwork($('#set_net').value));
  $('#netchip').addEventListener('click', () => showPane(source ? 'settings' : 'welcome'));
  updateChips();

  // ---------- create wizard ----------
  let wizMnemonic = '', quiz = [];
  $('#w_create').addEventListener('click', () => showPane('create1'));
  $('#w_import').addEventListener('click', () => showPane('import'));
  $('#c_back0').addEventListener('click', () => showPane('welcome'));
  $('#i_back').addEventListener('click', () => showPane('welcome'));
  $('#extra_tog').addEventListener('click', () => {
    const b = $('#extra_body'); const open = b.style.display !== 'block';
    b.style.display = open ? 'block' : 'none';
    $('#extra_tog').textContent = open ? '－ Add your own entropy ▴' : '＋ Add your own entropy (optional) ▾';
  });
  // movement entropy: pointer position + timing jitter, drawn as a fading trail.
  // Mixed into the hash with the CSPRNG — it can only add, never weaken.
  let moveEntropy = '', moveSamples = 0;
  const MOVE_TARGET = 180;
  (() => {
    const pad = $('#entropad'), cv = $('#entrocanvas'), ctx = cv.getContext('2d');
    let drawing = false, last = null, sized = false;
    function size() { const r = pad.getBoundingClientRect(); cv.width = r.width * 2; cv.height = r.height * 2; ctx.scale(2, 2); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#f0a020'; sized = true; }
    function sample(e) {
      const r = pad.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      moveEntropy += `${x.toFixed(2)},${y.toFixed(2)},${performance.now().toFixed(3)};`;
      moveSamples++;
      const pct = Math.min(100, Math.round(moveSamples / MOVE_TARGET * 100));
      $('#entrobar').style.width = pct + '%';
      $('#entromsg').textContent = pct >= 100 ? '100% — plenty collected (keep going if you like)' : pct + '% — every wiggle adds randomness';
      if (moveSamples > 3) $('#entrohint').style.display = 'none';
      if (last) { ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(x, y); ctx.stroke(); }
      last = { x, y };
      if (moveSamples % 40 === 0) { ctx.fillStyle = 'rgba(14,17,22,0.35)'; ctx.globalAlpha = 1; ctx.fillRect(0, 0, cv.width, cv.height); } // fade old trail
    }
    pad.addEventListener('pointerdown', (e) => { if (!sized) size(); drawing = true; last = null; sample(e); });
    pad.addEventListener('pointermove', (e) => { if (!sized) size(); if (drawing || e.pointerType === 'mouse') sample(e); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => pad.addEventListener(ev, () => { drawing = false; last = null; }));
  })();

  $('#c_gen').addEventListener('click', () => {
    const dice = $('#dice').value.trim();
    if (dice && /[^1-6\s]/.test(dice)) return toast('Dice rolls can only contain digits 1–6.', 'bad');
    wizMnemonic = window.OW.generateFrom(dice + moveEntropy);
    const box = $('#c_words'); box.textContent = '';
    wizMnemonic.split(' ').forEach((w, i) => {
      const s = document.createElement('span'); const n = document.createElement('i');
      n.textContent = i + 1; s.append(n, w); box.appendChild(s);
    });
    showPane('create2');
  });
  $('#c_back1').addEventListener('click', () => { wizMnemonic = ''; $('#c_words').textContent = ''; showPane('create1'); });
  $('#c_wrote').addEventListener('click', () => { buildQuiz(); showPane('create3'); });
  $('#q_back').addEventListener('click', () => showPane('create2'));
  function buildQuiz() {
    const words = wizMnemonic.split(' ');
    // 4 distinct random positions; each gets the right word + 2 decoys
    const picks = new Set();
    while (picks.size < 4) picks.add(Math.floor(Math.random() * words.length));
    quiz = [...picks].sort((a, b) => a - b).map((idx) => {
      const opts = new Set([words[idx]]);
      while (opts.size < 3) { const d = words[Math.floor(Math.random() * words.length)]; if (d !== words[idx]) opts.add(d); }
      return { idx, answer: words[idx], opts: [...opts].sort(() => Math.random() - 0.5), chosen: null };
    });
    const box = $('#q_box'); box.textContent = '';
    quiz.forEach((q, qi) => {
      const row = document.createElement('div'); row.className = 'qrow';
      const k = document.createElement('div'); k.className = 'qk'; k.innerHTML = `Word <i>#${q.idx + 1}</i>`;
      const chips = document.createElement('div'); chips.className = 'qchips';
      q.opts.forEach((w) => {
        const c = document.createElement('button'); c.type = 'button'; c.className = 'qchip'; c.textContent = w;
        c.addEventListener('click', () => {
          q.chosen = w;
          chips.querySelectorAll('.qchip').forEach((x) => x.classList.toggle('sel', x === c));
          $('#q_check').disabled = quiz.some((x) => !x.chosen);
        });
        chips.appendChild(c);
      });
      row.append(k, chips); box.appendChild(row);
    });
    $('#q_check').disabled = true;
  }
  $('#q_check').addEventListener('click', () => {
    const wrong = quiz.filter((q) => q.chosen !== q.answer);
    if (wrong.length) {
      toast(`Not quite — word #${wrong[0].idx + 1} is wrong. Check your paper and try again.`, 'bad');
      buildQuiz(); // fresh positions each attempt
      return;
    }
    $('#c_replacenote').style.display = window.OW.vault.exists() ? 'block' : 'none';
    showPane('create4');
  });
  function openCreated() { source = wizMnemonic; passphrase = $('#c_pass').value; mode = 'full'; scriptType = 'p2wpkh'; wizMnemonic = ''; moveEntropy = ''; moveSamples = 0; $('#c_words').textContent = ''; $('#dice').value = ''; $('#c_pass').value = ''; initWallet(); }
  $('#c_save').addEventListener('click', async () => {
    const pin = await askPin({ mainnet: network === 'mainnet' }); if (pin == null) return;
    toast('Encrypting…'); await new Promise((r) => setTimeout(r, 30));
    try { window.OW.vault.save(wizMnemonic, pin, $('#c_pass').value, network); openCreated(); }
    catch (e) { toast('✗ ' + e.message, 'bad'); }
  });
  $('#c_skip').addEventListener('click', () => { openCreated(); toast('Not saved — keep that paper safe; you’ll need the words next time.'); });

  // ---------- import ----------
  $('#load').addEventListener('click', loadFromInput);
  $('#mnemonic').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); loadFromInput(); } });
  function loadFromInput() {
    const s = $('#mnemonic').value.trim();
    if (window.OW.validate(s)) mode = 'full';
    else if (window.OW.isXpub(s)) mode = 'watch';
    else return toast('✗ ' + window.OW.diagnose(s), 'bad');
    source = s; scriptType = 'p2wpkh';
    passphrase = mode === 'full' ? $('#i_pass').value : '';
    $('#mnemonic').value = ''; $('#i_pass').value = '';
    initWallet();
  }
  // import an encrypted cold-generator backup file
  $('#bkimport').addEventListener('click', async () => {
    const f = $('#bkfile').files && $('#bkfile').files[0];
    if (!f) return ($('#bkinfo').textContent = 'Choose your backup .json file first.', $('#bkinfo').className = 'hint bad');
    $('#bkinfo').className = 'hint'; $('#bkinfo').textContent = 'Decrypting… (key stretching takes a moment)';
    await new Promise((r) => setTimeout(r, 30));
    try {
      const text = await f.text();
      const { mnemonic, passphraseUsed, metadataAuthenticated } = window.OW.importBackup({ json: text, password: $('#bkpass').value });
      if (!window.OW.validate(mnemonic)) throw new Error('decrypted, but the recovered phrase is not valid BIP-39');
      if (metadataAuthenticated === false) toast('Legacy backup: its labels (network/passphrase flag) are not cryptographically authenticated — only the seed itself is verified.', 'bad');
      if (passphraseUsed && !$('#bkbip39').value) {
        $('#bkbip39row').style.display = 'block';
        $('#bkinfo').className = 'hint';
        $('#bkinfo').textContent = 'This wallet was made with a BIP-39 passphrase — enter it just above (it isn’t stored in the file, by design), then Decrypt & open again.';
        $('#bkbip39').focus();
        return;
      }
      source = mnemonic; mode = 'full'; scriptType = 'p2wpkh';
      passphrase = passphraseUsed ? $('#bkbip39').value : '';
      $('#bkpass').value = ''; $('#bkfile').value = ''; $('#bkbip39').value = ''; $('#bkbip39row').style.display = 'none'; $('#bkinfo').textContent = '';
      initWallet();
    } catch (e) { $('#bkinfo').className = 'hint bad'; $('#bkinfo').textContent = '✗ ' + e.message; }
  });

  // --- WIF inspect & sweep (educational: one key -> every address format) ---
  $('#wifinspect').addEventListener('click', async () => {
    const wif = $('#wif').value.trim();
    if (!wif) return toast('paste a private key (WIF) first', 'bad');
    const out = $('#wifout'); out.textContent = 'Looking up every address format…';
    try {
      const rows = await window.OW.wifInspect({ wif, network });
      out.textContent = ''; let anyFunded = false;
      rows.forEach((r) => {
        const total = r.balance.confirmed + r.balance.pending;
        const funded = total > 0 && r.type !== 'p2pk';
        if (funded) anyFunded = true;
        const d = document.createElement('div'); d.style.cssText = 'padding:9px 0;border-top:1px solid var(--line-soft)';
        const balTxt = r.type === 'p2pk' ? 'no address — explorers can’t show P2PK balances' : `${coins(total)} ${unit()}${total ? '' : ' (empty)'}`;
        d.innerHTML = `<div style="font-size:12px;font-weight:700;color:var(--muted)">${SHORT[r.type]}</div>
          <div class="mono" style="font-size:11px;color:var(--faint)">${esc(r.address || '(bare public key)')}</div>
          <div style="font-size:12.5px;margin-top:2px;color:${funded ? 'var(--mint)' : 'var(--text)'}">${balTxt}</div>`;
        if (funded) {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'sec'; b.textContent = 'Sweep this →'; b.style.marginTop = '6px';
          b.addEventListener('click', () => sweepWif(r.type, b));
          d.appendChild(b);
        }
        out.appendChild(d);
      });
      $('#wifswrow').style.display = anyFunded ? 'block' : 'none';
      if (!anyFunded) { const p = document.createElement('p'); p.className = 'hint'; p.style.marginTop = '8px'; p.textContent = 'This key holds no balance in any spendable format. (P2PK balances are invisible to explorers by design.)'; out.appendChild(p); }
    } catch (e) { out.textContent = ''; toast('✗ ' + e.message, 'bad'); }
  });
  async function sweepWif(type, btn) {
    const to = $('#wifto').value.trim();
    if (!to) return toast('enter a destination address to sweep to', 'bad');
    btn.disabled = true;
    try {
      toast('Building…');
      const dry = await window.OW.wifSweep({ wif: $('#wif').value.trim(), network, scriptType: type, toAddress: to, broadcast: false });
      const px = await usdPrice();
      const ok = await confirmSheet('Sweep this key?', [
        ['To', to],
        ['Amount', `${dry.swept.toLocaleString()} sat`, `${coins(dry.swept)} ${unit()}${px ? ' · ' + fmtUsd(dry.swept, px) : ''}`],
        ['Network fee', `${dry.fee.toLocaleString()} sat`, px ? fmtUsd(dry.fee, px) : ''],
        ['From', SHORT[type] + ' (imported key) · ' + network],
      ], 'Sweep');
      if (!ok) { btn.disabled = false; return toast('Cancelled — nothing sent.'); }
      toast('Sweeping…');
      // broadcast the EXACT transaction that was just confirmed — no rebuild
      const s = dry.txHex
        ? await window.OW.broadcastHex({ hex: dry.txHex, network })
        : await window.OW.wifSweep({ wif: $('#wif').value.trim(), network, scriptType: type, toAddress: to, broadcast: true }); // p2pk path (per-UTXO txs)
      const a = document.createElement('a'); a.href = s.explorer; a.target = '_blank'; a.rel = 'noopener'; a.textContent = `✓ swept ${dry.swept} sat — explorer ↗`;
      btn.replaceWith(a); toast('✓ swept', 'ok');
    } catch (e) { toast('✗ ' + e.message, 'bad'); btn.disabled = false; }
  }

  function walletFP() { try { return window.OW.fingerprint(source, network, passphrase); } catch { return null; } }
  function initWallet() {
    $('#lockbtn').style.display = 'inline-block';
    $('#vault_state').textContent = window.OW.vault.exists() ? 'saved encrypted on this device' : 'not saved — seed lives in this tab only';
    $('#acct_watchnote').style.display = mode === 'watch' ? 'block' : 'none';
    renderAccountRows();
    renderTotal();          // paint the hero + type pills immediately (…), before data lands
    showPane('home');
    // With a passphrase, confirm the RIGHT wallet opened: a wrong passphrase
    // still "works" but gives a different (empty) wallet — the fingerprint catches it.
    if (mode === 'full' && passphrase) toast(`Wallet fingerprint ${walletFP()} — the same words + passphrase always give this code. A different code means a different passphrase.`, 'ok');
    else toast(mode === 'watch' ? 'Watch-only wallet opened (xpub).' : '✓ Wallet open', 'ok');
    refreshAll();
  }

  function lock() { location.reload(); } // hard reset clears the seed from memory
  $('#lockbtn').addEventListener('click', lock);
  $('#set_lock').addEventListener('click', lock);

  // ---------- balances / accounts ----------
  const typesFor = () => (mode === 'watch' ? TYPES.filter((t) => t.id === 'p2wpkh') : TYPES);

  // full HD discovery result per script type (change lives on rotated addresses,
  // so a single index-0 read would under-count). The active type gets full
  // discovery; the others get a cheap index-0 read for the home summary and are
  // discovered in full when opened.
  const discovered = {};
  async function refreshAll() {
    const g = ++gen;
    const jobs = typesFor().map(async (t) => {
      try {
        if (t.id === 'p2pk') {
          const list = p2pkLoad();
          if (!list.length) { balances.p2pk = { confirmed: 0, pending: 0 }; return; }
          const ann = await window.OW.p2pkStatus({ network, outpoints: list });
          const live = ann.filter((o) => !o.spent && !o.error);
          balances.p2pk = { confirmed: live.filter((o) => o.confirmed).reduce((a, o) => a + o.value, 0),
                            pending: live.filter((o) => !o.confirmed).reduce((a, o) => a + o.value, 0) };
        } else if (t.id === (mode === 'watch' ? 'p2wpkh' : scriptType) || t.id === 'p2wpkh') {
          const disc = await window.OW.discover({ source, network, scriptType: t.id, passphrase });
          discovered[t.id] = disc; balances[t.id] = disc.balance;
        } else {
          const st = await window.OW.status(source, network, t.id, 0, passphrase);
          balances[t.id] = st.balance;
        }
      } catch { balances[t.id] = balances[t.id] || null; }
    });
    await Promise.allSettled(jobs);
    if (g !== gen) return;
    renderAccountRows(); renderTotal();
    refreshHomeActivity(g);
  }
  // The Home headline shows the SELECTED script type, with a per-type selector
  // (each pill carries its own balance, so 1 tBTC on Legacy is never invisible
  // while viewing P2PK) plus a smaller all-accounts combined total underneath.
  const activeType = () => (mode === 'watch' ? 'p2wpkh' : scriptType);
  function renderTypeSel() {
    const box = $('#type_sel'); if (!box) return;
    const cur = activeType();
    box.textContent = '';
    typesFor().forEach((t) => {
      const b = balances[t.id];
      const amt = b == null ? '…' : hideBal ? '••' : coins(b.confirmed);
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'typepill' + (t.id === cur ? ' on' : '');
      pill.innerHTML = `<span class="tn">${SHORT[t.id]}</span><span class="tv">${amt}</span>`;
      pill.addEventListener('click', () => setActiveType(t.id));
      box.appendChild(pill);
    });
  }
  async function setActiveType(id) {
    if (mode === 'watch' || id === activeType()) return; // watch-only exposes SegWit only
    scriptType = id;
    renderTotal();
    // upgrade the newly-selected type to full HD discovery (change addresses too)
    if (id !== 'p2pk' && !discovered[id]) {
      const g = gen;
      try {
        const disc = await window.OW.discover({ source, network, scriptType: id, passphrase });
        if (g !== gen) return;
        discovered[id] = disc; balances[id] = disc.balance;
        renderTotal(); renderAccountRows();
      } catch { /* keep the cheap index-0 read */ }
    }
  }
  function renderTotal() {
    const cur = activeType();
    const active = balances[cur] || { confirmed: 0, pending: 0 };
    const combined = sum(balances);
    const combPend = Object.values(balances).reduce((a, b) => a + (b?.pending || 0), 0);
    $('#bal_label').textContent = SHORT[cur] ? SHORT[cur].toUpperCase() : 'BALANCE';
    $('#bal_total').innerHTML = (hideBal ? '••••' : coins(active.confirmed)) + `<span class="u">${unit()}</span>`;
    const ap = active.pending || 0;
    $('#bal_sub').textContent = ap ? `+ ${hideBal ? '•' : coins(ap)} pending  ›  view` : '';
    $('#bal_sub').style.display = ap ? 'block' : 'none';
    $('#bal_sub').style.cursor = ap ? 'pointer' : 'default';
    const all = $('#bal_all');
    const extra = combPend ? ` (+${hideBal ? '•' : coins(combPend)} pending)` : '';
    all.innerHTML = `All types · <b>${hideBal ? '••••' : coins(combined)}</b> ${unit()}${extra}`;
    renderTypeSel();
  }
  $('#bal_all').addEventListener('click', () => showPane('accounts'));
  $('#bal_sub').addEventListener('click', () => { const a = $('#home_activity'); if (a) a.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('#bal_eye').addEventListener('click', () => { hideBal = !hideBal; renderTotal(); renderAccountRows(); });

  function acctRow(t) {
    const b = balances[t.id];
    const row = document.createElement('div'); row.className = 'acct';
    row.innerHTML = `<span class="badge b-${t.id}">${BADGE[t.id]}</span>
      <span class="meta"><span class="name">${SHORT[t.id]}${t.id === 'p2pk' ? ' <span class="tag">museum</span>' : ''}</span>
      <span class="d">${ONELINE[t.id]}</span></span>
      <span class="amt"><b>${b == null ? '…' : hideBal ? '••' : coins(b.confirmed)}</b><span>${unit()}</span></span>`;
    row.addEventListener('click', () => openAccount(t.id));
    return row;
  }
  function renderAccountRows() {
    const list = $('#acct_list'); list.textContent = '';
    typesFor().forEach((t) => list.appendChild(acctRow(t)));
  }

  async function refreshHomeActivity(g) {
    try {
      const txs = await window.OW.history(source, network, 'p2wpkh', 0, passphrase);
      if (g !== gen) return;
      const box = $('#home_activity'); box.textContent = '';
      if (!txs.length) { box.innerHTML = '<div class="hint" style="padding:8px 0">No transactions yet — get coins from the faucet to start.</div>'; return; }
      const base = window.OW.explorer(network);
      txs.slice(0, 6).forEach((t) => {
        const dir = t.net >= 0;
        // Built with textContent/createElement (not innerHTML): the explorer-supplied
        // txid is never interpreted as markup, whatever a remote source returns.
        const d = document.createElement('div'); d.className = 'tx'; d.style.cursor = 'pointer';
        const ti = document.createElement('span'); ti.className = 'ti';
        ti.style.color = dir ? 'var(--mint)' : 'var(--accent)'; ti.textContent = dir ? '↙' : '↗';
        const mid = document.createElement('span');
        const b = document.createElement('b'); b.textContent = dir ? 'Received' : 'Sent';
        const meta = document.createElement('span'); meta.style.cssText = 'font-size:11.5px;color:var(--faint)';
        meta.textContent = `${t.confirmed ? '✓ confirmed' : '⧗ pending'} · ${String(t.txid).slice(0, 10)}… · open ↗`;
        mid.append(b, document.createElement('br'), meta);
        const v = document.createElement('span'); v.className = 'v';
        v.style.color = dir ? 'var(--mint)' : 'var(--text)';
        v.textContent = `${dir ? '+' : '−'}${Math.abs(t.net).toLocaleString()} sat`;
        d.append(ti, mid, v);
        d.addEventListener('click', () => window.open(base + encodeURIComponent(t.txid), '_blank', 'noopener'));
        box.appendChild(d);
      });
    } catch { /* home activity is best-effort */ }
  }
  $('#home_refresh').addEventListener('click', () => refreshAll());

  // quick actions
  $('#qa_recv').addEventListener('click', () => showPane('accounts'));
  $('#qa_send').addEventListener('click', () => openSend(scriptType === 'p2pk' ? 'p2wpkh' : scriptType));
  $('#qa_faucet').addEventListener('click', () => window.open('https://olesia.io/faucet/', '_blank', 'noopener'));
  $('#qa_learn').addEventListener('click', () => showPane('learn'));

  // ---------- account detail ----------
  $('#acc_moretog').addEventListener('click', () => {
    const a = $('#acc_about'); const open = a.style.display !== 'block';
    a.style.display = open ? 'block' : 'none';
    $('#acc_moretog').textContent = open ? 'about ▴' : 'about ▾';
  });
  $('#acc_addr').addEventListener('click', () => {
    const t = $('#acc_addr').textContent; if (!t) return;
    navigator.clipboard.writeText(t).then(() => toast('Address copied ✓', 'ok')).catch(() => {});
  });
  async function openAccount(type) {
    scriptType = type;
    const t = TYPES.find((x) => x.id === type);
    $('#acc_title').textContent = SHORT[type];
    $('#acc_one').textContent = ONELINE[type];
    const PURPOSE = { p2pk: 44, p2pkh: 44, 'p2sh-p2wpkh': 49, p2wpkh: 84, p2tr: 86 };
    $('#acc_path').textContent = `m/${PURPOSE[type]}'/${network === 'mainnet' ? 0 : 1}'/0'/0/0`;
    $('#acc_about').textContent = t.about; $('#acc_about').style.display = 'none'; $('#acc_moretog').textContent = 'about ▾';
    $('#lab').style.display = type === 'p2pk' && mode === 'full' ? 'block' : 'none';
    $('#acc_label').style.display = type === 'p2pk' ? 'none' : 'block';
    try {
      const info = window.OW.info(source, network, type, 0, passphrase);
      $('#acc_addr').textContent = info.address || info.scriptHex;
      document.querySelector('.qrbox').classList.toggle('noaddr', !info.address);
      if (info.address) $('#acc_qr').src = await window.OW.qr(info.address);
      $('#acc_label').value = info.address ? (localStorage.getItem('olesia:label:' + info.address) || '') : '';
      $('#acc_recvhint').innerHTML = type === 'p2pk'
        ? 'P2PK has no address — this is its raw locking script. Fund it from the Lab below.'
        : 'Scan or copy to receive. Need coins? <a href="https://olesia.io/faucet/" target="_blank" rel="noopener">Free testnet coins →</a>';
    } catch (e) { toast('✗ ' + e.message, 'bad'); return; }
    showPane('account');
    refreshAccount();
    if (type === 'p2pk') refreshLab();
  }
  $('#acc_label').addEventListener('input', () => {
    if (!source || scriptType === 'p2pk') return;
    try { const a = window.OW.info(source, network, scriptType, 0, passphrase).address; if (a) localStorage.setItem('olesia:label:' + a, $('#acc_label').value); } catch {}
  });
  $('#acc_refresh').addEventListener('click', refreshAccount);
  async function refreshAccount() {
    const g = ++gen;
    if (scriptType === 'p2pk') {
      $('#acc_bal').textContent = 'Tracked below — explorers can’t index P2PK, so Olesia follows the exact coins it created.';
      $('#acc_utxos').textContent = ''; $('#acc_hist').textContent = '(see “Your P2PK coins”)';
      return;
    }
    try {
      // full HD discovery: balance + UTXOs across ALL receive & change addresses
      const disc = await window.OW.discover({ source, network, scriptType, passphrase });
      if (g !== gen) return;
      discovered[scriptType] = disc; balances[scriptType] = disc.balance;
      $('#acc_bal').textContent = `${coins(disc.balance.confirmed)} ${unit()} confirmed` + (disc.balance.pending ? ` · ${coins(disc.balance.pending)} pending` : '')
        + (disc.used.length > 1 ? ` · across ${disc.used.length} addresses` : '');
      $('#acc_utxos').textContent = disc.utxos.length ? disc.utxos.map((u) => `${u.value.toLocaleString()} sat ${u.confirmed ? '✓' : '⧗'}`).join('  ·  ') : '(no UTXOs yet)';
      // rotate the receive address to the next unused one (avoids address reuse)
      if (mode !== 'watch') {
        const nextAddr = window.OW.address(source, network, scriptType, disc.nextReceive, passphrase);
        if (nextAddr && $('#acc_addr').textContent !== nextAddr) {
          $('#acc_addr').textContent = nextAddr;
          document.querySelector('.qrbox').classList.remove('noaddr');
          $('#acc_qr').src = await window.OW.qr(nextAddr);
          $('#acc_recvhint').innerHTML = `Fresh unused address (receive #${disc.nextReceive}). Older addresses still work and their funds are always found from your seed.`;
        }
      }
      renderTotal(); renderAccountRows();
    } catch (e) { if (g === gen) toast('✗ ' + e.message, 'bad'); }
    try {
      const txs = await window.OW.history(source, network, scriptType, 0, passphrase);
      if (g !== gen) return;
      const h = $('#acc_hist'); h.textContent = '';
      if (!txs.length) { h.textContent = '(no transactions yet)'; return; }
      const base = window.OW.explorer(network);
      txs.forEach((t) => {
        const row = document.createElement('div'); row.style.margin = '3px 0';
        row.style.color = t.net >= 0 ? 'var(--mint)' : 'var(--bad)';
        row.append(`${t.confirmed ? '✓' : '⧗'} ${t.net >= 0 ? '+' : '−'}${Math.abs(t.net).toLocaleString()} sat  `);
        const a = document.createElement('a'); a.href = base + t.txid; a.target = '_blank'; a.rel = 'noopener'; a.textContent = t.txid.slice(0, 10) + '… ↗';
        row.appendChild(a); h.appendChild(row);
      });
    } catch { /* history best-effort */ }
  }
  $('#acc_sendbtn').addEventListener('click', () => {
    if (scriptType === 'p2pk') return toast('P2PK spends from its Lab below — use “Spend a P2PK coin out”.');
    openSend(scriptType);
  });

  // ---------- P2PK lab ----------
  const p2pkKey = () => { try { return `olesia:p2pk:${network}:${window.OW.info(source, network, 'p2pk', 0, passphrase).scriptHex}`; } catch { return `olesia:p2pk:${network}:x`; } };
  const p2pkLoad = () => { try { return JSON.parse(localStorage.getItem(p2pkKey()) || '[]'); } catch { return []; } };
  const p2pkStore = (l) => { try { localStorage.setItem(p2pkKey(), JSON.stringify(l)); } catch {} };
  async function refreshLab() {
    try {
      const st = await window.OW.status(source, network, 'p2wpkh', 0, passphrase);
      $('#p2pk_srcbal').textContent = `SegWit balance available to move: ${coins(st.balance.confirmed)} ${unit()}`;
      $('#p2pk_need').style.display = st.balance.confirmed <= 0 ? 'block' : 'none';
      $('#p2pk_fundbtn').disabled = st.balance.confirmed <= 0;
    } catch (e) { $('#p2pk_srcbal').textContent = '✗ ' + e.message; }
    refreshP2PKList();
  }
  async function refreshP2PKList() {
    const list = p2pkLoad(); const el = $('#p2pk_list');
    if (!list.length) { el.textContent = '(none yet — fund one above)'; return; }
    el.textContent = 'loading…';
    let ann; try { ann = await window.OW.p2pkStatus({ network, outpoints: list }); } catch { ann = list.map((o) => ({ ...o, value: o.amount, error: 'status failed' })); }
    el.textContent = '';
    ann.forEach((o) => {
      const row = document.createElement('div'); row.style.cssText = 'padding:8px 0;border-top:1px solid var(--line-soft)';
      const state = o.error ? '⚠ ' + o.error : o.spent ? 'spent' : (o.confirmed ? '✓ confirmed' : '⧗ pending');
      const head = document.createElement('div'); head.className = 'mono'; head.style.color = o.spent ? 'var(--faint)' : 'var(--text)';
      head.textContent = `${(o.value / 1e8).toFixed(8)} · ${state} · ${o.txid.slice(0, 12)}…:${o.vout}`;
      row.appendChild(head);
      if (!o.spent && !o.error) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'sec'; b.textContent = 'Spend this →'; b.style.marginTop = '6px';
        b.addEventListener('click', () => spendOneP2PK({ txid: o.txid, vout: o.vout }, b));
        row.appendChild(b);
      }
      el.appendChild(row);
    });
  }
  async function spendOneP2PK(outpoint, btn) {
    const to = $('#p2pk_to').value.trim();
    if (!to) return toast('enter a destination address first', 'bad');
    btn.disabled = true;
    try {
      toast('Building…');
      const msg = $('#p2pk_msg').value.trim();
      const dry = await window.OW.spendP2PK({ source, network, outpoint, toAddress: to, message: msg, broadcast: false, passphrase });
      const px = await usdPrice();
      const rows = [
        ['To', to],
        ['Amount', `${dry.sent.toLocaleString()} sat`, `${coins(dry.sent)} ${unit()}${px ? ' · ' + fmtUsd(dry.sent, px) : ''}`],
        ['Network fee', `${dry.fee.toLocaleString()} sat`, px ? fmtUsd(dry.fee, px) : ''],
      ];
      if (msg) rows.push(['OP_RETURN', `“${msg.slice(0, 40)}${msg.length > 40 ? '…' : ''}”`, 'a note from Satoshi’s own script type']);
      rows.push(['From', 'P2PK (bare public key) · ' + network]);
      const okGo = await confirmSheet('Spend this P2PK coin?', rows);
      if (!okGo) { btn.disabled = false; return toast('Cancelled — nothing sent.'); }
      toast('Spending P2PK…');
      const r = await window.OW.spendP2PK({ source, network, outpoint, toAddress: to, message: msg, broadcast: true, passphrase });
      const res = $('#p2pk_result'); res.style.display = 'block'; res.className = 'mono ok';
      res.textContent = `✓ swept ${r.sent} sat → ${r.to} (fee ${r.fee})  `;
      const a = document.createElement('a'); a.href = r.explorer; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'explorer ↗'; res.appendChild(a);
      toast('✓ P2PK spent', 'ok'); setTimeout(refreshP2PKList, 1500);
    } catch (e) { toast('✗ ' + e.message, 'bad'); btn.disabled = false; }
  }
  $('#p2pk_fundbtn').addEventListener('click', async () => {
    const amt = Number($('#p2pk_amt').value);
    if (!(amt > 0)) return toast('enter an amount (sats) to move into P2PK', 'bad');
    $('#p2pk_fundbtn').disabled = true;
    try {
      toast('Building…');
      const dry = await window.OW.fundP2PK({ source, network, amount: amt, broadcast: false, passphrase });
      const px = await usdPrice();
      const okGo = await confirmSheet('Move coins into P2PK?', [
        ['To', 'your own P2PK (bare public key — no address)'],
        ['Amount', `${amt.toLocaleString()} sat`, `${coins(amt)} ${unit()}${px ? ' · ' + fmtUsd(amt, px) : ''}`],
        ['Network fee', `${dry.fee.toLocaleString()} sat`, px ? fmtUsd(dry.fee, px) : ''],
        ['From', 'Native SegWit · ' + network],
      ]);
      if (!okGo) { $('#p2pk_fundbtn').disabled = false; return toast('Cancelled — nothing sent.'); }
      toast('Funding P2PK…');
      const r = await window.OW.fundP2PK({ source, network, amount: amt, broadcast: true, passphrase });
      const list = p2pkLoad(); list.push({ txid: r.txid, vout: r.vout, amount: r.amount }); p2pkStore(list);
      const res = $('#p2pk_result'); res.style.display = 'block'; res.className = 'mono ok';
      res.textContent = `✓ moved ${r.amount} sat into P2PK (fee ${r.fee})  `;
      const a = document.createElement('a'); a.href = r.explorer; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'explorer ↗'; res.appendChild(a);
      toast('✓ P2PK funded', 'ok'); $('#p2pk_amt').value = ''; setTimeout(refreshLab, 1500);
    } catch (e) { toast('✗ ' + e.message, 'bad'); $('#p2pk_fundbtn').disabled = false; }
  });
  $('#p2pk_refresh').addEventListener('click', refreshP2PKList);
  $('#p2pk_import').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#p2pk_importbtn').click(); });
  $('#p2pk_importbtn').addEventListener('click', async () => {
    const raw = $('#p2pk_import').value.trim();
    if (!raw) return toast('paste the funding txid to recover a coin', 'bad');
    const [txid, voutStr] = raw.split(':'); const vout = Number(voutStr) || 0;
    toast('Looking up…');
    try {
      const o = await window.OW.p2pkImport({ source, network, txid: txid.trim(), vout, passphrase });
      const list = p2pkLoad();
      if (list.some((x) => x.txid === o.txid && x.vout === o.vout)) toast('already tracked');
      else { list.push({ txid: o.txid, vout: o.vout, amount: o.amount }); p2pkStore(list); toast('✓ P2PK coin recovered', 'ok'); }
      $('#p2pk_import').value = ''; refreshP2PKList();
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
  });

  // ---------- OP_RETURN message helpers (example fill + live byte count) ----------
  // Satoshi's genesis message — technically it lived in the genesis COINBASE, not
  // OP_RETURN (which didn't exist until 2014); OP_RETURN is today's equivalent.
  const SATOSHI = 'The Times 03/Jan/2009 Chancellor on brink of second bailout for banks';
  const byteLen = (s) => new TextEncoder().encode(s || '').length;
  function wireMsg(inputId, countId) {
    const inp = $('#' + inputId), cnt = $('#' + countId);
    if (!inp || !cnt) return;
    const upd = () => { const n = byteLen(inp.value); cnt.textContent = `${n} / 80 bytes`; cnt.classList.toggle('over', n > 80); };
    inp.addEventListener('input', upd); upd();
  }
  document.addEventListener('click', (e) => {
    const ex = e.target.closest && e.target.closest('.msgex'); if (!ex) return;
    const inp = $('#' + ex.dataset.fill); if (!inp) return;
    inp.value = SATOSHI; inp.dispatchEvent(new Event('input'));
    toast('Filled Satoshi’s 2009 headline (68 bytes). Satoshi wrote it in the genesis coinbase; OP_RETURN is today’s way.');
  });
  wireMsg('msg', 'msgcount'); wireMsg('p2pk_msg', 'p2pk_msgcount');

  // ---------- send ----------
  let sendType = 'p2wpkh', sendMode = 'pay';
  function populateSendTypes() {
    const sel = $('#send_type'); sel.innerHTML = '';
    const types = mode === 'watch' ? TYPES.filter((t) => t.id === 'p2wpkh') : TYPES.filter((t) => !t.noAddress);
    types.forEach((t) => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; sel.appendChild(o); });
    sel.value = sendType;
    $('#send_typecard').style.display = types.length > 1 ? 'block' : 'none';
  }
  // list other accounts that currently hold spendable coins — used to point the
  // user at a funded account when the one they picked is empty
  function fundedHint(exclude) {
    const others = Object.entries(balances).filter(([k, b]) => k !== exclude && b && b.confirmed > 0);
    if (!others.length) return '';
    return ' Funded now: ' + others.map(([k, b]) => `${SHORT[k]} (${coins(b.confirmed)} ${unit()})`).join(', ') + '.';
  }
  function updateEmptyBanner(b) {
    const el = $('#send_empty');
    if (mode === 'watch' || (b && b.confirmed > 0)) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = `This <b>${SHORT[sendType]}</b> address type has no confirmed coins to spend${b && b.pending ? ' (some are still pending here)' : ''}. Pick a funded one in the <b>Address type</b> selector above.` + fundedHint(sendType);
  }
  async function selectSendType(type) {
    sendType = type;
    $('#send_from').textContent = SHORT[sendType];
    sweepMode = false; $('#sweepnote').style.display = 'none'; $('#amt').value = ''; $('#amt').placeholder = 'e.g. 10000';
    $('#send_bal').textContent = '…';
    try {
      let b = balances[sendType];
      if (!b) { const st = await window.OW.status(source, network, sendType, 0, passphrase); balances[sendType] = st.balance; b = st.balance; }
      $('#send_bal').textContent = `${coins(b.confirmed)} ${unit()} available`;
      updateEmptyBanner(b);
    } catch { $('#send_bal').textContent = 'balance unavailable'; }
  }
  $('#send_type').addEventListener('change', () => selectSendType($('#send_type').value));
  function openSend(fromType) {
    sendType = fromType && fromType !== 'p2pk' ? fromType : 'p2wpkh';
    if (mode === 'watch') sendType = 'p2wpkh';
    $('#send_from').textContent = SHORT[sendType];
    populateSendTypes();
    const b = balances[sendType];
    $('#send_bal').textContent = b ? `${coins(b.confirmed)} ${unit()} available` : '…';
    updateEmptyBanner(b);
    $('#send_wo').style.display = mode === 'watch' ? 'block' : 'none';
    $('#send_p2pk').style.display = 'none';
    const canHot = mode === 'full';
    $('#send').disabled = !canHot; $('#dryrun').disabled = !canHot; $('#maxbtn').disabled = !canHot;
    sweepMode = false; $('#sweepnote').style.display = 'none';
    setSendMode('pay');
    showPane('send');
  }
  function setSendMode(m) {
    sendMode = m;
    $$('#send_mode .feep').forEach((x) => x.classList.toggle('active', x.dataset.mode === m));
    $('#send_pay').style.display = m === 'pay' ? 'block' : 'none';
    $('#send').textContent = m === 'msg' ? 'Write on the chain' : 'Send';
    // in message-only mode the note becomes required and the explainer opens
    if (m === 'msg') {
      $('#orbody').style.display = 'block'; $('#orchev').textContent = 'Hide ▴'; $('#msg').focus();
      if (network === 'mainnet') toast('Mainnet: this writes to every Bitcoin node, forever. Testnets are the place to practise.', 'bad');
    }
  }
  $$('#send_mode .feep').forEach((b) => b.addEventListener('click', () => setSendMode(b.dataset.mode)));
  $('#maxbtn').addEventListener('click', () => {
    sweepMode = true; $('#sweepnote').style.display = 'block';
    const b = balances[sendType]; $('#amt').value = ''; $('#amt').placeholder = b ? `~${b.confirmed.toLocaleString()} sat minus fee` : 'everything minus fee';
    toast('Sweep mode: everything (minus fee) goes to the destination.');
  });
  $('#amt').addEventListener('input', () => { if ($('#amt').value) { sweepMode = false; $('#sweepnote').style.display = 'none'; } });
  // OP_RETURN explainer expand/collapse
  // only the header toggles; clicks inside the explainer body, the message input,
  // or the tools row never collapse it (so you can select/copy the text)
  $('#orchev').addEventListener('click', (e) => { e.stopPropagation(); toggleOr(); });
  $('#ormore').addEventListener('click', (e) => {
    if (e.target.id === 'msg' || (e.target.closest && (e.target.closest('.msgtools') || e.target.closest('#orbody')))) return;
    toggleOr();
  });
  function toggleOr() {
    const open = $('#orbody').style.display !== 'block';
    $('#orbody').style.display = open ? 'block' : 'none';
    $('#orchev').textContent = open ? 'Hide ▴' : "What's this? ▾";
  }
  // fee presets — Auto ('') = engine asks the network for an estimate
  const setFeeActive = () => $$('#fee_presets .feep').forEach((x) => x.classList.toggle('active', x.dataset.fee === $('#fee').value));
  $('#fee').value = '';
  $$('#fee_presets .feep').forEach((b) => b.addEventListener('click', () => { $('#fee').value = b.dataset.fee; setFeeActive(); }));
  $('#fee').addEventListener('input', setFeeActive);

  // message-only = a sweep back to your own address carrying the OP_RETURN, so
  // no coins leave the wallet — the purest "just write on the chain".
  const buildTx = (broadcast) => {
    const msg = $('#msg').value;
    if (sendMode === 'msg') return window.OW.sweep({ mnemonic: source, network, scriptType: sendType, toAddress: myAddress(), message: msg, feeRate: $('#fee').value, broadcast, passphrase });
    if (sweepMode) return window.OW.sweep({ mnemonic: source, network, scriptType: sendType, toAddress: $('#to').value, message: msg, feeRate: $('#fee').value, broadcast, passphrase });
    return window.OW.send({ mnemonic: source, network, scriptType: sendType, toAddress: $('#to').value, amount: $('#amt').value, message: msg, feeRate: $('#fee').value, broadcast, passphrase });
  };
  const myAddress = () => window.OW.info(source, network, sendType, 0, passphrase).address;

  // SECURITY INVARIANT: build ONCE, decode the actual transaction for display,
  // confirm, then broadcast the EXACT SAME BYTES. After the confirmation sheet
  // is shown, nothing is re-fetched, re-selected, re-priced, or re-signed.
  async function runSend(broadcast) {
    const msgOnly = sendMode === 'msg';
    const to = msgOnly ? myAddress() : $('#to').value.trim();
    if (!to) return toast('enter a destination address', 'bad');
    if (msgOnly && !$('#msg').value.trim()) return toast('type the message you want to write on the chain', 'bad');
    try {
      toast('Building…');
      const built = await buildTx(false);      // signed but NOT broadcast — frozen bytes
      if (!broadcast) return renderResult(built, false);
      const frozenHex = built.txHex, frozenTxid = built.txid;
      if (!frozenHex) throw new Error('engine did not return the built transaction — refusing to continue');
      const px = await usdPrice();
      // render the confirmation from the transaction itself, not the form.
      // change now lands on the CHANGE chain (built.changeAddress), so mark that
      // (or the self-address in message-only mode) as change — everything else is external.
      const dec = window.OW.decodeTx({ hex: frozenHex, network });
      const mine = myAddress();
      const changeAddr = built.changeAddress || mine;
      const rows = [];
      for (const o of dec.outputs) {
        if (o.type === 'op_return') rows.push(['OP_RETURN', `“${(o.opReturn || '').slice(0, 48)}”`, 'permanent public message']);
        else if (o.address === changeAddr || o.address === mine) rows.push([msgOnly ? 'Back to you' : 'Change (back to you)', o.address, `${o.amount.toLocaleString()} sat`]);
        else rows.push(['To', o.address || `(unknown script)`, `${o.amount.toLocaleString()} sat · ${coins(o.amount)} ${unit()}${px ? ' · ' + fmtUsd(o.amount, px) : ''}`]);
      }
      rows.push(['Network fee', `${built.fee.toLocaleString()} sat`, `${built.feeRate} sat/vB${px ? ' · ' + fmtUsd(built.fee, px) : ''}`]);
      // abnormal-fee tripwires: % of what leaves the wallet, and absolute rate
      const paidOut = dec.outputs.filter((o) => o.type !== 'op_return' && o.address !== mine && o.address !== changeAddr).reduce((a, o) => a + o.amount, 0);
      const feePct = paidOut > 0 ? (built.fee / paidOut) * 100 : 0;
      if (feePct > 10) rows.push(['⚠ UNUSUALLY HIGH FEE', `${feePct.toFixed(1)}% of the amount sent`, 'check the fee field before confirming']);
      if (built.feeRate > 200) rows.push(['⚠ HIGH FEE RATE', `${built.feeRate} sat/vB`, 'typical is 1–20; confirm this is deliberate']);
      rows.push(['From', SHORT[sendType] + ' · ' + network]);
      rows.push(['txid', frozenTxid.slice(0, 16) + '…', 'this exact transaction will be sent']);
      const okGo = await confirmSheet(msgOnly ? 'Write this on the chain?' : sweepMode ? 'Sweep everything?' : 'Send this?', rows, msgOnly ? 'Write it' : 'Confirm & send');
      if (!okGo) return toast('Cancelled — nothing sent.');
      toast('Broadcasting…');
      const res = await window.OW.broadcastHex({ hex: frozenHex, network });
      renderResult({ ...built, broadcastTxid: res.txid, explorer: res.explorer }, true);
    } catch (e) {
      let m = e.message;
      // the most common tripwire: trying to spend from an empty script-type account
      if (/no UTXOs|insufficient|not enough|no coins/i.test(m)) {
        m = `The ${SHORT[sendType]} address type has no spendable coins here. Switch the Address type selector at the top of this screen to a funded one.` + fundedHint(sendType);
        updateEmptyBanner(balances[sendType]);
      }
      toast('✗ ' + m, 'bad');
    }
  }
  $('#dryrun').addEventListener('click', () => runSend(false));
  $('#send').addEventListener('click', () => runSend(true));
  function renderResult(res, broadcast) {
    const r = $('#result'); r.textContent = ''; r.className = 'mono';
    const line = (t) => { const d = document.createElement('div'); d.textContent = t; r.appendChild(d); };
    line(broadcast ? '✓ BROADCAST' : '· DRY RUN (nothing sent)');
    const row = document.createElement('div'); row.textContent = 'txid: ' + res.txid;
    const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'sec copy'; cp.textContent = 'Copy'; cp.style.marginLeft = '8px';
    cp.addEventListener('click', () => navigator.clipboard.writeText(res.txid).then(() => { cp.textContent = '✓'; setTimeout(() => { cp.textContent = 'Copy'; }, 1200); }).catch(() => {}));
    row.appendChild(cp); r.appendChild(row);
    line(`fee: ${res.fee} sat · vsize: ${res.vsize} · ${res.feeRate} sat/vB`);
    if (res.swept != null) line(`sweeping ${res.swept} sat → ${res.to}`);
    if (broadcast && res.explorer) { const a = document.createElement('a'); a.href = res.explorer; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'view on explorer ↗'; r.appendChild(a); }
    r.style.display = 'block';
    toast(broadcast ? '✓ sent' : 'built (dry run) — nothing broadcast', broadcast ? 'ok' : '');
    if (broadcast) setTimeout(refreshAll, 1600);
  }

  // ---------- learn ----------
  const LESSONS = [
    ['Entropy', 'A wallet is a very large secret number. If it’s <b>random enough</b>, nobody can ever guess it — there are more possible keys (2<sup>256</sup>) than atoms in the observable universe. Weak randomness is how early browser wallets were drained. Olesia draws entropy from your OS’s cryptographic generator.'],
    ['The seed phrase', 'That number is encoded as <b>12 or 24 words</b> (BIP-39). The words <i>are</i> the wallet — no reset, no recovery without them. Write them on paper, in order. A photo in your camera roll is a photo in someone’s cloud.'],
    ['Keys', 'From the seed come <b>private keys</b>; each has a <b>public key</b> made by one-way maths. You sign with the private key; anyone can verify with the public one. Olesia signs with RFC-6979 deterministic nonces — the classic nonce-reuse mistake is impossible by construction.'],
    ['Addresses', 'An address is <b>a lock, not a place</b> — a friendly encoding of the rule “satisfy this script to spend”. Different script types are different locks, which is why one seed gives you five different addresses. Explore them under Addresses.'],
    ['UTXOs', 'Bitcoin has no balance field. You own discrete chunks — <b>unspent transaction outputs</b> — like odd-denomination coins in a pocket. A payment consumes some coins and mints new ones: one to the recipient, change back to you.'],
    ['Fees', 'Miners include transactions that pay them, priced in <b>sat/vB</b>. Busier network → higher rate to confirm fast. <b>Auto</b> in the Send screen asks the network for a live estimate; on testnets fees barely matter, so experiment freely.'],
    ['Networks', '<b>Testnet3/4</b> and <b>Signet</b> share mainnet’s rules but use worthless coins — perfect for practice. <b>Mainnet</b> is real money. Every test network uses the same key maths, so what you learn here is the real thing, pointed at a playground.'],
    ['Hot vs cold', 'A <b>hot</b> wallet keeps keys on a connected device — convenient, fine for small amounts. A <b>cold</b> wallet generates and signs offline, so keys never touch the internet. The one rule: real value belongs in cold storage — use the <a href="https://offline.olesia.io" target="_blank" rel="noopener">cold generator</a> and the air-gap tools.'],
    ['Writing on-chain', 'OP_RETURN attaches a tiny permanent note to a transaction — no coins, unspendable, forever public. Satoshi set the tone by writing a newspaper headline into the first block. Know the debate: critics say block space is for money and every byte lives on every node forever; supporters note OP_RETURN was <i>designed</i> as the honest, prunable way to carry a small note — kinder than hiding data in fake addresses that bloat the UTXO set. Olesia teaches only the tidy form: 80 bytes, one output, no inscriptions. Practice on testnets; on mainnet, ask if it truly needs to be forever.'],
  ];
  const learnRead = () => { try { return new Set(JSON.parse(localStorage.getItem('olesia:learn') || '[]')); } catch { return new Set(); } };
  function renderLearn() {
    const read = learnRead(); const box = $('#lessons'); box.textContent = '';
    LESSONS.forEach(([title, body], i) => {
      const d = document.createElement('div'); d.className = 'lesson' + (read.has(i) ? ' done' : '');
      d.innerHTML = `<button><span class="n">${String(i + 1).padStart(2, '0')}</span> ${title} <span class="chk">${read.has(i) ? '✓' : ''}</span></button><div class="body">${body}</div>`;
      d.querySelector('button').addEventListener('click', () => {
        d.classList.toggle('open');
        if (d.classList.contains('open')) {
          const r = learnRead(); r.add(i);
          try { localStorage.setItem('olesia:learn', JSON.stringify([...r])); } catch {}
          d.querySelector('.chk').textContent = '✓'; updateLearnProg();
        }
      });
      box.appendChild(d);
    });
    updateLearnProg();
  }
  function updateLearnProg() {
    const n = learnRead().size;
    $('#learn_bar').style.width = (n / LESSONS.length * 100) + '%';
    $('#learn_progtext').textContent = `${n} of ${LESSONS.length}` + (n === LESSONS.length ? ' — all done 🎉' : '');
  }
  renderLearn();

  // ---------- settings ----------
  const tog = (id) => $(id).classList.toggle('on');
  $('#set_xpub').addEventListener('click', () => {
    try {
      const xpub = mode === 'watch' ? source : window.OW.xpub(source, network, passphrase);
      const d = window.OW.descriptors({ source, network, passphrase });
      $('#set_xpub_out').textContent =
        `Account key (${xpub.slice(0, 4)}):\n${xpub}\n\n` +
        `Output descriptors — the unambiguous way to import this wallet as watch-only ` +
        `(Bitcoin Core / Sparrow). They carry the script type, fingerprint, path and branch:\n\n` +
        `receive:\n${d.receive}\n\nchange:\n${d.change}`;
      tog('#xpub_body');
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
  });
  $('#set_vault').addEventListener('click', () => tog('#vault_body'));
  $('#set_addwallet').addEventListener('click', async () => {
    const saved = window.OW.vault.exists();
    const ok = await confirmSheet('Switch wallet?', [
      ['Current wallet', saved ? 'stays saved on this device (encrypted)' : 'NOT saved — you need its words to reopen it'],
      ['Coins', 'always safe on-chain — a wallet is just the keys'],
    ], 'Continue');
    if (!ok) return;
    source = ''; mode = ''; passphrase = ''; Object.keys(balances).forEach((k) => delete balances[k]);
    $('#lockbtn').style.display = 'none';
    showPane('welcome');
  });
  $('#set_airgap').addEventListener('click', () => tog('#airgap_body'));
  $('#vsave').addEventListener('click', async () => {
    if (!source || mode !== 'full') return toast('open a wallet with a seed first', 'bad');
    const pin = await askPin({ mainnet: network === 'mainnet' }); if (pin == null) return;
    toast('Encrypting…'); await new Promise((r) => setTimeout(r, 30));
    try {
      window.OW.vault.save(source, pin, passphrase, network);
      $('#vault_state').textContent = 'saved encrypted on this device';
      toast('✓ saved — next visit, unlock with your PIN', 'ok');
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
  });
  function wireForget(btn) {
    btn.addEventListener('click', () => {
      if (!forgetArmed) { forgetArmed = true; btn.textContent = 'Really forget? Coins stay on-chain; you need the words to restore. Tap again.'; return; }
      window.OW.vault.forget(); forgetArmed = false;
      btn.textContent = 'Forget saved wallet…';
      $('#vault_state').textContent = 'not saved — seed lives in this tab only';
      $('#unlock').classList.remove('on');
      toast('Saved wallet removed from this device.');
      if (!source) showPane('welcome');
    });
  }
  wireForget($('#vforget')); wireForget($('#vforget2'));

  // ---------- air-gap ----------
  $('#buildunsigned').addEventListener('click', async () => {
    try {
      toast('Building unsigned PSBT…');
      const u = await window.OW.buildUnsigned({ source, network, toAddress: $('#to').value, amount: $('#amt').value, message: $('#msg').value, feeRate: $('#fee').value, passphrase });
      $('#unsignedout').value = u.psbt;
      const r = $('#agresult'); r.style.display = 'block'; r.className = 'mono ok';
      r.textContent = `unsigned PSBT built — fee ${u.fee} sat, ~${u.vsize} vB. Copy it to your offline signer.`;
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
  });
  // SECURITY INVARIANT: verify-before-sign. The PSBT (and the online machine
  // that built it) is untrusted. Decode it independently, verify which coins
  // are ours and which outputs are cryptographically OUR change, compute the
  // fee ourselves, show everything — and only then allow signing.
  $('#signbtn').addEventListener('click', async () => {
    try {
      if (mode !== 'full') return toast('signing needs the seed', 'bad');
      if (network === 'mainnet' && navigator.onLine) toast('⚠ signing a mainnet PSBT while ONLINE — for real funds, do this offline.', 'bad');
      const psbt = $('#signin').value.trim() || $('#unsignedout').value.trim();
      if (!psbt) return toast('paste an unsigned PSBT to sign', 'bad');
      const d = window.OW.describePsbt({ psbt, source, network, passphrase });
      const rows = [['Network', (NETLABEL[network] || network) + (network === 'mainnet' ? ' — REAL bitcoin' : '')]];
      d.inputs.forEach((inp, i) => rows.push([
        `Input ${i + 1}`,
        inp.amount != null ? `${inp.amount.toLocaleString()} sat` : '⚠ amount unknown',
        inp.mine ? `✓ this wallet's coin · ${inp.path}` : "⚠ NOT this wallet's coin",
      ]));
      d.outputs.forEach((o) => {
        if (o.type === 'op_return') rows.push(['OP_RETURN', `“${(o.opReturn || '').slice(0, 40)}”`, 'permanent public message']);
        else if (o.change) rows.push(['Change — verified yours', o.address, `${o.amount.toLocaleString()} sat · ${o.path}`]);
        else rows.push(['PAYMENT → external', o.address || '(unknown script)', `${o.amount.toLocaleString()} sat — leaves the wallet`]);
      });
      rows.push(['Network fee (computed)', d.fee != null ? `${d.fee.toLocaleString()} sat` : 'UNKNOWN — cannot verify', d.feeRate != null ? `≈${d.feeRate} sat/vB` : '']);
      const okGo = await confirmSheet('Sign this transaction?', rows, 'Sign');
      if (!okGo) return toast('Cancelled — nothing signed.');
      const s = window.OW.signPsbt({ psbt, mnemonic: source, network, passphrase });
      $('#signedout').value = s.psbt;
      const r = $('#agresult'); r.style.display = 'block'; r.className = 'mono ok';
      r.textContent = `signed ✓ txid ${s.txid} — copy the signed PSBT to broadcast.`;
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
  });
  $('#bcbtn').addEventListener('click', async () => {
    try {
      const psbt = $('#bcin').value.trim() || $('#signedout').value.trim();
      if (!psbt) return toast('paste a signed PSBT to broadcast', 'bad');
      toast('Broadcasting…');
      const res = await window.OW.broadcastPsbt({ psbt, network });
      const r = $('#agresult'); r.style.display = 'block'; r.className = 'mono ok'; r.textContent = '✓ broadcast — txid ' + res.txid + '  ';
      const a = document.createElement('a'); a.href = res.explorer; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'explorer ↗'; r.appendChild(a);
      setTimeout(refreshAll, 1600);
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
  });

  // ---------- vault unlock (startup): PIN keypad + passphrase fallback ----------
  let pinBuf = '', padMode = true;
  // auto-submit once the PIN reaches its known length (default 6). If length was
  // never stored (older vault) and a 6-digit auto-attempt fails, fall back to
  // manual so a longer PIN can still be typed.
  const storedLen = (() => { try { return localStorage.getItem('olesia:pinlen'); } catch { return null; } })();
  let pinLen = storedLen ? +storedLen : 6, autoOn = true, lenKnown = !!storedLen;
  function renderDots() {
    const d = $('#pindots'); d.textContent = '';
    const n = Math.max(pinBuf.length, autoOn ? pinLen : 6);
    for (let i = 0; i < n; i++) { const s = document.createElement('i'); if (i < pinBuf.length) s.className = 'fill'; d.appendChild(s); }
  }
  renderDots();
  const pinDigit = (k) => {
    if (k === 'back') pinBuf = pinBuf.slice(0, -1);
    else if (pinBuf.length < 12) pinBuf += k;
    $('#vmsg').textContent = '';
    renderDots();
    if (autoOn && padMode && k !== 'back' && pinBuf.length >= pinLen) unlockVault();
  };
  $('#pad').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !b.dataset.k) return;
    pinDigit(b.dataset.k);
  });
  $('#pad_abc').addEventListener('click', () => {
    padMode = !padMode;
    $('#pad_abc').textContent = padMode ? 'abc' : '123';
    $('#vpinrow').style.display = padMode ? 'none' : 'flex';
    $('#pad').style.display = padMode ? 'grid' : 'none';
    $('#pindots').style.display = padMode ? 'flex' : 'none';
    pinBuf = ''; renderDots();
    if (!padMode) $('#vpin').focus();
  });
  let unlocking = false;
  async function unlockVault() {
    if (unlocking) return;
    const pin = padMode ? pinBuf : $('#vpin').value;
    if (!pin) return ($('#vmsg').textContent = padMode ? 'tap your PIN digits first' : 'enter your passphrase');
    unlocking = true;
    $('#vmsg').textContent = 'Unlocking…';
    await new Promise((r) => setTimeout(r, 30));
    try {
      const v = window.OW.vault.open(pin);
      pinBuf = ''; $('#vpin').value = ''; renderDots(); $('#vmsg').textContent = '';
      source = v.m; passphrase = v.p || ''; mode = 'full'; scriptType = 'p2wpkh';
      $('#unlock').classList.remove('on');
      initWallet();
    } catch (e) {
      // a failed auto-submit on a vault with no stored length means the real PIN is
      // probably longer than 6 — stop auto-submitting so the rest can be typed
      if (autoOn && padMode && !lenKnown) { autoOn = false; $('#vmsg').textContent = 'longer PIN? type it all, then tap Unlock'; }
      else { $('#vmsg').textContent = '✗ ' + e.message; }
      pinBuf = ''; renderDots();
    }
    unlocking = false;
  }
  $('#vunlock').addEventListener('click', unlockVault);
  $('#vpin').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockVault(); });
  // physical keyboard works on the keypad too
  document.addEventListener('keydown', (e) => {
    if (!$('#unlock').classList.contains('on') || !padMode) return;
    if (/^[0-9]$/.test(e.key)) pinDigit(e.key);
    else if (e.key === 'Backspace') pinDigit('back');
    else if (e.key === 'Enter') unlockVault();
  });

  // ---------- seed backup viewer (PIN-gated) ----------
  $('#set_backup').addEventListener('click', () => {
    if (mode !== 'full') return toast('watch-only wallets have no seed here', 'bad');
    const body = $('#backup_body');
    if (body.classList.contains('on')) { hideBackup(); body.classList.remove('on'); return; }
    body.classList.add('on');
    const saved = window.OW.vault.exists();
    $('#bk_pinrow').style.display = saved ? 'flex' : 'none';
    $('#bk_hold').style.display = saved ? 'none' : 'block';
  });
  function hideBackup() {
    $('#bk_show').style.display = 'none'; $('#bk_words').textContent = '';
    $('#bk_gate').style.display = 'block'; $('#bk_pin').value = '';
    clearTimeout(bkTimer);
  }
  let bkTimer;
  function showWords(m, p) {
    const box = $('#bk_words'); box.textContent = '';
    m.trim().split(/\s+/).forEach((w, i) => {
      const s = document.createElement('span'); const n = document.createElement('i');
      n.textContent = i + 1; s.append(n, w); box.appendChild(s);
    });
    if (p) {
      const s = document.createElement('span'); s.style.gridColumn = '1 / -1'; s.style.color = 'var(--accent)';
      s.textContent = `+ passphrase set (not shown — remember it separately; it is part of this wallet). Wallet fingerprint: ${walletFP()} — check this matches when you restore, to prove the passphrase was right.`;
      box.appendChild(s);
    }
    $('#bk_gate').style.display = 'none'; $('#bk_show').style.display = 'block';
    clearTimeout(bkTimer); bkTimer = setTimeout(hideBackup, 60000); // auto-hide after 60s
  }
  $('#bk_reveal').addEventListener('click', async () => {
    const pin = $('#bk_pin').value;
    if (!pin) return toast('enter your PIN', 'bad');
    toast('Checking…'); await new Promise((r) => setTimeout(r, 30));
    try { const v = window.OW.vault.open(pin); showWords(v.m, v.p); toast('Revealed — auto-hides in 60s.'); }
    catch (e) { toast('✗ ' + e.message, 'bad'); }
  });
  $('#bk_pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#bk_reveal').click(); });
  // no vault saved -> no PIN exists to check; require a deliberate 1.5s hold instead
  let holdT;
  const holdBtn = $('#bk_hold');
  const startHold = () => { holdBtn.textContent = 'Keep holding…'; holdT = setTimeout(() => { showWords(source, passphrase); holdBtn.textContent = 'Hold to reveal (1.5s)…'; }, 1500); };
  const endHold = () => { clearTimeout(holdT); holdBtn.textContent = 'Hold to reveal (1.5s)…'; };
  holdBtn.addEventListener('mousedown', startHold); holdBtn.addEventListener('touchstart', startHold, { passive: true });
  holdBtn.addEventListener('mouseup', endHold); holdBtn.addEventListener('mouseleave', endHold); holdBtn.addEventListener('touchend', endHold);

  // ---------- boot ----------
  if (window.OW.vault.exists()) { $('#unlock').classList.add('on'); }
  else showPane('welcome');
})();
