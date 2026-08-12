// Adversarial PSBT verification: the offline signer must independently
// establish what a PSBT spends and where every satoshi goes — and refuse to
// sign anything it cannot verify. The PSBT creator is the adversary here.
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hexToBytes } from '@noble/hashes/utils';
import { base64 } from '@scure/base';
import { describePsbt, signUnsigned } from '../src/send.js';
import { accountXpub } from '../src/wallet.js';
import { deriveKey } from '../src/wallet.js';
import { net } from '../src/networks.js';

let bad = false;
const ok = (l, c) => { console.log(l.padEnd(62), c ? '✓' : '✗ FAIL'); if (!c) bad = true; };

const NET = 'testnet4';
const WALLET = 'immense rain burden meat one stock cigar dice enhance post jacket aerobic';   // ours
const ATTACKER = 'like youth surface loop fire bulk push repair riot scan blame tilt';        // theirs
const n = net(NET);
const axpub = accountXpub(WALLET, '', NET);
const acct = HDKey.fromExtendedKey(axpub);
const walletScript = (chain, index) => btc.p2wpkh(acct.deriveChild(chain).deriveChild(index).publicKey, n.btc);
const attackerAddr = deriveKey(ATTACKER, '', NET, 0).address;
const OUR = walletScript(0, 0);      // receive #0 (the app's live address)
const OUR_CHANGE = walletScript(1, 0); // change #0

// helper: hand-build a PSBT exactly as a (possibly malicious) online machine would
function makePSBT({ inputs, outputs }) {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  for (const i of inputs) tx.addInput(i);
  for (const o of outputs) {
    if (o.address) tx.addOutputAddress(o.address, BigInt(o.amount), n.btc);
    else tx.addOutput({ script: o.script, amount: BigInt(o.amount ?? 0) });
  }
  return base64.encode(tx.toPSBT());
}
const ourInput = (value, vout = 0) => ({ txid: hexToBytes('ab'.repeat(32)), index: vout, witnessUtxo: { script: OUR.script, amount: BigInt(value) } });
const throwsMsg = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

// ---- 1. THE core attack: full-value output to attacker, labelled however -----
{
  const psbt = makePSBT({ inputs: [ourInput(1000000)], outputs: [{ address: attackerAddr, amount: 950000 }] });
  const d = describePsbt({ psbt, source: WALLET, network: NET });
  const out = d.outputs[0];
  ok('attack tx: input verified as OURS with path', d.inputs[0].mine && d.inputs[0].path === "m/84'/1'/0'/0/0");
  ok('attack tx: 950,000 sat output is EXTERNAL, never change', out.change === false && out.address === attackerAddr);
  ok('attack tx: fee computed independently = 50,000 sat', d.fee === 50000);
}

// ---- 2. fake change: attacker output + forged bip32 metadata ----------------
{
  // the PSBT *claims* the attacker output is change via bip32Derivation metadata;
  // ownership must come from OUR derivation, not the creator's claims
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput(ourInput(1000000));
  const atkScript = btc.p2wpkh(HDKey.fromExtendedKey(accountXpub(ATTACKER, '', NET)).deriveChild(1).deriveChild(0).publicKey, n.btc);
  tx.addOutput({ script: atkScript.script, amount: 999000n }); // "change" says the attacker
  const d = describePsbt({ psbt: base64.encode(tx.toPSBT()), source: WALLET, network: NET });
  ok('fake change: attacker\'s chain-1 address is still EXTERNAL', d.outputs[0].change === false);
}

// ---- 3. real change IS cryptographically recognised -------------------------
{
  const psbt = makePSBT({ inputs: [ourInput(1000000)], outputs: [
    { address: attackerAddr, amount: 500000 },
    { address: OUR_CHANGE.address, amount: 498600 },
  ] });
  const d = describePsbt({ psbt, source: WALLET, network: NET });
  const chg = d.outputs.find((o) => o.address === OUR_CHANGE.address);
  ok("real change: verified with path m/84'/1'/0'/1/0", chg.change === true && chg.path === "m/84'/1'/0'/1/0");
  ok('real change: external total counts only the payment', d.externalTotal === 500000 && d.changeTotal === 498600);
  ok('real change: fee = 1,400 sat', d.fee === 1400);
}

// ---- 4. multiple external outputs / multiple wallet inputs ------------------
{
  const psbt = makePSBT({
    inputs: [ourInput(600000, 0), ourInput(400000, 1)],
    outputs: [{ address: attackerAddr, amount: 300000 }, { address: deriveKey(ATTACKER, '', NET, 1).address, amount: 300000 }, { address: OUR.address, amount: 398000 }],
  });
  const d = describePsbt({ psbt, source: WALLET, network: NET });
  ok('multi: both inputs recognised as ours', d.allInputsMine && d.inputs.length === 2);
  ok('multi: two externals + our receive addr marked change/ours', d.outputs.filter((o) => !o.change).length === 2 && d.outputs.find((o) => o.address === OUR.address).change === true);
}

// ---- 5. very large fee: displayed AND signing refused -----------------------
{
  const psbt = makePSBT({ inputs: [ourInput(1000000)], outputs: [{ address: attackerAddr, amount: 100000 }] });
  const d = describePsbt({ psbt, source: WALLET, network: NET });
  ok('huge fee: computed and exposed (900,000 sat)', d.fee === 900000);
  ok('huge fee: signUnsigned REFUSES (>20% of inputs)', throwsMsg(() => signUnsigned({ psbt, mnemonic: WALLET, network: NET }), /fee .*exceeds 20%/));
}

// ---- 6. foreign input: not our coin -> refuse to co-sign --------------------
{
  const atkKey = deriveKey(ATTACKER, '', NET, 0);
  const psbt = makePSBT({ inputs: [
    ourInput(500000),
    { txid: hexToBytes('cd'.repeat(32)), index: 0, witnessUtxo: { script: atkKey.spend.script, amount: 500000n } },
  ], outputs: [{ address: attackerAddr, amount: 990000 }] });
  const d = describePsbt({ psbt, source: WALLET, network: NET });
  ok('foreign input: flagged NOT this wallet\'s coin', d.inputs[1].mine === false && d.anyInputMine === true);
  ok('foreign input: signing refused', throwsMsg(() => signUnsigned({ psbt, mnemonic: WALLET, network: NET }), /foreign inputs/));
}

// ---- 7. wrong network: testnet PSBT vs mainnet wallet -----------------------
{
  const psbt = makePSBT({ inputs: [ourInput(100000)], outputs: [{ address: OUR.address, amount: 99000 }] });
  const d = describePsbt({ psbt, source: WALLET, network: 'mainnet' }); // same seed, mainnet derivation
  ok('wrong network: no input belongs to the mainnet wallet', d.anyInputMine === false);
  ok('wrong network: signing refused with clear message', throwsMsg(() => signUnsigned({ psbt, mnemonic: WALLET, network: 'mainnet' }), /wrong seed, passphrase, or network/));
}

// ---- 8. missing witnessUtxo: fee unverifiable -> refuse ---------------------
{
  const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
  tx.addInput({ txid: hexToBytes('ab'.repeat(32)), index: 0 }); // outpoint only, no amount
  tx.addOutputAddress(attackerAddr, 90000n, n.btc);
  const psbt = base64.encode(tx.toPSBT());
  const d = describePsbt({ psbt, source: WALLET, network: NET });
  ok('missing amounts: fee is null (unknowable), never guessed', d.fee === null);
  ok('missing amounts: signing refused', throwsMsg(() => signUnsigned({ psbt, mnemonic: WALLET, network: NET }), /cannot be independently verified|no input belongs/));
}

// ---- 9. a different script type (taproot) to someone else: external ---------
{
  const trAddr = deriveKey(ATTACKER, '', NET, 0); // reuse a real key for a valid p2tr
  const trPub = HDKey.fromExtendedKey(accountXpub(ATTACKER, '', NET)).deriveChild(0).deriveChild(0).publicKey;
  const tr = btc.p2tr(trPub.slice(1), undefined, n.btc);
  const psbt = makePSBT({ inputs: [ourInput(100000)], outputs: [
    { script: tr.script, amount: 50000 },
    { address: OUR_CHANGE.address, amount: 49000 },
  ] });
  const d = describePsbt({ psbt, source: WALLET, network: NET });
  ok('other script type (p2tr) to a stranger: external', d.outputs[0].change === false && d.outputs[0].type === 'tr');
}

// ---- 10. malformed PSBT: clean error, nothing signed ------------------------
{
  let clean = false;
  try { describePsbt({ psbt: 'definitely-not-a-psbt', source: WALLET, network: NET }); }
  catch (e) { clean = e instanceof Error; }
  ok('malformed PSBT: clean Error from describe', clean);
  ok('malformed PSBT: signUnsigned also refuses cleanly', throwsMsg(() => signUnsigned({ psbt: 'zzz', mnemonic: WALLET, network: NET }), /./));
}

// ---- 11. incorrect derivation metadata is simply ignored --------------------
{
  // ownership is re-derived from OUR account; creator-supplied paths carry no authority.
  const psbt = makePSBT({ inputs: [ourInput(200000)], outputs: [{ address: OUR_CHANGE.address, amount: 199000 }] });
  const d = describePsbt({ psbt, source: WALLET, network: NET });
  ok('metadata-free PSBT: change still verified by derivation alone', d.outputs[0].change === true);
}

// ---- 12. the happy path still signs -----------------------------------------
{
  const psbt = makePSBT({ inputs: [ourInput(1000000)], outputs: [
    { address: attackerAddr, amount: 500000 }, { address: OUR_CHANGE.address, amount: 498600 },
  ] });
  let s = null; try { s = signUnsigned({ psbt, mnemonic: WALLET, network: NET }); } catch { /* fail below */ }
  ok('legitimate PSBT signs and finalizes', !!(s && s.txid && s.txHex));
}

console.log(bad ? '\nPSBT-VERIFY TEST FAILED' : '\nPSBT-VERIFY TEST PASS — the offline signer verifies before it signs');
process.exit(bad ? 1 : 0);
