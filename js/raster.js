// Image processing: adjustments + dithering. Output: Float32Array "burn amount" 0..1 per pixel.

const KERNELS = {
  floyd: { div: 16, k: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  atkinson: { div: 8, k: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
  jarvis: { div: 48, k: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]] },
  stucki: { div: 42, k: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]] },
  sierra: { div: 32, k: [[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2], [-1, 2, 2], [0, 2, 3], [1, 2, 2]] },
};

const BAYER8 = (() => {
  const m = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25], [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];
  return m.map(r => r.map(v => (v + 0.5) / 64));
})();

export const DITHERS = {
  floyd: 'Floyd–Steinberg (photos)',
  atkinson: 'Atkinson (high contrast)',
  jarvis: 'Jarvis (smooth)',
  stucki: 'Stucki',
  sierra: 'Sierra',
  ordered: 'Ordered / Bayer (pattern)',
  threshold: 'Black & white (logos, text)',
  grayscale: 'Grayscale (variable power)',
};

export function processImage(imgData, w, h, s) {
  const d = imgData.data;
  const n = w * h;
  let g = new Float32Array(n);
  const bright = (s.brightness || 0) * 2.55;
  const c = (s.contrast || 0) * 2.55;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const gamma = s.gamma || 1;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    let v = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * a + 255 * (1 - a);
    g[i] = v;
  }
  if (s.sharpen > 0) g = sharpen(g, w, h, s.sharpen / 100);
  for (let i = 0; i < n; i++) {
    let v = g[i];
    const isBg = s.removeBg && v >= 248;
    v = cf * (v + bright - 128) + 128;
    v = Math.max(0, Math.min(255, v));
    if (gamma !== 1) v = 255 * Math.pow(v / 255, 1 / gamma);
    if (s.invert) v = 255 - v;
    if (isBg && !s.invert) v = 255;
    g[i] = v;
  }
  const out = new Float32Array(n);
  const mode = s.dither || 'floyd';
  if (mode === 'grayscale') {
    for (let i = 0; i < n; i++) { const dk = 1 - g[i] / 255; out[i] = dk < 0.02 ? 0 : dk; }
  } else if (mode === 'threshold') {
    const t = 255 * (1 - (s.threshold ?? 50) / 100);
    for (let i = 0; i < n; i++) out[i] = g[i] < t ? 1 : 0;
  } else if (mode === 'ordered') {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; out[i] = (1 - g[i] / 255) > BAYER8[y & 7][x & 7] ? 1 : 0;
    }
  } else {
    const K = KERNELS[mode] || KERNELS.floyd;
    const e = g; // in place error diffusion (serpentine)
    for (let y = 0; y < h; y++) {
      const rev = y & 1;
      for (let xi = 0; xi < w; xi++) {
        const x = rev ? w - 1 - xi : xi;
        const i = y * w + x;
        const old = e[i];
        const nv = old < 128 ? 0 : 255;
        out[i] = nv === 0 ? 1 : 0;
        const err = old - nv;
        if (!err) continue;
        for (const [dx0, dy, wt] of K.k) {
          const dx = rev ? -dx0 : dx0;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy >= h) continue;
          e[yy * w + xx] += (err * wt) / K.div;
        }
      }
    }
  }
  return out;
}

function sharpen(g, w, h, amt) {
  const o = new Float32Array(g.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const l = g[y * w + Math.max(0, x - 1)], r = g[y * w + Math.min(w - 1, x + 1)];
    const u = g[Math.max(0, y - 1) * w + x], dn = g[Math.min(h - 1, y + 1) * w + x];
    o[i] = Math.max(0, Math.min(255, g[i] + amt * (4 * g[i] - l - r - u - dn)));
  }
  return o;
}
