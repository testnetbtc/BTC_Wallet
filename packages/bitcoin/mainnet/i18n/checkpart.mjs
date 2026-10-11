// Checks one translated part against the English part it was made from: same keys, strings only,
// tags/placeholders preserved, nothing left identical to English (apart from short tokens).
//   node mainnet/i18n/checkpart.mjs parts/new.json parts/de.5.json
import { readFileSync } from 'node:fs';
const [, , enFile, trFile] = process.argv;
const en = JSON.parse(readFileSync(enFile, 'utf8')), tr = JSON.parse(readFileSync(trFile, 'utf8'));
const tags = (s) => (String(s).match(/<\d+\/?>|<\/\d+>|\{\w+\}/g) || []).sort().join(' ');
const problems = [];
for (const k of Object.keys(en)) {
  const v = tr[k];
  if (typeof v !== 'string' || !v.trim()) { problems.push('missing: ' + k); continue; }
  if (tags(v) !== tags(k)) problems.push('tags/placeholders differ: ' + k + ' -> ' + v);
  if (v === k && /\p{L}{4,}/u.test(k) && k.split(' ').length > 2) problems.push('identical to English: ' + k);
}
for (const k of Object.keys(tr)) if (!(k in en)) problems.push('extra key: ' + k);
problems.forEach((p) => console.log(p));
console.log(`${trFile}: ${Object.keys(tr).length}/${Object.keys(en).length} keys · ${problems.length ? problems.length + ' problem(s)' : 'OK'}`);
process.exit(problems.length ? 1 : 0);
