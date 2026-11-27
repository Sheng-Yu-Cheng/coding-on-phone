// On-screen programmer's keyboard.
//  - Shift / Ctrl work like a PC: hold them with one thumb, or tap for one-shot,
//    double-tap Shift to lock.
//  - Swipe up on any key = the shifted character (shown small in the corner).
//  - Drag on the space bar = trackpad cursor; with Shift = select.
//  - Arrows, backspace repeat when held.

const K = (k, s, opt = {}) => ({ k, s, ...opt });
const letters = (str) => str.split('').map((c) => K(c, c.toUpperCase()));

const ROWS = [
  [K('(', '~'), K(')', '`'), K('[', '{'), K(']', '}'), K('<', '<<'), K('>', '>>'), K('=', '+'),
    K('-', '_'), K('/', '?'), K("'", '"'), K('\\', '|')],
  [K('1', '!'), K('2', '@'), K('3', '#'), K('4', '$'), K('5', '%'), K('6', '^'), K('7', '&'),
    K('8', '*'), K('9', '('), K('0', ')')],
  letters('qwertyuiop'),
  [...letters('asdfghjkl'), K(';', ':')],
  [K('shift', null, { act: 'shift', label: '⇧', w: 1.25 }), ...letters('zxcvbnm'), K(',', '<'), K('.', '>'),
    K('bksp', null, { act: 'bksp', label: '⌫', w: 1.25, repeat: true })],
  [K('ctrl', null, { act: 'ctrl', label: 'Ctrl', w: 1.3 }), K('tab', null, { act: 'tab', label: 'Tab', w: 1.2 }),
    K(' ', ' ', { act: 'space', label: '⎵', w: 3 }),
    K('left', 'home', { act: 'nav', label: '←', hint: '⇤', repeat: true }),
    K('up', 'docstart', { act: 'nav', label: '↑', hint: '⤒', repeat: true }),
    K('down', 'docend', { act: 'nav', label: '↓', hint: '⤓', repeat: true }),
    K('right', 'end', { act: 'nav', label: '→', hint: '⇥', repeat: true }),
    K('enter', null, { act: 'enter', label: '⏎', w: 1.5 })],
];

const SWIPE = 16;       // px upward to pick the shifted character
const REPEAT_DELAY = 320;
const REPEAT_RATE = 45;

export class Keyboard {
  // handler(event): {type:'char'|'bksp'|'enter'|'tab'|'nav'|'trackpad', ...,shift,ctrl}
  constructor(root, handler) {
    this.root = root;
    this.handler = handler;
    this.shift = 0;          // 0 off, 1 one-shot, 2 locked
    this.ctrl = 0;           // 0 off, 1 one-shot
    this.shiftHeld = false;
    this.ctrlHeld = false;
    this.shiftUsed = false;  // a held/one-shot shift was used for navigation
    this.pointers = new Map();
    this.lastShiftTap = 0;
    this._build();
  }

  _build() {
    this.root.innerHTML = '';
    for (const row of ROWS) {
      const r = document.createElement('div');
      r.className = 'kb-row';
      for (const key of row) {
        const b = document.createElement('div');
        b.className = 'key' + (key.act ? ' key-' + key.act : '');
        b.style.flexGrow = key.w || 1;
        const hint = key.hint || (!key.act && key.s && key.s.toLowerCase() !== key.k ? key.s : '');
        b.innerHTML = `<span class="key-main"></span><span class="key-hint"></span>`;
        b.firstChild.textContent = key.label || key.k;
        b.lastChild.textContent = hint;
        key.el = b;
        b._key = key;
        r.appendChild(b);
      }
      this.root.appendChild(r);
    }
    const opts = { passive: false };
    this.root.addEventListener('pointerdown', (e) => this._down(e), opts);
    this.root.addEventListener('pointermove', (e) => this._move(e), opts);
    this.root.addEventListener('pointerup', (e) => this._up(e, false), opts);
    this.root.addEventListener('pointercancel', (e) => this._up(e, true), opts);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('touchstart', (e) => e.preventDefault(), opts);
    this._paint();
  }

  get shiftOn() { return this.shift > 0 || this.shiftHeld; }
  get ctrlOn() { return this.ctrl > 0 || this.ctrlHeld; }

  _paint() {
    this.root.classList.toggle('shifted', this.shiftOn);
    this.root.classList.toggle('shift-lock', this.shift === 2);
    this.root.classList.toggle('ctrl-on', this.ctrlOn);
    for (const row of ROWS) {
      for (const key of row) {
        if (key.act) continue;
        key.el.firstChild.textContent = this.shiftOn ? key.s : key.k;
      }
    }
  }

  _mods() { return { shift: this.shiftOn, ctrl: this.ctrlOn }; }

  // Called after a key fired, to release one-shot modifiers.
  _consume(isNav) {
    let changed = false;
    if (this.ctrl === 1) { this.ctrl = 0; changed = true; }
    if (this.ctrlHeld) this.ctrlUsed = true;
    if (isNav) {
      if (this.shiftOn) this.shiftUsed = true;
    } else {
      if (this.shift === 1) { this.shift = 0; changed = true; }
      this.shiftUsed = false;
    }
    if (this.shiftHeld) this.shiftHeldUsed = true;
    if (changed) this._paint();
  }

  _emit(ev, isNav = false) {
    const mods = this._mods();
    // A sticky shift that was only used to extend a selection should not
    // capitalise the next letter.
    if (ev.type === 'char' && this.shift === 1 && this.shiftUsed && !this.shiftHeld) {
      mods.shift = false;
      ev.ch = ev.base;
    }
    this.handler({ ...ev, ...mods });
    this._consume(isNav);
  }

  _fire(key, alt) {
    switch (key.act) {
      case 'bksp': return this._emit({ type: 'bksp' });
      case 'enter': return this._emit({ type: 'enter' });
      case 'tab': return this._emit({ type: 'tab' });
      case 'nav': return this._emit({ type: 'nav', dir: alt ? key.s : key.k }, true);
      case 'space': return this._emit({ type: 'char', ch: ' ', base: ' ' });
      default: {
        const shifted = alt || this.shiftOn;
        return this._emit({ type: 'char', ch: shifted ? key.s : key.k, base: key.k, alt });
      }
    }
  }

  _down(e) {
    e.preventDefault();
    const el = e.target.closest('.key');
    if (!el) return;
    const key = el._key;
    try { this.root.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
    const st = { key, x: e.clientX, y: e.clientY, alt: false, pad: false, px: e.clientX, py: e.clientY, timer: null, fired: false };
    this.pointers.set(e.pointerId, st);
    el.classList.add('down');
    if (key.act === 'shift') { this.shiftHeld = true; this.shiftHeldUsed = false; this._paint(); return; }
    if (key.act === 'ctrl') { this.ctrlHeld = true; this.ctrlUsed = false; this._paint(); return; }
    if (key.repeat) {
      this._fire(key, false);
      st.fired = true;
      st.timer = setTimeout(() => {
        st.timer = setInterval(() => { if (!st.alt) this._fire(key, false); }, REPEAT_RATE);
      }, REPEAT_DELAY);
    }
  }

  _move(e) {
    const st = this.pointers.get(e.pointerId);
    if (!st) return;
    e.preventDefault();
    const key = st.key;
    if (key.act === 'space') {
      if (!st.pad && Math.hypot(e.clientX - st.x, e.clientY - st.y) > 8) {
        st.pad = true;
        st.px = e.clientX;
        st.py = e.clientY;
        this.root.classList.add('trackpad');
      }
      if (st.pad) {
        const stepX = 9;
        const stepY = 22;
        const dx = Math.trunc((e.clientX - st.px) / stepX);
        const dy = Math.trunc((e.clientY - st.py) / stepY);
        if (dx || dy) {
          st.px += dx * stepX;
          st.py += dy * stepY;
          this.handler({ type: 'trackpad', dx, dy, ...this._mods() });
          if (this.shiftOn) this.shiftUsed = true;
          if (this.shiftHeld) this.shiftHeldUsed = true;
        }
      }
      return;
    }
    if (key.act === 'shift' || key.act === 'ctrl' || !key.s) return;
    const alt = st.y - e.clientY > SWIPE;
    if (alt !== st.alt) {
      st.alt = alt;
      key.el.classList.toggle('alt', alt);
      if (alt && st.timer) { clearTimeout(st.timer); clearInterval(st.timer); st.timer = null; }
    }
  }

  _up(e, cancelled) {
    const st = this.pointers.get(e.pointerId);
    if (!st) return;
    e.preventDefault();
    this.pointers.delete(e.pointerId);
    const key = st.key;
    key.el.classList.remove('down', 'alt');
    if (st.timer) { clearTimeout(st.timer); clearInterval(st.timer); }
    if (key.act === 'shift') {
      this.shiftHeld = false;
      if (!this.shiftHeldUsed && !cancelled) {
        const now = Date.now();
        if (this.shift === 2 || (this.shift === 1 && this.shiftUsed)) this.shift = 0;
        else if (this.shift === 1 && now - this.lastShiftTap < 400) this.shift = 2;
        else this.shift = this.shift === 1 ? 0 : 1;
        this.lastShiftTap = now;
        this.shiftUsed = false;
      }
      return this._paint();
    }
    if (key.act === 'ctrl') {
      this.ctrlHeld = false;
      if (!this.ctrlUsed && !cancelled) this.ctrl = this.ctrl ? 0 : 1;
      return this._paint();
    }
    if (key.act === 'space' && st.pad) { this.root.classList.remove('trackpad'); return; }
    if (cancelled) return;
    if (key.repeat) { if (st.alt) this._fire(key, true); return; }
    this._fire(key, st.alt);
  }
}
