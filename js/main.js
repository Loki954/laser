import { Editor } from './editor.js';
import { Machine } from './machine.js';
import { SerialTransport, BleTransport, DemoTransport, AndroidTransport, onBtEvent } from './transport.js';
import { newObject, invalidate, objWorldBBox, DEFAULT_OPS, cutAroundLocal, cutAroundWorld, localCommands, uid } from './scene.js';
import { SHAPES, CUT_AROUND } from './shapes.js';
import { FONTS, getFont, loadUserFonts, addUserFont } from './text.js';
import { DITHERS } from './raster.js';
import { buildJob, jobOrigin, fmtTime } from './gcode.js';
import { allPresets, savePreset, deletePreset } from './presets.js';
import { svgToPolylines, polylinesToCommands } from './svg.js';
import { polylinesBBox } from './geometry.js';
import { idbGet, idbSet, idbDel, lsGet, lsSet } from './storage.js';
import { h, section, row, num, field, range, select, seg, toggle, btn, toast, openSheet, closeSheet, ask, askText } from './ui.js';
import { VERSION } from './version.js';

const MODELS = {
  s9: { name: 'SculpFun S9 / S10', w: 410, h: 400 },
  s30: { name: 'SculpFun S30 / S30 Pro', w: 410, h: 400 },
  s30max: { name: 'SculpFun S30 Pro Max / Ultra', w: 600, h: 600 },
  sf_a9: { name: 'SculpFun SF-A9', w: 400, h: 400 },
  icube: { name: 'SculpFun iCube', w: 130, h: 130 },
  ts1: { name: 'SculpFun TS1', w: 300, h: 300 },
  custom: { name: 'Custom size', w: 400, h: 400 },
};

const DEFAULT_CFG = {
  model: 's9', bedW: 410, bedH: 400, sMax: 1000, framePower: 3, frameFeed: 3000, pointerPower: 3,
  anchor: 'bl', absolute: false, air: false, overscan: 1, bidir: true, autoUnlock: true,
  transfer: 'upload', fileName: 'studio.nc', bleChunk: 20, rxBuffer: 120, jogStep: 10, jogFeed: 3000,
  pointer: false, pointerDX: 0, pointerDY: 0, hasHoming: false, burnPower: 200, frameRepeat: false,
};

const app = window.app = {
  objects: [], selectedId: null, tool: 'select', bitmaps: {}, blobs: {},
  cfg: { ...DEFAULT_CFG, ...lsGet('cfg', {}) },
  machine: new Machine(),
  previewOn: false, job: null, sceneVer: 0, jobVer: -1,
  history: [], future: [],
  tab: 'object', run: { phase: null, pct: 0, active: false },
  log: [],
};
const $ = (s) => document.querySelector(s);
const tabbody = $('#tabbody');
const editor = new Editor($('#cv'), app);
app.machine.autoUnlock = app.cfg.autoUnlock;

// ---------------- scene management ----------------
app.selected = () => app.objects.find(o => o.id === app.selectedId) || null;
app.select = (id) => {
  app.selectedId = id;
  app.groupSel = false;
  if (id && app.tab !== 'object') setTab('object'); else renderPanel();
  editor.render();
};
app.changed = (panel = false) => {
  app.sceneVer++;
  if (app.previewOn) { app.previewOn = false; $('#previewBar').hidden = true; }
  editor.render();
  if (panel) renderPanel();
  scheduleSave();
};
function serialize() {
  return JSON.stringify(app.objects.map(o => {
    const c = {};
    for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) c[k] = v;
    return c;
  }));
}
function restore(json) {
  app.objects = JSON.parse(json);
  app.objects.forEach(o => { o._needsRender = () => editor.render(); });
  if (!app.objects.find(o => o.id === app.selectedId)) app.selectedId = null;
}
app.commit = () => {
  const s = serialize();
  if (app.history[app.history.length - 1] === s) return;
  app.history.push(s); if (app.history.length > 80) app.history.shift();
  app.future = [];
  app.sceneVer++;
  scheduleSave();
};
function undo() {
  if (app.history.length < 2) return toast('Nothing to undo');
  app.future.push(app.history.pop());
  restore(app.history[app.history.length - 1]); app.changed(true);
}
function redo() {
  if (!app.future.length) return toast('Nothing to redo');
  const s = app.future.pop(); app.history.push(s); restore(s); app.changed(true);
}
let saveT = 0;
function scheduleSave() {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    try { await idbSet('kv', 'project', serialize()); } catch (e) { console.warn('save', e); }
  }, 600);
}

function addObject(o, select = true) {
  o._needsRender = () => editor.render();
  app.objects.push(o);
  app.commit();
  if (select) app.select(o.id);
  app.changed(true);
  return o;
}
function bedCenter() {
  // put new things in the middle of what you're looking at (inside the bed)
  const [x, y] = editor.toWorld(editor.w / 2, editor.h / 2);
  return [Math.max(10, Math.min(app.cfg.bedW - 10, x)), Math.max(10, Math.min(app.cfg.bedH - 10, y))];
}

async function addText(value = 'Hello') {
  const [x, y] = bedCenter();
  const o = newObject('text', { x, y, w: 60, h: 15, op: 'fill', name: 'Text', text: { value, font: 'roboto-bold' } });
  await getFont(o.text.font);
  o._needsRender = () => editor.render();
  sizeText(o, 15);
  addObject(o);
  return o;
}
function sizeText(o, hmm) {
  invalidate(o); o.w = 100; o.h = 100;
  localCommands(o);
  const n = o.nat;
  if (n) { o.h = hmm; o.w = n.w * hmm / n.h; }
  invalidate(o);
}
function fitTextHeight(o, hmm) { sizeText(o, hmm); app.changed(true); app.commit(); }
function refitTextKeepScale(o) {
  // keep the same letter height when text content/font changes
  const old = o.nat ? { ...o.nat } : null;
  invalidate(o);
  localCommands(o);
  const n = o.nat;
  if (n && old) { o.w = n.w * (o.w / old.w); o.h = n.h * (o.h / old.h); }
  invalidate(o); app.changed(false);
}

function addShape(kind) {
  const [x, y] = bedCenter();
  const sz = kind === 'heart' ? [44, 40] : kind === 'polygon' ? [46, 40] : [40, 40];
  const o = newObject('shape', { x, y, w: sz[0], h: sz[1], op: 'cut', name: SHAPES[kind].label, shape: { kind, radius: kind === 'rounded' ? 6 : 0 } });
  addObject(o);
}

app.addPath = (pts, closed) => {
  const pls = [{ pts, closed }];
  const bb = polylinesBBox(pls);
  const o = newObject('path', {
    x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2, w: Math.max(0.01, bb.x1 - bb.x0), h: Math.max(0.01, bb.y1 - bb.y0),
    op: 'cut', name: closed ? 'Drawn shape' : 'Line', lockRatio: true,
    path: { cmds: polylinesToCommands(pls), ver: uid(), open: !closed },
  });
  addObject(o);
};

async function addImageFile(file) {
  if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) {
    try {
      const pls = await svgToPolylines(await file.text());
      const bb = polylinesBBox(pls);
      let w = bb.x1 - bb.x0, hh = bb.y1 - bb.y0;
      const k = Math.max(w, hh) > 150 ? 150 / Math.max(w, hh) : 1;
      const [x, y] = bedCenter();
      const o = newObject('path', {
        x, y, w: w * k, h: hh * k, op: 'cut', name: file.name.replace(/\.svg$/i, ''),
        path: { cmds: polylinesToCommands(pls), ver: uid(), open: pls.every(p => !p.closed) },
      });
      addObject(o);
      toast(`SVG imported: ${pls.length} path(s)`);
    } catch (e) { toast('SVG import failed: ' + e.message, true); }
    return;
  }
  try {
    let bmp = await createImageBitmap(file);
    // limit very large photos (memory)
    const MAX = 2400;
    let blob = file;
    if (Math.max(bmp.width, bmp.height) > MAX) {
      const k = MAX / Math.max(bmp.width, bmp.height);
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
      bmp = await createImageBitmap(blob);
    }
    const [x, y] = bedCenter();
    const ar = bmp.width / bmp.height;
    const w = ar >= 1 ? 80 : 80 * ar, hh = ar >= 1 ? 80 / ar : 80;
    const o = newObject('image', { x, y, w, h: hh, op: 'fill', name: file.name.replace(/\.[^.]+$/, '') || 'Image' });
    app.bitmaps[o.id] = bmp; app.blobs[o.id] = blob;
    idbSet('images', o.id, blob).catch(() => { });
    addObject(o);
  } catch (e) { toast('Could not open image: ' + e.message, true); }
}

app.selectAll = () => {
  if (!app.objects.some(o => o.visible !== false)) return toast('Add something to the board first');
  setTool('select');
  app.selectedId = null; app.groupSel = true;
  if (app.tab !== 'object') setTab('object'); else renderPanel();
  editor.render();
};
app.refreshPanel = () => renderPanel();
function scaleAll(k, about) {
  const b = about || editor.groupBox(); if (!b) return;
  for (const o of editor.groupObjects()) {
    o.w = Math.max(0.3, o.w * k); o.h = Math.max(0.01, o.h * k);
    o.x = b.cx + (o.x - b.cx) * k; o.y = b.cy + (o.y - b.cy) * k;
  }
  app.changed(true); app.commit();
  editor.fitContent();
}
function moveAll(dx, dy) {
  for (const o of editor.groupObjects()) { o.x += dx; o.y += dy; }
  app.changed(true); app.commit(); editor.fitContent();
}
function groupPanel() {
  const b = editor.groupBox();
  if (!b) { app.groupSel = false; return objectTab(); }
  const W = b.x1 - b.x0, H = b.y1 - b.y0, n = editor.groupObjects().length;
  return [section('Whole design (' + n + ' object' + (n > 1 ? 's' : '') + ')',
    h('div', { class: 'hint' }, 'Drag inside the dashed box to move everything. Drag a corner to make it bigger or smaller. ⟳ rotates it.'),
    h('div', { class: 'grid2' },
      field('Width mm', num(W, { min: 1, max: 2000, step: 1, onChange: (v) => scaleAll(v / W) })),
      field('Height mm', num(H, { min: 1, max: 2000, step: 1, onChange: (v) => scaleAll(v / H) })),
    ),
    h('div', { class: 'btns', style: { marginTop: '8px' } },
      btn('− 10%', () => scaleAll(0.9)), btn('+ 10%', () => scaleAll(1.1)),
      btn('½', () => scaleAll(0.5)), btn('×2', () => scaleAll(2)),
    ),
    h('div', { class: 'btns', style: { marginTop: '8px' } },
      btn('Center on bed', () => moveAll(app.cfg.bedW / 2 - b.cx, app.cfg.bedH / 2 - b.cy)),
      btn('Done', () => app.select(null), 'primary'),
    ),
    h('div', { class: 'hint' }, 'Sizes keep their proportions. Hidden or locked objects are not changed.'),
  )];
}

function deleteSel() {
  const o = app.selected(); if (!o) return;
  app.objects = app.objects.filter(x => x !== o);
  app.selectedId = null; app.commit(); app.changed(true);
}
function duplicateSel() {
  const o = app.selected(); if (!o) return;
  const c = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')))));
  c.id = uid(); c.x += 8; c.y += 8;
  if (o.type === 'image') { app.bitmaps[c.id] = app.bitmaps[o.id]; app.blobs[c.id] = app.blobs[o.id]; idbSet('images', c.id, app.blobs[o.id]).catch(() => { }); }
  addObject(c);
}
function detachCutAround(o) {
  const pls = cutAroundLocal(o);
  if (!pls || !pls.length) return;
  // convert to world-space path object
  {
    const w = cutAroundWorld(o);
    const bb = polylinesBBox(w);
    const p = newObject('path', {
      x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2, w: bb.x1 - bb.x0, h: bb.y1 - bb.y0, op: 'cut',
      name: 'Cut around ' + (o.name || o.type), path: { cmds: polylinesToCommands(w), ver: uid(), open: false },
    });
    p.ops.cut = { power: o.cutAround.power, speed: o.cutAround.speed, passes: o.cutAround.passes };
    o.cutAround.enabled = false;
    addObject(p);
  }
}

// job origin in world coordinates (where the laser head should be)
app.originWorld = () => {
  if (app.cfg.absolute) return [0, app.cfg.bedH];
  const vis = app.objects.filter(o => o.visible !== false);
  if (!vis.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of vis) { const b = objWorldBBox(o); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
  return jobOrigin({ x0, y0, x1, y1 }, app.cfg);
};
app.headWorld = () => {
  const o = app.originWorld(); if (!o) return null;
  const p = app.machine.status.wpos; if (!p) return null;
  return [o[0] + p[0], o[1] - p[1]];
};

// ---------------- line tool ----------------
app.lineDraftChanged = () => {
  const n = editor.draft ? editor.draft.length : 0;
  $('#drawHint').textContent = n === 0 ? 'Tap to add points' : n === 1 ? 'Tap the next point' : `${n} points · tap the first point to close`;
};
app.finishLine = (closed) => {
  const d = editor.draft;
  editor.draft = null; editor.hover = null;
  if (d && d.length > 1) app.addPath(d, closed && d.length > 2);
  app.lineDraftChanged(); editor.render();
};

function setTool(t) {
  if (app.tool === 'line' && t !== 'line') app.finishLine(false);
  app.tool = t;
  document.querySelectorAll('#tools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  $('#drawBar').hidden = t !== 'line';
  if (t === 'line') { editor.draft = []; app.lineDraftChanged(); }
  if (t === 'draw') toast('Draw with your finger. Use two fingers to move the view.');
  editor.render();
}

// ---------------- panels ----------------
function setTab(t) {
  app.tab = t;
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  renderPanel();
}
function renderPanel() {
  const st = tabbody.scrollTop;
  tabbody.innerHTML = '';
  const f = { object: objectTab, layers: layersTab, machine: machineTab, run: runTab }[app.tab];
  tabbody.append(...[].concat(f()));
  tabbody.scrollTop = st;
}

const live = (o, fn, geo = true) => (v) => { fn(v); if (geo) invalidate(o); app.changed(false); };
const done = () => { app.commit(); };

function opSettings(o, op) {
  const ops = o.ops[op];
  const kids = [];
  kids.push(h('div', { class: 'grid3' },
    field('Power %', num(ops.power, { min: 0, max: 100, step: 1, onInput: live(o, v => ops.power = v, false), onChange: done })),
    field('Speed mm/min', num(ops.speed, { min: 10, max: 20000, step: 50, onInput: live(o, v => ops.speed = v, false), onChange: done })),
    field('Passes', num(ops.passes, { min: 1, max: 50, step: 1, onInput: live(o, v => ops.passes = Math.round(v), false), onChange: done })),
  ));
  if (op === 'fill') {
    kids.push(row('Line density', ...range(ops.interval, { min: 2, max: 20, step: 1, fmt: v => `${v}/mm`, onInput: live(o, v => { ops.interval = v; o._preview = null; }, false), onChange: done })));
  }
  // presets
  const list = allPresets(op);
  const opts = [['', 'Material presets…']];
  list.forEach((p, i) => opts.push([String(i), (p.user ? '★ ' : '') + `${p.name}  (${p.power}% · ${p.speed} · ×${p.passes})`]));
  const sel = select(opts, '', (v) => {
    if (v === '') return;
    const p = list[+v];
    Object.assign(ops, { power: p.power, speed: p.speed, passes: p.passes }, p.interval ? { interval: p.interval } : {});
    o._preview = null; app.commit(); app.changed(true); toast('Preset applied: ' + p.name);
  });
  kids.push(h('div', { class: 'row' }, sel, btn('Save', async () => {
    const name = await askText('Name for this preset', 'e.g. Birch 3 mm cut');
    if (!name) return;
    savePreset({ name, op, power: ops.power, speed: ops.speed, passes: ops.passes, ...(op === 'fill' ? { interval: ops.interval } : {}) });
    toast('Preset saved'); renderPanel();
  })));
  return kids;
}

function objectTab() {
  if (app.groupSel) return groupPanel();
  const o = app.selected();
  if (!o) {
    return [h('div', { class: 'empty' },
      h('p', {}, h('b', {}, 'Nothing selected.')),
      h('p', {}, 'Add text, an image or a shape with the buttons above, or draw lines to cut. Tap something on the board to edit it.'),
      h('div', { class: 'btns' }, btn('＋ Text', () => addText()), btn('＋ Image', () => $('#fileImage').click()), btn('＋ Shape', shapePicker), btn('Draw lines', () => setTool('line'))),
    )];
  }
  const out = [];
  // header
  out.push(h('div', { class: 'row' },
    h('input', { type: 'text', value: o.name || '', placeholder: o.type, style: { flex: 1 }, onchange: (e) => { o.name = e.target.value; done(); } }),
    btn('⧉', duplicateSel), btn('🗑', deleteSel, 'danger'),
  ));

  // type specific content
  if (o.type === 'text') {
    const ta = h('textarea', { rows: 2 }, o.text.value);
    ta.addEventListener('input', () => { o.text.value = ta.value || ' '; refitTextKeepScale(o); });
    ta.addEventListener('change', done);
    const fonts = {}; FONTS.forEach(f => fonts[f.id] = f.name); fonts['__add'] = '＋ Add your own font (.ttf/.otf)…';
    out.push(section('Text', ta,
      row('Font', select(fonts, o.text.font, async (v) => {
        if (v === '__add') { $('#fileFont').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { const id = await addUserFont(f); o.text.font = id; refitTextKeepScale(o); done(); renderPanel(); } catch (er) { toast('Font error: ' + er.message, true); } e.target.value = ''; }; $('#fileFont').click(); return; }
        o.text.font = v; await getFont(v); refitTextKeepScale(o); done();
      })),
      row('Align', seg({ left: 'Left', center: 'Center', right: 'Right' }, o.text.align, (v) => { o.text.align = v; refitTextKeepScale(o); done(); })),
      row('Spacing', ...range(o.text.letterSpacing, { min: -10, max: 40, step: 1, onInput: (v) => { o.text.letterSpacing = v; refitTextKeepScale(o); }, onChange: done })),
      o.text.value.includes('\n') ? row('Line gap', ...range(o.text.lineHeight, { min: 0.7, max: 2.5, step: 0.05, fmt: v => v.toFixed(2), onInput: (v) => { o.text.lineHeight = v; refitTextKeepScale(o); }, onChange: done })) : null,
    ));
  }
  if (o.type === 'shape') {
    const kinds = {}; Object.entries(SHAPES).forEach(([k, v]) => kinds[k] = v.label);
    const s = o.shape;
    out.push(section('Shape',
      row('Type', select(kinds, s.kind, (v) => { s.kind = v; if (v === 'rounded' && !s.radius) s.radius = 6; invalidate(o); o.name = SHAPES[v].label; app.changed(true); done(); })),
      (s.kind === 'rect' || s.kind === 'rounded') ? row('Corner radius', ...range(s.radius || 0, { min: 0, max: Math.round(Math.min(o.w, o.h) / 2), step: 0.5, fmt: v => v + ' mm', onInput: live(o, v => s.radius = v), onChange: done })) : null,
      s.kind === 'star' ? row('Points', ...range(s.points, { min: 3, max: 20, step: 1, onInput: live(o, v => s.points = v), onChange: done })) : null,
      s.kind === 'star' ? row('Inner size', ...range(s.inner, { min: 0.1, max: 0.9, step: 0.01, fmt: v => Math.round(v * 100) + '%', onInput: live(o, v => s.inner = v), onChange: done })) : null,
      s.kind === 'polygon' ? row('Sides', ...range(s.sides, { min: 3, max: 16, step: 1, onInput: live(o, v => s.sides = v), onChange: done })) : null,
    ));
  }

  // laser operation
  const laser = [];
  if (o.type === 'image') {
    laser.push(h('div', { class: 'hint' }, 'Images are engraved. Turn on "Cut around" below to cut the piece out.'));
    laser.push(...opSettings(o, 'fill'));
    const im = o.img;
    const pv = () => { o._preview = null; };
    laser.push(h('div', { class: 'sec', style: { padding: '8px', marginTop: '8px' } },
      row('Mode', select(DITHERS, im.dither, (v) => { im.dither = v; pv(); app.changed(true); done(); })),
      im.dither === 'threshold' ? row('Threshold', ...range(im.threshold, { min: 1, max: 99, onInput: live(o, v => { im.threshold = v; pv(); }, false), onChange: done })) : null,
      im.dither === 'grayscale' ? row('Min power %', ...range(im.powerMin, { min: 0, max: 100, onInput: live(o, v => im.powerMin = v, false), onChange: done })) : null,
      row('Brightness', ...range(im.brightness, { min: -100, max: 100, onInput: live(o, v => { im.brightness = v; pv(); }, false), onChange: done })),
      row('Contrast', ...range(im.contrast, { min: -100, max: 100, onInput: live(o, v => { im.contrast = v; pv(); }, false), onChange: done })),
      row('Gamma', ...range(im.gamma, { min: 0.3, max: 3, step: 0.05, fmt: v => v.toFixed(2), onInput: live(o, v => { im.gamma = v; pv(); }, false), onChange: done })),
      row('Sharpen', ...range(im.sharpen || 0, { min: 0, max: 100, onInput: live(o, v => { im.sharpen = v; pv(); }, false), onChange: done })),
      row('Invert', toggle(im.invert, (v) => { im.invert = v; pv(); app.changed(false); done(); }), h('span', { class: 'hint' }, 'for dark materials')),
      row('Skip white', toggle(im.removeBg, (v) => { im.removeBg = v; pv(); app.changed(false); done(); }), h('span', { class: 'hint' }, 'don\'t burn the background')),
    ));
  } else {
    laser.push(seg({ fill: 'Engrave', line: 'Engrave lines', cut: 'Cut' }, o.op, (v) => { o.op = v; app.changed(true); done(); }, true));
    laser.push(h('div', { class: 'hint' }, {
      fill: 'Burns the whole inside of the shape/text (filled).',
      line: 'Burns only the outline, once (thin line, not through).',
      cut: 'Laser follows the lines and cuts through. Use more passes for thicker material.',
    }[o.op]));
    laser.push(...opSettings(o, o.op));
  }
  out.push(section('Laser', ...laser));

  // cut around
  const ca = o.cutAround;
  const caKids = [h('h3', {}, h('span', { class: 'grow' }, 'Cut around'), toggle(ca.enabled, (v) => { ca.enabled = v; invalidate(o); app.changed(true); done(); }))];
  if (ca.enabled) {
    caKids.push(
      row('Shape', select(CUT_AROUND, ca.shape, (v) => { ca.shape = v; invalidate(o); app.changed(false); done(); })),
      row('Margin', ...range(ca.margin, { min: 0, max: 30, step: 0.5, fmt: v => v + ' mm', onInput: live(o, v => ca.margin = v), onChange: done })),
      h('div', { class: 'grid3' },
        field('Power %', num(ca.power, { min: 0, max: 100, onInput: live(o, v => ca.power = v, false), onChange: done })),
        field('Speed mm/min', num(ca.speed, { min: 10, max: 20000, step: 50, onInput: live(o, v => ca.speed = v, false), onChange: done })),
        field('Passes', num(ca.passes, { min: 1, max: 50, onInput: live(o, v => ca.passes = Math.round(v), false), onChange: done })),
      ),
      (() => {
        const list = allPresets('cut'); const opts = [['', 'Cut presets…']];
        list.forEach((p, i) => opts.push([String(i), (p.user ? '★ ' : '') + `${p.name} (${p.power}% · ${p.speed} · ×${p.passes})`]));
        return h('div', { class: 'row' }, select(opts, '', (v) => { if (v === '') return; const p = list[+v]; Object.assign(ca, { power: p.power, speed: p.speed, passes: p.passes }); app.changed(true); done(); }));
      })(),
      h('div', { class: 'hint' }, 'The red dashed line is cut last, after everything inside is finished.'),
      h('div', { class: 'btns' }, btn('Make it a separate shape (to edit it freely)', () => detachCutAround(o))),
    );
  } else {
    caKids.push(h('div', { class: 'hint' }, 'Cut this piece out with a heart, circle, rectangle… or a contour that follows the outline.'));
  }
  out.push(h('div', { class: 'sec' }, ...caKids));

  // geometry
  const H = app.cfg.bedH;
  out.push(section('Size & position',
    h('div', { class: 'grid2' },
      field('Width mm', num(o.w, { min: 0.5, max: 2000, step: 0.5, onInput: (v) => { const k = v / o.w; o.w = v; if (o.lockRatio) o.h *= k; invalidate(o); app.changed(false); }, onChange: () => { done(); renderPanel(); } })),
      field('Height mm', num(o.h, { min: 0.5, max: 2000, step: 0.5, onInput: (v) => { const k = v / o.h; o.h = v; if (o.lockRatio) o.w *= k; invalidate(o); app.changed(false); }, onChange: () => { done(); renderPanel(); } })),
      field('X (center)', num(o.x, { step: 0.5, onInput: (v) => { o.x = v; app.changed(false); }, onChange: done })),
      field('Y (center)', num(H - o.y, { step: 0.5, onInput: (v) => { o.y = H - v; app.changed(false); }, onChange: done })),
      field('Rotation °', num(o.rot || 0, { step: 1, min: -360, max: 360, onInput: (v) => { o.rot = v; app.changed(false); }, onChange: done })),
      h('label', { class: 'fld' }, 'Keep proportions', toggle(o.lockRatio, (v) => { o.lockRatio = v; done(); })),
    ),
    h('div', { class: 'btns', style: { marginTop: '8px' } },
      btn('⇋ Flip', () => { o.flipX = !o.flipX; app.changed(false); done(); }),
      btn('⇵ Flip', () => { o.flipY = !o.flipY; app.changed(false); done(); }),
      btn('Center', () => { o.x = app.cfg.bedW / 2; o.y = app.cfg.bedH / 2; app.changed(true); done(); }),
      btn('Front', () => { app.objects = app.objects.filter(x => x !== o).concat([o]); app.changed(); done(); }),
      btn('Back', () => { app.objects = [o].concat(app.objects.filter(x => x !== o)); app.changed(); done(); }),
    ),
  ));
  return out;
}

function layersTab() {
  if (!app.objects.length) return [h('div', { class: 'empty' }, 'No objects yet.')];
  const icon = { image: '🖼', text: 'T', shape: '⬟', path: '〰' };
  const opName = (o) => o.type === 'image' || o.op === 'fill' ? 'engrave' : o.op === 'line' ? 'line' : 'cut';
  const ul = h('ul', { class: 'layers' });
  [...app.objects].reverse().forEach(o => {
    ul.append(h('li', { class: o.id === app.selectedId ? 'on' : '', onclick: () => app.select(o.id) },
      h('span', {}, icon[o.type]),
      h('span', { class: 'nm' }, o.name || (o.type === 'text' ? o.text.value : o.type)),
      h('span', { class: 'tag ' + opName(o) }, opName(o)),
      o.cutAround.enabled ? h('span', { class: 'tag cut' }, '+cut') : null,
      h('button', { onclick: (e) => { e.stopPropagation(); o.visible = o.visible === false; app.changed(true); done(); }, title: 'Show/hide' }, o.visible === false ? '🚫' : '👁'),
    ));
  });
  return [ul, h('div', { class: 'hint' }, 'Order when running: engraving first, then line engraving, then cuts (small/inner shapes before outer ones). Hidden objects are skipped.')];
}

// ---------------- machine tab ----------------
let consoleEl = null;
function machineTab() {
  const m = app.machine;
  const out = [];
  if (!m.connected && AndroidTransport.supported()) {
    out.push(section('Connect',
      h('div', { class: 'btns' },
        btn('🔵 Connect to engraver', androidPicker, 'primary'),
        btn('Demo (no laser)', () => connect('demo')),
      ),
      h('div', { class: 'hint' }, 'Turn the engraver on. Close the original SculpFun app so it doesn\'t hold the Bluetooth connection.'),
    ));
  } else if (!m.connected) {
    const serialOk = SerialTransport.supported(), bleOk = BleTransport.supported();
    out.push(section('Connect',
      h('div', { class: 'btns' },
        btn('🔵 Bluetooth', () => connect('serial'), 'primary'),
        btn('Bluetooth LE', () => connect('ble')),
        btn('Demo (no laser)', () => connect('demo')),
      ),
      h('div', { class: 'hint' }, 'Use "Bluetooth" first. Pair the engraver in Android Settings → Bluetooth once (the name starts with "SculpFun"). Turn off Bluetooth in the original SculpFun app.'),
      !serialOk ? h('div', { class: 'hint warn' }, 'This browser can\'t do Bluetooth Classic (Web Serial). Open this page in Chrome for Android (version 138 or newer).') : null,
      !bleOk ? h('div', { class: 'hint warn' }, 'Web Bluetooth is not available in this browser.') : null,
      h('div', { class: 'hint' }, 'Didn\'t find it? Try "Bluetooth LE"; long-press it to show every nearby device.'),
    ));
  } else {
    const s = m.status;
    out.push(section('Machine',
      h('div', { class: 'stat' }, h('span', {}, 'Connection'), h('b', {}, m.t.name)),
      m.info.model ? h('div', { class: 'stat' }, h('span', {}, 'Model'), h('b', {}, m.info.model)) : null,
      m.info.version ? h('div', { class: 'stat' }, h('span', {}, 'Firmware'), h('b', {}, m.info.version)) : null,
      h('div', { class: 'stat' }, h('span', {}, 'State'), h('b', { id: 'mState' }, s.state)),
      h('div', { class: 'stat' }, h('span', {}, 'Position'), h('b', { id: 'mPos' }, `X ${s.wpos[0].toFixed(1)}  Y ${s.wpos[1].toFixed(1)}`)),
      h('div', { class: 'btns', style: { marginTop: '6px' } }, btn('Disconnect', () => m.detach(), 'danger')),
    ));
    out.push(section('Move the laser', ...movePanel()));
  }
  consoleEl = h('div', { class: 'console' });
  app.log.slice(-200).forEach(l => consoleEl.append(logLine(l)));
  const inp = h('input', { type: 'text', placeholder: 'G-code or $ command, e.g. $$', autocapitalize: 'off', autocomplete: 'off' });
  const sendIt = () => { const v = inp.value.trim(); if (!v) return; inp.value = ''; m.send(v).catch(e => addLog({ dir: 'err', text: e.message })); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendIt(); });
  out.push(section('Console', consoleEl, h('div', { class: 'row' }, inp, btn('Send', sendIt))));
  setTimeout(() => { consoleEl.scrollTop = consoleEl.scrollHeight; }, 0);
  return out;
}
// ---------------- moving the head ----------------
function originOpts() {
  const c = app.cfg;
  return { absolute: c.absolute, offset: c.pointer ? [+c.pointerDX || 0, +c.pointerDY || 0] : [0, 0] };
}
function movePanel() {
  const m = app.machine, c = app.cfg;
  const go = (p) => p.catch(e => toast(e.message, true));
  const J = (dx, dy) => () => { if (!m.connected) return toast('Connect to the engraver first', true); go(m.jog(dx * c.jogStep, dy * c.jogStep, c.jogFeed)); };
  const home = async () => {
    if (!m.connected) return toast('Connect to the engraver first', true);
    if (c.hasHoming) { toast('Homing…'); go(m.send('$H', 90000)); }
    else go(m.send('$J=G90 X0 Y0 F' + c.jogFeed));
  };
  return [
    row('Step', seg([['0.1', '0.1'], ['1', '1'], ['10', '10'], ['50', '50 mm']], c.jogStep, (v) => { c.jogStep = +v; saveCfg(); })),
    row('Speed', num(c.jogFeed, { min: 100, max: 10000, step: 100, onChange: (v) => { c.jogFeed = v; saveCfg(); } }), h('span', { class: 'hint' }, 'mm/min')),
    h('div', { class: 'jog' },
      btn('↖', J(-1, 1)), btn('↑', J(0, 1)), btn('↗', J(1, 1)),
      btn('←', J(-1, 0)), h('button', { class: 'c', onclick: home }, c.hasHoming ? '🏠 Home' : '🏠 Start'), btn('→', J(1, 0)),
      btn('↙', J(-1, -1)), btn('↓', J(0, -1)), btn('↘', J(1, -1)),
    ),
    h('div', { class: 'btns', style: { marginTop: '8px' } },
      btn('⏹ Stop moving', () => m.connected && m.realtime(String.fromCharCode(0x85))),
      btn(laserDot ? '🔴 Laser dot off' : '🔴 Laser dot', toggleDot),
      btn(c.air ? '💨 Air off' : '💨 Air on', () => { c.air = !c.air; saveCfg(); if (m.connected) m.send(c.air ? 'M8' : 'M9').catch(() => { }); renderPanel(); moveSheetRefresh(); }),
      btn('🔓 Unlock', () => go(m.send('$X'))),
      c.hasHoming ? btn('Go to start', () => go(m.send('$J=G90 X0 Y0 F' + c.jogFeed))) : null,
    ),
    h('div', { class: 'hint' }, c.hasHoming ? '🏠 Home drives to the limit switches. "Go to start" returns to where the last job started.'
      : '🏠 Start returns the head to where the last job or frame started. Machine has limit switches? Turn on "Homing" in Settings.'),
    h('div', { class: 'hint' }, 'The job always starts where the ' + (c.pointer ? 'red pointer' : 'laser') + ' is when you press Start or Show where.'),
  ];
}
let moveSheetOpen = false;
function moveSheet() {
  moveSheetOpen = true;
  const m = app.machine;
  openSheet('Move the laser', !m.connected ? h('div', { class: 'btns', style: { marginBottom: '8px' } }, btn('Connect first', () => { closeSheet(); setTab('machine'); }, 'primary')) : null,
    ...movePanel(), h('div', { class: 'btns', style: { marginTop: '10px' } }, btn('Close', () => { moveSheetOpen = false; closeSheet(); })));
}
function moveSheetRefresh() { if (moveSheetOpen && !$('#sheet').hidden) moveSheet(); }

let framing = false;
function showWhereSheet() {
  const m = app.machine, c = app.cfg;
  const offTxt = `${(+c.pointerDX).toFixed(1)}, ${(+c.pointerDY).toFixed(1)} mm`;
  openSheet('Show where it will engrave',
    !m.connected ? h('div', { class: 'btns', style: { marginBottom: '8px' } }, btn('Connect first', () => { closeSheet(); setTab('machine'); }, 'primary')) : null,
    c.pointer
      ? h('div', { class: 'hint' }, `Using the separate red pointer (offset ${offTxt}). `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); c.pointer = false; saveCfg(); showWhereSheet(); } }, 'Use the blue laser instead'))
      : h('div', {},
        h('div', { class: 'hint' }, 'The blue laser moves around the design at very low power. It shows where the engraving goes without burning, like "Laser preview" in the SculpFun app.'),
        row('Preview power', ...range(c.framePower, { min: 1, max: 30, step: 1, fmt: v => 'S' + v + ' (' + (v / c.sMax * 100).toFixed(1) + '%)', onChange: (v) => { c.framePower = v; c.pointerPower = v; saveCfg(); } })),
        h('div', { class: 'hint' }, 'Too faint to see? Raise it a little. It starts burning at around S15–S30 depending on the material.'),
      ),
    h('div', { class: 'btns', style: { margin: '8px 0' } },
      btn('⬚ Box around the design', () => runFrame(false), 'primary'),
      btn('✎ Trace the outline', () => runFrame(true)),
    ),
    row('Keep repeating', toggle(c.frameRepeat, (v) => { c.frameRepeat = v; saveCfg(); }), h('span', { class: 'hint' }, 'until you tap Stop')),
    h('div', { class: 'btns' }, btn('⏹ Stop', stopFrame, 'danger'), btn('Move the laser…', () => { closeSheet(); moveSheet(); }), btn('Close', closeSheet)),
    h('div', { class: 'hint' }, 'Move the ' + (c.pointer ? 'red pointer' : 'laser') + ' to where the design should start (' + ({ bl: 'bottom-left corner', center: 'center', tl: 'top-left corner', tr: 'top-right corner', br: 'bottom-right corner' }[c.anchor] || 'bed position') + '), then tap a button above.'),
  );
}
async function runFrame(trace) {
  const m = app.machine;
  if (!m.connected) { toast('Connect to the engraver first', true); return; }
  if (framing) return;
  let job; try { job = getJob(); } catch (e) { return toast(e.message, true); }
  const c = app.cfg;
  framing = true;
  try {
    do {
      toast(trace ? 'Tracing the outline…' : 'Showing the box…');
      const usePointer = c.pointer && (+c.pointerDX || +c.pointerDY);
      const opts = { power: c.framePower, feed: c.frameFeed, absolute: c.absolute, offset: [+c.pointerDX || 0, +c.pointerDY || 0], pointer: !!usePointer };
      if (trace) await m.trace(job.hull, opts); else await m.frame(job.gbox, opts);
    } while (framing && c.frameRepeat && m.connected && !m.cancelFrame);
  } catch (e) { toast(e.message, true); try { await m.send('M5'); } catch (_) { } }
  framing = false;
}
async function stopFrame() {
  const m = app.machine;
  framing = false;
  if (!m.connected) return;
  await m.stopMotion();
  toast('Stopped');
}
function pointerCalibration() {
  const m = app.machine, c = app.cfg;
  let dot = null;
  const step = h('div');
  const render = () => {
    step.innerHTML = '';
    if (!m.connected) { step.append(h('p', { class: 'hint warn' }, 'Connect to the engraver first.'), btn('Connect', () => { closeSheet(); setTab('machine'); }, 'primary')); return; }
    if (!dot) {
      step.append(
        h('p', {}, '1. Put a scrap of wood or cardboard under the laser.'),
        h('p', {}, '2. Tap the button. The laser burns one small dot.'),
        h('div', { class: 'btns' }, btn('🔥 Burn a dot', async () => {
          try {
            await m.send(`M3 S${c.burnPower}\nG4 P0.4\nM5`);
            dot = [...m.status.wpos]; render();
          } catch (e) { toast(e.message, true); }
        }, 'primary')),
      );
    } else {
      step.append(
        h('p', {}, '3. Move the head until the red pointer sits exactly on the burnt dot. Use small steps (1 or 0.1 mm) at the end.'),
        ...movePanel(),
        h('div', { class: 'btns', style: { marginTop: '8px' } },
          btn('Burn again', () => { dot = null; render(); }),
          btn('✔ Pointer is on the dot', () => {
            const p = m.status.wpos;
            c.pointerDX = Math.round((dot[0] - p[0]) * 100) / 100; c.pointerDY = Math.round((dot[1] - p[1]) * 100) / 100;
            c.pointer = true; saveCfg(); closeSheet();
            toast(`Saved: pointer is ${c.pointerDX} mm X, ${c.pointerDY} mm Y from the laser`);
          }, 'primary')),
      );
    }
  };
  render();
  openSheet('Set up the red pointer',
    h('p', { class: 'hint' }, 'The red pointer sits a little beside the laser beam. This measures how far, so the pointer can show exactly where the laser will engrave.'),
    step,
    h('div', { class: 'grid2', style: { marginTop: '10px' } },
      field('Offset X mm', num(c.pointerDX, { step: 0.1, onChange: (v) => { c.pointerDX = v; saveCfg(); } })),
      field('Offset Y mm', num(c.pointerDY, { step: 0.1, onChange: (v) => { c.pointerDY = v; saveCfg(); } })),
    ),
    h('div', { class: 'btns', style: { marginTop: '10px' } }, btn('Close', closeSheet)),
  );
}

let laserDot = false;
async function toggleDot() {
  const m = app.machine;
  try {
    if (!laserDot) { await m.send(`M3 S${app.cfg.pointerPower}\nG1 F1000`); laserDot = true; toast('Weak laser dot ON — don\'t look into it'); }
    else { await m.send('M5'); laserDot = false; }
  } catch (e) { toast(e.message, true); }
  renderPanel(); moveSheetRefresh();
}
function logLine(l) { return h('div', { class: l.dir === 'out' ? 'out' : l.dir === 'err' ? 'err' : '' }, (l.dir === 'out' ? '› ' : '') + l.text); }
function addLog(l) {
  app.log.push(l); if (app.log.length > 500) app.log.splice(0, 100);
  if (consoleEl && consoleEl.isConnected) { consoleEl.append(logLine(l)); if (consoleEl.childNodes.length > 300) consoleEl.firstChild.remove(); consoleEl.scrollTop = consoleEl.scrollHeight; }
}

function androidPicker() {
  const BT = window.AndroidBT;
  const st = BT.state();
  if (st === 'unsupported') return toast('This device has no Bluetooth', true);
  if (st === 'noperm' || st === 'off') {
    openSheet('Bluetooth needed',
      h('p', { class: 'hint' }, st === 'off' ? 'Bluetooth is turned off.' : 'Allow Loki Laser to use Bluetooth ("Nearby devices").'),
      h('div', { class: 'btns' }, btn('Cancel', closeSheet), btn(st === 'off' ? 'Turn on Bluetooth' : 'Allow', () => { BT.requestSetup(); closeSheet(); }, 'primary')));
    return;
  }
  let devs = [];
  try { devs = JSON.parse(BT.devices()); } catch (e) { }
  const isSF = (n) => /sculp|sf-|icube|ts1/i.test(n || '');
  devs.sort((a, b) => (isSF(b.name) ? 1 : 0) - (isSF(a.name) ? 1 : 0));
  const pick = (d) => { BT.stopScan(); off && off(); closeSheet(); connect('android', d); };
  const item = (d) => {
    const nm = h('span', { class: 'nm' }, d.name || ('Unknown device ' + d.address));
    const ic = h('span', {}, isSF(d.name) ? '🔥' : '🔵');
    const li = h('li', { onclick: () => pick({ name: li._name || d.address, address: d.address }) }, ic, nm, h('span', { class: 'tag' }, d.paired ? 'paired' : 'new'));
    li._name = d.name; li._nm = nm; li._ic = ic;
    return li;
  };
  const warn = h('div');
  const showWarn = () => {
    warn.innerHTML = '';
    const s2 = BT.state();
    if (s2 === 'noscanperm') warn.append(h('div', { class: 'hint warn' }, 'To search, Android needs "Nearby devices" and "Location" permission for Loki Laser (the SculpFun app needs the same).'), btn('Allow', () => BT.requestSetup(), 'primary'));
    else if (s2 === 'noloc') warn.append(h('div', { class: 'hint warn' }, 'Location (GPS) is off. Android only finds Bluetooth devices when Location is on.'), btn('Turn on Location', () => BT.requestSetup(), 'primary'));
  };
  showWarn();
  const list = h('ul', { class: 'layers' }, ...devs.map(item));
  const found = h('ul', { class: 'layers' });
  const status = h('div', { class: 'hint' });
  const items = new Map();
  devs.forEach(d => items.set(d.address, null));
  let off = null;
  const doScan = () => {
    showWarn();
    status.textContent = 'Searching… (about 12 seconds)';
    off && off();
    off = onBtEvent((ev) => {
      if (ev.type === 'found') {
        if (items.has(ev.address)) {
          const li = items.get(ev.address);
          if (li && ev.name && !li._name) { li._name = ev.name; li._nm.textContent = ev.name; li._ic.textContent = isSF(ev.name) ? '🔥' : '🔵'; if (isSF(ev.name)) found.prepend(li); }
          return;
        }
        const li = item({ name: ev.name, address: ev.address, paired: false });
        items.set(ev.address, li);
        if (isSF(ev.name)) found.prepend(li); else found.append(li);
      }
      if (ev.type === 'scanError') { status.textContent = ev.message; showWarn(); off && off(); }
      if (ev.type === 'scanDone') {
        status.textContent = found.childNodes.length ? 'Search finished. Tap your engraver (name starts with "SculpFun").'
          : 'Nothing found. Make sure the SculpFun app is fully closed (swipe it away) — while it is connected, the engraver is hidden. Then turn the engraver off and on and search again.';
        off && off();
      }
    });
    BT.startScan();
  };
  const scanBtn = btn('🔍 Search for nearby devices', doScan);
  openSheet('Choose your engraver', warn,
    devs.length ? h('div', {}, h('div', { class: 'hint' }, 'Paired devices'), list) : null,
    h('div', { class: 'btns', style: { margin: '8px 0' } }, scanBtn), status, found,
    h('div', { class: 'hint' }, 'Tip: close the SculpFun app completely first. The engraver can only be connected to one app at a time.'),
    h('div', { class: 'btns', style: { marginTop: '10px' } }, btn('Close', () => { BT.stopScan(); off && off(); closeSheet(); })));
  if (!devs.some(d => isSF(d.name))) setTimeout(doScan, 300);
  window.__btPermRefresh = showWarn;
}

async function connect(kind, dev) {
  const m = app.machine;
  let t;
  if (kind === 'android') { t = new AndroidTransport(dev.address, dev.name); toast('Connecting to ' + (dev.name || dev.address) + '…'); }
  else if (kind === 'serial') t = new SerialTransport();
  else if (kind === 'ble') t = new BleTransport(app.cfg.bleChunk);
  else t = new DemoTransport();
  try {
    m._connectArgs = [];
    await m.attach(t);
    toast('Connected (' + t.name + ')');
    setTimeout(renderPanel, 1500);
  } catch (e) {
    if (e.name === 'NotFoundError') toast('No device chosen', true);
    else toast(e.message || String(e), true);
  }
  renderPanel();
}

// ---------------- run tab ----------------
function getJob() {
  if (app.job && app.jobVer === app.sceneVer && app.jobCfg === JSON.stringify(app.cfg)) return app.job;
  app.job = buildJob(app.objects, app.bitmaps, app.cfg);
  app.jobVer = app.sceneVer; app.jobCfg = JSON.stringify(app.cfg);
  return app.job;
}

function runTab() {
  const c = app.cfg, m = app.machine;
  const out = [];
  let job = null, err = null;
  if (app.objects.length) { try { job = getJob(); } catch (e) { err = e.message; } }

  const anchors = { tl: '↖', tr: '↗', center: '✛', bl: '↙', br: '↘' };
  out.push(section('Start point',
    h('div', { class: 'hint' }, 'Where is the laser head when you press Start?'),
    seg({ bl: '↙ Bottom-left', center: '✛ Center', tl: '↖ Top-left' }, c.absolute ? '' : c.anchor, (v) => { c.anchor = v; c.absolute = false; saveCfg(); app.changed(true); }),
    h('div', { class: 'row' }, seg({ tr: '↗ Top-right', br: '↘ Bottom-right' }, c.absolute ? '' : c.anchor, (v) => { c.anchor = v; c.absolute = false; saveCfg(); app.changed(true); })),
    row('Use bed position', toggle(c.absolute, (v) => { c.absolute = v; saveCfg(); app.changed(true); }), h('span', { class: 'hint' }, 'only after homing (limit switches)')),
  ));

  const sum = [];
  if (err) sum.push(h('div', { class: 'hint warn' }, err));
  else if (job) {
    const bb = job.worldBBox;
    sum.push(
      h('div', { class: 'stat' }, h('span', {}, 'Job size'), h('b', {}, `${(bb.x1 - bb.x0).toFixed(1)} × ${(bb.y1 - bb.y0).toFixed(1)} mm `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); app.selectAll(); } }, 'resize'))),
      h('div', { class: 'stat' }, h('span', {}, 'Estimated time'), h('b', {}, '≈ ' + fmtTime(job.time))),
      h('div', { class: 'stat' }, h('span', {}, 'G-code'), h('b', {}, `${(job.bytes / 1024).toFixed(0)} KB · ${job.lines.toLocaleString()} lines`)),
    );
    if (job.bytes > 3e6) sum.push(h('div', { class: 'hint warn' }, 'Big file: upload over Bluetooth may take several minutes. Lower "Line density" or make the image smaller to speed it up.'));
  } else sum.push(h('div', { class: 'hint' }, 'Add something to the board first.'));
  sum.push(row('Air assist', toggle(c.air, (v) => { c.air = v; saveCfg(); })));
  sum.push(h('div', { class: 'btns' },
    btn(app.previewOn ? 'Hide preview' : '👁 Preview path', togglePreview),
    btn('🎯 Show where', showWhereSheet),
  ));
  out.push(section('Job', ...sum));

  const run = app.run;
  const prog = h('div', { class: 'progress' }, h('div', { id: 'runBar', style: { width: (run.pct || 0) + '%' } }));
  const lbl = h('div', { class: 'stat' }, h('span', { id: 'runPhase' }, runPhaseText()), h('b', { id: 'runPct' }, run.active ? (run.pct || 0).toFixed(1) + '%' : ''));
  const ctl = run.active
    ? h('div', { class: 'btns' },
      btn(m.status.state === 'Hold' ? '▶ Resume' : '⏸ Pause', () => { (m.status.state === 'Hold' ? m.resume() : m.pause()); setTimeout(renderPanel, 400); }),
      btn('⏹ Stop', async () => { if (await ask('Stop the job now?', 'Stop', true)) stopJob(); }, 'danger'))
    : h('div', { class: 'btns' }, btn('▶ Start', startJob, 'primary full'));
  out.push(section('Run', lbl, prog, h('div', { style: { height: '8px' } }), ctl,
    !m.connected ? h('div', { class: 'hint warn' }, 'Not connected — go to the Machine tab.') : null,
    h('div', { class: 'hint' }, '⚠ Wear laser safety glasses. Never leave the engraver running unattended.'),
  ));

  out.push(section('More',
    row('Send method', seg({ upload: 'Upload, then run', stream: 'Stream live' }, c.transfer, (v) => { c.transfer = v; saveCfg(); })),
    h('div', { class: 'hint' }, 'Upload sends the file to the engraver first (like the SculpFun app) — it keeps running even if the phone disconnects. Stream sends line by line.'),
    h('div', { class: 'btns' }, btn('⬇ Save G-code (.nc)', exportGcode), btn('🧪 Material test…', materialTest)),
  ));
  return out;
}
function runPhaseText() {
  const r = app.run;
  if (!r.active) return r.lastMsg || 'Ready';
  if (r.phase === 'upload') return 'Sending to engraver…';
  if (app.machine.status.state === 'Hold') return 'Paused';
  return 'Engraving…';
}
function updateRunUI() {
  const bar = $('#runBar'); if (!bar) return;
  bar.style.width = (app.run.pct || 0) + '%';
  $('#runPct').textContent = app.run.active ? (app.run.pct || 0).toFixed(1) + '%' : '';
  $('#runPhase').textContent = runPhaseText();
}

function togglePreview() {
  if (app.previewOn) { app.previewOn = false; $('#previewBar').hidden = true; editor.render(); renderPanel(); return; }
  try {
    const job = getJob();
    app.previewOn = true;
    $('#previewBar').hidden = false;
    $('#previewInfo').textContent = `≈ ${fmtTime(job.time)} · blue = engrave, red = cut, dashed = moves`;
    editor.render(); renderPanel();
  } catch (e) { toast(e.message, true); }
}

async function startJob() {
  const m = app.machine;
  if (!m.connected) { setTab('machine'); return toast('Connect to the engraver first', true); }
  let job; try { job = getJob(); } catch (e) { return toast(e.message, true); }
  const c = app.cfg;
  openSheet('Start the job?',
    h('div', { class: 'stat' }, h('span', {}, 'Estimated time'), h('b', {}, '≈ ' + fmtTime(job.time))),
    h('div', { class: 'stat' }, h('span', {}, 'Start point'), h('b', {}, c.absolute ? 'bed position' : { bl: 'bottom-left', center: 'center', tl: 'top-left', tr: 'top-right', br: 'bottom-right' }[c.anchor] + ' = ' + (c.pointer ? 'red pointer' : 'laser') + ' now')),
    h('p', { class: 'hint warn' }, '⚠ Put on laser safety glasses. Check focus and that the material is flat. Stay with the machine.'),
    h('div', { class: 'btns' }, btn('Cancel', closeSheet), btn('▶ Start now', async () => {
      closeSheet();
      app.run = { active: true, phase: c.transfer === 'upload' ? 'upload' : 'run', pct: 0 };
      if (app.previewOn) togglePreview();
      setTab('run');
      try {
        if (c.transfer === 'upload') await m.uploadAndRun(c.fileName, job.gcode, originOpts());
        else { await m.stream(job.gcode, { ...originOpts(), rxBuffer: c.rxBuffer }); }
      } catch (e) {
        app.run = { active: false, lastMsg: 'Failed: ' + e.message };
        toast(e.message, true); renderPanel();
      }
    }, 'primary')),
  );
}
async function stopJob() {
  await app.machine.stop();
  app.run = { active: false, lastMsg: 'Stopped' };
  renderPanel();
}

function download(name, data, type) {
  if (window.AndroidApp) {
    const u8 = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    window.AndroidApp.saveFile(name, type, btoa(bin));
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportGcode() {
  try { const job = getJob(); download('job.nc', job.gcode, 'text/plain'); } catch (e) { toast(e.message, true); }
}

function materialTest() {
  let kind = 'fill', powers = '20,40,60,80,100', speeds = '1000,2000,3000,4000,5000', passes = 1;
  const pIn = h('input', { type: 'text', value: powers }), sIn = h('input', { type: 'text', value: speeds });
  const nIn = h('input', { type: 'number', value: 1, min: 1, max: 20 });
  openSheet('Material test',
    h('p', { class: 'hint' }, 'Creates a grid of small squares, each with a different power and speed, so you can see what works on your material.'),
    row('Test', seg({ fill: 'Engrave', cut: 'Cut' }, kind, (v) => { kind = v; if (v === 'cut') { sIn.value = '200,300,400,600,800'; pIn.value = '100'; nIn.value = 3; } else { sIn.value = speeds; pIn.value = powers; nIn.value = 1; } })),
    field('Power % (columns)', pIn), field('Speed mm/min (rows)', sIn), field('Passes', nIn),
    h('div', { class: 'btns', style: { marginTop: '10px' } }, btn('Cancel', closeSheet), btn('Create', async () => {
      const P = pIn.value.split(/[ ,;]+/).map(Number).filter(v => v > 0 && v <= 100);
      const S = sIn.value.split(/[ ,;]+/).map(Number).filter(v => v > 0);
      const n = Math.max(1, +nIn.value || 1);
      if (!P.length || !S.length) return toast('Enter power and speed values', true);
      closeSheet();
      const cell = 8, gap = 4;
      const W = P.length * (cell + gap), Hh = S.length * (cell + gap);
      // place next to the existing design so nothing overlaps
      let [cx, cy] = bedCenter();
      const vis = app.objects.filter(o => o.visible !== false);
      if (vis.length) {
        // find the free spot (with labels area) closest to the view center
        const boxes = vis.map(o => objWorldBBox(o));
        const tw = W + 20, th = Hh + 16, pad = 4;
        let best = null;
        for (let y = th / 2 + 2; y <= app.cfg.bedH - th / 2 - 2; y += 5) for (let x = tw / 2 + 2; x <= app.cfg.bedW - tw / 2 - 2; x += 5) {
          const r = { x0: x - tw / 2 - pad, y0: y - th / 2 - pad, x1: x + tw / 2 + pad, y1: y + th / 2 + pad };
          if (boxes.some(b => b.x0 < r.x1 && b.x1 > r.x0 && b.y0 < r.y1 && b.y1 > r.y0)) continue;
          const d = Math.hypot(x - cx, y - cy);
          if (!best || d < best.d) best = { x, y, d };
        }
        if (best) { cx = best.x; cy = best.y + 3; } else toast('No free space on the bed — the test overlaps your design');
      }
      const x0 = cx - W / 2 + 10, y0 = cy - Hh / 2;
      await getFont('roboto-bold');
      S.forEach((sp, r) => P.forEach((pw, c) => {
        const o = newObject('shape', { x: x0 + c * (cell + gap) + cell / 2, y: y0 + r * (cell + gap) + cell / 2, w: cell, h: cell, op: kind, name: `${pw}% ${sp}`, shape: { kind: kind === 'cut' ? 'circle' : 'rect' } });
        o.ops[kind] = { ...o.ops[kind], power: pw, speed: sp, passes: n };
        o._needsRender = () => editor.render();
        app.objects.push(o);
      }));
      const lab = (txt, x, y, hh) => { const t = newObject('text', { x, y, w: 10, h: hh, op: 'line', name: 'label ' + txt, text: { value: txt, font: 'roboto-bold' } }); t._h = hh; t.ops.line = { power: 30, speed: 1500, passes: 1 }; t._needsRender = () => editor.render(); app.objects.push(t); return t; };
      const labels = [];
      P.forEach((pw, c) => labels.push(lab(String(pw), x0 + c * (cell + gap) + cell / 2, y0 - 5, 3)));
      S.forEach((sp, r) => labels.push(lab(String(sp), x0 - 10, y0 + r * (cell + gap) + cell / 2, 2.5)));
      labels.push(lab('POWER %', x0 + W / 2 - gap / 2, y0 - 10, 3));
      for (const t of labels) sizeText(t, t._h);
      app.selectedId = null; app.commit(); app.changed(true); editor.fitContent();
      toast('Material test added. Frame it, then Start.');
    }, 'primary')),
  );
}

// ---------------- menu & settings ----------------
function menu() {
  openSheet('Menu', h('div', { class: 'menu' },
    h('button', { onclick: async () => { closeSheet(); if (await ask('Start a new empty project? The current design is removed.', 'New project', true)) { app.objects = []; app.selectedId = null; app.commit(); app.changed(true); } } }, '🆕 New project'),
    h('button', { onclick: () => { closeSheet(); saveProject(); } }, '💾 Save project to file'),
    h('button', { onclick: () => { closeSheet(); $('#fileProject').click(); } }, '📂 Open project file'),
    h('button', { onclick: () => { closeSheet(); exportGcode(); } }, '⬇ Save G-code (.nc)'),
    h('button', { onclick: () => { closeSheet(); settings(); } }, '⚙ Settings'),
    h('button', { onclick: () => { closeSheet(); presetsSheet(); } }, '★ My material presets'),
    h('button', { onclick: () => { closeSheet(); checkUpdate(true); } }, '⟳ Check for updates'),
    h('button', { onclick: () => { closeSheet(); help(); } }, '❓ Help'),
  ), h('p', { class: 'hint' }, 'Version ' + VERSION + (window.AndroidApp ? ' · app ' + (JSON.parse(window.AndroidApp.info() || '{}').version || '') : '')));
}
function saveCfg() { lsSet('cfg', app.cfg); app.machine.autoUnlock = app.cfg.autoUnlock; }
function settings() {
  const c = app.cfg;
  const models = {}; Object.entries(MODELS).forEach(([k, v]) => models[k] = `${v.name} (${v.w}×${v.h})`);
  const n = (key, opts) => num(c[key], { ...opts, onChange: (v) => { c[key] = v; saveCfg(); editor.render(); } });
  openSheet('Settings',
    section('Machine',
      row('Model', select(models, c.model, (v) => { c.model = v; if (v !== 'custom') { c.bedW = MODELS[v].w; c.bedH = MODELS[v].h; } saveCfg(); closeSheet(); settings(); editor.fit(); })),
      h('div', { class: 'grid2' }, field('Work area width mm', n('bedW', { min: 50, max: 2000 })), field('Work area height mm', n('bedH', { min: 50, max: 2000 }))),
      h('div', { class: 'grid2' }, field('Max S value ($30)', n('sMax', { min: 1, max: 10000 })), field('Overscan mm', n('overscan', { min: 0, max: 20, step: 0.5 }))),
      row('Engrave both ways', toggle(c.bidir, (v) => { c.bidir = v; saveCfg(); })),
      row('Auto-unlock alarm', toggle(c.autoUnlock, (v) => { c.autoUnlock = v; saveCfg(); })),
      row('Homing', toggle(c.hasHoming, (v) => { c.hasHoming = v; saveCfg(); }), h('span', { class: 'hint' }, 'machine has limit switches ($H)')),
    ),
    section('Show where',
      row('Show with', seg([['laser', 'Blue laser (weak)'], ['pointer', 'Separate red pointer']], c.pointer ? 'pointer' : 'laser', (v) => { c.pointer = v === 'pointer'; saveCfg(); })),
      h('div', { class: 'grid2' }, field('Pointer offset X mm', n('pointerDX', { step: 0.1 })), field('Pointer offset Y mm', n('pointerDY', { step: 0.1 }))),
      h('div', { class: 'hint' }, 'Only for machines with an extra red pointer next to the laser. Most SculpFun models use the blue laser.'),
      h('div', { class: 'btns' }, btn('Measure pointer offset…', () => { closeSheet(); pointerCalibration(); })),
    ),
    section('Frame & laser dot',
      h('div', { class: 'grid3' }, field('Frame power (S)', n('framePower', { min: 0, max: 100 })), field('Frame speed', n('frameFeed', { min: 100, max: 10000, step: 100 })), field('Dot power (S)', n('pointerPower', { min: 0, max: 100 }))),
      h('div', { class: 'hint' }, 'S values are 0…' + c.sMax + ' (not %). 3–10 gives a visible dot that does not burn.'),
    ),
    section('Connection',
      h('div', { class: 'grid3' }, field('File name on engraver', h('input', { type: 'text', value: c.fileName, onchange: (e) => { c.fileName = e.target.value.replace(/[^\w.-]/g, '') || 'studio.nc'; saveCfg(); } })), field('BLE packet bytes', n('bleChunk', { min: 20, max: 500 })), field('Stream buffer', n('rxBuffer', { min: 32, max: 1024 }))),
    ),
    h('div', { class: 'btns' }, btn('Close', closeSheet, 'primary')),
  );
}
function presetsSheet() {
  const list = allPresets().filter(p => p.user);
  openSheet('My material presets',
    list.length ? h('ul', { class: 'layers' }, ...list.map(p => h('li', {}, h('span', { class: 'nm' }, `${p.name} — ${p.op} ${p.power}% · ${p.speed} · ×${p.passes}`), h('button', { onclick: () => { deletePreset(p.name); presetsSheet(); } }, '🗑')))) : h('p', { class: 'hint' }, 'No presets yet. Use "Save" next to a material preset list.'),
    h('div', { class: 'btns' }, btn('Close', closeSheet, 'primary')),
  );
}
function help() {
  openSheet('How it works',
    h('ol', { class: 'hint', style: { paddingLeft: '18px', fontSize: '14px' } },
      h('li', {}, 'Add text, an image or a shape. Or tap "Lines" / "Draw" to draw cut lines.'),
      h('li', {}, 'Select it and choose Engrave or Cut in the Object tab. Turn on "Cut around" to cut it out as a heart, circle…'),
      h('li', {}, 'Machine tab → Connect → pick your SculpFun. Tap ✥ Move to put the laser (or red pointer) where the design should start.'),
      h('li', {}, 'Tap 🎯 Show where to see the outline on the material.'),
      h('li', {}, 'Run tab → Start.'),
    ),
    h('p', { class: 'hint' }, 'Tip: install this app from Chrome\'s menu → "Add to Home screen". It updates itself automatically.'),
    h('div', { class: 'btns' }, btn('Close', closeSheet, 'primary')),
  );
}
async function saveProject() {
  const imgs = {};
  for (const o of app.objects) if (o.type === 'image' && app.blobs[o.id]) imgs[o.id] = await blobToDataURL(app.blobs[o.id]);
  download('project.sfs.json', JSON.stringify({ app: 'loki-laser', v: 1, objects: JSON.parse(serialize()), images: imgs }), 'application/json');
}
const blobToDataURL = (b) => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
async function openProject(file) {
  try {
    const d = JSON.parse(await file.text());
    for (const [id, url] of Object.entries(d.images || {})) {
      const blob = await (await fetch(url)).blob();
      app.blobs[id] = blob; app.bitmaps[id] = await createImageBitmap(blob); idbSet('images', id, blob).catch(() => { });
    }
    restore(JSON.stringify(d.objects || [])); app.selectedId = null; app.commit(); app.changed(true); editor.fitContent();
    toast('Project opened');
  } catch (e) { toast('Could not open project: ' + e.message, true); }
}

function shapePicker() {
  const icon = (k) => {
    const cmds = SHAPES[k].gen(36, 36, k === 'rounded' ? { radius: 7 } : {});
    let d = '';
    for (const c of cmds) {
      if (c.t === 'M' || c.t === 'L') d += `${c.t}${c.x + 22} ${c.y + 22}`;
      else if (c.t === 'C') d += `C${c.x1 + 22} ${c.y1 + 22} ${c.x2 + 22} ${c.y2 + 22} ${c.x + 22} ${c.y + 22}`;
      else if (c.t === 'Z') d += 'Z';
    }
    return h('span', { html: `<svg viewBox="0 0 44 44"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>` });
  };
  openSheet('Add a shape', h('div', { class: 'shapegrid' },
    ...Object.entries(SHAPES).map(([k, v]) => h('button', { onclick: () => { closeSheet(); addShape(k); } }, icon(k), v.label)),
    h('button', { onclick: () => { closeSheet(); setTool('line'); } }, h('span', { html: '<svg viewBox="0 0 44 44"><path d="M6 36 L18 10 L30 30 L40 8" fill="none" stroke="currentColor" stroke-width="2.5"/></svg>' }), 'Lines (tap points)'),
    h('button', { onclick: () => { closeSheet(); setTool('draw'); } }, h('span', { html: '<svg viewBox="0 0 44 44"><path d="M6 30 C12 6 20 40 28 18 S38 14 40 30" fill="none" stroke="currentColor" stroke-width="2.5"/></svg>' }), 'Freehand'),
  ), h('p', { class: 'hint' }, 'New shapes are set to Cut. Change it to Engrave in the Object tab.'));
}

// ---------------- status pill & machine events ----------------
const pill = $('#statusPill');
function updatePill() {
  const m = app.machine, s = m.status;
  let cls = 'off', txt = '● Not connected';
  if (m.connected) {
    cls = s.state === 'Alarm' ? 'alarm' : (s.state === 'Run' || s.state === 'Jog' || s.state === 'Hold' || app.run.active) ? 'run' : 'idle';
    txt = '● ' + (app.run.active ? (app.run.phase === 'upload' ? `Sending ${app.run.pct.toFixed(0)}%` : `${s.state === 'Hold' ? 'Paused' : 'Running'} ${app.run.pct.toFixed(0)}%`) : s.state);
  }
  pill.className = 'pill ' + cls; pill.textContent = txt;
}
pill.onclick = () => setTab('machine');
const m = app.machine;
let lastState = '';
m.on('status', (s) => {
  updatePill();
  const st = $('#mState'); if (st) st.textContent = s.state;
  const ps = $('#mPos'); if (ps) ps.textContent = `X ${s.wpos[0].toFixed(1)}  Y ${s.wpos[1].toFixed(1)}`;
  if (s.state !== lastState) { lastState = s.state; if (app.tab === 'run') updateRunUI(); }
  editor.render();
});
m.on('line', addLog);
m.on('connected', () => { renderPanel(); updatePill(); });
m.on('disconnected', () => { laserDot = false; if (app.run.active && app.run.phase === 'upload') app.run = { active: false, lastMsg: 'Disconnected during upload' }; renderPanel(); updatePill(); toast('Disconnected'); });
m.on('alarm', (l) => { addLog({ dir: 'err', text: l }); toast('Engraver alarm: ' + l + (app.cfg.autoUnlock ? ' (unlocked)' : ''), true); });
m.on('progress', (p) => {
  if (!app.run.active) return;
  app.run.phase = p.phase; app.run.pct = p.pct;
  updatePill(); if (app.tab === 'run') updateRunUI();
});
m.on('jobdone', (d) => {
  const was = app.run.active;
  app.run = { active: false, lastMsg: d && d.stopped ? 'Stopped' : 'Finished ✔' };
  if (was && !(d && d.stopped)) { toast('Job finished ✔'); try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) { } }
  updatePill(); if (app.tab === 'run') renderPanel();
});

// ---------------- wiring ----------------
document.querySelectorAll('.tabs [data-tab]').forEach(b => b.onclick = () => setTab(b.dataset.tab));
document.querySelectorAll('#tools [data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
document.querySelectorAll('#tools [data-add]').forEach(b => b.onclick = () => {
  setTool('select');
  const k = b.dataset.add;
  if (k === 'text') addText();
  else if (k === 'image') $('#fileImage').click();
  else shapePicker();
});
document.querySelectorAll('#tools [data-act]').forEach(b => b.onclick = () => (b.dataset.act === 'undo' ? undo() : b.dataset.act === 'all' ? app.selectAll() : redo()));
document.querySelectorAll('[data-zoom]').forEach(b => b.onclick = () => {
  const z = b.dataset.zoom;
  if (z === 'fit') { app.objects.length ? editor.fitContent() : editor.fit(); }
  else editor.zoomAt(editor.w / 2, editor.h / 2, z === 'in' ? 1.4 : 1 / 1.4);
});
$('#fileImage').onchange = (e) => { const f = e.target.files[0]; if (f) addImageFile(f); e.target.value = ''; };
$('#fileProject').onchange = (e) => { const f = e.target.files[0]; if (f) openProject(f); e.target.value = ''; };
$('#menuBtn').onclick = menu;
$('#btnShowWhere').onclick = showWhereSheet;
$('#btnMove').onclick = moveSheet;
$('#lineFinish').onclick = () => { app.finishLine(false); setTool('select'); };
$('#lineClose').onclick = () => { app.finishLine(true); setTool('select'); };
$('#lineUndo').onclick = () => { if (editor.draft && editor.draft.length) { editor.draft.pop(); app.lineDraftChanged(); editor.render(); } };
$('#previewClose').onclick = togglePreview;
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea,select')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && app.selected()) { e.preventDefault(); deleteSel(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if (e.key === 'Escape') { if (app.tool === 'line') app.finishLine(false); setTool('select'); }
});
// paste images
document.addEventListener('paste', (e) => { for (const it of e.clipboardData?.items || []) if (it.type.startsWith('image/')) addImageFile(it.getAsFile()); });

// ---------------- updates (service worker) ----------------
let swReg = null;
async function setupSW() {
  if (window.__BUNDLED || !('serviceWorker' in navigator)) return;
  try {
    swReg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    const onWaiting = (w) => {
      // apply automatically when idle, otherwise ask
      if (!app.machine.connected && !app.run.active) w.postMessage('skipWaiting');
      else { $('#updateBar').hidden = false; $('#updateNow').onclick = () => w.postMessage('skipWaiting'); }
    };
    if (swReg.waiting) onWaiting(swReg.waiting);
    swReg.addEventListener('updatefound', () => {
      const nw = swReg.installing;
      nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) onWaiting(nw); });
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) return; reloading = true; location.reload(); });
    setInterval(() => swReg.update().catch(() => { }), 15 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') swReg.update().catch(() => { }); });
  } catch (e) { console.warn('SW', e); }
}
async function checkUpdate(manual) {
  if (window.AndroidApp) { if (manual) { toast('Checking for updates…'); window.AndroidApp.checkUpdate(); } return; }
  if (window.__BUNDLED) { if (manual) toast('This is the single-file version ' + VERSION + '. The installed web app updates itself.'); return; }
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const v = await r.json();
    if (v.version && v.version !== VERSION) { toast('Updating to ' + v.version + '…'); await swReg?.update(); }
    else if (manual) toast('You have the latest version (' + VERSION + ')');
  } catch (e) { if (manual) toast('Could not check for updates (offline?)', true); }
}

// ---------------- Android app events ----------------
onBtEvent((ev) => { if (ev.type === 'perm' && window.__btPermRefresh) window.__btPermRefresh(); });
window.__appEvent = (ev) => {
  const bar = $('#updateBar');
  if (ev.type === 'updateReady') {
    if (!app.machine.connected && !app.run.active) { window.AndroidApp.reload(); return; }
    bar.firstChild.textContent = 'Update ' + ev.version + ' downloaded. ';
    $('#updateNow').textContent = 'Restart now'; $('#updateNow').onclick = () => window.AndroidApp.reload(); bar.hidden = false;
  } else if (ev.type === 'apkUpdate') {
    bar.firstChild.textContent = 'New app version ' + ev.version + '. ';
    $('#updateNow').textContent = 'Download'; $('#updateNow').onclick = () => { window.AndroidApp.installUpdate(); bar.hidden = true; }; bar.hidden = false;
  } else if (ev.type === 'upToDate') toast('You have the latest version');
  else if (ev.type === 'resume' && window.__btPermRefresh && !$('#sheet').hidden) window.__btPermRefresh();
  else if (ev.type === 'updateError') toast('Could not check for updates: ' + ev.message, true);
};
window.__back = () => {
  if (!$('#sheet').hidden) { closeSheet(); return true; }
  if (app.previewOn) { togglePreview(); return true; }
  if (app.tool !== 'select') { setTool('select'); return true; }
  if (app.selectedId || app.groupSel) { app.select(null); return true; }
  if (app.tab !== 'object') { setTab('object'); return true; }
  if (window.__exitNext) return false;
  const busy = app.run.active ? ' The job keeps running on the engraver.' : app.machine.connected ? ' The engraver will be disconnected.' : '';
  ask('Close Loki Laser?' + busy, 'Close app', true).then(async (yes) => {
    if (!yes) return;
    try { if (app.machine.connected && !app.run.active) await app.machine.detach(); } catch (e) { }
    if (window.AndroidApp && window.AndroidApp.exit) window.AndroidApp.exit();
    else { window.__exitNext = true; toast('Press back again to close'); setTimeout(() => { window.__exitNext = false; }, 3000); }
  });
  return true;
};

// ---------------- boot ----------------
(async function boot() {
  await loadUserFonts();
  getFont('roboto-bold').catch(() => { });
  try {
    const saved = await idbGet('kv', 'project');
    if (saved) {
      restore(saved);
      for (const o of app.objects) if (o.type === 'image') {
        try { const b = await idbGet('images', o.id); if (b) { app.blobs[o.id] = b; app.bitmaps[o.id] = await createImageBitmap(b); } } catch (e) { }
      }
      // preload fonts used
      await Promise.all([...new Set(app.objects.filter(o => o.type === 'text').map(o => o.text.font))].map(f => getFont(f).catch(() => { })));
      app.objects.forEach(o => invalidate(o));
    }
  } catch (e) { console.warn(e); }
  app.history = [serialize()];
  renderPanel(); updatePill(); editor.render();
  if (app.objects.length) setTimeout(() => editor.fitContent(), 50);
  setupSW();
  setTimeout(() => checkUpdate(false), 4000);
})();
