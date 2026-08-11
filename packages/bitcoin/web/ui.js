// Olesia app shell — Home · Accounts · Learn · Settings. All signing/derivation
// lives in window.OW (entry.js); this file is pure UI state + wiring.
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  // ---------- state ----------
  let source = '', mode = '', network = 'testnet4', scriptType = 'p2wpkh';
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
  function confirmSheet(title, rows) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      $('#c_title').textContent = title;
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
  window.OW.networks.forEach((n) => {
    for (const sel of [$('#net'), $('#set_net')]) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); }
  });
  $('#net').value = network; $('#set_net').value = network;
  function updateChips() {
    $('#netname').textContent = network;
    $('#netchip').classList.toggle('main', network === 'mainnet');
    const c = $('#chip_net');
    if (network === 'mainnet') { c.className = 'practice main'; c.textContent = '⚠ REAL bitcoin — small amounts only'; }
    else { c.className = 'practice'; c.textContent = `Practice mode — ${network} coins have no value`; }
    $('#bal_unit').textContent = unit();
    $('#mainwarn').style.display = network === 'mainnet' ? 'block' : 'none';
    $('#mainwarn').textContent = '⚠ Mainnet — REAL bitcoin. A seed opens as a hot wallet (keep amounts small); an xpub opens watch-only. For meaningful funds use the cold generator + air-gap tools.';
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
    showPane('create4');
  });
  function openCreated() { source = wizMnemonic; mode = 'full'; scriptType = 'p2wpkh'; wizMnemonic = ''; moveEntropy = ''; moveSamples = 0; $('#c_words').textContent = ''; $('#dice').value = ''; initWallet(); }
  $('#c_save').addEventListener('click', async () => {
    const pin = $('#c_pin').value;
    toast('Encrypting…'); await new Promise((r) => setTimeout(r, 30));
    try { window.OW.vault.save(wizMnemonic, pin); $('#c_pin').value = ''; openCreated(); }
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
    $('#mnemonic').value = '';
    initWallet();
  }

  function initWallet() {
    $('#lockbtn').style.display = 'inline-block';
    $('#vault_state').textContent = window.OW.vault.exists() ? 'saved encrypted on this device' : 'not saved — seed lives in this tab only';
    $('#acct_watchnote').style.display = mode === 'watch' ? 'block' : 'none';
    renderAccountRows();
    showPane('home');
    toast(mode === 'watch' ? 'Watch-only wallet opened (xpub).' : '✓ Wallet open', 'ok');
    refreshAll();
  }

  function lock() { location.reload(); } // hard reset clears the seed from memory
  $('#lockbtn').addEventListener('click', lock);
  $('#set_lock').addEventListener('click', lock);

  // ---------- balances / accounts ----------
  const typesFor = () => (mode === 'watch' ? TYPES.filter((t) => t.id === 'p2wpkh') : TYPES);

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
        } else {
          const st = await window.OW.status(source, network, t.id);
          balances[t.id] = st.balance;
        }
      } catch { balances[t.id] = balances[t.id] || null; }
    });
    await Promise.allSettled(jobs);
    if (g !== gen) return;
    renderAccountRows(); renderTotal();
    refreshHomeActivity(g);
  }
  function renderTotal() {
    const total = sum(balances);
    const pend = Object.values(balances).reduce((a, b) => a + (b?.pending || 0), 0);
    $('#bal_total').innerHTML = (hideBal ? '••••' : coins(total)) + `<span class="u">${unit()}</span>`;
    $('#bal_sub').textContent = pend ? `+ ${hideBal ? '•' : coins(pend)} pending` : '';
    $('#bal_sub').style.display = pend ? 'block' : 'none';
  }
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
      const txs = await window.OW.history(source, network, 'p2wpkh');
      if (g !== gen) return;
      const box = $('#home_activity'); box.textContent = '';
      if (!txs.length) { box.innerHTML = '<div class="hint" style="padding:8px 0">No transactions yet — get coins from the faucet to start.</div>'; return; }
      const base = window.OW.explorer(network);
      txs.slice(0, 5).forEach((t) => {
        const d = document.createElement('div'); d.className = 'tx';
        const dir = t.net >= 0;
        d.innerHTML = `<span class="ti" style="color:${dir ? 'var(--mint)' : 'var(--accent)'}">${dir ? '↙' : '↗'}</span>
          <span><b>${dir ? 'Received' : 'Sent'}</b><br><a href="${base}${t.txid}" target="_blank" rel="noopener" style="font-size:11.5px;color:var(--faint)">${t.confirmed ? 'confirmed' : 'pending'} · ${t.txid.slice(0, 8)}… ↗</a></span>
          <span class="v" style="color:${dir ? 'var(--mint)' : 'var(--text)'}">${dir ? '+' : '−'}${Math.abs(t.net).toLocaleString()} sat</span>`;
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
    $('#acc_about').textContent = t.about; $('#acc_about').style.display = 'none'; $('#acc_moretog').textContent = 'about ▾';
    $('#lab').style.display = type === 'p2pk' && mode === 'full' ? 'block' : 'none';
    $('#acc_label').style.display = type === 'p2pk' ? 'none' : 'block';
    try {
      const info = window.OW.info(source, network, type);
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
    try { const a = window.OW.info(source, network, scriptType).address; if (a) localStorage.setItem('olesia:label:' + a, $('#acc_label').value); } catch {}
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
      const st = await window.OW.status(source, network, scriptType);
      if (g !== gen) return;
      balances[scriptType] = st.balance;
      $('#acc_bal').textContent = `${coins(st.balance.confirmed)} ${unit()} confirmed` + (st.balance.pending ? ` · ${coins(st.balance.pending)} pending` : '');
      $('#acc_utxos').textContent = st.utxos.length ? st.utxos.map((u) => `${u.value.toLocaleString()} sat ${u.confirmed ? '✓' : '⧗'}`).join('  ·  ') : '(no UTXOs yet)';
      renderTotal(); renderAccountRows();
    } catch (e) { if (g === gen) toast('✗ ' + e.message, 'bad'); }
    try {
      const txs = await window.OW.history(source, network, scriptType);
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
  const p2pkKey = () => { try { return `olesia:p2pk:${network}:${window.OW.info(source, network, 'p2pk').scriptHex}`; } catch { return `olesia:p2pk:${network}:x`; } };
  const p2pkLoad = () => { try { return JSON.parse(localStorage.getItem(p2pkKey()) || '[]'); } catch { return []; } };
  const p2pkStore = (l) => { try { localStorage.setItem(p2pkKey(), JSON.stringify(l)); } catch {} };
  async function refreshLab() {
    try {
      const st = await window.OW.status(source, network, 'p2wpkh');
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
      const dry = await window.OW.spendP2PK({ source, network, outpoint, toAddress: to, broadcast: false });
      const px = await usdPrice();
      const okGo = await confirmSheet('Spend this P2PK coin?', [
        ['To', to],
        ['Amount', `${dry.sent.toLocaleString()} sat`, `${coins(dry.sent)} ${unit()}${px ? ' · ' + fmtUsd(dry.sent, px) : ''}`],
        ['Network fee', `${dry.fee.toLocaleString()} sat`, px ? fmtUsd(dry.fee, px) : ''],
        ['From', 'P2PK (bare public key) · ' + network],
      ]);
      if (!okGo) { btn.disabled = false; return toast('Cancelled — nothing sent.'); }
      toast('Spending P2PK…');
      const r = await window.OW.spendP2PK({ source, network, outpoint, toAddress: to, broadcast: true });
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
      const dry = await window.OW.fundP2PK({ source, network, amount: amt, broadcast: false });
      const px = await usdPrice();
      const okGo = await confirmSheet('Move coins into P2PK?', [
        ['To', 'your own P2PK (bare public key — no address)'],
        ['Amount', `${amt.toLocaleString()} sat`, `${coins(amt)} ${unit()}${px ? ' · ' + fmtUsd(amt, px) : ''}`],
        ['Network fee', `${dry.fee.toLocaleString()} sat`, px ? fmtUsd(dry.fee, px) : ''],
        ['From', 'Native SegWit · ' + network],
      ]);
      if (!okGo) { $('#p2pk_fundbtn').disabled = false; return toast('Cancelled — nothing sent.'); }
      toast('Funding P2PK…');
      const r = await window.OW.fundP2PK({ source, network, amount: amt, broadcast: true });
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
      const o = await window.OW.p2pkImport({ source, network, txid: txid.trim(), vout });
      const list = p2pkLoad();
      if (list.some((x) => x.txid === o.txid && x.vout === o.vout)) toast('already tracked');
      else { list.push({ txid: o.txid, vout: o.vout, amount: o.amount }); p2pkStore(list); toast('✓ P2PK coin recovered', 'ok'); }
      $('#p2pk_import').value = ''; refreshP2PKList();
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
  });

  // ---------- send ----------
  let sendType = 'p2wpkh';
  function openSend(fromType) {
    sendType = fromType && fromType !== 'p2pk' ? fromType : 'p2wpkh';
    if (mode === 'watch') sendType = 'p2wpkh';
    $('#send_from').textContent = SHORT[sendType];
    const b = balances[sendType];
    $('#send_bal').textContent = b ? `${coins(b.confirmed)} ${unit()} available` : '…';
    $('#send_wo').style.display = mode === 'watch' ? 'block' : 'none';
    $('#send_p2pk').style.display = 'none';
    const canHot = mode === 'full';
    $('#send').disabled = !canHot; $('#dryrun').disabled = !canHot; $('#maxbtn').disabled = !canHot;
    sweepMode = false; $('#sweepnote').style.display = 'none';
    showPane('send');
  }
  $('#maxbtn').addEventListener('click', () => {
    sweepMode = true; $('#sweepnote').style.display = 'block';
    const b = balances[sendType]; $('#amt').value = ''; $('#amt').placeholder = b ? `~${b.confirmed.toLocaleString()} sat minus fee` : 'everything minus fee';
    toast('Sweep mode: everything (minus fee) goes to the destination.');
  });
  $('#amt').addEventListener('input', () => { if ($('#amt').value) { sweepMode = false; $('#sweepnote').style.display = 'none'; } });
  // OP_RETURN explainer expand/collapse
  $('#ormore').addEventListener('click', (e) => {
    if (e.target.id === 'msg') return;
    const open = $('#orbody').style.display !== 'block';
    $('#orbody').style.display = open ? 'block' : 'none';
    $('#orchev').textContent = open ? 'Hide ▴' : "What's this? ▾";
  });
  // fee presets — Auto ('') = engine asks the network for an estimate
  const setFeeActive = () => $$('.feep').forEach((x) => x.classList.toggle('active', x.dataset.fee === $('#fee').value));
  $('#fee').value = '';
  $$('.feep').forEach((b) => b.addEventListener('click', () => { $('#fee').value = b.dataset.fee; setFeeActive(); }));
  $('#fee').addEventListener('input', setFeeActive);

  const buildTx = (broadcast) => sweepMode
    ? window.OW.sweep({ mnemonic: source, network, scriptType: sendType, toAddress: $('#to').value, feeRate: $('#fee').value, broadcast })
    : window.OW.send({ mnemonic: source, network, scriptType: sendType, toAddress: $('#to').value, amount: $('#amt').value, message: $('#msg').value, feeRate: $('#fee').value, broadcast });

  async function runSend(broadcast) {
    const to = $('#to').value.trim();
    if (!to) return toast('enter a destination address', 'bad');
    try {
      toast('Building…');
      // Always dry-run first: the confirmation shows the REAL fee and amounts
      // from the actual transaction, never an estimate.
      const dry = await buildTx(false);
      if (!broadcast) return renderResult(dry, false);
      const px = await usdPrice();
      const amount = sweepMode ? dry.swept : Number($('#amt').value);
      const msg = $('#msg').value.trim();
      const rows = [
        ['To', to],
        [sweepMode ? 'Amount (sweep)' : 'Amount', `${amount.toLocaleString()} sat`, `${coins(amount)} ${unit()}${px ? ' · ' + fmtUsd(amount, px) : ''}`],
        ['Network fee', `${dry.fee.toLocaleString()} sat`, `${dry.feeRate} sat/vB${px ? ' · ' + fmtUsd(dry.fee, px) : ''}`],
      ];
      if (msg) rows.push(['OP_RETURN', `“${msg.slice(0, 40)}${msg.length > 40 ? '…' : ''}”`, 'permanent public message']);
      rows.push(['From', SHORT[sendType] + ' · ' + network]);
      const okGo = await confirmSheet(sweepMode ? 'Sweep everything?' : 'Send this?', rows);
      if (!okGo) return toast('Cancelled — nothing sent.');
      toast('Broadcasting…');
      renderResult(await buildTx(true), true);
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
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
    ['Addresses', 'An address is <b>a lock, not a place</b> — a friendly encoding of the rule “satisfy this script to spend”. Different script types are different locks, which is why one seed gives you five different addresses. Explore them in Accounts.'],
    ['UTXOs', 'Bitcoin has no balance field. You own discrete chunks — <b>unspent transaction outputs</b> — like odd-denomination coins in a pocket. A payment consumes some coins and mints new ones: one to the recipient, change back to you.'],
    ['Fees', 'Miners include transactions that pay them, priced in <b>sat/vB</b>. Busier network → higher rate to confirm fast. <b>Auto</b> in the Send screen asks the network for a live estimate; on testnets fees barely matter, so experiment freely.'],
    ['Networks', '<b>Testnet3/4</b> and <b>Signet</b> share mainnet’s rules but use worthless coins — perfect for practice. <b>Mainnet</b> is real money. Every test network uses the same key maths, so what you learn here is the real thing, pointed at a playground.'],
    ['Hot vs cold', 'A <b>hot</b> wallet keeps keys on a connected device — convenient, fine for small amounts. A <b>cold</b> wallet generates and signs offline, so keys never touch the internet. The one rule: real value belongs in cold storage — use the <a href="https://offline.olesia.io" target="_blank" rel="noopener">cold generator</a> and the air-gap tools.'],
    ['Writing on-chain', 'OP_RETURN attaches a tiny permanent note to a transaction — no coins, unspendable, forever public. Satoshi set the tone by writing a newspaper headline into the first block. People disagree about data on Bitcoin; Olesia is neutral — it’s part of the protocol, explained, for thoughtful use.'],
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
      $('#set_xpub_out').textContent = mode === 'watch' ? source : window.OW.xpub(source, network);
      tog('#xpub_body');
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
  });
  $('#set_vault').addEventListener('click', () => tog('#vault_body'));
  $('#set_airgap').addEventListener('click', () => tog('#airgap_body'));
  $('#vsave').addEventListener('click', async () => {
    if (!source || mode !== 'full') return toast('open a wallet with a seed first', 'bad');
    toast('Encrypting…'); await new Promise((r) => setTimeout(r, 30));
    try {
      window.OW.vault.save(source, $('#vsetpin').value);
      $('#vsetpin').value = ''; $('#vault_state').textContent = 'saved encrypted on this device';
      toast('✓ saved — next visit, unlock with your PIN', 'ok');
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
  });
  $('#vsetpin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#vsave').click(); });
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
      const u = await window.OW.buildUnsigned({ source, network, toAddress: $('#to').value, amount: $('#amt').value, message: $('#msg').value, feeRate: $('#fee').value });
      $('#unsignedout').value = u.psbt;
      const r = $('#agresult'); r.style.display = 'block'; r.className = 'mono ok';
      r.textContent = `unsigned PSBT built — fee ${u.fee} sat, ~${u.vsize} vB. Copy it to your offline signer.`;
    } catch (e) { toast('✗ ' + e.message, 'bad'); }
  });
  $('#signbtn').addEventListener('click', () => {
    try {
      if (mode !== 'full') return toast('signing needs the seed', 'bad');
      if (network === 'mainnet' && navigator.onLine) toast('⚠ signing a mainnet PSBT while ONLINE — for real funds, do this offline.', 'bad');
      const psbt = $('#signin').value.trim() || $('#unsignedout').value.trim();
      if (!psbt) return toast('paste an unsigned PSBT to sign', 'bad');
      const s = window.OW.signPsbt({ psbt, mnemonic: source, network });
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
  function renderDots() {
    const d = $('#pindots'); d.textContent = '';
    const n = Math.max(pinBuf.length, 4);
    for (let i = 0; i < n; i++) { const s = document.createElement('i'); if (i < pinBuf.length) s.className = 'fill'; d.appendChild(s); }
  }
  renderDots();
  $('#pad').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !b.dataset.k) return;
    if (b.dataset.k === 'back') pinBuf = pinBuf.slice(0, -1);
    else if (pinBuf.length < 12) pinBuf += b.dataset.k;
    $('#vmsg').textContent = '';
    renderDots();
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
  async function unlockVault() {
    const pin = padMode ? pinBuf : $('#vpin').value;
    if (!pin) return ($('#vmsg').textContent = padMode ? 'tap your PIN digits first' : 'enter your passphrase');
    $('#vmsg').textContent = 'Unlocking…';
    await new Promise((r) => setTimeout(r, 30));
    try {
      const m = window.OW.vault.open(pin);
      pinBuf = ''; $('#vpin').value = ''; renderDots(); $('#vmsg').textContent = '';
      source = m; mode = 'full'; scriptType = 'p2wpkh';
      $('#unlock').classList.remove('on');
      initWallet();
    } catch (e) { $('#vmsg').textContent = '✗ ' + e.message; pinBuf = ''; renderDots(); }
  }
  $('#vunlock').addEventListener('click', unlockVault);
  $('#vpin').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockVault(); });
  // physical keyboard works on the keypad too
  document.addEventListener('keydown', (e) => {
    if (!$('#unlock').classList.contains('on') || !padMode) return;
    if (/^[0-9]$/.test(e.key) && pinBuf.length < 12) { pinBuf += e.key; renderDots(); }
    else if (e.key === 'Backspace') { pinBuf = pinBuf.slice(0, -1); renderDots(); }
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
  function showWords(m) {
    const box = $('#bk_words'); box.textContent = '';
    m.trim().split(/\s+/).forEach((w, i) => {
      const s = document.createElement('span'); const n = document.createElement('i');
      n.textContent = i + 1; s.append(n, w); box.appendChild(s);
    });
    $('#bk_gate').style.display = 'none'; $('#bk_show').style.display = 'block';
    clearTimeout(bkTimer); bkTimer = setTimeout(hideBackup, 60000); // auto-hide after 60s
  }
  $('#bk_reveal').addEventListener('click', async () => {
    const pin = $('#bk_pin').value;
    if (!pin) return toast('enter your PIN', 'bad');
    toast('Checking…'); await new Promise((r) => setTimeout(r, 30));
    try { showWords(window.OW.vault.open(pin)); toast('Revealed — auto-hides in 60s.'); }
    catch (e) { toast('✗ ' + e.message, 'bad'); }
  });
  $('#bk_pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#bk_reveal').click(); });
  // no vault saved -> no PIN exists to check; require a deliberate 1.5s hold instead
  let holdT;
  const holdBtn = $('#bk_hold');
  const startHold = () => { holdBtn.textContent = 'Keep holding…'; holdT = setTimeout(() => { showWords(source); holdBtn.textContent = 'Hold to reveal (1.5s)…'; }, 1500); };
  const endHold = () => { clearTimeout(holdT); holdBtn.textContent = 'Hold to reveal (1.5s)…'; };
  holdBtn.addEventListener('mousedown', startHold); holdBtn.addEventListener('touchstart', startHold, { passive: true });
  holdBtn.addEventListener('mouseup', endHold); holdBtn.addEventListener('mouseleave', endHold); holdBtn.addEventListener('touchend', endHold);

  // ---------- boot ----------
  if (window.OW.vault.exists()) { $('#unlock').classList.add('on'); }
  else showPane('welcome');
})();
