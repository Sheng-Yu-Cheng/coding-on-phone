import { Editor } from './editor.js';
import { Keyboard } from './keyboard.js';
import { esc } from './highlight.js';
import { snippetMatches, localMatches, rankServerItems } from './complete.js';

const $ = (id) => document.getElementById(id);
const LANG_NAME = { cpp: 'C++', c: 'C', py: 'Python' };
const SOURCE_NAME = { cses: 'CSES', codeforces: 'Codeforces', leetcode: 'LeetCode', scratch: '草稿' };

const S = {
  problem: null,
  lang: 'cpp',
  view: 'code',
  snippets: [],
  langs: {},
  lsp: {},
  results: null,
  clip: '',
  chips: [],
  kb: false,
  settings: Object.assign({ fontSize: 12, keyHeight: 38, indent: 4 }, readLocal('cop-settings', {})),
};

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ }
}

async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  let res;
  try { res = await fetch(path, opt); } catch (_) { throw new Error('連不上伺服器'); }
  let data = null;
  try { data = await res.json(); } catch (_) { /* not JSON */ }
  if (!res.ok) throw new Error((data && data.error) || '伺服器錯誤 ' + res.status);
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = bad ? 'bad' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 4000 : 1600);
}

// ---------------------------------------------------------------- editor ---
const editor = new Editor($('editor'));
editor.indent = S.settings.indent;
editor.setFontSize(S.settings.fontSize);
document.documentElement.style.setProperty('--kh', S.settings.keyHeight + 'px');

let saveTimer;
let diagTimer;
let diagSeq = 0;

editor.onChange = () => {
  if (!S.problem) return;
  S.problem.code[S.lang] = editor.getText();
  S.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1200);
  clearTimeout(diagTimer);
  diagTimer = setTimeout(refreshDiagnostics, 650);
};
editor.onCursor = updateStatus;
editor.onFontSize = (fs) => { S.settings.fontSize = fs; writeLocal('cop-settings', S.settings); };
editor.onUserScroll = () => setKb(false);
editor.onTap = (pos, n) => {
  clearChips();
  if (n === 2) editor.selectWord(pos);
  else if (n >= 3) { editor.setCursor(pos); editor.selectLine(); } else editor.setCursor(pos, kb.shiftOn);
  setKb(true);
};

async function save() {
  clearTimeout(saveTimer);
  if (!S.problem || !S.dirty) return;
  S.dirty = false;
  try {
    await api('/api/save', { id: S.problem.id, lang: S.lang, code: editor.getText() });
  } catch (e) { S.dirty = true; toast('存檔失敗：' + e.message, true); }
}

function updateStatus() {
  const d = editor.diagAt(editor.cur.l);
  const el = $('status');
  el.hidden = !d;
  if (d) { el.textContent = d.message; el.className = d.severity === 1 ? '' : 'warn'; }
}

async function refreshDiagnostics() {
  if (!S.problem || S.lsp[S.lang] === null || S.lsp[S.lang] === undefined) return;
  const seq = ++diagSeq;
  const code = editor.getText();
  try {
    const r = await api('/api/diagnostics', { id: S.problem.id, lang: S.lang, code });
    if (seq !== diagSeq || code !== editor.getText()) return;
    if (!r.available) { S.lsp[S.lang] = null; return; }
    editor.setDiagnostics(r.diagnostics);
    updateStatus();
  } catch (_) { /* offline: ignore */ }
}

// ------------------------------------------------------------ completion ---
let compTimer;
let compSeq = 0;

function clearChips() {
  compSeq++;
  clearTimeout(compTimer);
  S.chips = [];
  $('chips').hidden = true;
  $('tools').hidden = false;
}

function showChips(list) {
  S.chips = list.slice(0, 24);
  const box = $('chips');
  if (!S.chips.length) { box.hidden = true; $('tools').hidden = false; return; }
  box.innerHTML = S.chips.map((c, i) =>
    `<button data-i="${i}" class="${c.kind === 'snip' ? 'snip' : ''}">${esc(c.label)}${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</button>`).join('');
  box.scrollLeft = 0;
  box.hidden = false;
  $('tools').hidden = true;
}

function applyChip(c) {
  const prefix = editor.wordBefore();
  const from = c.from ?? editor.cur.c - prefix.length;
  if (c.kind === 'snip') editor.insertSnippet(c.body, editor.cur.c - prefix.length);
  else editor.replaceBeforeCursor(from, c.insert);
  clearChips();
}

function inStringOrComment() {
  const row = editor.hlOut[editor.cur.l];
  const c = editor.cur.c - 1;
  return !!row && row.toks.some(([a, b, cls]) => (cls === 'str' || cls === 'com') && c >= a && c < b);
}

function updateCompletion() {
  const seq = ++compSeq;
  clearTimeout(compTimer);
  if (editor.selRange() || inStringOrComment()) return showChips([]);
  const prefix = editor.wordBefore();
  const before = editor.lines[editor.cur.l].slice(0, editor.cur.c);
  const trig = /\.$/.test(before) ? '.' : /->$/.test(before) ? '>' : /::$/.test(before) ? ':' : null;
  if ((!prefix || /^\d/.test(prefix)) && !trig) return showChips([]);
  const snips = snippetMatches(S.snippets, S.lang, prefix);
  const local = localMatches(editor.getText(), S.lang, prefix);
  showChips(snips.concat(local));
  if (!S.lsp[S.lang] || !S.problem) return;
  compTimer = setTimeout(async () => {
    const code = editor.getText();
    const { l, c } = editor.cur;
    try {
      const r = await api('/api/complete', { id: S.problem.id, lang: S.lang, code, line: l, col: c, trigger: trig });
      if (seq !== compSeq) return;
      if (!r.available) { S.lsp[S.lang] = null; return; }
      const ranked = rankServerItems(r.items || [], editor.wordBefore());
      if (ranked.length) showChips(snips.concat(ranked));
    } catch (_) { /* keep local suggestions */ }
  }, 90);
}

$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) applyChip(S.chips[+b.dataset.i]);
});

// --------------------------------------------------------------- clipboard ---
async function copyText(text, label = '已複製') {
  if (!text) return;
  S.clip = text;
  try { await navigator.clipboard.writeText(text); toast(label); } catch (_) { toast(label + '（僅限 App 內貼上）'); }
}

async function pasteText() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch (_) { text = S.clip; }
  if (text) editor.paste(text); else toast('剪貼簿是空的');
}

// ---------------------------------------------------------------- keyboard ---
const NAV = {
  left: (e) => editor.move('left', { shift: e.shift, word: e.ctrl }),
  right: (e) => editor.move('right', { shift: e.shift, word: e.ctrl }),
  up: (e) => (e.ctrl ? editor.moveLines(-1) : editor.move('up', { shift: e.shift })),
  down: (e) => (e.ctrl ? editor.moveLines(1) : editor.move('down', { shift: e.shift })),
  home: (e) => editor.home(e.shift),
  end: (e) => editor.end(e.shift),
  docstart: (e) => editor.docStart(e.shift),
  docend: (e) => editor.docEnd(e.shift),
};

const CTRL = {
  z: (e) => (e.shift ? editor.redo() : editor.undo()),
  y: () => editor.redo(),
  a: () => editor.selectAll(),
  c: () => copyText(editor.selectedText() || editor.lines[editor.cur.l] + '\n'),
  x: () => { const t = editor.selectedText(); if (t) { copyText(t, '已剪下'); editor.cut(); } },
  v: () => pasteText(),
  d: () => editor.duplicateLine(),
  k: () => editor.deleteLines(),
  l: () => editor.selectLine(),
  w: (e) => (e.shift ? editor.shrinkSelection() : editor.expandSelection()),
  s: () => save().then(() => toast('已存檔')),
  '/': () => editor.toggleComment(),
};

function onKey(e) {
  if (e.type === 'trackpad') {
    for (let i = 0; i < Math.abs(e.dx); i++) editor.move(e.dx < 0 ? 'left' : 'right', { shift: e.shift });
    for (let i = 0; i < Math.abs(e.dy); i++) editor.move(e.dy < 0 ? 'up' : 'down', { shift: e.shift });
    return clearChips();
  }
  if (e.type === 'nav') { NAV[e.dir](e); return clearChips(); }
  if (e.ctrl) {
    clearChips();
    if (e.type === 'enter') return run();
    if (e.type === 'bksp') return editor.backspace(true);
    const fn = e.type === 'char' && CTRL[(e.base || e.ch).toLowerCase()];
    if (fn) fn(e);
    return undefined;
  }
  switch (e.type) {
    case 'char':
      if (e.ch.length === 1) editor.type(e.ch); else editor.insert(e.ch, 'type');
      return updateCompletion();
    case 'bksp':
      editor.backspace();
      return editor.wordBefore() ? updateCompletion() : clearChips();
    case 'enter':
      editor.enter();
      return clearChips();
    case 'tab':
      if (!e.shift && S.chips.length && editor.wordBefore()) return applyChip(S.chips[0]);
      editor.tab(e.shift);
      return clearChips();
    default:
      return undefined;
  }
}

const kb = new Keyboard($('keys'), onKey);

function setKb(on) {
  if (S.view !== 'code') on = false;
  S.kb = on;
  $('kb').hidden = !on;
  $('kb-show').hidden = on || S.view !== 'code';
  if (on) requestAnimationFrame(() => { editor.render(); editor.reveal(); });
}

$('kb-show').addEventListener('click', () => setKb(true));

const TOOLS = {
  hide: () => setKb(false),
  undo: () => editor.undo(),
  redo: () => editor.redo(),
  expand: () => editor.expandSelection(),
  shrink: () => editor.shrinkSelection(),
  line: () => editor.selectLine(),
  copy: () => CTRL.c(),
  cut: () => CTRL.x(),
  paste: () => pasteText(),
  comment: () => editor.toggleComment(),
  dup: () => editor.duplicateLine(),
  snips: () => showSnippets(),
};
$('tools').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && TOOLS[b.dataset.tool]) TOOLS[b.dataset.tool]();
});

// A hardware keyboard (desktop browser, iPad) drives the same editor.
document.addEventListener('keydown', (e) => {
  if (S.view !== 'code' || !$('sheet').hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
  const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  let ev = null;
  if (map[e.key]) ev = { type: 'nav', dir: map[e.key] };
  else if (e.key === 'Home') ev = { type: 'nav', dir: mods.ctrl ? 'docstart' : 'home', ctrl: false };
  else if (e.key === 'End') ev = { type: 'nav', dir: mods.ctrl ? 'docend' : 'end', ctrl: false };
  else if (e.key === 'Backspace') ev = { type: 'bksp' };
  else if (e.key === 'Delete') { editor.del(); e.preventDefault(); return; } else if (e.key === 'Enter') ev = { type: 'enter' };
  else if (e.key === 'Tab') ev = { type: 'tab' };
  else if (e.key === 'Escape') { clearChips(); return; } else if (e.key.length === 1) ev = { type: 'char', ch: e.key, base: e.key.toLowerCase() };
  if (!ev) return;
  if (mods.ctrl && ev.type === 'char' && !CTRL[ev.base]) return;   // leave browser shortcuts alone
  e.preventDefault();
  onKey({ ...mods, ...ev });
});

// ------------------------------------------------------------------ views ---
function setView(v) {
  S.view = v;
  for (const name of ['problem', 'code', 'tests']) $('view-' + name).hidden = name !== v;
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.view === v);
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  setKb(v === 'code' && S.kb);
  if (v === 'code') { $('kb-show').hidden = S.kb; editor.render(); }
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setView(b.dataset.view);
});

function renderProblem() {
  const p = S.problem;
  $('p-title').textContent = p.title;
  const meta = [`<span>${esc(SOURCE_NAME[p.source] || p.source)}</span>`];
  if (p.source !== 'scratch') meta.push(`<span>時限 ${p.timeLimit}s</span>`);
  if (p.url) meta.push(`<a href="${esc(p.url).replace(/"/g, '&quot;')}" target="_blank" rel="noopener">開啟原題／提交 ↗</a>`);
  $('p-meta').innerHTML = meta.join('');
  const note = p.note ? `<div class="note">${esc(p.note)}</div>` : '';
  // p.html was sanitised by the server to a tag whitelist with no attributes.
  $('p-body').innerHTML = note + (p.html || '<div class="empty">這是草稿，沒有題目敘述。<br>到「測試」頁貼上輸入就能執行。</div>');
}

// ------------------------------------------------------------------ tests ---
let testsTimer;
function saveTestsSoon() {
  clearTimeout(testsTimer);
  testsTimer = setTimeout(() => {
    api('/api/problem/update', { id: S.problem.id, tests: S.problem.tests }).catch((e) => toast(e.message, true));
  }, 800);
}

function renderTests() {
  const p = S.problem;
  const res = S.results;
  const box = $('t-list');
  box.innerHTML = '';
  p.tests.forEach((t, i) => {
    const r = res && res.results[i];
    const el = document.createElement('div');
    el.className = 'test';
    el.innerHTML = `<div class="test-head"><b>測試 ${i + 1}</b>` +
      (r ? `<span class="tag ${r.status}">${r.status}</span><span class="ms">${r.timeMs} ms${r.detail ? ' · ' + esc(r.detail) : ''}</span>` : '') +
      `<button data-del="${i}" class="danger">刪除</button></div>` +
      `<div class="io"><div><label>輸入</label><textarea data-f="input" data-i="${i}" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"></textarea></div>` +
      `<div><label>預期輸出</label><textarea data-f="expected" data-i="${i}" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"></textarea></div></div>` +
      (r && (r.status !== 'AC' || !t.expected) ? `<label class="ms">實際輸出</label><pre class="out"></pre>` : '') +
      (r && r.stderr ? `<label class="ms">stderr</label><pre class="out err"></pre>` : '');
    const areas = el.querySelectorAll('textarea');
    areas[0].value = t.input;
    areas[1].value = t.expected;
    const outs = el.querySelectorAll('pre.out:not(.err)');
    if (outs[0]) outs[0].textContent = r.stdout || '（沒有輸出）';
    const err = el.querySelector('pre.err');
    if (err) err.textContent = r.stderr;
    box.appendChild(el);
  });
  if (!p.tests.length) box.innerHTML = '<div class="empty">還沒有測試資料。<br>按下面的按鈕新增，或直接按 ▶ 以空輸入執行。</div>';
}

function renderSummary() {
  const res = S.results;
  const sum = $('t-summary');
  const comp = $('t-compile');
  const badge = $('badge');
  badge.textContent = '';
  comp.hidden = true;
  if (!res) { sum.textContent = ''; return; }
  if (res.running) { sum.textContent = '編譯執行中…'; return; }
  if (res.compile.stderr) {
    comp.hidden = false;
    comp.className = res.compile.ok ? 'warn' : '';
    comp.innerHTML = esc(res.compile.stderr).replace(/^(main\.\w+):(\d+):(\d+)/gm,
      '<span class="loc" data-l="$2" data-c="$3">$1:$2:$3</span>');
  }
  if (!res.compile.ok) { sum.innerHTML = '<span class="tag CE">CE</span> 編譯失敗'; badge.textContent = '✗'; badge.className = 'bad'; return; }
  const judged = res.results.filter((r) => r.status !== 'OK');
  const ac = res.results.filter((r) => r.status === 'AC').length;
  const bad = judged.length - ac;
  if (!judged.length) sum.textContent = '執行完成（沒有預期輸出可比對）';
  else if (!bad) sum.innerHTML = `<span class="tag AC">AC</span> ${ac} / ${judged.length} 筆通過`;
  else sum.innerHTML = `<span class="tag WA">✗</span> ${ac} / ${judged.length} 筆通過`;
  badge.textContent = judged.length ? (bad ? '✗' : '✓') : '';
  badge.className = bad ? 'bad' : 'ok';
}

$('t-compile').addEventListener('click', (e) => {
  const loc = e.target.closest('.loc');
  if (!loc) return;
  setView('code');
  editor.setCursor({ l: +loc.dataset.l - 1, c: +loc.dataset.c - 1 });
  setKb(true);
});
$('t-list').addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.f) { S.problem.tests[+t.dataset.i][t.dataset.f] = t.value; saveTestsSoon(); }
});
$('t-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-del]');
  if (!b) return;
  S.problem.tests.splice(+b.dataset.del, 1);
  S.results = null;
  renderSummary();
  renderTests();
  saveTestsSoon();
});
$('t-add').addEventListener('click', () => {
  S.problem.tests.push({ input: '', expected: '' });
  S.results = null;
  renderSummary();
  renderTests();
  saveTestsSoon();
  const areas = $('t-list').querySelectorAll('textarea[data-f=input]');
  areas[areas.length - 1].focus();
});

function compileDiagnostics(stderr) {
  const out = [];
  const re = /^main\.\w+:(\d+):(\d+): (error|warning): (.*)$/gm;
  let m;
  while ((m = re.exec(stderr))) {
    out.push({ line: +m[1] - 1, col: +m[2] - 1, endLine: +m[1] - 1, endCol: +m[2], severity: m[3] === 'error' ? 1 : 2, message: m[4] });
  }
  return out;
}

async function run() {
  if (!S.problem || (S.results && S.results.running)) return;
  if (!S.langs[S.lang]) return toast(`伺服器沒有安裝 ${LANG_NAME[S.lang]} 的編譯器`, true);
  clearTimeout(saveTimer);
  S.dirty = false;
  const p = S.problem;
  const tests = p.tests.length ? p.tests : [{ input: '', expected: '' }];
  const implicit = !p.tests.length;
  S.results = { running: true };
  $('btn-run').disabled = true;
  setView('tests');
  renderSummary();
  try {
    const res = await api('/api/run', { id: p.id, lang: S.lang, code: editor.getText(), tests, timeLimit: p.timeLimit });
    S.results = res;
    if (implicit && res.results.length) { p.tests = [{ input: '', expected: '' }]; }
    if (!S.lsp[S.lang]) editor.setDiagnostics(compileDiagnostics(res.compile.stderr || ''));
    const judged = res.results.filter((r) => r.status !== 'OK');
    const solved = res.compile.ok && judged.length > 0 && judged.every((r) => r.status === 'AC');
    if (solved !== !!p.solved) { p.solved = solved; api('/api/problem/update', { id: p.id, solved }).catch(() => {}); }
  } catch (e) {
    S.results = null;
    toast(e.message, true);
  }
  $('btn-run').disabled = false;
  renderSummary();
  renderTests();
}
$('btn-run').addEventListener('click', run);
$('btn-copy').addEventListener('click', () => copyText(editor.getText(), '已複製全部程式碼'));

// --------------------------------------------------------------- problems ---
function templateFor(lang) {
  return S.snippets.find((s) => s.template && s.lang === lang);
}

function loadCode() {
  const p = S.problem;
  editor.lang = S.lang;
  const code = p.code[S.lang];
  if (code !== undefined && code.trim() !== '') editor.setText(code);
  else {
    const starter = p.starter && p.starter[S.lang];
    const tpl = templateFor(S.lang);
    editor.setText('');
    if (starter) editor.setText(starter);
    else if (tpl) editor.insertSnippet(tpl.body);
    editor.undoStack = [];
    p.code[S.lang] = editor.getText();
  }
  clearChips();
  clearTimeout(diagTimer);
  diagTimer = setTimeout(refreshDiagnostics, 300);
}

async function openProblem(id, view) {
  await save();
  const p = await api('/api/problem?id=' + encodeURIComponent(id));
  p.code = p.code || {};
  p.tests = p.tests || [];
  S.problem = p;
  S.results = null;
  S.lang = p.lang || 'cpp';
  $('lang').value = S.lang;
  writeLocal('cop-last', p.id);
  renderProblem();
  renderSummary();
  renderTests();
  loadCode();
  setView(view || (p.html ? 'problem' : 'code'));
}

$('lang').addEventListener('change', async () => {
  await save();
  S.lang = $('lang').value;
  S.problem.lang = S.lang;
  S.results = null;
  renderSummary();
  renderTests();
  loadCode();
  api('/api/problem/update', { id: S.problem.id, lang: S.lang }).catch(() => {});
});

// ----------------------------------------------------------------- sheets ---
function openSheet(title, html) {
  $('sheet-title').textContent = title;
  $('sheet-body').innerHTML = html;
  $('sheet').hidden = false;
  return $('sheet-body');
}
function closeSheet() { $('sheet').hidden = true; $('sheet-body').innerHTML = ''; }
$('sheet-close').addEventListener('click', closeSheet);
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet') && S.problem) closeSheet(); });

const fmtTime = (t) => new Date(t * 1000).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function showMenu() {
  let problems = [];
  try { problems = await api('/api/problems'); } catch (e) { toast(e.message, true); }
  const body = openSheet('題目', `
    <div class="row"><input id="m-url" type="url" inputmode="url" placeholder="貼上題目網址，或 CSES 題號" autocapitalize="off" autocorrect="off" spellcheck="false">
      <button id="m-paste">貼上</button></div>
    <div class="row"><button id="m-fetch" class="primary" style="flex:1">抓取題目</button><button id="m-new">新草稿</button></div>
    <div class="hint">支援 CSES（主要）、Codeforces 與 LeetCode（盡力而為，可能被擋）。</div>
    <div class="row" style="margin-top:12px"><button id="m-snips" style="flex:1">片段與模板</button>
      <button id="m-hist" style="flex:1">歷史版本</button><button id="m-set" style="flex:1">設定</button></div>
    <div class="sec">最近的題目</div>
    <div class="list" id="m-list">${problems.map((p) => `
      <div class="item ${S.problem && p.id === S.problem.id ? 'on' : ''}" data-id="${esc(p.id)}">
        <div class="grow"><div class="t">${p.solved ? '✓ ' : ''}${esc(p.title || p.id)}</div>
        <small>${esc(SOURCE_NAME[p.source] || '')} · ${fmtTime(p.updated || 0)}</small></div>
        <button data-del="${esc(p.id)}" class="danger">刪除</button></div>`).join('') || '<div class="item"><span class="hint">還沒有題目</span></div>'}
    </div>`);
  const url = body.querySelector('#m-url');
  body.querySelector('#m-paste').onclick = async () => {
    try { url.value = (await navigator.clipboard.readText()).trim(); } catch (_) { url.focus(); }
  };
  body.querySelector('#m-fetch').onclick = async (e) => {
    if (!url.value.trim()) return url.focus();
    e.target.disabled = true;
    e.target.textContent = '抓取中…';
    try {
      const p = await api('/api/problem/fetch', { url: url.value.trim(), lang: S.lang });
      closeSheet();
      await openProblem(p.id, 'problem');
      if (!p.tests.length && p.source !== 'leetcode') toast('沒有抓到範例測資，請手動新增', true);
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
      e.target.textContent = '抓取題目';
    }
  };
  body.querySelector('#m-new').onclick = async () => {
    const p = await api('/api/problem/new', { lang: S.lang });
    closeSheet();
    await openProblem(p.id, 'code');
    setKb(true);
  };
  body.querySelector('#m-snips').onclick = showSnippets;
  body.querySelector('#m-hist').onclick = showHistory;
  body.querySelector('#m-set').onclick = showSettings;
  body.querySelector('#m-list').onclick = async (e) => {
    const del = e.target.closest('button[data-del]');
    if (del) {
      if (del.dataset.armed) {
        await api('/api/problem/delete', { id: del.dataset.del });
        if (S.problem && S.problem.id === del.dataset.del) { S.problem = null; S.dirty = false; }
        return showMenu();
      }
      del.dataset.armed = '1';
      del.textContent = '確定刪除？';
      return undefined;
    }
    const item = e.target.closest('.item[data-id]');
    if (item) { closeSheet(); await openProblem(item.dataset.id); }
    return undefined;
  };
}
$('btn-menu').addEventListener('click', showMenu);

function showSnippets() {
  const body = openSheet('片段與模板', `
    <div class="hint">打縮寫再按 <code class="k">Tab</code>（或點建議列）就會展開；<code class="k">$0</code> 是展開後游標的位置。「模板」會在新題目自動帶入。</div>
    <div class="row" style="margin-top:10px"><button id="s-add" class="primary" style="flex:1">＋ 新增片段</button>
      <button id="s-sel" style="flex:1">用選取的程式碼建立</button></div>
    <div class="list">${S.snippets.map((s, i) => `
      <div class="item" data-i="${i}"><div class="grow"><div class="t">${s.template ? '模板' : `<code class="k">${esc(s.abbr)}</code>`} ${esc(s.name)}</div>
      <small>${LANG_NAME[s.lang]}</small></div><button data-ins="${i}">插入</button></div>`).join('')}</div>`);
  body.querySelector('#s-add').onclick = () => showSnippetForm(-1, '');
  body.querySelector('#s-sel').onclick = () => {
    const t = editor.selectedText();
    if (!t) return toast('先在編輯器選取一段程式碼', true);
    return showSnippetForm(-1, t);
  };
  body.querySelector('.list').onclick = (e) => {
    const ins = e.target.closest('button[data-ins]');
    if (ins) { closeSheet(); setView('code'); editor.insertSnippet(S.snippets[+ins.dataset.ins].body); return setKb(true); }
    const item = e.target.closest('.item');
    if (item) showSnippetForm(+item.dataset.i);
    return undefined;
  };
}

function showSnippetForm(index, preset) {
  const s = index >= 0 ? S.snippets[index] : { abbr: '', name: '', lang: S.lang, body: preset || '', template: false };
  const body = openSheet(index >= 0 ? '編輯片段' : '新增片段', `
    <div class="row"><input id="f-abbr" type="text" placeholder="縮寫（例如 fori）" autocapitalize="off" autocorrect="off" spellcheck="false">
      <select id="f-lang"><option value="cpp">C++</option><option value="c">C</option><option value="py">Python</option></select></div>
    <div class="row"><input id="f-name" type="text" placeholder="說明"></div>
    <textarea id="f-body" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" placeholder="程式碼，$0 為游標位置"></textarea>
    <div class="row" style="margin-top:8px"><label><input id="f-tpl" type="checkbox"> 作為這個語言的新檔模板</label></div>
    <div class="row"><button id="f-save" class="primary" style="flex:1">儲存</button>
      ${index >= 0 ? '<button id="f-del" class="danger">刪除</button>' : ''}<button id="f-back">返回</button></div>`);
  const q = (id) => body.querySelector(id);
  q('#f-abbr').value = s.abbr;
  q('#f-name').value = s.name;
  q('#f-lang').value = s.lang;
  q('#f-body').value = s.body;
  q('#f-tpl').checked = s.template;
  const persist = async (list) => {
    try { S.snippets = await api('/api/snippets', { snippets: list }); showSnippets(); } catch (e) { toast(e.message, true); }
  };
  q('#f-back').onclick = showSnippets;
  q('#f-save').onclick = () => {
    const next = { abbr: q('#f-abbr').value.trim(), name: q('#f-name').value.trim(), lang: q('#f-lang').value, body: q('#f-body').value, template: q('#f-tpl').checked };
    if (!next.template && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(next.abbr)) return toast('縮寫只能用英數與底線，且不能以數字開頭', true);
    if (!next.body.trim()) return toast('內容是空的', true);
    let list = S.snippets.slice();
    if (next.template) list = list.map((x, i) => (x.template && x.lang === next.lang && i !== index ? { ...x, template: false, abbr: x.abbr || 'tpl' } : x));
    if (index >= 0) list[index] = next; else list.push(next);
    return persist(list);
  };
  if (index >= 0) q('#f-del').onclick = () => persist(S.snippets.filter((_, i) => i !== index));
}

async function showHistory() {
  if (!S.problem) return;
  let list = [];
  try { list = await api('/api/history?id=' + encodeURIComponent(S.problem.id)); } catch (e) { toast(e.message, true); }
  const body = openSheet('歷史版本', `
    <div class="hint">每次按 ▶ 執行時會留下一份。點一下可還原到編輯器（可用復原退回）。</div>
    <div class="list" style="margin-top:10px">${list.map((h) => `
      <div class="item" data-n="${esc(h.name)}" data-lang="${h.lang}"><div class="grow"><div class="t">${fmtTime(h.time)}</div>
      <small>${LANG_NAME[h.lang]} · ${h.size} bytes</small></div><button>還原</button></div>`).join('') || '<div class="item"><span class="hint">還沒有歷史版本</span></div>'}</div>`);
  body.querySelector('.list').onclick = async (e) => {
    const item = e.target.closest('.item[data-n]');
    if (!item) return;
    try {
      const r = await api(`/api/history/file?id=${encodeURIComponent(S.problem.id)}&name=${encodeURIComponent(item.dataset.n)}`);
      if (item.dataset.lang !== S.lang) { $('lang').value = item.dataset.lang; $('lang').dispatchEvent(new Event('change')); await new Promise((ok) => setTimeout(ok, 150)); }
      editor.setText(r.code, { keepUndo: true });
      editor.onChange();
      closeSheet();
      setView('code');
      toast('已還原');
    } catch (err) { toast(err.message, true); }
  };
}

function showSettings() {
  const st = S.settings;
  const body = openSheet('設定', `
    <div class="row"><span class="grow" style="flex:1">程式碼字體大小</span><button data-k="fontSize" data-d="-0.5">－</button><b id="v-fontSize" style="width:44px;text-align:center"></b><button data-k="fontSize" data-d="0.5">＋</button></div>
    <div class="row"><span style="flex:1">按鍵高度</span><button data-k="keyHeight" data-d="-2">－</button><b id="v-keyHeight" style="width:44px;text-align:center"></b><button data-k="keyHeight" data-d="2">＋</button></div>
    <div class="row"><span style="flex:1">縮排寬度</span><button data-k="indent" data-d="-2">－</button><b id="v-indent" style="width:44px;text-align:center"></b><button data-k="indent" data-d="2">＋</button></div>
    <div class="hint">在程式碼上用雙指縮放也能調整字體。</div>
    <div class="sec">伺服器</div>
    <div class="hint">${Object.keys(LANG_NAME).map((l) => `${LANG_NAME[l]}：${S.langs[l] ? '可執行' : '<b>缺編譯器</b>'}，補全 ${S.lsp[l] ? esc(S.lsp[l]) : '內建字詞（未安裝語言伺服器）'}`).join('<br>')}</div>
    <div class="sec">鍵盤速查</div>
    <div class="hint">按鍵往上滑＝輸入右上角的符號；按住空白鍵滑動＝移動游標，搭配 ⇧ 是選取；⇧ 點兩下鎖定。<br>
      <code class="k">Ctrl</code>+ Z 復原、Y 重做、A 全選、C/X/V 複製剪下貼上、D 複製行、K 刪行、L 選行、/ 註解、W 擴選、←→ 以字移動、↑↓ 搬移整行、⏎ 執行。</div>`);
  const lim = { fontSize: [7, 24], keyHeight: [28, 52], indent: [2, 8] };
  const paint = () => { for (const k of Object.keys(lim)) body.querySelector('#v-' + k).textContent = st[k]; };
  paint();
  body.onclick = (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const k = b.dataset.k;
    st[k] = Math.max(lim[k][0], Math.min(lim[k][1], st[k] + +b.dataset.d));
    writeLocal('cop-settings', st);
    editor.indent = st.indent;
    editor.setFontSize(st.fontSize);
    document.documentElement.style.setProperty('--kh', st.keyHeight + 'px');
    paint();
  };
}

// ------------------------------------------------------------------- boot ---
document.addEventListener('visibilitychange', () => {
  if (document.hidden && S.problem && S.dirty) {
    S.dirty = false;
    fetch('/api/save', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: S.problem.id, lang: S.lang, code: editor.getText() }) }).catch(() => { S.dirty = true; });
  }
});
window.addEventListener('resize', () => { editor.render(); });
document.addEventListener('gesturestart', (e) => e.preventDefault());

async function boot() {
  setView('code');
  try {
    const st = await api('/api/state');
    S.snippets = st.snippets;
    S.langs = st.langs;
    S.lsp = st.lsp;
    const last = readLocal('cop-last', null);
    if (last && st.problems.some((p) => p.id === last)) await openProblem(last, 'code');
    else showMenu();
  } catch (e) {
    toast(e.message, true);
  }
}
boot();

window.COP = { S, editor, kb, onKey };   // handy for debugging from the console
