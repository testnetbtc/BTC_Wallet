(function(){
  const $ = s => document.querySelector(s);

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

  // --- wipe the screen ------------------------------------------------------
  $('#wipe').addEventListener('click', ()=>{
    mouse=[]; $('#mousebar').style.width='0%';
    ['#words','#addr','#meta','#vresult'].forEach(s=>{ $(s).textContent=''; });
    $('#vresult').className='';
    ['#va1','#va2','#pass','#pass2','#dice'].forEach(s=>{ $(s).value=''; });
    $('#out').style.display='none';
    updatePass();
    scrollTo({top:0,behavior:'smooth'});
  });
})();
