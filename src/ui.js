(function(){
  const $ = s => document.querySelector(s);
  let current = null;
  let selfCheckOk = false;   // latched: if the crypto self-check fails, generation
                             // must stay disabled no matter what else happens.

  function download(name, text, type){
    const b = new Blob([text], {type: type||'application/json'});
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = name; a.click();
    setTimeout(()=>URL.revokeObjectURL(u), 1000);
  }

  // --- crypto self-check against the official BIP-84 vector -----------------
  try {
    const vc = window.Alea._vectorCheck();
    $('#selfcheck').textContent = vc.ok
      ? '✓ crypto self-check PASS — derivation matches the official BIP-84 test vector'
      : '✗ crypto self-check FAILED — do not use this build';
    $('#selfcheck').className = vc.ok ? 'badge ok' : 'badge bad';
    selfCheckOk = !!vc.ok;
    if(!vc.ok) $('#gen').disabled = true;
  } catch(e){
    $('#selfcheck').textContent = 'self-check error: '+e.message;
    $('#selfcheck').className = 'badge bad';
    $('#gen').disabled = true;
  }

  // --- online/offline indicator --------------------------------------------
  function net(){
    const on = navigator.onLine;
    $('#offline').textContent = on
      ? '● ONLINE — disconnect from the internet before generating a wallet you will fund'
      : '● offline — good';
    $('#offline').className = on ? 'badge bad' : 'badge ok';
    refreshGen();   // being online blocks MAINNET generation (see refreshGen below)
  }
  addEventListener('online', net); addEventListener('offline', net);

  // --- optional entropy stirring (mouse / touch) ---------------------------
  // NOTE: this is DEFENCE IN DEPTH, not the security root. The key always has
  // 256 bits from crypto.getRandomValues; the mouse only stirs extra into the
  // hash. So the readout is labelled "optional stir", never "key strength".
  let mouse=[];
  function stir(x,y){
    if(mouse.length<6000) mouse.push(x&255, y&255, (performance.now()*1000|0)&255);
    const pct = Math.min(100, mouse.length/1800*100);
    $('#mousebar').style.width = pct.toFixed(0)+'%';
    $('#mousestat').textContent = 'optional stir: '+pct.toFixed(0)+'%'+(pct>=100?' (plenty — more adds nothing)':'');
  }
  function resetMouse(){ mouse=[]; $('#mousebar').style.width='0%'; $('#mousestat').textContent='optional stir: 0%'; }
  $('#pad').addEventListener('mousemove', e=>stir(e.clientX,e.clientY));
  $('#pad').addEventListener('touchmove', e=>{ const t=e.touches[0]; if(t) stir(t.clientX|0,t.clientY|0); }, {passive:true});
  $('#mousereset').addEventListener('click', resetMouse);

  // --- passphrase confirmation + generate-button gating --------------------
  // A typo in the passphrase = funds lost forever, so confirm it. Generation is
  // gated by three conditions: the crypto self-check must pass, the two passphrase
  // fields must match, and — F-01 hardening — MAINNET may NOT be generated while
  // the browser is online (a hosted/networked page is a supply-chain risk;
  // disconnect from the internet to make a real wallet). Testnet is unaffected.
  function passOk(){ const a=$('#pass').value, b=$('#pass2').value; return (!a && !b) || a===b; }
  function mainnetOnlineBlocked(){ return $('#net').value==='mainnet' && navigator.onLine; }
  function refreshGen(){
    const isMain = $('#net').value === 'mainnet';
    $('#netwarn').style.display = isMain ? 'block' : 'none';
    const ok = passOk();
    $('#passwarn').style.display = ok ? 'none' : 'block';
    $('#gen').disabled = !selfCheckOk || !ok || mainnetOnlineBlocked();
    $('#gen').textContent =
        !selfCheckOk ? 'Disabled — crypto self-check failed'
      : !ok ? 'Passphrases do not match'
      : mainnetOnlineBlocked() ? 'Disconnect from the internet for mainnet'
      : isMain ? 'Generate REAL mainnet wallet'
      : 'Generate wallet';
  }
  $('#net').addEventListener('change', refreshGen);
  $('#pass').addEventListener('input', refreshGen);
  $('#pass2').addEventListener('input', refreshGen);
  // BIP-39 passphrase fields are hidden (type=password) by default to resist
  // shoulder-surfing; a toggle reveals them so the user can check for typos.
  $('#passshow').addEventListener('click', ()=>{
    const t = $('#pass').type === 'password' ? 'text' : 'password';
    $('#pass').type = t; $('#pass2').type = t;
    $('#passshow').textContent = t === 'password' ? 'Show' : 'Hide';
  });
  net(); refreshGen();

  // --- browser RNG liveness check (diagnostic; NOT a proof of quality) ------
  $('#rngtest').addEventListener('click', ()=>{
    const r = window.Alea.rngSelfTest(8192);
    $('#rngresult').textContent = (r.ok ? '✓ RNG liveness: alive' : '✗ RNG liveness: FAILED')
      + ' — '+r.bits+' bits sampled, '+(r.proportion*100).toFixed(2)+'% ones (want ~50%), '
      + r.distinct+'/256 byte values seen. Liveness only: detects a broken/stuck RNG, never a proof of quality.';
    $('#rngresult').className = 'badge '+(r.ok ? 'ok' : 'bad');
  });

  // --- advanced: reveal the raw entropy hex (hidden by default) -------------
  // Showing the entropy is opt-in so it isn't sitting on screen by default (it is
  // the SAME secret as the words). Behind the toggle it lets an advanced user
  // independently confirm the entropy→mnemonic mapping.
  $('#advtoggle').addEventListener('click', ()=>{
    const el = $('#adv');
    const show = el.style.display === 'none' || !el.style.display;
    el.style.display = show ? 'block' : 'none';
    $('#advtoggle').textContent = show ? 'Hide raw entropy' : 'Advanced: show raw entropy (verify)';
  });

  // --- generate -------------------------------------------------------------
  $('#gen').addEventListener('click', ()=>{
    if(!passOk() || !selfCheckOk) return;
    const w = window.Alea.makeWallet({
      mouseBytes:new Uint8Array(mouse),
      diceString:$('#dice').value.trim(),
      passphrase:$('#pass').value,
      network:$('#net').value
    });
    $('#words').textContent = w.mnemonic;
    $('#addr').textContent  = w.address;
    $('#meta').textContent  = 'network: '+w.network+'  ·  path: '+w.path+
                              '  ·  passphrase: '+(w.passphraseUsed?'set (you MUST keep it)':'(none)');
    current = w;
    $('#dr').textContent = w.descriptorReceive;
    $('#ehex').textContent = w.entropyHex;   // raw 256-bit root, for independent verification
    // Honest entropy summary: strength is ALWAYS 256 bits; show the sources that
    // were combined, never a variable "meter" that implies wiggling = security.
    const usedMouse = mouse.length > 0, usedDice = $('#dice').value.trim().length > 0,
          usedPass = $('#pass').value.length > 0;
    const mark = b => b ? '✓' : '–';
    $('#entropy').textContent =
      'Entropy: 256 bits — full strength (the maximum a 24-word phrase can hold). '
      + 'Sources hashed together: OS CSPRNG (primary) · mouse '+mark(usedMouse)
      + ' · dice '+mark(usedDice)+' · passphrase '+mark(usedPass)+'. '
      + 'On a correctly functioning, uncompromised system the CSPRNG alone makes this '
      + '256-bit strong; the optional sources can only add, never subtract, and cannot '
      + 'push it above 256.';
    setupVerify(w.mnemonic);
    $('#out').style.display='block';
    $('#out').scrollIntoView({behavior:'smooth'});
  });

  // --- backup verification: prove you wrote the words down correctly -------
  function setupVerify(mn){
    const words = mn.split(' ');
    const r = new Uint32Array(2); crypto.getRandomValues(r);
    const i1 = r[0]%24; let i2 = r[1]%24; if(i2===i1) i2=(i2+1)%24;
    $('#vq1').textContent = 'word #'+(i1+1);
    $('#vq2').textContent = 'word #'+(i2+1);
    $('#va1').value=''; $('#va2').value='';
    $('#vresult').textContent=''; $('#vresult').className='';
    $('#vcheck').onclick = ()=>{
      const ok = $('#va1').value.trim().toLowerCase()===words[i1]
              && $('#va2').value.trim().toLowerCase()===words[i2];
      $('#vresult').textContent = ok
        ? '✓ the 2 sampled words match — but 2 of 24 is only a spot-check; do a full test restore below before trusting this backup'
        : '✗ does not match — re-check what you wrote down';
      $('#vresult').className = 'badge '+(ok?'ok':'bad');
    };
  }

  // --- save encrypted backup / descriptor -----------------------------------
  function filePassOk(){ const a=$('#fpass').value, b=$('#fpass2').value; return a.length>0 && a===b; }
  // Honest, deliberately-conservative estimate: bits assuming the password were a
  // RANDOM string of the character classes present. Real human passwords score far
  // LOWER (dictionary attacks), so this is an optimistic upper bound, said so plainly.
  // The robust answer is the generator, not the estimate.
  function pwStrengthHint(pw){
    if(!pw) return '';
    let charset = 0;
    if(/[a-z]/.test(pw)) charset += 26;
    if(/[A-Z]/.test(pw)) charset += 26;
    if(/[0-9]/.test(pw)) charset += 10;
    if(/[^a-zA-Z0-9]/.test(pw)) charset += 32;
    const bits = Math.round(pw.length * Math.log2(charset || 1));
    const label = bits < 40 ? 'weak' : bits < 70 ? 'fair' : 'strong';
    return 'rough strength ~'+bits+' bits ('+label+') — optimistic upper bound; a dictionary '
         + 'word scores far lower. Backup files can be attacked offline, so prefer the generator.';
  }
  function updateFilePass(){
    const ok = filePassOk();
    $('#fpwarn').style.display = (($('#fpass').value||$('#fpass2').value) && !ok) ? 'block' : 'none';
    $('#savebk').disabled = !ok;
    $('#fpstrength').textContent = pwStrengthHint($('#fpass').value);
  }
  $('#fpass').addEventListener('input',updateFilePass);
  $('#fpass2').addEventListener('input',updateFilePass);
  // one-click strong password for the backup FILE (Diceware from the wordlist).
  $('#genpw').addEventListener('click', ()=>{
    const pw = window.Alea.randomPassword(6);
    $('#fpass').type='text'; $('#fpass2').type='text';   // reveal so it can be written down
    $('#fpass').value = pw; $('#fpass2').value = pw;
    updateFilePass();
    $('#saveinfo').textContent = '✓ strong password generated (shown above) — WRITE IT DOWN now; without it the backup can never be restored';
    $('#saveinfo').className = 'badge ok';
  });

  $('#savebk').addEventListener('click', ()=>{
    if(!current || !filePassOk()) return;
    const blob = window.Alea.encryptBackup(current.mnemonic, $('#fpass').value, current);
    download('alea-backup-'+current.network+'.json', JSON.stringify(blob,null,2));
    $('#saveinfo').textContent = '✓ encrypted backup downloaded — test restoring it below before you rely on it';
    $('#saveinfo').className = 'badge ok';
  });

  $('#savedesc').addEventListener('click', ()=>{
    if(!current) return;
    const txt = '# Alea watch-only descriptors ('+current.network+')\n'
      + '# Import into Bitcoin Core (importdescriptors) or Sparrow. Contains NO private key.\n'
      + 'receive: '+current.descriptorReceive+'\n'
      + 'change:  '+current.descriptorChange+'\n';
    download('alea-descriptor-'+current.network+'.txt', txt, 'text/plain');
  });

  // --- restore from an encrypted backup file --------------------------------
  let loaded = null;
  $('#bkfile').addEventListener('change', e=>{
    const f = e.target.files && e.target.files[0]; if(!f) return;
    const r = new FileReader();
    r.onload = () => {
      try { loaded = JSON.parse(r.result);
        $('#rinfo').textContent = 'loaded '+(loaded.network||'?')+' backup (v'+(loaded.version||'?')+') from '+(loaded.createdAt||'?')
          + (loaded.passphraseUsed ? ' — this wallet HAS a BIP-39 passphrase, enter it below' : '');
        $('#rinfo').className='badge ok';
      } catch(err){ loaded=null; $('#rinfo').textContent='not a valid backup file'; $('#rinfo').className='badge bad'; }
    };
    r.readAsText(f);
  });

  $('#restore').addEventListener('click', ()=>{
    if(!loaded){ $('#rinfo').textContent='choose a backup file first'; $('#rinfo').className='badge bad'; return; }
    let out;
    try { out = window.Alea.decryptBackup(loaded, $('#rpass').value); }
    catch(err){ $('#rinfo').textContent='✗ '+err.message; $('#rinfo').className='badge bad'; return; }
    const testnet = (loaded.network !== 'mainnet');  // 'testnet' (legacy), 'testnet3', 'testnet4'
    const d = window.Alea.deriveFrom(out.mnemonic, $('#rbip39').value, testnet);
    const match = window.Alea.verifyAddress(loaded, d.address);
    $('#rwords').textContent = out.mnemonic;
    $('#raddr').textContent  = d.address + (match ? '  ✓ matches the backup' : '  ✗ DOES NOT match — wrong BIP-39 passphrase?');
    $('#rout').style.display = 'block';
    $('#rinfo').textContent = match ? '✓ restored and verified' : '✗ decrypted, but the address does not match the file';
    $('#rinfo').className = 'badge '+(match?'ok':'bad');
  });

  // --- wipe the screen ------------------------------------------------------
  $('#wipe').addEventListener('click', ()=>{
    resetMouse();
    ['#words','#addr','#meta','#vresult','#entropy','#ehex','#rngresult','#fpstrength'].forEach(s=>{ $(s).textContent=''; });
    $('#rngresult').className='';
    $('#vresult').className='';
    ['#va1','#va2','#pass','#pass2','#dice','#fpass','#fpass2','#rpass','#rbip39'].forEach(s=>{ $(s).value=''; });
    ['#rwords','#raddr','#saveinfo','#rinfo','#dr'].forEach(s=>{ $(s).textContent=''; });
    $('#saveinfo').className=''; $('#rinfo').className='';
    // reset secret-field visibility + the advanced entropy panel
    ['#pass','#pass2','#fpass','#fpass2'].forEach(s=>{ $(s).type='password'; });
    $('#passshow').textContent='Show';
    $('#adv').style.display='none'; $('#advtoggle').textContent='Advanced: show raw entropy (verify)';
    $('#rout').style.display='none'; current=null; loaded=null; updateFilePass();
    $('#out').style.display='none';
    refreshGen();
    scrollTo({top:0,behavior:'smooth'});
  });
})();
