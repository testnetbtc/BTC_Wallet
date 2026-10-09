// Merges the part files mainnet/i18n/parts/<code>.<k>.json (any number of parts, keys may be
// split however the translator liked) into mainnet/i18n/<code>.json, then validates it.
//   node mainnet/i18n/merge.mjs de
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { validate } from './validate.mjs';
const code = process.argv[2]; if (!code) { console.error('usage: node mainnet/i18n/merge.mjs <code>'); process.exit(2); }
const DIR = 'mainnet/i18n'; mkdirSync(`${DIR}/parts`, { recursive: true });
const en = JSON.parse(readFileSync(`${DIR}/en.json`, 'utf8'));
const out = {};
const parts = readdirSync(`${DIR}/parts`).filter((f) => f.startsWith(code + '.') && f.endsWith('.json')).sort();
for (const f of parts) { const j = JSON.parse(readFileSync(`${DIR}/parts/${f}`, 'utf8')); for (const [k, v] of Object.entries(j)) if (k in en && typeof v === 'string') out[k] = v; }
const ordered = {}; for (const k of Object.keys(en)) if (k in out) ordered[k] = out[k];
writeFileSync(`${DIR}/${code}.json`, JSON.stringify(ordered, null, 1) + '\n');
const r = validate(code);
r.problems.slice(0, 40).forEach((p) => console.log(p));
console.log(`${code}.json: ${Object.keys(ordered).length}/${Object.keys(en).length} keys from ${parts.length} part(s) · ${r.ok ? 'OK' : r.problems.length + ' problem(s)'}`);
process.exit(r.ok ? 0 : 1);
