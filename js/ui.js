// Tiny DOM helpers for building panels
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function section(title, ...kids) {
  return h('div', { class: 'sec' }, title ? h('h3', {}, title) : null, ...kids);
}

export function row(label, ...ctl) {
  return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, ...ctl));
}

export function num(value, { step = 1, min, max, onInput, onChange, width } = {}) {
  const i = h('input', { type: 'number', inputmode: 'decimal', step, min, max, value: fmtNum(value) });
  if (width) i.style.width = width;
  i.addEventListener('input', () => { const v = parseFloat(i.value); if (!isNaN(v)) onInput && onInput(clamp(v, min, max)); });
  i.addEventListener('change', () => { let v = parseFloat(i.value); if (isNaN(v)) v = value; v = clamp(v, min, max); i.value = fmtNum(v); onChange && onChange(v); });
  return i;
}

export function field(label, input) { return h('label', { class: 'fld' }, label, input); }

export function range(value, { min = 0, max = 100, step = 1, fmt = (v) => v, onInput, onChange } = {}) {
  const r = h('input', { type: 'range', min, max, step, value });
  const out = h('span', { class: 'val' }, fmt(value));
  r.addEventListener('input', () => { const v = parseFloat(r.value); out.textContent = fmt(v); onInput && onInput(v); });
  r.addEventListener('change', () => onChange && onChange(parseFloat(r.value)));
  return [r, out];
}

export function select(options, value, onChange) {
  const s = h('select', {}, ...(Array.isArray(options) ? options : Object.entries(options)).map(([k, v]) => h('option', { value: k, selected: String(k) === String(value) }, v)));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

export function seg(options, value, onChange, big) {
  const wrap = h('div', { class: 'seg' + (big ? ' big' : '') });
  for (const [k, v] of (Array.isArray(options) ? options : Object.entries(options))) {
    const b = h('button', { class: String(k) === String(value) ? 'on' : '', type: 'button' }, v);
    b.addEventListener('click', () => { [...wrap.children].forEach(c => c.classList.remove('on')); b.classList.add('on'); onChange(k); });
    wrap.append(b);
  }
  return wrap;
}

export function toggle(checked, onChange) {
  const i = h('input', { type: 'checkbox', checked: !!checked });
  i.addEventListener('change', () => onChange(i.checked));
  return h('label', { class: 'switch' }, i, h('span'));
}

export function btn(label, onClick, cls = '') {
  return h('button', { class: 'btn ' + cls, type: 'button', onclick: onClick }, label);
}

function clamp(v, min, max) {
  if (min !== undefined && v < +min) v = +min;
  if (max !== undefined && v > +max) v = +max;
  return v;
}
function fmtNum(v) { return Math.round(v * 100) / 100; }

let toastT = 0;
export function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => t.className = 'toast', err ? 4500 : 2400);
}

export function openSheet(title, ...content) {
  const s = document.getElementById('sheet'), c = document.getElementById('sheetCard');
  if (window.__sheetClose) { const f = window.__sheetClose; window.__sheetClose = null; try { f(true); } catch (e) { } }
  c.innerHTML = '';
  c.append(h('h2', {}, title), ...content.flat(Infinity).filter(x => x != null && x !== false));
  s.hidden = false;
  s.onclick = (e) => { if (e.target === s) closeSheet(); };
}
export function closeSheet() {
  document.getElementById('sheet').hidden = true;
  const f = window.__sheetClose; window.__sheetClose = null; if (f) try { f(); } catch (e) { }
}

// In-page replacements for confirm()/prompt() (those are blocked in some app views)
export function ask(message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const done = (v) => { closeSheet(); resolve(v); };
    openSheet(message, h('div', { class: 'btns' },
      btn('Cancel', () => done(false)), btn(okLabel, () => done(true), danger ? 'danger' : 'primary')));
    document.getElementById('sheet').onclick = (e) => { if (e.target.id === 'sheet') done(false); };
  });
}
export function askText(message, placeholder = '') {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'text', placeholder });
    const done = (v) => { closeSheet(); resolve(v); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); });
    openSheet(message, inp, h('div', { class: 'btns', style: { marginTop: '10px' } },
      btn('Cancel', () => done(null)), btn('Save', () => done(inp.value.trim() || null), 'primary')));
    setTimeout(() => inp.focus(), 50);
  });
}
