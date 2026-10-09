// Olesia mainnet wallet — languages.
//
// English is built into the page. Every other language is a JSON file next to the page
// (i18n/<code>.json — a map from the English string to its translation), fetched from the page's
// own origin, listed in BUILD_HASH.txt and checked by the live check. A translation is DATA: it
// is only ever placed as text nodes and into the page's own existing inline elements (reused,
// never created from the translation), so no translation can add markup or script.
//
// Static text: the page is walked for "units" — elements whose children are text and simple
// inline elements (<b>, <code>, <a>, <span>…, <br>). A unit's key is its English content with
// the child elements numbered: "Load your encrypted <1>.dat</1> file". The translation keeps the
// numbers; the original child elements are moved back in with their text replaced. Units whose
// text the script has since changed are left alone. Attributes title / placeholder / aria-label
// are keyed by their English value.
// Script text: OI18N.t('English', { n: 3 }) — "{n}" placeholders are filled after translation.
(function () {
  const LANGS = [
    ['en', 'English'], ['af', 'Afrikaans'], ['bg', 'Български'], ['cs', 'Čeština'], ['da', 'Dansk'], ['de', 'Deutsch'], ['el', 'Ελληνικά'],
    ['es', 'Español'], ['et', 'Eesti'], ['fi', 'Suomi'], ['fr', 'Français'], ['hi', 'हिन्दी'], ['hr', 'Hrvatski'], ['hu', 'Magyar'],
    ['id', 'Bahasa Indonesia'], ['it', 'Italiano'], ['ja', '日本語'], ['ko', '한국어'], ['lt', 'Lietuvių'], ['lv', 'Latviešu'],
    ['ms', 'Bahasa Melayu'], ['nb', 'Norsk'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['pt', 'Português'], ['ro', 'Română'],
    ['ru', 'Русский'], ['sk', 'Slovenčina'], ['sl', 'Slovenščina'], ['sr', 'Srpski'], ['sv', 'Svenska'], ['th', 'ไทย'], ['tr', 'Türkçe'],
    ['uk', 'Українська'], ['vi', 'Tiếng Việt'], ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文（香港・台灣）'],
  ];
  const KEY = 'olesia:mainnet:lang';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'CANVAS', 'SVG', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'NOSCRIPT']);   // a <select> is walked for its <option>s
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  let dict = null, code = 'en', loading = null, applied = false;   // applied: the page has been walked once; units made by the script after that are its own
  const missing = new Set();   // English strings a language had no entry for (reported by the tests)
  const listeners = [];

  const has = (k) => !!dict && Object.prototype.hasOwnProperty.call(dict, k);
  const t = (key, params) => {
    let s = has(key) ? dict[key] : key;
    if (code !== 'en' && key && !has(key)) missing.add(key);
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
    return s;
  };
  const hasLetters = (s) => /\p{L}/u.test(s);
  const simple = (c) => c.tagName === 'BR' || (c.children.length === 0 && !SKIP.has(c.tagName) && !c.hasAttribute('data-noi18n'));
  // the serialised content of a unit: its text, with child elements numbered in order
  function keyOf(el) {
    let k = 1, s = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeType === 1) { s += n.tagName === 'BR' ? `<${k}/>` : `<${k}>${n.textContent.replace(/\s+/g, ' ').trim()}</${k}>`; k++; }
    }
    return s.replace(/\s+/g, ' ').trim();
  }
  // put a translation into a unit, reusing its own child elements
  function fill(el, tr) {
    const kids = el.__i.kids, used = new Set(), frag = document.createDocumentFragment();
    const re = /<(\d+)\/>|<(\d+)>([\s\S]*?)<\/\2>/g; let last = 0, m;
    while ((m = re.exec(tr))) {
      if (m.index > last) frag.appendChild(document.createTextNode(tr.slice(last, m.index)));
      const idx = Number(m[1] || m[2]) - 1, src = kids[idx];
      if (src && !used.has(idx)) { if (m[2] !== undefined && src.tagName !== 'BR') src.textContent = m[3]; frag.appendChild(src); used.add(idx); }
      else frag.appendChild(document.createTextNode(m[3] || ''));
      last = re.lastIndex;
    }
    if (last < tr.length) frag.appendChild(document.createTextNode(tr.slice(last)));
    kids.forEach((k, i) => { if (!used.has(i)) frag.appendChild(k); });   // an element the translation forgot is kept, not lost
    el.replaceChildren(frag);
  }
  // walk the page: translate every unit and attribute; English restores the originals
  function walk(el, keys) {
    if (el.nodeType !== 1 || SKIP.has(el.tagName) || el.hasAttribute('data-noi18n')) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a); if (!v || !hasLetters(v)) continue;
      if (!el.__ia) el.__ia = {}; if (!(a in el.__ia)) el.__ia[a] = v;
      const key = el.__ia[a]; if (keys) keys.add(key); else el.setAttribute(a, t(key));
    }
    const kids = [...el.children];
    const direct = [...el.childNodes].some((n) => n.nodeType === 3 && hasLetters(n.nodeValue));
    if (direct && kids.every(simple)) {
      if (!el.__i) { if (applied && !keys) { el.__i = { skip: true }; return; } el.__i = { key: keyOf(el), kids, last: null }; }   // made by the script later: it re-words its own text
      if (el.__i.skip) return;
      const now = keyOf(el);
      if (now !== el.__i.key && now !== el.__i.last) return;   // the script has written here since; leave it
      if (keys) { keys.add(el.__i.key); return; }
      const tr = t(el.__i.key); fill(el, tr); el.__i.last = keyOf(el);
      return;
    }
    if (direct && keys) keys.orphans.push(keyOf(el).slice(0, 80));   // text next to a complex child: not reachable — fix the markup
    for (const c of kids) walk(c, keys);
  }
  function apply() {
    walk(document.body); applied = true;
    const title = document.querySelector('title'); if (title) { if (!title.__k) title.__k = title.textContent; title.textContent = t(title.__k); }
    document.documentElement.lang = code;
    for (const f of listeners) { try { f(code); } catch { /* a listener must not stop the others */ } }
  }
  async function set(next, { save = true } = {}) {
    if (!LANGS.some(([c]) => c === next)) next = 'en';
    if (next === 'en') { dict = null; code = 'en'; missing.clear(); }
    else {
      try {
        loading = fetch(new URL(`i18n/${next}.json`, location.href), { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(async (r) => { if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not a dictionary'); return j; });
        const j = await loading;
        dict = {}; for (const [k, v] of Object.entries(j)) if (typeof v === 'string') dict[k] = v;   // strings only
        code = next; missing.clear();
      } catch (e) { loading = null; return { ok: false, error: e.message }; }
      loading = null;
    }
    if (save) { try { localStorage.setItem(KEY, code); } catch { /* fine */ } }
    apply();
    return { ok: true };
  }
  // the language to start in: the saved choice, else the browser's, else English
  function initial() {
    try { const s = localStorage.getItem(KEY); if (s && LANGS.some(([c]) => c === s)) return s; } catch { /* fine */ }
    const have = new Set(LANGS.map(([c]) => c));
    for (const l of (navigator.languages || [navigator.language || 'en'])) {
      const low = String(l).toLowerCase(), base = low.split('-')[0];
      if (low.startsWith('zh')) return /hant|tw|hk|mo/.test(low) ? 'zh-Hant' : 'zh-Hans';
      if (base === 'no' || base === 'nn') return 'nb';
      if (have.has(base)) return base;
    }
    return 'en';
  }
  // units and attributes still showing an English catalogue string whose translation differs:
  // exact, language-independent — what the tests use to prove nothing reachable was left behind
  function untranslated() {
    const out = [];
    const visit = (el) => {
      if (el.nodeType !== 1 || SKIP.has(el.tagName) || el.hasAttribute('data-noi18n')) return;
      for (const a of ATTRS) { const v = el.getAttribute(a); if (v && has(v) && dict[v] !== v) out.push(a + ': ' + v); }
      const kids = [...el.children];
      if ([...el.childNodes].some((n) => n.nodeType === 3 && hasLetters(n.nodeValue)) && kids.every(simple)) { const k = keyOf(el); if (has(k) && dict[k] !== k) out.push(k.slice(0, 80)); return; }
      for (const c of kids) visit(c);
    };
    if (dict) visit(document.body);
    return out;
  }
  const keys = () => { const k = new Set(); k.orphans = []; walk(document.body, k); const title = document.querySelector('title'); if (title) k.add(title.__k || title.textContent); return { keys: [...k], orphans: k.orphans }; };
  window.OI18N = { t, set, apply, initial, keys, untranslated, LANGS, get code() { return code; }, get missing() { return [...missing]; }, onChange: (f) => listeners.push(f) };
})();
