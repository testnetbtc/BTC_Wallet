(function () {
  const $ = (s) => document.querySelector(s);
  const show = (el, msg, cls) => { el.textContent = msg; el.className = cls || ''; };
  const fmt = (sats) => (sats / 1e8).toFixed(8) + ' tBTC (' + Number(sats).toLocaleString() + ' sat)';
  let source = '', mode = '', network = 'testnet4', scriptType = 'p2wpkh'; // mode: 'full'|'watch'

  // populate networks (incl. mainnet)
  window.OW.networks.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; $('#net').appendChild(o); });
  $('#net').value = 'testnet4';
  $('#net').addEventListener('change', () => { network = $('#net').value; applyGating(); if (source) loadWallet(); });

  // populate script types + show the explainer for the selected one
  window.OW.scriptTypes().forEach((t) => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; $('#stype').appendChild(o); });
  $('#stype').value = 'p2wpkh';
  function showAbout() { const t = window.OW.scriptTypes().find((x) => x.id === scriptType); $('#stype_about').textContent = t ? t.about : ''; }
  showAbout();
  $('#stype').addEventListener('change', () => { scriptType = $('#stype').value; showAbout(); applyGating(); if (source) loadWallet(); });

  // inline "?" tooltips + onboarding dismiss
  document.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('help')) {
      const t = document.getElementById(e.target.dataset.target);
      if (t) t.style.display = t.style.display === 'block' ? 'none' : 'block';
    }
  });
  try { if (localStorage.getItem('olesia:onboard') === 'done' && $('#onboard')) $('#onboard').style.display = 'none'; } catch {}
  if ($('#onboard_x')) $('#onboard_x').addEventListener('click', () => { $('#onboard').style.display = 'none'; try { localStorage.setItem('olesia:onboard', 'done'); } catch {} });

  // tabs (Receive / Send / Advanced)
  function showTab(name) {
    ['recv', 'actions', 'airgap'].forEach((n) => { const el = $('#' + n); if (el) el.style.display = n === name ? 'block' : 'none'; });
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // fee presets (slow / normal / fast) + custom override
  const setFeeActive = () => document.querySelectorAll('.feep').forEach((x) => x.classList.toggle('active', x.dataset.fee === $('#fee').value));
  $('#fee').value = '2';
  document.querySelectorAll('.feep').forEach((b) => b.addEventListener('click', () => { $('#fee').value = b.dataset.fee; setFeeActive(); }));
  $('#fee').addEventListener('input', setFeeActive);

  // copy-to-clipboard buttons (data-copy = element id)
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.copy'); if (!b || !b.dataset.copy) return;
    const el = $('#' + b.dataset.copy); if (!el) return;
    const text = ('value' in el) ? el.value : el.textContent;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => { const o = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = o; }, 1200); }).catch(() => {});
  });

  // paste-from-clipboard buttons (data-paste = element id) — mobile-friendly
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('.paste'); if (!b || !b.dataset.paste) return;
    const el = $('#' + b.dataset.paste); if (!el) return;
    try {
      const t = await navigator.clipboard.readText();
      if (!t) return;
      el.value = t.trim(); el.dispatchEvent(new Event('input'));
      const o = b.textContent; b.textContent = 'Pasted ✓'; setTimeout(() => { b.textContent = o; }, 1200);
    } catch { show($('#status'), "Couldn't read clipboard — paste manually (long-press the field)", 'bad'); }
  });
  $('#gen').addEventListener('click', () => {
    $('#mnemonic').value = window.OW.generate();
    show($('#status'), 'New 24-word seed generated. Write it down, then press Load.', 'hint');
  });

  $('#load').addEventListener('click', loadWallet);
  async function loadWallet() {
    const s = $('#mnemonic').value.trim();
    if (window.OW.validate(s)) mode = 'full';
    else if (window.OW.isXpub(s)) mode = 'watch';
    else { show($('#status'), '✗ ' + window.OW.diagnose(s), 'bad'); return; }
    source = s; network = $('#net').value;
    // xpub watch-only supports P2WPKH only
    if (mode === 'watch' && scriptType !== 'p2wpkh') { $('#stype').value = 'p2wpkh'; scriptType = 'p2wpkh'; showAbout(); }
    const info = window.OW.info(source, network, scriptType);
    show($('#addr'), info.address || ('P2PK — no address. scriptPubKey: ' + info.scriptHex), 'mono');
    try { const q = $('#qr'); if (info.address) { q.src = await window.OW.qr(info.address); q.style.display = 'inline-block'; } else q.style.display = 'none'; } catch {}
    $('#label').value = info.address ? (localStorage.getItem('olesia:label:' + info.address) || '') : '';
    show($('#mode'), (mode === 'full' ? 'full wallet (can sign)' : 'watch-only (xpub)') + ' · ' + scriptType, 'hint');
    $('#expxpub').style.display = mode === 'full' ? 'inline-block' : 'none';
    $('#xpubout').style.display = 'none'; $('#copyxpub').style.display = 'none';
    $('#tabs').style.display = 'flex'; showTab('recv');
    applyGating();
    show($('#status'), 'Loaded. Fetching…', 'hint');
    await refreshStatus(); await refreshHistory();
  }

  function applyGating() {
    const isMain = network === 'mainnet';
    $('#mainwarn').style.display = isMain ? 'block' : 'none';
    const p2pk = scriptType === 'p2pk';
    const hot = mode === 'full' && !p2pk;  // seed => hot send/sweep; P2PK is receive-only for now
    [['#send', hot], ['#dryrun', hot], ['#sweep', hot], ['#sweepdry', hot],
     ['#signbtn', mode === 'full']].forEach(([id, on]) => { const el = $(id); if (el) el.disabled = !on; });
    if (isMain) {
      $('#mainwarn').textContent =
        mode === 'full' ? '⚠ Mainnet HOT WALLET — REAL bitcoin. Your seed is in this browser tab (never stored, never sent); Send/Sweep broadcast immediately via your own node. Keep only small amounts you would accept losing. For larger sums, load an xpub (watch-only) and use the offline air-gap tools below.'
        : mode === 'watch' ? '⚠ Mainnet, watch-only (xpub) — build an unsigned PSBT below, sign it offline, then broadcast the signed PSBT here.'
        : '⚠ Mainnet — REAL bitcoin. Paste a 12- or 24-word seed and press Load to use it as a hot wallet (keep amounts small), or an xpub for watch-only.';
    }
    $('#hotnote').textContent =
      p2pk ? 'P2PK is receive / museum-display only for now — spending a bare public key is a dedicated follow-up.'
      : hot ? (isMain ? '⚠ mainnet hot wallet — real BTC, small amounts only' : '')
      : (mode === 'watch' ? 'Watch-only: no seed loaded — build an unsigned PSBT, sign it elsewhere.' : '');
  }

  $('#expxpub').addEventListener('click', () => {
    try { const x = window.OW.xpub(source, network); show($('#xpubout'), x, 'mono'); $('#xpubout').style.display = 'block'; $('#copyxpub').style.display = 'inline-block'; }
    catch (e) { show($('#status'), '✗ ' + e.message, 'bad'); }
  });
  $('#label').addEventListener('input', () => { const a = $('#addr').textContent; if (a) localStorage.setItem('olesia:label:' + a, $('#label').value); });

  $('#refresh').addEventListener('click', async () => { await refreshStatus(); await refreshHistory(); });
  async function refreshStatus() {
    try {
      const st = await window.OW.status(source, network, scriptType);
      show($('#bal'), fmt(st.balance.confirmed) + ' confirmed' + (st.balance.pending ? '  ·  ' + fmt(st.balance.pending) + ' pending' : ''), 'mono');
      $('#utxos').textContent = st.utxos.length ? st.utxos.map((u) => `${u.value} sat ${u.confirmed ? '✓' : 'pending'}`).join('   ·   ') : '(no UTXOs yet)';
      show($('#status'), 'Balance updated.', 'ok');
    } catch (e) { show($('#status'), '✗ ' + e.message, 'bad'); }
  }
  async function refreshHistory() {
    try {
      const txs = await window.OW.history(source, network, scriptType);
      const h = $('#history'); h.textContent = '';
      if (!txs.length) { h.textContent = '(no transactions yet)'; return; }
      const base = window.OW.explorer(network);
      for (const t of txs) {
        const row = document.createElement('div'); row.style.margin = '3px 0';
        row.style.color = t.net >= 0 ? '#7ee2a8' : '#ff9ca0';
        row.appendChild(document.createTextNode(`${t.confirmed ? '✓' : '⧗ pending'}  ${t.net >= 0 ? '+' : '−'}${Math.abs(t.net).toLocaleString()} sat   `));
        const a = document.createElement('a'); a.href = base + t.txid; a.target = '_blank'; a.rel = 'noopener'; a.textContent = t.txid.slice(0, 12) + '… ↗';
        row.appendChild(a); h.appendChild(row);
      }
    } catch (e) { $('#history').textContent = '✗ ' + e.message; }
  }

  const sendArgs = (broadcast) => ({ mnemonic: source, network, scriptType, toAddress: $('#to').value, amount: $('#amt').value, message: $('#msg').value, feeRate: $('#fee').value, broadcast });
  async function runSend(b) { try { show($('#status'), b ? 'Broadcasting…' : 'Building…', 'hint'); renderResult(await window.OW.send(sendArgs(b)), b); } catch (e) { show($('#status'), '✗ ' + e.message, 'bad'); } }
  $('#dryrun').addEventListener('click', () => runSend(false));
  $('#send').addEventListener('click', () => runSend(true));
  async function runSweep(b) { try { if (!$('#sweepto').value.trim()) return show($('#status'), 'enter a sweep destination', 'bad'); show($('#status'), b ? 'Broadcasting sweep…' : 'Building sweep…', 'hint'); renderResult(await window.OW.sweep({ mnemonic: source, network, scriptType, toAddress: $('#sweepto').value, feeRate: $('#fee').value, broadcast: b }), b); } catch (e) { show($('#status'), '✗ ' + e.message, 'bad'); } }
  $('#sweepdry').addEventListener('click', () => runSweep(false));
  $('#sweep').addEventListener('click', () => runSweep(true));

  function renderResult(res, broadcast) {
    const r = $('#result'); r.textContent = '';
    const line = (t) => { const d = document.createElement('div'); d.textContent = t; r.appendChild(d); };
    line(broadcast ? '✓ BROADCAST' : '· DRY RUN (nothing sent)');
    const txidRow = document.createElement('div'); txidRow.textContent = 'txid: ' + res.txid;
    const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'sec copy'; cp.textContent = 'Copy'; cp.style.marginLeft = '8px';
    cp.addEventListener('click', () => navigator.clipboard.writeText(res.txid).then(() => { cp.textContent = 'Copied ✓'; setTimeout(() => { cp.textContent = 'Copy'; }, 1200); }).catch(() => {}));
    txidRow.appendChild(cp); r.appendChild(txidRow);
    line('fee: ' + res.fee + ' sat  ·  vsize: ' + res.vsize + '  ·  ' + res.feeRate + ' sat/vB');
    if (res.swept != null) line('sweeping ' + res.swept + ' sat → ' + res.to);
    if (broadcast && res.explorer) { const a = document.createElement('a'); a.href = res.explorer; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'view on explorer ↗'; r.appendChild(a); }
    r.style.display = 'block';
    show($('#status'), broadcast ? '✓ sent — see result' : 'built (dry run)', broadcast ? 'ok' : 'hint');
    if (broadcast) setTimeout(async () => { await refreshStatus(); await refreshHistory(); }, 1500);
  }

  // --- air-gap PSBT tools ---
  $('#buildunsigned').addEventListener('click', async () => {
    try {
      show($('#status'), 'Building unsigned PSBT…', 'hint');
      const u = await window.OW.buildUnsigned({ source, network, toAddress: $('#to').value, amount: $('#amt').value, message: $('#msg').value, feeRate: $('#fee').value });
      $('#unsignedout').value = u.psbt;
      show($('#agresult'), 'unsigned PSBT built — fee ' + u.fee + ' sat, ~' + u.vsize + ' vB. Copy it to your offline signer.', 'ok');
      $('#agresult').style.display = 'block';
    } catch (e) { show($('#status'), '✗ ' + e.message, 'bad'); }
  });
  $('#signbtn').addEventListener('click', () => {
    try {
      if (mode !== 'full') return show($('#status'), 'signing needs the seed (load your 24 words)', 'bad');
      if (network === 'mainnet' && navigator.onLine) show($('#status'), '⚠ signing a mainnet PSBT while ONLINE — for real funds, do this offline.', 'bad');
      const psbt = $('#signin').value.trim() || $('#unsignedout').value.trim();
      if (!psbt) return show($('#status'), 'paste an unsigned PSBT to sign', 'bad');
      const s = window.OW.signPsbt({ psbt, mnemonic: source, network });
      $('#signedout').value = s.psbt;
      show($('#agresult'), 'signed ✓  txid ' + s.txid + ' — copy the signed PSBT to broadcast (online).', 'ok');
      $('#agresult').style.display = 'block';
    } catch (e) { show($('#status'), '✗ ' + e.message, 'bad'); }
  });
  $('#bcbtn').addEventListener('click', async () => {
    try {
      const psbt = $('#bcin').value.trim() || $('#signedout').value.trim();
      if (!psbt) return show($('#status'), 'paste a signed PSBT to broadcast', 'bad');
      show($('#status'), 'Broadcasting…', 'hint');
      const res = await window.OW.broadcastPsbt({ psbt, network });
      const r = $('#agresult'); r.textContent = '✓ broadcast — txid ' + res.txid + '  '; r.className = 'ok';
      const a = document.createElement('a'); a.href = res.explorer; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'explorer ↗'; r.appendChild(a);
      r.style.display = 'block';
      setTimeout(async () => { await refreshStatus(); await refreshHistory(); }, 1500);
    } catch (e) { show($('#status'), '✗ ' + e.message, 'bad'); }
  });
})();
