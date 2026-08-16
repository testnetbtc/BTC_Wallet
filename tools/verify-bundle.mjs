// M5 — served-bundle IDENTITY verifier (complements tools/verify-headers.mjs, which only checks
// that headers are PRESENT, not that the served CODE matches the repo). The wallet and cold
// generator are each a single self-contained index.html, so a sha256 of the served bytes is the
// whole build. This fetches the live page and compares it to the repo build hash, so a stale or
// altered deployment (e.g. app.olesia.io serving an older bundle than HEAD) is caught instead of
// passing silently. Run AFTER `node web/build.mjs` so web/BUILD_HASH.txt is current:
//   node tools/verify-bundle.mjs                 # preview URLs (default)
//   node tools/verify-bundle.mjs production      # live domains
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Each target: the repo artifact whose hash is authoritative + the deployed URLs to check.
const REPO = {
  wallet: join(ROOT, 'packages/bitcoin/web/index.html'),
  coldgen: join(ROOT, 'packages/bitcoin/web/site/index.html'),
};
const TARGETS = {
  preview: { wallet: 'https://preview.olesia-wallet.pages.dev/' },
  production: { wallet: 'https://app.olesia.io/' },
};

const env = process.argv[2] === 'production' ? 'production' : 'preview';
let bad = false;
for (const [name, url] of Object.entries(TARGETS[env])) {
  const repoPath = REPO[name];
  if (!repoPath || !existsSync(repoPath)) { console.log(`? ${name}: no repo artifact at ${repoPath} — run the build first`); bad = true; continue; }
  const repoHash = sha(readFileSync(repoPath));
  let servedHash = null, err = null;
  try { const res = await fetch(url + '?cb=' + process.pid, { cache: 'no-store' }); servedHash = sha(Buffer.from(await res.arrayBuffer())); }
  catch (e) { err = e.message; }
  const match = servedHash && servedHash === repoHash;
  if (!match) bad = true;
  console.log(`${match ? '✓' : '✗'} ${name.padEnd(8)} ${url}`);
  console.log(`    repo   : ${repoHash}`);
  console.log(`    served : ${servedHash || '(fetch failed: ' + err + ')'}`);
  if (servedHash && !match) console.log('    ✗ DEPLOYMENT DRIFT — the live bytes do not match this repo build. Redeploy, or check out the deployed commit.');
}
console.log(bad ? '\nBUNDLE VERIFY FAILED — served code != repo build' : `\nBUNDLE VERIFY PASS (${env}) — served bytes match the repo build`);
process.exit(bad ? 1 : 0);
