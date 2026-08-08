import * as esbuild from 'esbuild';
import { mkdirSync } from 'fs';
mkdirSync('web/dist', { recursive: true });
await esbuild.build({
  entryPoints: ['web/entry.js'], bundle: true, format: 'iife',
  outfile: 'web/dist/online.bundle.js', target: 'es2020', legalComments: 'none',
});
await import('./assemble.mjs');
