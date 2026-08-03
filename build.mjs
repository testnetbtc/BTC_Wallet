import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
mkdirSync('dist', { recursive: true });
await esbuild.build({
  entryPoints: ['src/app.js'], bundle: true, format: 'iife',
  outfile: 'dist/alea.bundle.js', legalComments: 'none', target: 'es2020',
});
console.log('bundle bytes:', readFileSync('dist/alea.bundle.js').length);
