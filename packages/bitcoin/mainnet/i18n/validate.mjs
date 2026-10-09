// Checks one dictionary against en.json without a browser: every key present and non-empty,
// strings only, no extra keys, and every <n>…</n>, <n/> and {name} of the English preserved.
//   node mainnet/i18n/validate.mjs de          (exit 1 on any problem; prints them)
import { readFileSync } from 'node:fs';
export function validate(code, dir = 'mainnet/i18n') {
  const en = JSON.parse(readFileSync(`${dir}/en.json`, 'utf8'));
  let d; try { d = JSON.parse(readFileSync(`${dir}/${code}.json`, 'utf8')); } catch (e) { return { ok: false, problems: ['not JSON: ' + e.message] }; }
  const tags = (s) => (String(s).match(/<\d+\/?>|<\/\d+>|\{\w+\}/g) || []).sort().join(' ');
  const problems = [];
  for (const k of Object.keys(en)) {
    const v = d[k];
    if (typeof v !== 'string' || !v.trim()) problems.push('missing: ' + k);
    else if (tags(v) !== tags(k)) problems.push(`placeholders differ: ${k}  →  ${v}`);
    else if (/<\/?[a-z]/i.test(v) && !/<\/?[a-z]/i.test(k)) problems.push('markup added: ' + k + '  →  ' + v);
  }
  for (const k of Object.keys(d)) if (!(k in en)) problems.push('not an English key: ' + k);
  return { ok: problems.length === 0, problems, total: Object.keys(en).length, same: Object.keys(en).filter((k) => d[k] === k && k.split(' ').length > 2).length };
}
if (process.argv[1] && process.argv[1].endsWith('validate.mjs')) {
  const code = process.argv[2]; if (!code) { console.error('usage: node mainnet/i18n/validate.mjs <code>'); process.exit(2); }
  const r = validate(code);
  r.problems.slice(0, 40).forEach((p) => console.log(p));
  console.log(`${code}: ${r.ok ? 'OK' : r.problems.length + ' problem(s)'} · ${r.total} keys · ${r.same} left identical to English`);
  process.exit(r.ok ? 0 : 1);
}
