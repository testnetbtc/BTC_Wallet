#!/usr/bin/env node
// Tiny CLI for the testnet send/receive round-trip. The mnemonic is stored in a
// gitignored 600 file under .secrets/ — NEVER printed, NEVER committed. Testnet only.
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { receiveAddress, walletStatus, prepareAndSend } from './src/send.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET_DIR = join(HERE, '.secrets');
const [cmd, network = 'testnet3'] = process.argv.slice(2);
const file = join(SECRET_DIR, `${network}.json`);

function loadMnemonic() {
  if (!existsSync(file)) throw new Error(`no wallet for ${network} — run: node cli.mjs init ${network}`);
  return JSON.parse(readFileSync(file, 'utf8')).mnemonic;
}

if (cmd === 'init') {
  if (network === 'mainnet') throw new Error('refusing to init a mainnet wallet from the CLI');
  mkdirSync(SECRET_DIR, { recursive: true });
  if (existsSync(file)) { console.log(`already exists: ${file}`); process.exit(0); }
  const mnemonic = generateMnemonic(wordlist, 256);
  writeFileSync(file, JSON.stringify({ network, mnemonic }, null, 2)); chmodSync(file, 0o600);
  console.log('created', file, '(600, gitignored — mnemonic NOT printed)');
  console.log('receive address:', receiveAddress(mnemonic, '', network));
} else if (cmd === 'address') {
  console.log(receiveAddress(loadMnemonic(), '', network));
} else if (cmd === 'balance') {
  const s = await walletStatus(loadMnemonic(), '', network);
  console.log('address   :', s.address);
  console.log('balance   :', s.balance.confirmed, 'sat confirmed,', s.balance.pending, 'pending');
  console.log('utxos     :', s.utxos.map((u) => `${u.value}sat ${u.confirmed ? '✓' : 'pending'}`).join(', ') || '(none)');
} else if (cmd === 'send') {
  // node cli.mjs send <network> '<message>' <toAddress> <amountSat> [--broadcast]
  const args = process.argv.slice(4);
  const broadcast = args.includes('--broadcast');
  const [message, toAddress, amountSat] = args.filter((a) => a !== '--broadcast');
  const recipients = toAddress && amountSat ? [{ address: toAddress, amount: Number(amountSat) }] : [];
  const res = await prepareAndSend({ mnemonic: loadMnemonic(), network, message: message || null, recipients, broadcast });
  console.log(JSON.stringify({ from: res.from, txid: res.txid, fee: res.fee, vsize: res.vsize,
                               feeRate: res.feeRate, broadcast: res.broadcast,
                               broadcastTxid: res.broadcastTxid, explorer: res.explorer }, null, 2));
  if (!broadcast) console.log('\n(dry run — add --broadcast to actually send)');
} else {
  console.log('usage: node cli.mjs <init|address|balance|send> [network=testnet3] ...');
}
