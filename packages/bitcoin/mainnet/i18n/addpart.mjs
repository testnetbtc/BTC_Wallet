// Adds a translated part to an existing dictionary and prunes keys that are no longer in en.json:
//   node mainnet/i18n/addpart.mjs de mainnet/i18n/parts/de.5.json
import { readFileSync, writeFileSync } from 'node:fs';
import { validate } from './validate.mjs';
const [, , code, partFile] = process.argv;
const DIR = 'mainnet/i18n';
const en = JSON.parse(readFileSync(`${DIR}/en.json`, 'utf8'));
const cur = JSON.parse(readFileSync(`${DIR}/${code}.json`, 'utf8'));
const part = partFile ? JSON.parse(readFileSync(partFile, 'utf8')) : {};
const out = {};
for (const k of Object.keys(en)) { const v = typeof part[k] === 'string' && part[k].trim() ? part[k] : cur[k]; if (typeof v === 'string') out[k] = v; }
writeFileSync(`${DIR}/${code}.json`, JSON.stringify(out, null, 1) + '\n');
const r = validate(code);
r.problems.slice(0, 20).forEach((p) => console.log(p));
console.log(`${code}.json: ${Object.keys(out).length}/${Object.keys(en).length} keys (${Object.keys(cur).length - Object.keys(out).length + Object.keys(part).filter((k) => k in en && !(k in cur)).length} pruned) · ${r.ok ? 'OK' : r.problems.length + ' problem(s)'}`);
process.exit(r.ok ? 0 : 1);
