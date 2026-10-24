// SVG import -> polylines (mm), using the browser's own geometry engine
import { simplify, polylinesBBox } from './geometry.js';

export async function svgToPolylines(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') throw new Error('Not an SVG file');
  // physical size
  const unit = (v) => {
    if (!v) return null;
    const m = String(v).match(/^([\d.]+)\s*(mm|cm|in|pt|px)?$/); if (!m) return null;
    const n = parseFloat(m[1]);
    return { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96, undefined: 25.4 / 96 }[m[2]] * n;
  };
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:10px;height:10px;overflow:hidden;visibility:hidden';
  const live = document.importNode(svg, true);
  host.appendChild(live); document.body.appendChild(host);
  try {
    const vb = live.viewBox && live.viewBox.baseVal && live.viewBox.baseVal.width ? live.viewBox.baseVal : null;
    const wmm = unit(svg.getAttribute('width'));
    let mmPerUnit = 25.4 / 96;
    if (vb && wmm) mmPerUnit = wmm / vb.width;
    const els = live.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon');
    const out = [];
    const rootInv = live.getScreenCTM() ? live.getScreenCTM().inverse() : null;
    for (const el of els) {
      if (el.closest('defs,clipPath,mask,symbol')) continue;
      let len = 0;
      try { len = el.getTotalLength(); } catch (e) { continue; }
      if (!len) continue;
      const ctm = el.getScreenCTM && rootInv ? rootInv.multiply(el.getScreenCTM()) : el.getCTM();
      const step = Math.max(len / 4000, 0.15 / mmPerUnit);
      const n = Math.ceil(len / step);
      let cur = [];
      let prev = null;
      const flush = () => { if (cur.length > 1) out.push(cur); cur = []; };
      for (let i = 0; i <= n; i++) {
        const p = el.getPointAtLength(Math.min(len, i * step));
        const q = ctm ? p.matrixTransform(ctm) : p;
        const pt = [q.x * mmPerUnit, q.y * mmPerUnit];
        if (prev && Math.hypot(pt[0] - prev[0], pt[1] - prev[1]) > step * mmPerUnit * 3) flush();
        cur.push(pt); prev = pt;
      }
      flush();
    }
    const pls = out.map(pts => {
      const f = pts[0], l = pts[pts.length - 1];
      const closed = Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.3;
      const s = simplify(closed ? pts.slice(0, -1) : pts, 0.03);
      return { pts: s, closed };
    }).filter(p => p.pts.length > 1);
    if (!pls.length) throw new Error('No shapes found in SVG');
    return pls;
  } finally { host.remove(); }
}

export function polylinesToCommands(pls) {
  const c = [];
  for (const pl of pls) {
    c.push({ t: 'M', x: pl.pts[0][0], y: pl.pts[0][1] });
    for (let i = 1; i < pl.pts.length; i++) c.push({ t: 'L', x: pl.pts[i][0], y: pl.pts[i][1] });
    if (pl.closed) c.push({ t: 'Z' });
  }
  return c;
}

export { polylinesBBox };
