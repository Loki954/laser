// Geometry helpers. All coordinates are millimetres, Y axis pointing DOWN (screen space).
// A "command path" is an array of {t:'M'|'L'|'Q'|'C'|'Z', x,y, x1,y1, x2,y2}.
// A "polyline" is {pts:[[x,y],...], closed:boolean}.

export const DEG = Math.PI / 180;

export function matIdentity() { return [1, 0, 0, 1, 0, 0]; }
// [a,b,c,d,e,f] maps (x,y) -> (a*x + c*y + e, b*x + d*y + f)
export function matMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export function matTranslate(x, y) { return [1, 0, 0, 1, x, y]; }
export function matScale(sx, sy) { return [sx, 0, 0, sy, 0, 0]; }
export function matRotate(deg) { const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG); return [c, s, -s, c, 0, 0]; }
export function matInvert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return matIdentity();
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
export function applyMat(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

export function transformCommands(cmds, m) {
  return cmds.map(c => {
    const o = { t: c.t };
    if (c.x !== undefined) [o.x, o.y] = applyMat(m, c.x, c.y);
    if (c.x1 !== undefined) [o.x1, o.y1] = applyMat(m, c.x1, c.y1);
    if (c.x2 !== undefined) [o.x2, o.y2] = applyMat(m, c.x2, c.y2);
    return o;
  });
}

export function commandsBBox(cmds) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  // Bounding box from flattened curve for accuracy
  for (const pl of flattenCommands(cmds, 0.05)) for (const p of pl.pts) add(p[0], p[1]);
  if (x0 === Infinity) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

// Flatten bezier commands to polylines with a given tolerance (same units as coords).
export function flattenCommands(cmds, tol = 0.03) {
  const out = [];
  let cur = null, sx = 0, sy = 0, px = 0, py = 0;
  const seg = (n) => Math.max(1, Math.min(200, Math.ceil(n)));
  for (const c of cmds) {
    switch (c.t) {
      case 'M':
        if (cur && cur.pts.length > 1) out.push(cur);
        cur = { pts: [[c.x, c.y]], closed: false };
        sx = px = c.x; sy = py = c.y; break;
      case 'L':
        if (!cur) cur = { pts: [[px, py]], closed: false };
        cur.pts.push([c.x, c.y]); px = c.x; py = c.y; break;
      case 'Q': {
        if (!cur) cur = { pts: [[px, py]], closed: false };
        const d = Math.hypot(px - 2 * c.x1 + c.x, py - 2 * c.y1 + c.y);
        const n = seg(Math.sqrt(d / (4 * tol)) + 1);
        for (let i = 1; i <= n; i++) {
          const t = i / n, mt = 1 - t;
          cur.pts.push([mt * mt * px + 2 * mt * t * c.x1 + t * t * c.x, mt * mt * py + 2 * mt * t * c.y1 + t * t * c.y]);
        }
        px = c.x; py = c.y; break;
      }
      case 'C': {
        if (!cur) cur = { pts: [[px, py]], closed: false };
        const d1 = Math.hypot(px - 2 * c.x1 + c.x2, py - 2 * c.y1 + c.y2);
        const d2 = Math.hypot(c.x1 - 2 * c.x2 + c.x, c.y1 - 2 * c.y2 + c.y);
        const n = seg(Math.sqrt(Math.max(d1, d2) * 0.75 / tol) + 1);
        for (let i = 1; i <= n; i++) {
          const t = i / n, mt = 1 - t;
          const a = mt * mt * mt, b = 3 * mt * mt * t, cc = 3 * mt * t * t, dd = t * t * t;
          cur.pts.push([a * px + b * c.x1 + cc * c.x2 + dd * c.x, a * py + b * c.y1 + cc * c.y2 + dd * c.y]);
        }
        px = c.x; py = c.y; break;
      }
      case 'Z':
        if (cur) {
          const f = cur.pts[0], l = cur.pts[cur.pts.length - 1];
          if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) cur.pts.pop();
          cur.closed = true;
          if (cur.pts.length > 1) out.push(cur);
          cur = null; px = sx; py = sy;
        }
        break;
    }
  }
  if (cur && cur.pts.length > 1) out.push(cur);
  return out;
}

export function polylinesBBox(pls) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pl of pls) for (const [x, y] of pl.pts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  if (x0 === Infinity) return null;
  return { x0, y0, x1, y1 };
}

export function polylineLength(pl) {
  let L = 0; const p = pl.pts;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  if (pl.closed && p.length > 1) L += Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]);
  return L;
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return a / 2;
}

// Ramer–Douglas–Peucker simplification
export function simplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function simplifyClosed(pts, eps) {
  if (pts.length < 4) return pts;
  // split at the point farthest from pts[0] so both halves get simplified properly
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = simplify(pts.slice(0, far + 1), eps);
  const b = simplify(pts.slice(far).concat([pts[0]]), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

// Chaikin smoothing for closed loops
export function chaikinClosed(pts, iter = 1) {
  let p = pts;
  for (let k = 0; k < iter; k++) {
    const o = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      o.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    p = o;
  }
  return p;
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function polylinesToPath2D(pls) {
  const p = new Path2D();
  for (const pl of pls) {
    if (!pl.pts.length) continue;
    p.moveTo(pl.pts[0][0], pl.pts[0][1]);
    for (let i = 1; i < pl.pts.length; i++) p.lineTo(pl.pts[i][0], pl.pts[i][1]);
    if (pl.closed) p.closePath();
  }
  return p;
}

// ---------- Contour tracing (marching squares) on a binary mask ----------
// mask: Uint8Array w*h (1 = solid). Returns closed loops in pixel coordinates.
export function traceMask(mask, w, h) {
  // pad by 1 so contours are always closed
  const W = w + 2, H = h + 2;
  const m = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) m.set(mask.subarray(y * w, y * w + w), (y + 1) * W + 1);
  const segs = new Map(); // key "x,y" of start -> list of end keys
  const key = (x, y) => x * 2 + ',' + y * 2; // half-pixel grid -> integer keys
  const edges = [];
  const add = (ax, ay, bx, by) => edges.push([ax, ay, bx, by]);
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const tl = m[y * W + x], tr = m[y * W + x + 1], br = m[(y + 1) * W + x + 1], bl = m[(y + 1) * W + x];
      const c = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (c === 0 || c === 15) continue;
      // edge midpoints (cell between pixel centers x..x+1, y..y+1)
      const T = [x + 0.5, y], R = [x + 1, y + 0.5], B = [x + 0.5, y + 1], L = [x, y + 0.5];
      // orientation: solid on the left when walking
      switch (c) {
        case 1: add(...L, ...B); break;
        case 2: add(...B, ...R); break;
        case 3: add(...L, ...R); break;
        case 4: add(...R, ...T); break;
        case 5: add(...L, ...T); add(...R, ...B); break; // saddle
        case 6: add(...B, ...T); break;
        case 7: add(...L, ...T); break;
        case 8: add(...T, ...L); break;
        case 9: add(...T, ...B); break;
        case 10: add(...T, ...R); add(...B, ...L); break; // saddle
        case 11: add(...T, ...R); break;
        case 12: add(...R, ...L); break;
        case 13: add(...R, ...B); break;
        case 14: add(...B, ...L); break;
      }
    }
  }
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]; const k = key(e[0], e[1]);
    let l = segs.get(k); if (!l) segs.set(k, l = []); l.push(i);
  }
  const used = new Uint8Array(edges.length);
  const loops = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    const loop = []; let j = i;
    while (j !== undefined && !used[j]) {
      used[j] = 1; const e = edges[j];
      loop.push([e[0] - 1, e[1] - 1]); // un-pad
      const nexts = segs.get(key(e[2], e[3]));
      j = undefined;
      if (nexts) for (const n of nexts) if (!used[n]) { j = n; break; }
    }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

// Exact-ish euclidean distance transform (Felzenszwalb) on binary mask; returns Float32 distances (pixels) to nearest solid.
export function distanceTransform(mask, w, h) {
  const INF = 1e20;
  const f = new Float32Array(Math.max(w, h));
  const d = new Float32Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float32Array(Math.max(w, h) + 1);
  const grid = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = mask[i] ? 0 : INF;
  const dt1 = (n) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    dt1(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    dt1(w);
    for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(d[x]);
  }
  return grid;
}

// Fill holes: everything not reachable from border background becomes solid
export function fillHoles(mask, w, h) {
  const out = new Uint8Array(w * h).fill(1);
  const stack = [];
  const push = (x, y) => { const i = y * w + x; if (!mask[i] && out[i]) { out[i] = 0; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  return out;
}
