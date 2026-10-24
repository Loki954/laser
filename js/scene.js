// Scene objects: images, text, shapes, paths. Geometry in mm, Y down.
import { SHAPES, ellipse, rect, polygon, star, heart, badge } from './shapes.js';
import {
  matMul, matTranslate, matRotate, matScale, transformCommands, flattenCommands, commandsBBox,
  polylinesBBox, pointInPolygon, simplifyClosed, chaikinClosed, traceMask, distanceTransform, fillHoles, applyMat,
  polylinesToPath2D,
} from './geometry.js';
import { getFontSync, getFont, textToCommands } from './text.js';
import { processImage } from './raster.js';

let NEXT = 1;
export const uid = () => 'o' + Date.now().toString(36) + (NEXT++);

export const DEFAULT_OPS = {
  fill: { power: 40, speed: 3000, passes: 1, interval: 10 },
  line: { power: 40, speed: 1500, passes: 1 },
  cut: { power: 100, speed: 300, passes: 3 },
};

export const IMAGE_DEFAULTS = {
  brightness: 0, contrast: 0, gamma: 1, invert: false, dither: 'floyd', threshold: 50,
  powerMin: 0, removeBg: true, sharpen: 0,
};

export function newObject(type, props = {}) {
  const o = {
    id: uid(), type, x: 100, y: 100, w: 40, h: 40, rot: 0, flipX: false, flipY: false, lockRatio: true, name: '',
    op: type === 'image' ? 'fill' : (type === 'path' ? 'cut' : 'fill'),
    ops: JSON.parse(JSON.stringify(DEFAULT_OPS)),
    cutAround: { enabled: false, shape: 'heart', margin: 3, power: 100, speed: 300, passes: 3 },
    visible: true, locked: false,
    ...props,
  };
  if (type === 'image') o.img = { ...IMAGE_DEFAULTS, ...(props.img || {}) };
  if (type === 'text') o.text = { value: 'Text', font: 'roboto-bold', letterSpacing: 0, lineHeight: 1.15, align: 'center', ...(props.text || {}) };
  if (type === 'shape') o.shape = { kind: 'rect', radius: 0, points: 5, inner: 0.45, sides: 6, ...(props.shape || {}) };
  return o;
}

// ---------- local geometry (centered at 0,0, sized w x h) ----------
const geoCache = new Map();
export function invalidate(o) { for (const k of [...geoCache.keys()]) if (k.startsWith(o.id + '|')) geoCache.delete(k); }

function naturalCommands(o) {
  if (o.type === 'text') {
    const font = getFontSync(o.text.font);
    if (!font) { getFont(o.text.font).then(() => { invalidate(o); o._needsRender && o._needsRender(); }); return null; }
    return textToCommands(font, o.text.value, o.text);
  }
  if (o.type === 'path') return o.path.cmds;
  return null;
}

export function localCommands(o) {
  const key = o.id + '|lc|' + o.w + '|' + o.h + '|' + JSON.stringify(o.shape || o.text || (o.path && o.path.ver) || '');
  if (geoCache.has(key)) return geoCache.get(key);
  let cmds = [];
  if (o.type === 'shape') {
    const S = SHAPES[o.shape.kind] || SHAPES.rect;
    cmds = S.gen(o.w, o.h, o.shape);
  } else if (o.type === 'text' || o.type === 'path') {
    const nat = naturalCommands(o);
    if (!nat) return [];
    const nb = o.type === 'path' && o.path.bbox ? o.path.bbox : commandsBBox(nat);
    if (o.type === 'path') o.path.bbox = nb;
    const nw = nb.x1 - nb.x0 || 1e-6, nh = nb.y1 - nb.y0 || 1e-6;
    o._natural = { w: nw, h: nh };
    o.nat = { w: nw, h: nh };
    const sx = nw > 1e-5 ? o.w / nw : 1, sy = nh > 1e-5 ? o.h / nh : 1;
    const m = matMul(matScale(sx, sy), matTranslate(-(nb.x0 + nb.x1) / 2, -(nb.y0 + nb.y1) / 2));
    cmds = transformCommands(nat, m);
  }
  geoCache.set(key, cmds);
  return cmds;
}

export function objMatrix(o) {
  return matMul(matMul(matTranslate(o.x, o.y), matRotate(o.rot || 0)), matScale(o.flipX ? -1 : 1, o.flipY ? -1 : 1));
}

export function worldPolylines(o, tol = 0.03) {
  const cmds = localCommands(o);
  if (!cmds.length) return [];
  return flattenCommands(transformCommands(cmds, objMatrix(o)), tol);
}

export function localPolylines(o, tol = 0.03) {
  return flattenCommands(localCommands(o), tol);
}

export function objCorners(o) {
  const m = objMatrix(o), w = o.w / 2, h = o.h / 2;
  return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => applyMat(m, x, y));
}

export function objWorldBBox(o) {
  const pts = objCorners(o);
  const ca = cutAroundLocal(o);
  if (ca) { const m = objMatrix(o); for (const pl of ca) for (const p of pl.pts) pts.push(applyMat(m, p[0], p[1])); }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

export function hitTest(o, x, y) {
  const m = objMatrix(o);
  // inverse transform the point
  const c = Math.cos(-(o.rot || 0) * Math.PI / 180), s = Math.sin(-(o.rot || 0) * Math.PI / 180);
  let dx = x - o.x, dy = y - o.y;
  let lx = dx * c - dy * s, ly = dx * s + dy * c;
  if (o.flipX) lx = -lx; if (o.flipY) ly = -ly;
  const pad = 2;
  if (Math.abs(lx) <= o.w / 2 + pad && Math.abs(ly) <= o.h / 2 + pad) return true;
  return false;
}

// ---------- cut-around ----------
function shapeGenFor(kind) {
  switch (kind) {
    case 'heart': return { gen: (W, H) => heart(W, H), aspect: 1.1 };
    case 'circle': return { gen: (W, H) => ellipse(W, H), aspect: 1 };
    case 'star': return { gen: (W, H) => star(W, H, 5, 0.5), aspect: 1.05 };
    case 'polygon': return { gen: (W, H) => polygon(W, H, 6), aspect: 1.1547 };
    case 'badge': return { gen: (W, H) => badge(W, H), aspect: 0.85 };
    default: return null;
  }
}

// Find the smallest shape (fixed aspect) that contains a rw x rh rectangle centred at (0, dy)
function fitAround(kind, rw, rh) {
  const g = shapeGenFor(kind);
  const testPoly = (s, dy) => {
    const W = s * g.aspect, H = s;
    const pl = flattenCommands(g.gen(W, H), 0.05)[0].pts;
    // sample rect boundary
    const N = 12;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const pts = [[-rw / 2 + t * rw, dy - rh / 2], [-rw / 2 + t * rw, dy + rh / 2], [-rw / 2, dy - rh / 2 + t * rh], [rw / 2, dy - rh / 2 + t * rh]];
      for (const [x, y] of pts) if (!pointInPolygon(x, y, pl)) return false;
    }
    return true;
  };
  let best = null;
  const base = Math.max(rw / g.aspect, rh);
  for (let k = -12; k <= 12; k++) {
    let lo = base * 0.5, hi = base * 6;
    const dyFrac = k / 40;
    if (!testPoly(hi, dyFrac * hi)) continue;
    for (let it = 0; it < 22; it++) { const mid = (lo + hi) / 2; if (testPoly(mid, dyFrac * mid)) hi = mid; else lo = mid; }
    if (!best || hi < best.s) best = { s: hi, dy: dyFrac * hi };
  }
  if (!best) best = { s: base * 2, dy: 0 };
  const W = best.s * g.aspect, H = best.s;
  return transformCommands(g.gen(W, H), matTranslate(0, -best.dy));
}

export function cutAroundLocal(o) {
  const ca = o.cutAround;
  if (!ca || !ca.enabled) return null;
  const key = o.id + '|ca|' + o.w + '|' + o.h + '|' + JSON.stringify(ca) + '|' + JSON.stringify(o.shape || o.text || o.img || (o.path && o.path.ver) || '') + (o._imgVer || '');
  if (geoCache.has(key)) return geoCache.get(key);
  const m = Math.max(0, +ca.margin || 0);
  let cmds;
  const rw = o.w + 2 * m, rh = o.h + 2 * m;
  switch (ca.shape) {
    case 'rect': cmds = rect(rw, rh, 0); break;
    case 'rounded': cmds = rect(rw, rh, Math.min(rw, rh) * 0.18); break;
    case 'ellipse': cmds = ellipse(rw * Math.SQRT2, rh * Math.SQRT2); break;
    case 'contour': {
      const r = contourLocal(o, m);
      geoCache.set(key, r); return r;
    }
    default: {
      // shapes fit around the object's own box (without margin), margin added by inflating box
      cmds = fitAround(ca.shape, rw, rh);
    }
  }
  const r = flattenCommands(cmds, 0.03);
  geoCache.set(key, r);
  return r;
}

export function cutAroundWorld(o) {
  const l = cutAroundLocal(o);
  if (!l) return null;
  const m = objMatrix(o);
  return l.map(pl => ({ closed: pl.closed, pts: pl.pts.map(p => applyMat(m, p[0], p[1])) }));
}

// Contour that follows the object's silhouette, offset by margin (mm)
function contourLocal(o, margin) {
  const ppmm = Math.max(2, Math.min(10, 1600 / Math.max(o.w + 2 * margin, o.h + 2 * margin)));
  const pad = margin + 1;
  const W = Math.ceil((o.w + 2 * pad) * ppmm), H = Math.ceil((o.h + 2 * pad) * ppmm);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.setTransform(ppmm, 0, 0, ppmm, W / 2, H / 2);
  let mask;
  if (o.type === 'image') {
    const p = o._preview;
    if (!p) return [];
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(p.canvas, -o.w / 2, -o.h / 2, o.w, o.h);
  } else {
    const pls = localPolylines(o, 0.05);
    const path = polylinesToPath2D(pls);
    ctx.fillStyle = '#000'; ctx.strokeStyle = '#000'; ctx.lineWidth = 0.6; ctx.lineJoin = 'round';
    if (pls.some(p => p.closed)) ctx.fill(path, 'nonzero');
    ctx.stroke(path);
  }
  const d = ctx.getImageData(0, 0, W, H).data;
  mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = d[i * 4] < 160 ? 1 : 0;
  // dilate by margin
  const dist = distanceTransform(mask, W, H);
  const r = margin * ppmm;
  const dil = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) dil[i] = dist[i] <= r + 0.5 ? 1 : 0;
  const solid = fillHoles(dil, W, H);
  const loops = traceMask(solid, W, H);
  const out = [];
  for (const lp of loops) {
    if (lp.length < 8) continue;
    let pts = lp.map(([x, y]) => [(x - W / 2) / ppmm, (y - H / 2) / ppmm]);
    pts = simplifyClosed(pts, 0.6 / ppmm);
    pts = chaikinClosed(pts, 2);
    pts = simplifyClosed(pts, 0.03);
    // drop tiny islands (< 1mm)
    const bb = polylinesBBox([{ pts }]);
    if (bb.x1 - bb.x0 < 1 && bb.y1 - bb.y0 < 1) continue;
    out.push({ pts, closed: true });
  }
  return out;
}

// ---------- image previews (processed bitmap at display resolution) ----------
export function imagePreview(o, bitmap, ppmm) {
  const key = JSON.stringify(o.img) + '|' + o.w + '|' + o.h + '|' + (o.ops.fill.interval) + '|' + ppmm;
  if (o._preview && o._preview.key === key) return o._preview;
  const W = Math.max(1, Math.round(o.w * ppmm)), H = Math.max(1, Math.round(o.h * ppmm));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, W, H);
  const id = ctx.getImageData(0, 0, W, H);
  const power = processImage(id, W, H, o.img);
  const out = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = 255 - Math.round(power[i] * 255);
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = power[i] > 0 ? 255 : 0;
  }
  ctx.clearRect(0, 0, W, H);
  ctx.putImageData(out, 0, 0);
  o._preview = { key, canvas: cv };
  o._imgVer = (o._imgVer || 0) + 1;
  return o._preview;
}
