// Tiny line-based tokenizer for C, C++ and Python. Good enough for colouring
// and for knowing which characters sit inside strings/comments.

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const C_KW = `if else for while do switch case default break continue return goto sizeof typedef
  struct union enum static const extern inline volatile register restrict`;
const CPP_KW = C_KW + ` class public private protected virtual override final template typename
  using namespace new delete this operator friend constexpr consteval constinit noexcept try catch
  throw auto decltype explicit mutable static_cast dynamic_cast const_cast reinterpret_cast
  nullptr true false and or not concept requires co_await co_return co_yield static_assert`;
const C_TYPES = `int long short char float double void unsigned signed bool size_t int8_t int16_t
  int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE`;
const CPP_TYPES = C_TYPES + ` ll ull ld string vector map set multiset unordered_map unordered_set
  pair tuple queue deque stack priority_queue array bitset list optional string_view wchar_t
  pii pll vi vl __int128`;
const PY_KW = `and as assert async await break class continue def del elif else except finally for
  from global if import in is lambda nonlocal not or pass raise return try while with yield
  True False None match case`;
const PY_TYPES = `int float str list dict set tuple bool bytes range len print input map sum min max
  sorted enumerate zip abs any all open self`;

const LANGS = {
  c: { kw: words(C_KW), types: words(C_TYPES), py: false },
  cpp: { kw: words(CPP_KW), types: words(CPP_TYPES), py: false },
  py: { kw: words(PY_KW), types: words(PY_TYPES), py: true },
};

const ID_START = /[A-Za-z_]/;
const ID_REST = /[A-Za-z0-9_]/;
const NUM = /^(0[xX][0-9a-fA-F']+|0[bB][01']+|\d[\d']*\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[uUlLfFjJ]*/;

// state: 0 normal, 1 inside /* */, 2 inside ''' , 3 inside """
export function tokenizeLine(line, state, lang) {
  const L = LANGS[lang] || LANGS.cpp;
  const toks = [];
  const n = line.length;
  let i = 0;
  const push = (s, e, c) => { if (e > s) toks.push([s, e, c]); };

  if (state === 1) {
    const end = line.indexOf('*/');
    if (end < 0) { push(0, n, 'com'); return { toks, state: 1 }; }
    push(0, end + 2, 'com'); i = end + 2; state = 0;
  } else if (state === 2 || state === 3) {
    const q = state === 2 ? "'''" : '"""';
    const end = line.indexOf(q);
    if (end < 0) { push(0, n, 'str'); return { toks, state }; }
    push(0, end + 3, 'str'); i = end + 3; state = 0;
  }

  if (!L.py) {
    const m = /^\s*#\s*\w*/.exec(line);
    if (m && i === 0) {
      push(0, m[0].length, 'pre');
      i = m[0].length;
      const inc = /^\s*(<[^>]*>?)/.exec(line.slice(i));
      if (/include/.test(m[0]) && inc) { push(i, i + inc[0].length, 'str'); i += inc[0].length; }
    }
  }

  while (i < n) {
    const ch = line[i];
    if (L.py) {
      if (ch === '#') { push(i, n, 'com'); break; }
    } else if (ch === '/' && line[i + 1] === '/') {
      push(i, n, 'com'); break;
    } else if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end < 0) { push(i, n, 'com'); state = 1; break; }
      push(i, end + 2, 'com'); i = end + 2; continue;
    }
    if (ch === '"' || ch === "'") {
      if (L.py && line.startsWith(ch.repeat(3), i)) {
        const end = line.indexOf(ch.repeat(3), i + 3);
        if (end < 0) { push(i, n, 'str'); state = ch === "'" ? 2 : 3; break; }
        push(i, end + 3, 'str'); i = end + 3; continue;
      }
      // C++ digit separator such as 1'000'000 is handled by NUM, not here.
      let j = i + 1;
      while (j < n && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      j = Math.min(n, j + 1);
      push(i, j, 'str'); i = j; continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] || ''))) {
      const m = NUM.exec(line.slice(i));
      const len = m ? m[0].length : 1;
      push(i, i + len, 'num'); i += len; continue;
    }
    if (ID_START.test(ch)) {
      let j = i + 1;
      while (j < n && ID_REST.test(line[j])) j++;
      const w = line.slice(i, j);
      if (L.py && /^[rbfuRBFU]{1,2}$/.test(w) && (line[j] === '"' || line[j] === "'")) { i = j; continue; }
      let cls = null;
      if (L.kw.has(w)) cls = 'kw';
      else if (L.types.has(w)) cls = 'typ';
      else {
        let k = j;
        while (k < n && line[k] === ' ') k++;
        if (line[k] === '(') cls = 'fn';
      }
      if (cls) push(i, j, cls);
      i = j; continue;
    }
    if (L.py && ch === '@' && /^\s*$/.test(line.slice(0, i))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(line[j])) j++;
      push(i, j, 'pre'); i = j; continue;
    }
    i++;
  }
  return { toks, state };
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
export const esc = (s) => s.replace(/[&<>]/g, (c) => ESC[c]);

export function lineHtml(line, toks) {
  if (!toks.length) return esc(line);
  let out = '';
  let pos = 0;
  for (const [s, e, c] of toks) {
    if (s > pos) out += esc(line.slice(pos, s));
    out += `<span class="t-${c}">${esc(line.slice(s, e))}</span>`;
    pos = e;
  }
  if (pos < line.length) out += esc(line.slice(pos));
  return out;
}

// Highlighter with a per-line cache keyed by (state, text).
export class Highlighter {
  constructor() { this.cache = new Map(); this.lang = 'cpp'; }

  setLang(lang) { if (lang !== this.lang) { this.lang = lang; this.cache.clear(); } }

  // Returns [{html, toks}] for every line.
  run(lines) {
    const out = new Array(lines.length);
    const next = new Map();
    let state = 0;
    for (let i = 0; i < lines.length; i++) {
      const key = state + '\u0000' + lines[i];
      let hit = this.cache.get(key);
      if (!hit) {
        const r = tokenizeLine(lines[i], state, this.lang);
        hit = { html: lineHtml(lines[i], r.toks), toks: r.toks, state: r.state };
      }
      next.set(key, hit);
      out[i] = hit;
      state = hit.state;
    }
    this.cache = next;
    return out;
  }
}

// Lines with string/comment contents blanked out, for bracket matching.
export function maskLines(lines, hl) {
  return lines.map((line, i) => {
    let s = line;
    for (const [a, b, c] of hl[i].toks) {
      if (c === 'str' || c === 'com') s = s.slice(0, a) + ' '.repeat(b - a) + s.slice(b);
    }
    return s;
  });
}
