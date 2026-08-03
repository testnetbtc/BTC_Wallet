(function(){
  const $ = s => document.querySelector(s);
  try { const vc = window.Alea._vectorCheck();
    $('#selfcheck').textContent = vc.ok ? '✓ crypto self-check PASS — derivation matches the official BIP-84 test vector'
                                        : '✗ crypto self-check FAILED — do not use this build';
    $('#selfcheck').className = vc.ok ? 'badge ok' : 'badge bad';
  } catch(e){ $('#selfcheck').textContent='self-check error: '+e.message; $('#selfcheck').className='badge bad'; }

  function net(){ const on=navigator.onLine;
    $('#offline').textContent = on ? '● ONLINE — disconnect from the internet before generating a wallet you will fund'
                                   : '● offline — good';
    $('#offline').className = on ? 'badge bad' : 'badge ok'; }
  net(); addEventListener('online',net); addEventListener('offline',net);

  let mouse=[];
  $('#pad').addEventListener('mousemove', e=>{
    if(mouse.length<6000){ mouse.push(e.clientX&255, e.clientY&255, (performance.now()*1000|0)&255); }
    $('#mousebar').style.width = Math.min(100, mouse.length/1800*100).toFixed(0)+'%';
  });

  $('#gen').addEventListener('click', ()=>{
    const testnet = $('#net').value==='testnet';
    const w = window.Alea.makeWallet({ mouseBytes:new Uint8Array(mouse),
      diceString:$('#dice').value.trim(), passphrase:$('#pass').value, testnet });
    $('#words').textContent = w.mnemonic;
    $('#addr').textContent = w.address;
    $('#meta').textContent = `network: ${w.network}  ·  path: ${w.path}  ·  passphrase: ${w.passphraseUsed?'set':'(none)'}`;
    $('#out').style.display='block';
    $('#out').scrollIntoView({behavior:'smooth'});
  });
})();
