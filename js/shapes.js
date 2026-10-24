// Shape generators. Each returns command paths centered at (0,0) and sized exactly w x h (mm).

const K = 0.5522847498;

function ptsToCommands(pts, closed = true) {
  const c = [{ t: 'M', x: pts[0][0], y: pts[0][1] }];
  for (let i = 1; i < pts.length; i++) c.push({ t: 'L', x: pts[i][0], y: pts[i][1] });
  if (closed) c.push({ t: 'Z' });
  return c;
}

function fitPts(pts, w, h) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const sx = w / ((x1 - x0) || 1), sy = h / ((y1 - y0) || 1), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return pts.map(([x, y]) => [(x - cx) * sx, (y - cy) * sy]);
}

export function ellipse(w, h) {
  const rx = w / 2, ry = h / 2, kx = rx * K, ky = ry * K;
  return [
    { t: 'M', x: rx, y: 0 },
    { t: 'C', x1: rx, y1: ky, x2: kx, y2: ry, x: 0, y: ry },
    { t: 'C', x1: -kx, y1: ry, x2: -rx, y2: ky, x: -rx, y: 0 },
    { t: 'C', x1: -rx, y1: -ky, x2: -kx, y2: -ry, x: 0, y: -ry },
    { t: 'C', x1: kx, y1: -ry, x2: rx, y2: -ky, x: rx, y: 0 },
    { t: 'Z' },
  ];
}

export function rect(w, h, r = 0) {
  const x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2;
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r < 0.01) return ptsToCommands([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  const k = r * (1 - K);
  return [
    { t: 'M', x: x0 + r, y: y0 },
    { t: 'L', x: x1 - r, y: y0 },
    { t: 'C', x1: x1 - k, y1: y0, x2: x1, y2: y0 + k, x: x1, y: y0 + r },
    { t: 'L', x: x1, y: y1 - r },
    { t: 'C', x1: x1, y1: y1 - k, x2: x1 - k, y2: y1, x: x1 - r, y: y1 },
    { t: 'L', x: x0 + r, y: y1 },
    { t: 'C', x1: x0 + k, y1: y1, x2: x0, y2: y1 - k, x: x0, y: y1 - r },
    { t: 'L', x: x0, y: y0 + r },
    { t: 'C', x1: x0, y1: y0 + k, x2: x0 + k, y2: y0, x: x0 + r, y: y0 },
    { t: 'Z' },
  ];
}

export function polygon(w, h, n = 6) {
  n = Math.max(3, Math.round(n));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n + (n % 2 === 0 ? Math.PI / n : 0);
    pts.push([Math.cos(a), Math.sin(a)]);
  }
  return ptsToCommands(fitPts(pts, w, h));
}

export function star(w, h, n = 5, inner = 0.45) {
  n = Math.max(3, Math.round(n));
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? inner : 1;
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return ptsToCommands(fitPts(pts, w, h));
}

export function heart(w, h) {
  const pts = [];
  const N = 240;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    pts.push([x, y]);
  }
  return ptsToCommands(fitPts(pts, w, h));
}

export function triangle(w, h) {
  return ptsToCommands([[0, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]);
}

export function line(w) {
  return [{ t: 'M', x: -w / 2, y: 0 }, { t: 'L', x: w / 2, y: 0 }];
}

export function cross(w, h, t = 0.33) {
  const a = t / 2;
  const p = [[-a, -0.5], [a, -0.5], [a, -a], [0.5, -a], [0.5, a], [a, a], [a, 0.5], [-a, 0.5], [-a, a], [-0.5, a], [-0.5, -a], [-a, -a]];
  return ptsToCommands(p.map(([x, y]) => [x * w, y * h]));
}

export function badge(w, h) {
  // shield / badge shape
  const pts = [];
  const N = 60;
  pts.push([-0.5, -0.5], [0.5, -0.5]);
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // right side curve down to bottom point
    const x = 0.5 * (1 - t * t);
    const y = -0.1 + t * 0.6;
    pts.push([x, y]);
  }
  for (let i = N; i >= 0; i--) {
    const t = i / N;
    pts.push([-0.5 * (1 - t * t), -0.1 + t * 0.6]);
  }
  return ptsToCommands(fitPts(pts, w, h));
}

export const SHAPES = {
  rect: { label: 'Rectangle', gen: (w, h, p) => rect(w, h, p.radius || 0), params: ['radius'] },
  rounded: { label: 'Rounded rect', gen: (w, h, p) => rect(w, h, p.radius ?? Math.min(w, h) * 0.15), params: ['radius'] },
  circle: { label: 'Circle / oval', gen: (w, h) => ellipse(w, h), params: [] },
  heart: { label: 'Heart', gen: (w, h) => heart(w, h), params: [] },
  star: { label: 'Star', gen: (w, h, p) => star(w, h, p.points || 5, p.inner || 0.45), params: ['points', 'inner'] },
  polygon: { label: 'Polygon', gen: (w, h, p) => polygon(w, h, p.sides || 6), params: ['sides'] },
  triangle: { label: 'Triangle', gen: (w, h) => triangle(w, h), params: [] },
  badge: { label: 'Shield', gen: (w, h) => badge(w, h), params: [] },
  cross: { label: 'Cross', gen: (w, h) => cross(w, h), params: [] },
};

// Shapes offered as "cut around"
export const CUT_AROUND = {
  heart: 'Heart',
  circle: 'Circle',
  ellipse: 'Oval',
  rect: 'Rectangle',
  rounded: 'Rounded rectangle',
  polygon: 'Hexagon',
  star: 'Star',
  badge: 'Shield',
  contour: 'Contour (follows the outline)',
};
