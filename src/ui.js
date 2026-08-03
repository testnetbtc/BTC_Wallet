(function(){
  const $ = s => document.querySelector(s);
  let current = null;

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
  }
  net(); addEventListener('online',net); addEventListener('offline',net);

  // --- optional entropy stirring (mouse / touch) ---------------------------
  let mouse=[];
  function stir(x,y){
    if(mouse.length<6000) mouse.push(x&255, y&255, (performance.now()*1000|0)&255);
    $('#mousebar').style.width = Math.min(100, mouse.length/1800*100).toFixed(0)+'%';
  }
  $('#pad').addEventListener('mousemove', e=>stir(e.clientX,e.clientY));
  $('#pad').addEventListener('touchmove', e=>{ const t=e.touches[0]; if(t) stir(t.clientX|0,t.clientY|0); }, {passive:true});

  // --- passphrase confirmation (a typo here = funds lost forever) ----------
  function passOk(){ const a=$('#pass').value, b=$('#pass2').value; return (!a && !b) || a===b; }
  function updatePass(){
    const ok = passOk();
    $('#passwarn').style.display = ok ? 'none' : 'block';
    $('#gen').disabled = !ok;
    $('#gen').textContent = ok ? 'Generate wallet' : 'Passphrases do not match';
  }
  $('#pass').addEventListener('input',updatePass);
  $('#pass2').addEventListener('input',updatePass);

  // --- generate -------------------------------------------------------------
  $('#gen').addEventListener('click', ()=>{
    if(!passOk()) return;
    const testnet = $('#net').value==='testnet';
    const w = window.Alea.makeWallet({
      mouseBytes:new Uint8Array(mouse),
      diceString:$('#dice').value.trim(),
      passphrase:$('#pass').value,
      testnet
    });
    $('#words').textContent = w.mnemonic;
    $('#addr').textContent  = w.address;
    $('#meta').textContent  = 'network: '+w.network+'  ·  path: '+w.path+
                              '  ·  passphrase: '+(w.passphraseUsed?'set (you MUST keep it)':'(none)');
    current = w;
    $('#dr').textContent = w.descriptorReceive;
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
        ? '✓ backup verified — your written copy is correct'
        : '✗ does not match — re-check what you wrote down';
      $('#vresult').className = 'badge '+(ok?'ok':'bad');
    };
  }

  // --- save encrypted backup / descriptor -----------------------------------
  function filePassOk(){ const a=$('#fpass').value, b=$('#fpass2').value; return a.length>0 && a===b; }
  function updateFilePass(){
    const ok = filePassOk();
    $('#fpwarn').style.display = (($('#fpass').value||$('#fpass2').value) && !ok) ? 'block' : 'none';
    $('#savebk').disabled = !ok;
  }
  $('#fpass').addEventListener('input',updateFilePass);
  $('#fpass2').addEventListener('input',updateFilePass);

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
        $('#rinfo').textContent = 'loaded '+(loaded.network||'?')+' backup from '+(loaded.createdAt||'?')
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
    const testnet = (loaded.network==='testnet');
    const d = window.Alea.deriveFrom(out.mnemonic, $('#rbip39').value, testnet);
    const match = d.address === loaded.address;
    $('#rwords').textContent = out.mnemonic;
    $('#raddr').textContent  = d.address + (match ? '  ✓ matches the backup' : '  ✗ DOES NOT match — wrong BIP-39 passphrase?');
    $('#rout').style.display = 'block';
    $('#rinfo').textContent = match ? '✓ restored and verified' : '✗ decrypted, but the address does not match the file';
    $('#rinfo').className = 'badge '+(match?'ok':'bad');
  });

  // --- wipe the screen ------------------------------------------------------
  $('#wipe').addEventListener('click', ()=>{
    mouse=[]; $('#mousebar').style.width='0%';
    ['#words','#addr','#meta','#vresult'].forEach(s=>{ $(s).textContent=''; });
    $('#vresult').className='';
    ['#va1','#va2','#pass','#pass2','#dice','#fpass','#fpass2','#rpass','#rbip39'].forEach(s=>{ $(s).value=''; });
    ['#rwords','#raddr','#saveinfo','#rinfo','#dr'].forEach(s=>{ $(s).textContent=''; });
    $('#saveinfo').className=''; $('#rinfo').className='';
    $('#rout').style.display='none'; current=null; loaded=null; updateFilePass();
    $('#out').style.display='none';
    updatePass();
    scrollTo({top:0,behavior:'smooth'});
  });
})();
