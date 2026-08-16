// Build the CONNECT bridge into a single self-contained, network-less page (app.olesia.io/connect).
// Same hardening as the offline signer: inline the bundle, hash inline scripts, lock the CSP to
// connect-src 'none' (the page only reads the same-origin vault and postMessages the opener — it
// never touches the network). Run from packages/bitcoin.
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { hardenHtml } from '../../../tools/csp.mjs';

mkdirSync('connect/dist', { recursive: true });
const bundle = (await esbuild.build({
  entryPoints: ['connect/entry.js'], bundle: true, format: 'iife', write: false,
  target: 'es2020', legalComments: 'none',
})).outputFiles[0].text;

const html = readFileSync('connect/index.html', 'utf8').replace('/*__CONNECT_BUNDLE__*/', () => bundle);
writeFileSync('connect/dist/index.html', html);

const { csp, scriptHashes } = hardenHtml({
  htmlPath: 'connect/dist/index.html', headersPath: 'connect/dist/_headers',
  connect: "'none'", img: 'data:', manifest: false,
});
console.log('connect bridge built:', scriptHashes, 'script hash(es) · connect-src none · connect/dist/{index.html,_headers}');
console.log('bundle bytes:', bundle.length, '· CSP:', csp);
