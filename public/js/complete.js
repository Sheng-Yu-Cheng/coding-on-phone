// Completion candidates: snippets + language server (when present) + words
// from the buffer and a small built-in vocabulary as fallback.

const VOCAB = {
  cpp: `vector string map set unordered_map unordered_set multiset pair tuple queue deque stack
    priority_queue bitset array push_back pop_back emplace_back emplace insert erase find count
    lower_bound upper_bound begin end rbegin rend size empty clear front back top push pop first
    second sort stable_sort reverse unique accumulate max_element min_element next_permutation
    swap min max abs gcd lcm fill iota resize assign substr to_string stoi stoll getline cin cout
    cerr endl long double int char bool void const auto return while for if else break continue
    struct class template typename using namespace std nullptr true false static inline
    make_pair make_tuple greater less numeric_limits INT_MAX INT_MIN LLONG_MAX LLONG_MIN
    memset memcpy sizeof function lambda binary_search nth_element partial_sum __builtin_popcount
    __builtin_popcountll __builtin_clz __builtin_ctz unsigned include define`,
  c: `int long char double float void unsigned const static struct typedef return while for if else
    break continue switch case default sizeof printf scanf puts getchar putchar malloc calloc
    realloc free memset memcpy strlen strcmp strcpy qsort abs include define NULL`,
  py: `def return for while if elif else in range len print input int str list dict set tuple map
    sum min max sorted enumerate zip abs any all import from as class lambda None True False
    append extend pop insert remove sort reverse split join strip readline sys stdin stdout
    collections deque defaultdict Counter heapq heappush heappop bisect bisect_left bisect_right
    itertools math functools lru_cache continue break pass not and or try except with yield`,
};
const vocab = {};
for (const k of Object.keys(VOCAB)) vocab[k] = VOCAB[k].split(/\s+/).filter(Boolean);

// Higher is better; 0 means no match.
export function score(label, prefix) {
  if (!prefix) return 1;
  if (label === prefix) return 0;                 // nothing to complete
  if (label.startsWith(prefix)) return 100 - Math.min(40, label.length - prefix.length);
  const ll = label.toLowerCase();
  const pl = prefix.toLowerCase();
  if (ll.startsWith(pl)) return 50 - Math.min(30, label.length - prefix.length);
  if (prefix.length >= 2) {                        // subsequence match, e.g. "pb" → push_back
    let i = 0;
    for (const ch of ll) if (ch === pl[i]) i++;
    if (i === pl.length) return 10;
  }
  return 0;
}

export function snippetMatches(snippets, lang, prefix) {
  if (!prefix) return [];
  return snippets
    .filter((s) => !s.template && s.abbr && s.lang === lang && s.abbr.startsWith(prefix))
    .sort((a, b) => a.abbr.length - b.abbr.length)
    .map((s) => ({ kind: 'snip', label: s.abbr, detail: s.name, body: s.body }));
}

export function localMatches(text, lang, prefix, limit = 20) {
  if (!prefix) return [];
  const seen = new Map();
  const words = text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
  for (const w of words) seen.set(w, (seen.get(w) || 0) + 1);
  // The word being typed is in the buffer once; do not offer it back.
  if (seen.get(prefix) === 1) seen.delete(prefix);
  for (const w of vocab[lang] || []) if (!seen.has(w)) seen.set(w, 0);
  const out = [];
  for (const [w, n] of seen) {
    const sc = score(w, prefix);
    if (sc > 0) out.push({ kind: 'word', label: w, insert: w, sc: sc + Math.min(n, 5) });
  }
  out.sort((a, b) => b.sc - a.sc || a.label.length - b.label.length);
  return out.slice(0, limit);
}

export function rankServerItems(items, prefix, limit = 30) {
  const out = [];
  const seen = new Set();
  items.forEach((it, i) => {
    const sc = score(it.label, prefix);
    if (sc <= 0 || seen.has(it.insert)) return;
    seen.add(it.insert);
    out.push({ kind: 'lsp', label: it.label, insert: it.insert, from: it.from, detail: '', sc: sc * 1000 - i });
  });
  out.sort((a, b) => b.sc - a.sc);
  return out.slice(0, limit);
}
