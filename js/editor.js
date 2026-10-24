// Canvas editor: view transform, drawing, touch/mouse interaction
import { worldPolylines, cutAroundWorld, objCorners, objMatrix, hitTest, imagePreview, objWorldBBox } from './scene.js';
import { simplify, polylinesBBox } from './geometry.js';

export class Editor {
  constructor(canvas, app) {
    this.cv = canvas; this.app = app;
    this.ctx = canvas.getContext('2d');
    this.view = { s: 2, ox: 20, oy: 20 };
    this.pointers = new Map();
    this.drag = null;
    this.draft = null; // line tool points
    this.stroke = null; // freehand
    this.dpr = window.devicePixelRatio || 1;
    this._raf = 0;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', e => this.up(e, true));
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    canvas.addEventListener('dblclick', e => { if (this.app.tool === 'line') this.app.finishLine(false); });
    this.resize();
  }
  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(r.width * this.dpr));
    this.cv.height = Math.max(1, Math.round(r.height * this.dpr));
    this.cv.style.width = r.width + 'px'; this.cv.style.height = r.height + 'px';
    this.w = r.width; this.h = r.height;
    if (!this._fitted && r.width > 10) { this._fitted = true; this.fit(); this._fitW = r.width; }
    else if (this._fitW && Math.abs(r.width - this._fitW) / this._fitW > 0.3) { this._fitW = r.width; this.fit(); }
    this.render();
  }
  fit(bb) {
    const c = this.app.cfg;
    bb = bb || { x0: 0, y0: 0, x1: c.bedW, y1: c.bedH };
    const pad = 16;
    const s = Math.min((this.w - pad * 2) / (bb.x1 - bb.x0 || 1), (this.h - pad * 2) / (bb.y1 - bb.y0 || 1));
    this.view.s = Math.max(0.2, Math.min(60, s));
    this.view.ox = (this.w - (bb.x1 - bb.x0) * this.view.s) / 2 - bb.x0 * this.view.s;
    this.view.oy = (this.h - (bb.y1 - bb.y0) * this.view.s) / 2 - bb.y0 * this.view.s;
    this.render();
  }
  fitContent() {
    const objs = this.app.objects.filter(o => o.visible !== false);
    if (!objs.length) return this.fit();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of objs) { const b = objWorldBBox(o); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
    const m = Math.max(5, (x1 - x0) * 0.15);
    this.fit({ x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m });
  }
  zoomAt(px, py, k) {
    const v = this.view; const ns = Math.max(0.2, Math.min(80, v.s * k)); k = ns / v.s;
    v.ox = px - (px - v.ox) * k; v.oy = py - (py - v.oy) * k; v.s = ns; this.render();
  }
  toWorld(px, py) { return [(px - this.view.ox) / this.view.s, (py - this.view.oy) / this.view.s]; }
  toScreen(x, y) { return [x * this.view.s + this.view.ox, y * this.view.s + this.view.oy]; }
  render() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); }

  // ---------------- drawing ----------------
  draw() {
    const { ctx, dpr, view: v, app } = this;
    const cs = getComputedStyle(document.documentElement);
    const col = (n) => cs.getPropertyValue(n).trim();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = col('--stage'); ctx.fillRect(0, 0, this.w, this.h);
    // bed
    const c = app.cfg;
    ctx.save();
    ctx.translate(v.ox, v.oy); ctx.scale(v.s, v.s);
    ctx.fillStyle = col('--bed'); ctx.fillRect(0, 0, c.bedW, c.bedH);
    const minor = v.s > 4 ? 5 : 10, major = 50;
    ctx.lineWidth = 1 / v.s;
    for (let x = 0; x <= c.bedW; x += minor) { ctx.strokeStyle = x % major === 0 ? col('--grid-major') : col('--grid'); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.bedH); ctx.stroke(); }
    for (let y = 0; y <= c.bedH; y += minor) { ctx.strokeStyle = (c.bedH - y) % major === 0 ? col('--grid-major') : col('--grid'); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.bedW, y); ctx.stroke(); }
    ctx.restore();
    // ruler labels
    ctx.fillStyle = col('--muted'); ctx.font = '10px system-ui';
    for (let x = 0; x <= c.bedW; x += 50) { const [sx, sy] = this.toScreen(x, c.bedH); if (sx > -20 && sx < this.w) ctx.fillText(String(x), sx + 2, Math.min(this.h - 3, sy + 11)); }

    const job = app.previewOn ? app.job : null;
    // objects
    for (const o of app.objects) {
      if (o.visible === false) continue;
      this.drawObject(o, !!job);
    }
    if (job) this.drawPreview(job);
    // origin marker
    this.drawOrigin();
    // machine head
    if (app.machine.connected) this.drawHead();
    // selection
    const sel = app.selected();
    if (app.groupSel && !job) this.drawGroup();
    else if (sel && !job) this.drawSelection(sel);
    // drafts
    if (this.draft && this.draft.length) {
      ctx.save(); ctx.strokeStyle = col('--cut'); ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); this.draft.forEach((p, i) => { const [x, y] = this.toScreen(...p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      if (this.hover) { const [x, y] = this.toScreen(...this.hover); ctx.lineTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col('--cut');
      for (const p of this.draft) { const [x, y] = this.toScreen(...p); ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
      ctx.restore();
    }
    if (this.stroke && this.stroke.length > 1) {
      ctx.save(); ctx.strokeStyle = col('--cut'); ctx.lineWidth = 2; ctx.beginPath();
      this.stroke.forEach((p, i) => { const [x, y] = this.toScreen(...p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.restore();
    }
  }

  strokePolylines(pls, color, width, dash) {
    const { ctx } = this;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    for (const pl of pls) {
      pl.pts.forEach((p, i) => { const [x, y] = this.toScreen(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      if (pl.closed) ctx.closePath();
    }
    ctx.stroke(); ctx.restore();
  }

  drawObject(o, dim) {
    const { ctx, app } = this;
    const cs = getComputedStyle(document.documentElement);
    const col = (n) => cs.getPropertyValue(n).trim();
    ctx.save();
    if (dim) ctx.globalAlpha = 0.25;
    if (o.type === 'image') {
      const bmp = app.bitmaps[o.id];
      if (bmp) {
        const ppmm = Math.min(o.ops.fill.interval || 10, 1400 / Math.max(o.w, o.h));
        let pv = null;
        try { pv = imagePreview(o, bmp, ppmm); } catch (e) { console.warn(e); }
        const m = objMatrix(o), v = this.view, d = this.dpr;
        ctx.setTransform(d * v.s, 0, 0, d * v.s, d * v.ox, d * v.oy);
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        ctx.imageSmoothingEnabled = v.s * (o.w / (pv ? pv.canvas.width : 1)) < 2;
        if (pv) ctx.drawImage(pv.canvas, -o.w / 2, -o.h / 2, o.w, o.h);
        ctx.setTransform(d, 0, 0, d, 0, 0);
      }
    } else {
      const pls = worldPolylines(o, Math.max(0.02, 0.4 / this.view.s));
      if (o.op === 'fill') {
        ctx.fillStyle = col('--engrave');
        ctx.beginPath();
        for (const pl of pls) { pl.pts.forEach((p, i) => { const [x, y] = this.toScreen(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); if (pl.closed) ctx.closePath(); }
        ctx.fill('nonzero');
        if (pls.some(p => !p.closed)) this.strokePolylines(pls.filter(p => !p.closed), col('--engrave'), Math.max(1.5, 0.3 * this.view.s));
      } else {
        this.strokePolylines(pls, o.op === 'cut' ? col('--cut') : col('--line'), o.op === 'cut' ? 2 : 1.5);
      }
    }
    const ca = cutAroundWorld(o);
    if (ca) this.strokePolylines(ca, col('--cut'), 2, [7, 4]);
    ctx.restore();
  }

  drawPreview(job) {
    const { ctx, dpr, view: v } = this;
    const cs = getComputedStyle(document.documentElement);
    const col = (n) => cs.getPropertyValue(n).trim();
    ctx.save();
    ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.ox, dpr * v.oy);
    ctx.imageSmoothingEnabled = false;
    for (const r of job.preview.rasters) ctx.drawImage(r.canvas, r.bb.x0, r.bb.y0, r.bb.x1 - r.bb.x0, r.bb.y1 - r.bb.y0);
    ctx.restore();
    // travel moves (gcode coords -> world)
    const [ox, oy] = job.origin;
    ctx.save(); ctx.strokeStyle = col('--travel'); ctx.lineWidth = 0.7; ctx.setLineDash([3, 3]); ctx.beginPath();
    const tr = job.preview.travel;
    const step = Math.max(1, Math.floor(tr.length / 4000));
    for (let i = 0; i < tr.length; i += step) {
      const t = tr[i];
      const [a, b] = this.toScreen(t[0] + ox, oy - t[1]); const [c, d] = this.toScreen(t[2] + ox, oy - t[3]);
      if (Math.hypot(c - a, d - b) < 3) continue;
      ctx.moveTo(a, b); ctx.lineTo(c, d);
    }
    ctx.stroke(); ctx.restore();
    for (const vct of job.preview.vectors) this.strokePolylines([{ pts: vct.pts, closed: false }], vct.kind === 'line' ? col('--line') : col('--cut'), 2);
  }

  drawOrigin() {
    const { ctx, app } = this;
    const o = app.originWorld();
    if (!o) return;
    const [x, y] = this.toScreen(o[0], o[1]);
    const cs = getComputedStyle(document.documentElement);
    ctx.save();
    ctx.strokeStyle = cs.getPropertyValue('--accent').trim(); ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 13, y); ctx.lineTo(x + 13, y); ctx.moveTo(x, y - 13); ctx.lineTo(x, y + 13); ctx.stroke();
    ctx.font = '600 11px system-ui'; ctx.fillText(app.cfg.absolute ? 'Machine 0,0' : 'Laser start', x + 10, y - 9);
    ctx.restore();
  }
  drawHead() {
    const { ctx, app } = this;
    const p = app.headWorld();
    if (!p) return;
    const [x, y] = this.toScreen(p[0], p[1]);
    ctx.save(); ctx.fillStyle = 'rgba(255,60,60,.85)'; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(255,60,60,.5)'; ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.stroke(); ctx.restore();
  }

  handles(o) {
    const cs = objCorners(o).map(p => this.toScreen(p[0], p[1]));
    const top = [(cs[0][0] + cs[1][0]) / 2, (cs[0][1] + cs[1][1]) / 2];
    const ang = (o.rot || 0) * Math.PI / 180;
    const rot = [top[0] + Math.sin(ang) * 30, top[1] - Math.cos(ang) * 30];
    return { corners: cs, rot, top };
  }
  groupObjects() { return this.app.objects.filter(o => o.visible !== false && !o.locked); }
  groupBox() {
    const objs = this.groupObjects();
    if (!objs.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of objs) { const b = objWorldBBox(o); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
    return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
  groupHandles() {
    const b = this.groupBox(); if (!b) return null;
    const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(p => this.toScreen(p[0], p[1]));
    const top = [(corners[0][0] + corners[1][0]) / 2, corners[0][1]];
    return { b, corners, top, rot: [top[0], top[1] - 30] };
  }
  drawGroup() {
    const { ctx } = this;
    const h = this.groupHandles(); if (!h) return;
    const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    ctx.save(); ctx.strokeStyle = acc; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
    ctx.beginPath(); h.corners.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(...h.top); ctx.lineTo(...h.rot); ctx.stroke();
    ctx.fillStyle = acc;
    for (const p of h.corners) { ctx.beginPath(); ctx.rect(p[0] - 8, p[1] - 8, 16, 16); ctx.fill(); }
    ctx.beginPath(); ctx.arc(h.rot[0], h.rot[1], 10, 0, 7); ctx.fill();
    ctx.fillStyle = '#1a1200'; ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('⟳', h.rot[0], h.rot[1] + 1);
    const txt = `All: ${(h.b.x1 - h.b.x0).toFixed(1)} × ${(h.b.y1 - h.b.y0).toFixed(1)} mm`;
    ctx.textAlign = 'left'; ctx.font = '600 12px system-ui';
    const tw = ctx.measureText(txt).width, bx = h.corners[2][0] - tw - 8, by = h.corners[2][1] + 12;
    ctx.fillStyle = acc; ctx.fillRect(bx, by, tw + 10, 20); ctx.fillStyle = '#1a1200'; ctx.fillText(txt, bx + 5, by + 10);
    ctx.restore();
  }
  snapshotGroup() { return this.groupObjects().map(o => ({ o, x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot || 0 })); }

  drawSelection(o) {
    const { ctx } = this;
    const cs = getComputedStyle(document.documentElement);
    const acc = cs.getPropertyValue('--accent').trim();
    const h = this.handles(o);
    ctx.save(); ctx.strokeStyle = acc; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.beginPath(); h.corners.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(...h.top); ctx.lineTo(...h.rot); ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const p of h.corners) { ctx.beginPath(); ctx.rect(p[0] - 7, p[1] - 7, 14, 14); ctx.fill(); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(h.rot[0], h.rot[1], 9, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = acc; ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('⟳', h.rot[0], h.rot[1] + 1);
    // size label
    const b = h.corners.reduce((a, p) => ({ x: Math.max(a.x, p[0]), y: Math.max(a.y, p[1]) }), { x: -1e9, y: -1e9 });
    ctx.textAlign = 'left'; ctx.font = '600 11px system-ui';
    const txt = `${o.w.toFixed(1)} × ${o.h.toFixed(1)} mm`;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; const tw = ctx.measureText(txt).width;
    ctx.fillRect(b.x - tw - 8, b.y + 10, tw + 8, 18); ctx.fillStyle = '#fff'; ctx.fillText(txt, b.x - tw - 4, b.y + 19);
    ctx.restore();
  }

  // ---------------- interaction ----------------
  pos(e) { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  down(e) {
    this.cv.setPointerCapture(e.pointerId);
    const p = this.pos(e);
    this.pointers.set(e.pointerId, p);
    const app = this.app;
    if (this.pointers.size === 2) {
      // pinch start
      if (this.stroke) this.stroke = null;
      if (this.drag && this.drag.kind !== 'pan') app.commit();
      const [a, b] = [...this.pointers.values()];
      this.drag = { kind: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      return;
    }
    if (this.pointers.size > 2) return;
    const w = this.toWorld(...p);
    this.downAt = { p, t: Date.now() };
    if (app.tool === 'draw') { this.stroke = [w]; this.drag = { kind: 'draw' }; return; }
    if (app.tool === 'line') { this.drag = { kind: 'pan', start: p, view: { ...this.view }, tapLine: true }; return; }
    if (app.groupSel && !app.previewOn) {
      const gh = this.groupHandles();
      if (gh) {
        const c = [gh.b.cx, gh.b.cy];
        if (Math.hypot(p[0] - gh.rot[0], p[1] - gh.rot[1]) < 26) { this.drag = { kind: 'grotate', c, a0: Math.atan2(w[0] - c[0], -(w[1] - c[1])), snap: this.snapshotGroup() }; return; }
        for (const cc of gh.corners) if (Math.hypot(p[0] - cc[0], p[1] - cc[1]) < 26) { this.drag = { kind: 'gscale', c, d0: Math.hypot(w[0] - c[0], w[1] - c[1]) || 1, snap: this.snapshotGroup() }; return; }
        if (w[0] >= gh.b.x0 && w[0] <= gh.b.x1 && w[1] >= gh.b.y0 && w[1] <= gh.b.y1) { this.drag = { kind: 'gmove', start: w, snap: this.snapshotGroup() }; return; }
      }
      this.drag = { kind: 'pan', start: p, view: { ...this.view }, tapEmpty: true };
      return;
    }
    const sel = app.selected();
    if (sel && !sel.locked && !app.previewOn) {
      const h = this.handles(sel);
      if (Math.hypot(p[0] - h.rot[0], p[1] - h.rot[1]) < 24) { this.drag = { kind: 'rotate', o: sel, start: sel.rot }; return; }
      for (let i = 0; i < 4; i++) {
        const c = h.corners[i];
        if (Math.hypot(p[0] - c[0], p[1] - c[1]) < 24) {
          this.drag = { kind: 'scale', o: sel, w0: sel.w, h0: sel.h, d0: Math.hypot(w[0] - sel.x, w[1] - sel.y) }; return;
        }
      }
    }
    if (!app.previewOn) {
      for (let i = app.objects.length - 1; i >= 0; i--) {
        const o = app.objects[i];
        if (o.visible === false) continue;
        if (hitTest(o, w[0], w[1])) {
          if (app.selectedId !== o.id) app.select(o.id);
          if (!o.locked) this.drag = { kind: 'move', o, off: [w[0] - o.x, w[1] - o.y], moved: false };
          else this.drag = { kind: 'pan', start: p, view: { ...this.view } };
          return;
        }
      }
    }
    this.drag = { kind: 'pan', start: p, view: { ...this.view }, tapEmpty: true };
  }
  move(e) {
    const p = this.pos(e);
    if (!this.pointers.has(e.pointerId)) {
      if (this.app.tool === 'line' && this.draft) { this.hover = this.toWorld(...p); this.render(); }
      return;
    }
    this.pointers.set(e.pointerId, p);
    const d = this.drag; if (!d) return;
    const w = this.toWorld(...p);
    const app = this.app;
    if (d.kind === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const nd = Math.hypot(a[0] - b[0], a[1] - b[1]); const nc = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.view.ox += nc[0] - d.c[0]; this.view.oy += nc[1] - d.c[1];
      this.zoomAt(nc[0], nc[1], nd / (d.d || 1));
      d.d = nd; d.c = nc; return;
    }
    if (d.kind === 'pan') {
      if (Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) > 6) { d.tapEmpty = false; d.tapLine = false; }
      this.view.ox = d.view.ox + p[0] - d.start[0]; this.view.oy = d.view.oy + p[1] - d.start[1]; this.render();
      if (app.tool === 'line') this.hover = w;
      return;
    }
    if (d.kind === 'draw') { const l = this.stroke[this.stroke.length - 1]; if (Math.hypot(w[0] - l[0], w[1] - l[1]) * this.view.s > 2) { this.stroke.push(w); this.render(); } return; }
    if (d.kind === 'gmove') {
      const dx = w[0] - d.start[0], dy = w[1] - d.start[1];
      for (const q of d.snap) { q.o.x = q.x + dx; q.o.y = q.y + dy; }
      d.moved = true; app.changed(false); return;
    }
    if (d.kind === 'gscale') {
      const k = Math.max(0.02, Math.hypot(w[0] - d.c[0], w[1] - d.c[1]) / d.d0);
      for (const q of d.snap) { q.o.w = Math.max(0.3, q.w * k); q.o.h = Math.max(0.01, q.h * k); q.o.x = d.c[0] + (q.x - d.c[0]) * k; q.o.y = d.c[1] + (q.y - d.c[1]) * k; }
      d.moved = true; app.changed(false); return;
    }
    if (d.kind === 'grotate') {
      let a = Math.atan2(w[0] - d.c[0], -(w[1] - d.c[1])) - d.a0;
      let deg = a * 180 / Math.PI; const sn = Math.round(deg / 15) * 15; if (Math.abs(deg - sn) < 4) deg = sn;
      const r = deg * Math.PI / 180, cs = Math.cos(r), sn2 = Math.sin(r);
      for (const q of d.snap) {
        const dx = q.x - d.c[0], dy = q.y - d.c[1];
        q.o.x = d.c[0] + dx * cs - dy * sn2; q.o.y = d.c[1] + dx * sn2 + dy * cs;
        q.o.rot = Math.round((((q.rot + deg) % 360) + 360) % 360 * 10) / 10;
      }
      d.moved = true; app.changed(false); return;
    }
    if (d.kind === 'move') {
      d.o.x = w[0] - d.off[0]; d.o.y = w[1] - d.off[1];
      // snap to bed center lines
      const c = app.cfg, snap = 6 / this.view.s;
      if (Math.abs(d.o.x - c.bedW / 2) < snap) d.o.x = c.bedW / 2;
      if (Math.abs(d.o.y - c.bedH / 2) < snap) d.o.y = c.bedH / 2;
      d.moved = true; app.changed(false); return;
    }
    if (d.kind === 'rotate') {
      let a = Math.atan2(w[0] - d.o.x, -(w[1] - d.o.y)) * 180 / Math.PI;
      const s = Math.round(a / 15) * 15; if (Math.abs(a - s) < 4) a = s;
      d.o.rot = Math.round(((a % 360) + 360) % 360 * 10) / 10; d.moved = true; app.changed(false); return;
    }
    if (d.kind === 'scale') {
      const o = d.o;
      const ang = -(o.rot || 0) * Math.PI / 180;
      const dx = w[0] - o.x, dy = w[1] - o.y;
      const lx = dx * Math.cos(ang) - dy * Math.sin(ang), ly = dx * Math.sin(ang) + dy * Math.cos(ang);
      if (o.lockRatio) {
        const k = Math.max(0.01, Math.hypot(dx, dy) / (d.d0 || 1));
        o.w = Math.max(0.5, d.w0 * k); o.h = Math.max(0.5, d.h0 * k);
      } else { o.w = Math.max(0.5, Math.abs(lx) * 2); o.h = Math.max(0.5, Math.abs(ly) * 2); }
      if (o.type === 'path' && o.path && o.path.open && o.h < 0.6) o.h = 0.01;
      d.moved = true; app.changed(false); return;
    }
  }
  up(e, cancel) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (this.pointers.size > 0) { if (d && d.kind === 'pinch') this.drag = null; return; }
    this.drag = null;
    if (!d || cancel) { this.stroke = null; this.render(); return; }
    const app = this.app;
    if (d.kind === 'draw' && this.stroke) {
      const pts = simplify(this.stroke, 0.15);
      this.stroke = null;
      if (pts.length > 1) {
        const first = pts[0], last = pts[pts.length - 1];
        const closed = pts.length > 3 && Math.hypot(first[0] - last[0], first[1] - last[1]) * this.view.s < 18;
        app.addPath(closed ? pts.slice(0, -1) : pts, closed);
      }
      this.render(); return;
    }
    if (d.kind === 'pan' && d.tapLine && p) {
      const w = this.toWorld(...p);
      if (!this.draft) this.draft = [];
      // tap on first point closes the shape
      if (this.draft.length > 2) {
        const [fx, fy] = this.toScreen(...this.draft[0]);
        if (Math.hypot(fx - p[0], fy - p[1]) < 20) { app.finishLine(true); return; }
      }
      this.draft.push(w); app.lineDraftChanged(); this.render(); return;
    }
    if (d.kind === 'pan' && d.tapEmpty) { app.select(null); return; }
    if (['move', 'rotate', 'scale', 'gmove', 'gscale', 'grotate'].includes(d.kind) && d.moved) { app.commit(); if (app.groupSel) app.refreshPanel && app.refreshPanel(); }
    this.render();
  }
}
