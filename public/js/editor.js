// A small code editor that never summons the system keyboard: all input
// arrives through method calls (from the on-screen keyboard or key events).
import { Highlighter, maskLines } from './highlight.js';

const cmp = (a, b) => a.l - b.l || a.c - b.c;
const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };
const QUOTES = new Set(['"', "'"]);
const WORD = /[A-Za-z0-9_]/;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Editor {
  constructor(root) {
    this.root = root;
    root.innerHTML = '<div class="ed-content"><div class="ed-curline"></div><div class="ed-sel"></div>' +
      '<div class="ed-lines"></div><div class="ed-diag"></div><div class="ed-cursor"></div></div>';
    this.content = root.firstChild;
    [this.curlineEl, this.selEl, this.linesEl, this.diagEl, this.cursorEl] = this.content.children;
    this.lines = [''];
    this.cur = { l: 0, c: 0 };
    this.anc = null;
    this.goal = null;
    this.indent = 4;
    this.lang = 'cpp';
    this.hl = new Highlighter();
    this.hlOut = [];
    this.undoStack = [];
    this.redoStack = [];
    this.lastKind = null;
    this.lastTime = 0;
    this.diags = [];
    this.expandStack = [];
    this.fontSize = 12;
    this.lastHtml = '';
    this.onChange = () => {};
    this.onCursor = () => {};
    this.onTap = () => {};
    this.onUserScroll = () => {};
    this.onFontSize = () => {};
    this._bindTouch();
    this.setFontSize(this.fontSize);
  }

  // ---- geometry ----------------------------------------------------------
  setFontSize(px) {
    this.fontSize = clamp(Math.round(px * 2) / 2, 7, 24);
    this.lineH = Math.round(this.fontSize * 1.42);
    this.root.style.setProperty('--fs', this.fontSize + 'px');
    this.root.style.setProperty('--lh', this.lineH + 'px');
    const probe = document.createElement('span');
    probe.className = 'ed-probe';
    probe.textContent = 'M'.repeat(40);
    this.content.appendChild(probe);
    this.charW = probe.getBoundingClientRect().width / 40 || this.fontSize * 0.6;
    probe.remove();
    this.lastHtml = '';
    this.render();
  }

  _gutter() {
    const digits = Math.max(2, String(this.lines.length).length);
    return Math.ceil(this.charW * digits) + 10;
  }

  posFromPoint(x, y) {
    const r = this.content.getBoundingClientRect();
    const l = clamp(Math.floor((y - r.top) / this.lineH), 0, this.lines.length - 1);
    const c = clamp(Math.round((x - r.left - this.gutter) / this.charW), 0, this.lines[l].length);
    return { l, c };
  }

  // ---- rendering ---------------------------------------------------------
  render() {
    this.hl.setLang(this.lang);
    this.hlOut = this.hl.run(this.lines);
    this.gutter = this._gutter();
    let html = '';
    let maxLen = 0;
    for (let i = 0; i < this.lines.length; i++) {
      html += '<div class="ln">' + this.hlOut[i].html + '</div>';
      if (this.lines[i].length > maxLen) maxLen = this.lines[i].length;
    }
    if (html !== this.lastHtml) {
      this.linesEl.innerHTML = html;
      this.lastHtml = html;
    }
    this.root.style.setProperty('--gutter', this.gutter + 'px');
    this.content.style.minWidth = Math.ceil(this.gutter + (maxLen + 3) * this.charW) + 'px';
    this.content.style.height = (this.lines.length * this.lineH + this.root.clientHeight * 0.4) + 'px';
    this.renderOverlay();
  }

  renderOverlay() {
    const { cur, lineH, charW, gutter } = this;
    this.cursorEl.style.transform = `translate(${gutter + cur.c * charW}px, ${cur.l * lineH}px)`;
    this.cursorEl.classList.remove('blink');
    void this.cursorEl.offsetWidth;
    this.cursorEl.classList.add('blink');
    this.curlineEl.style.transform = `translateY(${cur.l * lineH}px)`;
    const sel = this.selRange();
    let html = '';
    if (sel) {
      const [a, b] = sel;
      for (let l = a.l; l <= b.l; l++) {
        const from = l === a.l ? a.c : 0;
        const to = l === b.l ? b.c : this.lines[l].length + 1;
        if (to <= from) continue;
        html += `<div style="left:${gutter + from * charW}px;top:${l * lineH}px;width:${(to - from) * charW}px"></div>`;
      }
    }
    this.selEl.innerHTML = html;
    this.curlineEl.style.display = sel ? 'none' : '';
  }

  setDiagnostics(diags) {
    this.diags = diags || [];
    const { lineH, charW, gutter } = this;
    let html = '';
    for (const d of this.diags) {
      if (d.line >= this.lines.length) continue;
      const len = this.lines[d.line].length;
      const from = Math.min(d.col, len);
      let to = d.endLine === d.line ? d.endCol : len;
      if (to <= from) to = from + 1;
      const cls = d.severity === 1 ? 'err' : 'warn';
      html += `<div class="sq ${cls}" style="left:${gutter + from * charW}px;top:${d.line * lineH}px;width:${(to - from) * charW}px"></div>`;
      html += `<div class="mark ${cls}" style="top:${d.line * lineH}px"></div>`;
    }
    this.diagEl.innerHTML = html;
  }

  diagAt(line) {
    return this.diags.filter((d) => d.line === line).sort((a, b) => a.severity - b.severity)[0] || null;
  }

  reveal() {
    const { root, cur, lineH, charW, gutter } = this;
    const top = cur.l * lineH;
    const pad = lineH * 2;
    if (top - pad < root.scrollTop) root.scrollTop = Math.max(0, top - pad);
    else if (top + lineH + pad > root.scrollTop + root.clientHeight) root.scrollTop = top + lineH + pad - root.clientHeight;
    const x = cur.c * charW;
    const viewW = root.clientWidth - gutter;
    if (x - charW * 4 < root.scrollLeft) root.scrollLeft = Math.max(0, x - charW * 4);
    else if (x + charW * 3 > root.scrollLeft + viewW) root.scrollLeft = x + charW * 3 - viewW;
  }

  _changed(textChanged) {
    if (textChanged) { this.render(); this.setDiagnostics([]); this.onChange(); }
    else this.renderOverlay();
    this.reveal();
    this.onCursor();
  }

  // ---- text model --------------------------------------------------------
  getText() { return this.lines.join('\n'); }

  setText(text, { keepUndo = false } = {}) {
    if (keepUndo) this._snap(null);
    else { this.undoStack = []; this.redoStack = []; }
    this.lines = this._clean(text).split('\n');
    this.cur = { l: 0, c: 0 };
    this.anc = null;
    this.goal = null;
    this.expandStack = [];
    this.root.scrollTop = 0;
    this.root.scrollLeft = 0;
    this.render();
    this.setDiagnostics([]);
    this.onCursor();
  }

  _clean(text) {
    return String(text).replace(/\r\n?/g, '\n').replace(/\t/g, ' '.repeat(this.indent)).replace(/[​﻿]/g, '');
  }

  selRange() {
    if (!this.anc || cmp(this.anc, this.cur) === 0) return null;
    return cmp(this.anc, this.cur) < 0 ? [this.anc, this.cur] : [this.cur, this.anc];
  }

  textIn(a, b) {
    if (a.l === b.l) return this.lines[a.l].slice(a.c, b.c);
    return [this.lines[a.l].slice(a.c), ...this.lines.slice(a.l + 1, b.l), this.lines[b.l].slice(0, b.c)].join('\n');
  }

  selectedText() { const s = this.selRange(); return s ? this.textIn(s[0], s[1]) : ''; }

  _replace(a, b, text) {
    const before = this.lines[a.l].slice(0, a.c);
    const after = this.lines[b.l].slice(b.c);
    const ins = text.split('\n');
    const last = ins.length - 1;
    const end = { l: a.l + last, c: (last ? 0 : before.length) + ins[last].length };
    ins[0] = before + ins[0];
    ins[last] += after;
    this.lines.splice(a.l, b.l - a.l + 1, ...ins);
    return end;
  }

  _snap(kind) {
    const now = Date.now();
    this.expandStack = [];
    this.goal = null;
    if (kind && kind === this.lastKind && now - this.lastTime < 900) { this.lastTime = now; return; }
    this.undoStack.push({ lines: this.lines.slice(), cur: { ...this.cur }, anc: this.anc && { ...this.anc } });
    if (this.undoStack.length > 400) this.undoStack.shift();
    this.redoStack = [];
    this.lastKind = kind;
    this.lastTime = now;
  }

  _restore(from, to) {
    if (!from.length) return;
    to.push({ lines: this.lines.slice(), cur: { ...this.cur }, anc: this.anc && { ...this.anc } });
    const s = from.pop();
    this.lines = s.lines;
    this.cur = s.cur;
    this.anc = s.anc;
    this.lastKind = null;
    this._changed(true);
  }

  undo() { this._restore(this.undoStack, this.redoStack); }
  redo() { this._restore(this.redoStack, this.undoStack); }

  // Replace the selection (or insert at the cursor) with text.
  insert(text, kind = null) {
    this._snap(kind);
    const s = this.selRange() || [this.cur, this.cur];
    this.cur = this._replace(s[0], s[1], text);
    this.anc = null;
    this._changed(true);
  }

  paste(text) { if (text) this.insert(this._clean(text)); }

  cut() {
    const t = this.selectedText();
    if (t) this.insert('');
    return t;
  }

  // One typed character, with bracket pairing and smart closing.
  type(ch) {
    const sel = this.selRange();
    const line = this.lines[this.cur.l];
    const next = line[this.cur.c];
    const prev = line[this.cur.c - 1];
    if (sel && (OPEN[ch] || QUOTES.has(ch))) {
      const close = OPEN[ch] || ch;
      const inner = this.textIn(sel[0], sel[1]);
      this._snap(null);
      const start = sel[0];
      this._replace(sel[0], sel[1], ch + inner + close);
      const parts = inner.split('\n');
      this.anc = { l: start.l, c: start.c + 1 };
      this.cur = { l: start.l + parts.length - 1, c: (parts.length > 1 ? 0 : start.c + 1) + parts[parts.length - 1].length };
      return this._changed(true);
    }
    if (!sel) {
      if ((CLOSE[ch] || QUOTES.has(ch)) && next === ch) {      // type over the closer
        this.cur = { l: this.cur.l, c: this.cur.c + 1 };
        this.goal = null;
        return this._changed(false);
      }
      const roomy = next === undefined || /[\s)\]};,]/.test(next);
      if (OPEN[ch] && roomy) return this._pair(ch, OPEN[ch]);
      if (QUOTES.has(ch) && roomy && !(prev && (WORD.test(prev) || prev === ch || prev === '\\'))) {
        return this._pair(ch, ch);
      }
      if (ch === '}' && /^\s+$/.test(line.slice(0, this.cur.c))) {   // dedent a closing brace
        this._snap('type');
        const c = Math.max(0, this.cur.c - this.indent);
        this.cur = this._replace({ l: this.cur.l, c }, this.cur, '}');
        return this._changed(true);
      }
    }
    this.insert(ch, /\s/.test(ch) ? 'space' : 'type');
  }

  _pair(open, close) {
    this._snap('type');
    const end = this._replace(this.cur, this.cur, open + close);
    this.cur = { l: end.l, c: end.c - 1 };
    this._changed(true);
  }

  enter() {
    this._snap(null);
    const s = this.selRange();
    if (s) this.cur = this._replace(s[0], s[1], '');
    this.anc = null;
    const line = this.lines[this.cur.l];
    const before = line.slice(0, this.cur.c);
    const after = line.slice(this.cur.c);
    const base = /^ */.exec(before)[0];
    const tail = before.trimEnd().slice(-1);
    const opens = OPEN[tail] || (this.lang === 'py' && tail === ':');
    const ind = ' '.repeat(this.indent);
    if (OPEN[tail] && after.trimStart()[0] === OPEN[tail]) {
      this._replace(this.cur, { l: this.cur.l, c: this.cur.c + (after.length - after.trimStart().length) },
        '\n' + base + ind + '\n' + base);
      this.cur = { l: this.cur.l + 1, c: base.length + ind.length };
    } else {
      this.cur = this._replace(this.cur, this.cur, '\n' + base + (opens ? ind : ''));
    }
    this._changed(true);
  }

  backspace(word = false) {
    const s = this.selRange();
    if (s) return this.insert('');
    const { l, c } = this.cur;
    if (l === 0 && c === 0) return;
    this._snap('del');
    const line = this.lines[l];
    let from;
    let to = this.cur;
    if (c === 0) from = { l: l - 1, c: this.lines[l - 1].length };
    else if (word) from = this._wordLeft(this.cur);
    else if (/^ +$/.test(line.slice(0, c))) from = { l, c: c - ((c - 1) % this.indent + 1) };
    else {
      from = { l, c: c - 1 };
      const p = line[c - 1];
      if ((OPEN[p] && line[c] === OPEN[p]) || (QUOTES.has(p) && line[c] === p)) to = { l, c: c + 1 };
    }
    this.cur = this._replace(from, to, '');
    this._changed(true);
  }

  del() {
    const s = this.selRange();
    if (s) return this.insert('');
    const { l, c } = this.cur;
    const to = c < this.lines[l].length ? { l, c: c + 1 } : l + 1 < this.lines.length ? { l: l + 1, c: 0 } : null;
    if (!to) return;
    this._snap('del');
    this._replace(this.cur, to, '');
    this._changed(true);
  }

  tab(shift = false) {
    const s = this.selRange();
    if (shift || (s && s[0].l !== s[1].l)) return this.indentLines(shift ? -1 : 1);
    const n = this.indent - (this.cur.c % this.indent);
    this.insert(' '.repeat(n), 'space');
  }

  _lineSpan() {
    const s = this.selRange();
    if (!s) return [this.cur.l, this.cur.l];
    return [s[0].l, s[1].c === 0 && s[1].l > s[0].l ? s[1].l - 1 : s[1].l];
  }

  indentLines(dir) {
    const [a, b] = this._lineSpan();
    this._snap(null);
    for (let l = a; l <= b; l++) {
      const line = this.lines[l];
      let delta;
      if (dir > 0) {
        if (!line.trim()) continue;
        this.lines[l] = ' '.repeat(this.indent) + line;
        delta = this.indent;
      } else {
        delta = -Math.min(this.indent, /^ */.exec(line)[0].length);
        this.lines[l] = line.slice(-delta);
      }
      for (const p of [this.cur, this.anc]) if (p && p.l === l) p.c = Math.max(0, p.c + delta);
    }
    this._changed(true);
  }

  toggleComment() {
    const [a, b] = this._lineSpan();
    const mark = this.lang === 'py' ? '#' : '//';
    const rows = [];
    for (let l = a; l <= b; l++) if (this.lines[l].trim()) rows.push(l);
    if (!rows.length) return;
    const all = rows.every((l) => this.lines[l].trimStart().startsWith(mark));
    const col = Math.min(...rows.map((l) => /^ */.exec(this.lines[l])[0].length));
    this._snap(null);
    for (const l of rows) {
      const line = this.lines[l];
      let delta;
      if (all) {
        const i = line.indexOf(mark);
        const n = mark.length + (line[i + mark.length] === ' ' ? 1 : 0);
        this.lines[l] = line.slice(0, i) + line.slice(i + n);
        delta = -n;
      } else {
        this.lines[l] = line.slice(0, col) + mark + ' ' + line.slice(col);
        delta = mark.length + 1;
      }
      for (const p of [this.cur, this.anc]) if (p && p.l === l && p.c >= col) p.c = Math.max(col, p.c + delta);
    }
    this._changed(true);
  }

  duplicateLine() {
    const [a, b] = this._lineSpan();
    this._snap(null);
    const copy = this.lines.slice(a, b + 1);
    this.lines.splice(b + 1, 0, ...copy);
    this.cur = { l: this.cur.l + copy.length, c: this.cur.c };
    if (this.anc) this.anc = { l: this.anc.l + copy.length, c: this.anc.c };
    this._changed(true);
  }

  moveLines(dir) {
    const [a, b] = this._lineSpan();
    if ((dir < 0 && a === 0) || (dir > 0 && b === this.lines.length - 1)) return;
    this._snap('moveline');
    if (dir < 0) this.lines.splice(b, 0, this.lines.splice(a - 1, 1)[0]);
    else this.lines.splice(a, 0, this.lines.splice(b + 1, 1)[0]);
    this.cur = { l: this.cur.l + dir, c: this.cur.c };
    if (this.anc) this.anc = { l: this.anc.l + dir, c: this.anc.c };
    this._changed(true);
  }

  deleteLines() {
    const [a, b] = this._lineSpan();
    this._snap(null);
    this.lines.splice(a, b - a + 1);
    if (!this.lines.length) this.lines = [''];
    const l = Math.min(a, this.lines.length - 1);
    this.cur = { l, c: Math.min(this.cur.c, this.lines[l].length) };
    this.anc = null;
    this._changed(true);
  }

  // Insert a snippet body; "$0" marks where the cursor lands.
  insertSnippet(body, fromCol = null) {
    this._snap(null);
    const s = this.selRange();
    let a = s ? s[0] : this.cur;
    const b = s ? s[1] : this.cur;
    if (fromCol !== null && !s) a = { l: this.cur.l, c: fromCol };
    const base = /^ */.exec(this.lines[a.l])[0];
    const text = this._clean(body).replace(/\n$/, '').split('\n').map((ln, i) => (i ? base + ln : ln)).join('\n');
    const at = text.indexOf('$0');
    const clean = text.replace(/\$0/g, '');
    const end = this._replace(a, b, clean);
    this.anc = null;
    if (at >= 0) {
      const head = text.slice(0, at).split('\n');
      this.cur = { l: a.l + head.length - 1, c: (head.length > 1 ? 0 : a.c) + head[head.length - 1].length };
    } else this.cur = end;
    this._changed(true);
  }

  replaceBeforeCursor(fromCol, text) {
    this._snap(null);
    this.cur = this._replace({ l: this.cur.l, c: clamp(fromCol, 0, this.cur.c) }, this.cur, text);
    this.anc = null;
    this._changed(true);
  }

  wordBefore() {
    const line = this.lines[this.cur.l];
    let c = this.cur.c;
    while (c > 0 && WORD.test(line[c - 1])) c--;
    return line.slice(c, this.cur.c);
  }

  // ---- movement & selection ---------------------------------------------
  _wordLeft(p) {
    let { l, c } = p;
    if (c === 0) return l > 0 ? { l: l - 1, c: this.lines[l - 1].length } : p;
    const line = this.lines[l];
    while (c > 0 && line[c - 1] === ' ') c--;
    if (c > 0 && WORD.test(line[c - 1])) while (c > 0 && WORD.test(line[c - 1])) c--;
    else if (c > 0) c--;
    return { l, c };
  }

  _wordRight(p) {
    let { l, c } = p;
    const line = this.lines[l];
    if (c >= line.length) return l + 1 < this.lines.length ? { l: l + 1, c: 0 } : p;
    while (c < line.length && line[c] === ' ') c++;
    if (c < line.length && WORD.test(line[c])) while (c < line.length && WORD.test(line[c])) c++;
    else if (c < line.length) c++;
    return { l, c };
  }

  _moveTo(pos, shift, keepGoal = false) {
    if (shift) { if (!this.anc) this.anc = { ...this.cur }; } else this.anc = null;
    this.cur = pos;
    if (!keepGoal) this.goal = null;
    this.lastKind = null;
    this.expandStack = [];
    this._changed(false);
  }

  move(dir, { shift = false, word = false } = {}) {
    const sel = this.selRange();
    let { l, c } = this.cur;
    if (dir === 'left' || dir === 'right') {
      if (sel && !shift) return this._moveTo({ ...(dir === 'left' ? sel[0] : sel[1]) }, false);
      let p;
      if (word) p = dir === 'left' ? this._wordLeft(this.cur) : this._wordRight(this.cur);
      else if (dir === 'left') p = c > 0 ? { l, c: c - 1 } : l > 0 ? { l: l - 1, c: this.lines[l - 1].length } : this.cur;
      else p = c < this.lines[l].length ? { l, c: c + 1 } : l + 1 < this.lines.length ? { l: l + 1, c: 0 } : this.cur;
      return this._moveTo({ ...p }, shift);
    }
    if (this.goal === null) this.goal = c;
    l += dir === 'up' ? -1 : 1;
    if (l < 0) return this._moveTo({ l: 0, c: 0 }, shift);
    if (l >= this.lines.length) return this._moveTo({ l: this.lines.length - 1, c: this.lines[this.lines.length - 1].length }, shift);
    this._moveTo({ l, c: Math.min(this.goal, this.lines[l].length) }, shift, true);
  }

  home(shift = false) {
    const first = /^ */.exec(this.lines[this.cur.l])[0].length;
    this._moveTo({ l: this.cur.l, c: this.cur.c === first ? 0 : first }, shift);
  }

  end(shift = false) { this._moveTo({ l: this.cur.l, c: this.lines[this.cur.l].length }, shift); }
  docStart(shift = false) { this._moveTo({ l: 0, c: 0 }, shift); }
  docEnd(shift = false) { const l = this.lines.length - 1; this._moveTo({ l, c: this.lines[l].length }, shift); }

  setCursor(pos, shift = false) {
    const l = clamp(pos.l, 0, this.lines.length - 1);
    this._moveTo({ l, c: clamp(pos.c, 0, this.lines[l].length) }, shift);
  }

  select(a, b) { this.anc = { ...a }; this.cur = { ...b }; this.goal = null; this._changed(false); }
  selectAll() { const l = this.lines.length - 1; this.select({ l: 0, c: 0 }, { l, c: this.lines[l].length }); }

  wordAt(p) {
    const line = this.lines[p.l];
    let a = p.c;
    let b = p.c;
    while (a > 0 && WORD.test(line[a - 1])) a--;
    while (b < line.length && WORD.test(line[b])) b++;
    return a === b ? null : [{ l: p.l, c: a }, { l: p.l, c: b }];
  }

  selectWord(p = this.cur) { const w = this.wordAt(p); if (w) this.select(w[0], w[1]); else this.setCursor(p); }

  selectLine() {
    const [a, b] = this._lineSpan();
    if (b + 1 < this.lines.length) this.select({ l: a, c: 0 }, { l: b + 1, c: 0 });
    else this.select({ l: a, c: 0 }, { l: b, c: this.lines[b].length });
  }

  _offset(p) { let o = p.c; for (let i = 0; i < p.l; i++) o += this.lines[i].length + 1; return o; }

  _pos(off) {
    let l = 0;
    while (l < this.lines.length - 1 && off > this.lines[l].length) { off -= this.lines[l].length + 1; l++; }
    return { l, c: Math.min(off, this.lines[l].length) };
  }

  // Grow the selection: word → bracket contents → with brackets → line → block → … → all.
  expandSelection() {
    const sel = this.selRange() || [this.cur, this.cur];
    const A = this._offset(sel[0]);
    const B = this._offset(sel[1]);
    const cands = [];
    const add = (a, b) => { if (a <= A && b >= B && (a < A || b > B)) cands.push([a, b]); };
    const w = this.wordAt(sel[0]);
    if (w) add(this._offset(w[0]), this._offset(w[1]));
    const text = maskLines(this.lines, this.hlOut).join('\n');
    let start = A;
    let need = B;
    for (let guard = 0; guard < 60; guard++) {
      let depth = 0;
      let o = -1;
      for (let i = start - 1; i >= 0; i--) {
        const ch = text[i];
        if (CLOSE[ch]) depth++;
        else if (OPEN[ch]) { if (depth === 0) { o = i; break; } depth--; }
      }
      if (o < 0) break;
      depth = 0;
      let m = -1;
      for (let i = o + 1; i < text.length; i++) {
        const ch = text[i];
        if (OPEN[ch]) depth++;
        else if (CLOSE[ch]) { if (depth === 0) { m = i; break; } depth--; }
      }
      if (m >= need) {
        let ia = o + 1;
        let ib = m;
        let k = ia;                                        // trim blank edges of the inside,
        while (k < ib && text[k] === ' ') k++;             // but keep whole lines for a block body
        ia = text[k] === '\n' ? k + 1 : k;
        while (ib > ia && /\s/.test(text[ib - 1])) ib--;
        add(ia, ib);
        add(o, m + 1);
        need = Math.max(need, m + 1);
      }
      start = o;
    }
    const la = sel[0].l;
    const lb = sel[1].c === 0 && sel[1].l > la ? sel[1].l - 1 : sel[1].l;
    add(this._offset({ l: la, c: /^ */.exec(this.lines[la])[0].length }), this._offset({ l: lb, c: this.lines[lb].length }));
    add(this._offset({ l: la, c: 0 }), this._offset({ l: lb, c: this.lines[lb].length }));
    add(0, this.getText().length);
    if (!cands.length) return;
    cands.sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]));
    const stack = this.expandStack.concat([{ anc: this.anc && { ...this.anc }, cur: { ...this.cur } }]);
    this.select(this._pos(cands[0][0]), this._pos(cands[0][1]));
    this.expandStack = stack;
  }

  shrinkSelection() {
    const prev = this.expandStack.pop();
    if (!prev) { this.anc = null; return this._changed(false); }
    const stack = this.expandStack;
    this.anc = prev.anc;
    this.cur = prev.cur;
    this._changed(false);
    this.expandStack = stack;
  }

  // ---- touch -------------------------------------------------------------
  _bindTouch() {
    const root = this.root;
    let pinch = null;
    let startY = null;
    let lastTap = { t: 0, x: 0, y: 0, n: 0 };
    root.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinch = { d: dist(e.touches), fs: this.fontSize };
        e.preventDefault();
      } else if (e.touches.length === 1) startY = e.touches[0].clientY;
    }, { passive: false });
    root.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const fs = clamp(Math.round(pinch.fs * dist(e.touches) / pinch.d * 2) / 2, 7, 24);
        if (fs !== this.fontSize) { this.setFontSize(fs); this.onFontSize(fs); }
      } else if (startY !== null && e.touches.length === 1 && Math.abs(e.touches[0].clientY - startY) > 14) {
        startY = null;
        this.onUserScroll();
      }
    }, { passive: false });
    root.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
    root.addEventListener('click', (e) => {
      const p = this.posFromPoint(e.clientX, e.clientY);
      const now = Date.now();
      const near = Math.abs(e.clientX - lastTap.x) < 24 && Math.abs(e.clientY - lastTap.y) < 24 && now - lastTap.t < 380;
      const n = near ? lastTap.n + 1 : 1;
      lastTap = { t: now, x: e.clientX, y: e.clientY, n };
      this.onTap(p, n);
    });
  }
}

function dist(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1; }
