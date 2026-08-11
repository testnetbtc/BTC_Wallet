// Build the web wallet and copy it into www/ so Capacitor bundles it locally.
// If the wallet's build deps aren't installed (e.g. a clean CI checkout), fall
// back to the pre-built index.html that is committed in www/ — the app still
// builds, it just uses the last committed bundle.
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'packages', 'bitcoin', 'web');
const WWW = join(HERE, 'www');
mkdirSync(WWW, { recursive: true });
let fresh = false;
try {
  console.log('building wallet…');
  execSync('node web/build.mjs', { cwd: join(HERE, '..', 'packages', 'bitcoin'), stdio: 'inherit' });
  fresh = true;
} catch (e) {
  if (!existsSync(join(WWW, 'index.html'))) throw new Error('wallet build failed and no pre-built www/index.html to fall back on: ' + e.message);
  console.log('! wallet build unavailable here — using the committed www/index.html');
}
if (fresh) copyFileSync(join(WEB, 'index.html'), join(WWW, 'index.html'));
for (const f of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'])
  copyFileSync(join(WEB, 'pwa', f), join(WWW, f));
console.log('www/ ready — run `npx cap sync ios` on the Mac');
