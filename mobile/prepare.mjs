// Build the web wallet and copy it into www/ so Capacitor bundles it locally.
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'packages', 'bitcoin', 'web');
const WWW = join(HERE, 'www');
console.log('building wallet…');
execSync('node web/build.mjs', { cwd: join(HERE, '..', 'packages', 'bitcoin'), stdio: 'inherit' });
mkdirSync(WWW, { recursive: true });
copyFileSync(join(WEB, 'index.html'), join(WWW, 'index.html'));
for (const f of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'])
  copyFileSync(join(WEB, 'pwa', f), join(WWW, f));
console.log('www/ ready — run `npx cap sync ios` on the Mac');
