// Job builder: scene objects -> G-code for SculpFun (Grbl_ESP32, laser mode, S range 0..Smax)
import { objMatrix, localCommands, worldPolylines, cutAroundWorld, objCorners } from './scene.js';
import { flattenCommands, polygonArea, polylinesBBox, polylinesToPath2D } from './geometry.js';
import { processImage } from './raster.js';

const MAX_PIXELS = 12_000_000;

export function jobOrigin(bbox, cfg) {
  if (cfg.absolute) return [0, cfg.bedH];
  switch (cfg.anchor) {
    case 'center': return [(bbox.x0 + bbox.x1) / 2, (bbox.y0 + bbox.y1) / 2];
    case 'tl': return [bbox.x0, bbox.y0];
    case 'tr': return [bbox.x1, bbox.y0];
    case 'br': return [bbox.x1, bbox.y1];
    default: return [bbox.x0, bbox.y1]; // bottom-left
  }
}

function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// Render one object into a world-aligned burn map
export function rasterizeObject(o, bitmap, ppmm) {
  const cs = objCorners(o);
  const bb = { x0: Math.min(...cs.map(c => c[0])), y0: Math.min(...cs.map(c => c[1])), x1: Math.max(...cs.map(c => c[0])), y1: Math.max(...cs.map(c => c[1])) };
  let W = Math.ceil((bb.x1 - bb.x0) * ppmm), H = Math.ceil((bb.y1 - bb.y0) * ppmm);
  if (W * H > MAX_PIXELS) throw new Error(`"${o.name || o.type}" is too large for ${ppmm} lines/mm. Lower the line interval or make it smaller.`);
  W = Math.max(1, W); H = Math.max(1, H);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(ppmm, 0, 0, ppmm, -bb.x0 * ppmm, -bb.y0 * ppmm);
  const m = objMatrix(o);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  let burn;
  if (o.type === 'image') {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, -o.w / 2, -o.h / 2, o.w, o.h);
    burn = processImage(ctx.getImageData(0, 0, W, H), W, H, o.img);
  } else {
    const path = polylinesToPath2D(flattenCommands(localCommands(o), 0.02));
    ctx.fillStyle = '#000';
    ctx.fill(path, 'nonzero');
    const d = ctx.getImageData(0, 0, W, H).data;
    burn = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) burn[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  }
  return { bb: { x0: bb.x0, y0: bb.y0, x1: bb.x0 + W / ppmm, y1: bb.y0 + H / ppmm }, W, H, burn, ppmm };
}

export function buildJob(objects, bitmaps, cfg) {
  const Smax = cfg.sMax || 1000;
  const f = (v) => (Math.round(v * 100) / 100).toString();
  const visible = objects.filter(o => o.visible !== false);
  const out = [];
  let time = 0, pos = [0, 0], feedNow = 0;
  const rapid = cfg.rapid || 6000;
  const prev = { rasters: [], vectors: [], travel: [] };
  const allPts = [];

  // ---------- collect work ----------
  const rasters = [], lines = [], cuts = [];
  for (const o of visible) {
    if (o.op === 'fill' || o.type === 'image') {
      rasters.push(o);
    } else {
      const pls = worldPolylines(o, 0.02);
      const ops = o.ops[o.op];
      if (pls.length) (o.op === 'cut' ? cuts : lines).push({ o, pls, ops });
    }
    const ca = cutAroundWorld(o);
    if (ca && ca.length) cuts.push({ o, pls: ca, ops: o.cutAround, around: true });
  }
  if (!rasters.length && !lines.length && !cuts.length) throw new Error('Nothing to engrave or cut.');

  // rasterize first (need bbox for origin)
  const rmaps = [];
  for (const o of rasters) {
    const ppmm = Math.max(1, Math.min(20, +o.ops.fill.interval || 10));
    const r = rasterizeObject(o, bitmaps[o.id], ppmm);
    rmaps.push({ o, r });
  }
  // job bbox (world)
  const bbs = [];
  for (const { r } of rmaps) bbs.push({ pts: [[r.bb.x0, r.bb.y0], [r.bb.x1, r.bb.y1]] });
  for (const g of [...lines, ...cuts]) bbs.push(...g.pls);
  const wb = polylinesBBox(bbs);
  const [ox, oy] = jobOrigin(wb, cfg);
  const T = (x, y) => [x - ox, oy - y];

  out.push('; Loki Laser job');
  const gb0 = T(wb.x0, wb.y1), gb1 = T(wb.x1, wb.y0);
  out.push(`; MKS Bounds: X${f(gb0[0])} Y${f(gb0[1])} to X${f(gb1[0])} Y${f(gb1[1])}`);
  out.push('G90', 'G21', 'G0 X0 Y0 S0', 'M4 S0');
  if (cfg.air) out.push('M8');

  const moveTime = (x, y, feed) => { const d = Math.hypot(x - pos[0], y - pos[1]); time += d / feed * 60; pos = [x, y]; };
  let mode = 'G0';
  const G0 = (x, y) => {
    out.push(`G0X${f(x)}Y${f(y)}`); mode = 'G0';
    prev.travel.push([pos[0], pos[1], x, y]);
    moveTime(x, y, rapid);
  };

  // ---------- raster layers ----------
  for (const { o, r } of rmaps) {
    const ops = o.ops.fill;
    const pmax = Math.max(0, Math.min(100, ops.power)) / 100;
    const pmin = o.type === 'image' && o.img.dither === 'grayscale' ? Math.max(0, Math.min(pmax * 100, o.img.powerMin || 0)) / 100 : pmax;
    const speed = ops.speed;
    const os = cfg.overscan ?? 1;
    const S = (v) => v <= 0 ? 0 : Math.round(Smax * (pmin + (pmax - pmin) * v));
    const px = 1 / r.ppmm;
    // preview canvas
    const pc = document.createElement('canvas'); pc.width = r.W; pc.height = r.H;
    const pctx = pc.getContext('2d'); const pid = pctx.createImageData(r.W, r.H);
    for (let i = 0; i < r.W * r.H; i++) { const v = r.burn[i]; if (v > 0) { pid.data[i * 4 + 2] = 120; pid.data[i * 4 + 3] = Math.round(60 + 195 * v); } }
    pctx.putImageData(pid, 0, 0);
    prev.rasters.push({ canvas: pc, bb: r.bb });
    allPts.push([r.bb.x0, r.bb.y0], [r.bb.x1, r.bb.y0], [r.bb.x1, r.bb.y1], [r.bb.x0, r.bb.y1]);

    out.push(`; --- engrave: ${o.name || o.type} (${Math.round(pmax * 100)}% @ ${speed} mm/min, ${r.ppmm} lines/mm) ---`);
    for (let pass = 0; pass < Math.max(1, ops.passes | 0); pass++) {
      let dir = 0;
      for (let row = 0; row < r.H; row++) {
        const base = row * r.W;
        let a = -1, b = -1;
        for (let c = 0; c < r.W; c++) if (r.burn[base + c] > 0) { if (a < 0) a = c; b = c; }
        if (a < 0) continue;
        const wy = r.bb.y0 + (row + 0.5) * px;
        const ltr = cfg.bidir === false ? true : dir % 2 === 0; dir++;
        const xAt = (c) => T(r.bb.x0 + c * px, wy);
        const segs = []; // [startCol, endColExclusive, S]
        let c = a, curS = S(r.burn[base + a]), st = a;
        for (c = a + 1; c <= b + 1; c++) {
          const s = c <= b ? S(r.burn[base + c]) : -1;
          if (s !== curS) { segs.push([st, c, curS]); st = c; curS = s; }
        }
        if (!ltr) segs.reverse();
        const startCol = ltr ? a : b + 1, endCol = ltr ? b + 1 : a;
        const [sx, gy] = xAt(startCol);
        const sgn = ltr ? 1 : -1;
        G0(sx - sgn * os, gy);
        out.push(`G1X${f(sx)}S0F${speed}`); mode = 'G1'; feedNow = speed; moveTime(sx, gy, speed);
        for (const [s0, s1, s] of segs) {
          const endC = ltr ? s1 : s0;
          const [ex] = xAt(endC);
          const len = Math.abs(ex - pos[0]);
          if (s === 0 && len > 8) {
            G0(ex, gy); // long blank: rapid over it
          } else {
            out.push(mode === 'G0' ? `G1X${f(ex)}S${s}F${speed}` : `X${f(ex)}S${s}`); mode = 'G1';
            moveTime(ex, gy, speed);
          }
        }
        const [exx] = xAt(endCol);
        out.push(mode === 'G0' ? `G1X${f(exx + sgn * os)}S0F${speed}` : `X${f(exx + sgn * os)}S0`); mode = 'G1';
        moveTime(exx + sgn * os, gy, speed);
      }
    }
  }

  // ---------- vector layers ----------
  const emitPaths = (pls, ops, kind) => {
    const Sv = Math.round(Smax * Math.max(0, Math.min(100, ops.power)) / 100);
    const speed = ops.speed;
    for (let pass = 0; pass < Math.max(1, ops.passes | 0); pass++) {
      for (const pl of pls) {
        const pts = pl.pts.map(p => T(p[0], p[1]));
        if (pl.closed) pts.push(pts[0]);
        if (pass === 0) {
          prev.vectors.push({ pts: pl.pts.concat(pl.closed ? [pl.pts[0]] : []), kind });
          allPts.push(...pl.pts);
        }
        G0(pts[0][0], pts[0][1]);
        out.push(`G1X${f(pts[1][0])}Y${f(pts[1][1])}S${Sv}F${speed}`); mode = 'G1'; moveTime(pts[1][0], pts[1][1], speed);
        for (let i = 2; i < pts.length; i++) {
          out.push(`X${f(pts[i][0])}Y${f(pts[i][1])}`); moveTime(pts[i][0], pts[i][1], speed);
        }
      }
    }
  };
  const nearestOrder = (items, getStart) => {
    const res = []; const left = items.slice(); let p = pos.slice();
    const toG = (q) => T(q[0], q[1]);
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((it, i) => { const s = toG(getStart(it)); const d = Math.hypot(s[0] - p[0], s[1] - p[1]); if (d < bd) { bd = d; bi = i; } });
      const it = left.splice(bi, 1)[0]; res.push(it);
      const e = it.pls ? it.pls[it.pls.length - 1].pts[0] : it.pts[0]; p = toG(e);
    }
    return res;
  };

  if (lines.length) {
    for (const g of nearestOrder(lines, it => it.pls[0].pts[0])) {
      out.push(`; --- line engrave: ${g.o.name || g.o.type} (${g.ops.power}% @ ${g.ops.speed} mm/min) ---`);
      emitPaths(g.pls, g.ops, 'line');
    }
  }
  if (cuts.length) {
    // inner shapes first, outer shapes (like cut-around) last, so parts don't move before they're finished
    const area = (pls) => { const b = polylinesBBox(pls); return (b.x1 - b.x0) * (b.y1 - b.y0); };
    cuts.sort((a, b) => area(a.pls) - area(b.pls));
    for (const g of cuts) {
      const pls = g.pls.slice().sort((a, b) => Math.abs(polygonArea(a.pts)) - Math.abs(polygonArea(b.pts)));
      out.push(`; --- cut${g.around ? ' around' : ''}: ${g.o.name || g.o.type} (${g.ops.power}% @ ${g.ops.speed} mm/min x${g.ops.passes}) ---`);
      emitPaths(pls, g.ops, g.around ? 'around' : 'cut');
    }
  }

  out.push('M5', 'G0 X0 Y0');
  if (cfg.air) out.push('M9');
  moveTime(0, 0, rapid);
  const gcode = out.join('\n') + '\n';
  const hullPts = hull(allPts.map(p => T(p[0], p[1])));
  return {
    gcode,
    bytes: gcode.length,
    lines: out.length,
    time,
    worldBBox: wb,
    origin: [ox, oy],
    gbox: { x0: gb0[0], y0: gb0[1], x1: gb1[0], y1: gb1[1] },
    hull: hullPts,
    preview: prev,
  };
}

export function fmtTime(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}
