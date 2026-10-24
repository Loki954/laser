// Text -> vector paths using opentype.js (loaded globally from vendor/opentype.min.js)
import { idbGet, idbSet, idbKeys } from './storage.js';

export const FONTS = [
  { id: 'roboto', name: 'Roboto', file: 'fonts/roboto.ttf' },
  { id: 'roboto-bold', name: 'Roboto Bold', file: 'fonts/roboto-bold.ttf' },
  { id: 'montserrat-bold', name: 'Montserrat Bold', file: 'fonts/montserrat-bold.ttf' },
  { id: 'oswald', name: 'Oswald', file: 'fonts/oswald.ttf' },
  { id: 'rubik', name: 'Rubik', file: 'fonts/rubik.ttf' },
  { id: 'comfortaa', name: 'Comfortaa', file: 'fonts/comfortaa.ttf' },
  { id: 'playfair', name: 'Playfair Display', file: 'fonts/playfair.ttf' },
  { id: 'alice', name: 'Alice', file: 'fonts/alice.ttf' },
  { id: 'yeseva', name: 'Yeseva One', file: 'fonts/yeseva.ttf' },
  { id: 'kellyslab', name: 'Kelly Slab', file: 'fonts/kellyslab.ttf' },
  { id: 'russoone', name: 'Russo One', file: 'fonts/russoone.ttf' },
  { id: 'stalinist', name: 'Stalinist One', file: 'fonts/stalinist.ttf' },
  { id: 'blackops', name: 'Black Ops One (Latin)', file: 'fonts/blackops.ttf' },
  { id: 'pressstart', name: 'Press Start 2P', file: 'fonts/pressstart.ttf' },
  { id: 'amatic', name: 'Amatic SC', file: 'fonts/amatic.ttf' },
  { id: 'caveat', name: 'Caveat (handwriting)', file: 'fonts/caveat.ttf' },
  { id: 'badscript', name: 'Bad Script', file: 'fonts/badscript.ttf' },
  { id: 'marckscript', name: 'Marck Script', file: 'fonts/marckscript.ttf' },
  { id: 'lobster', name: 'Lobster', file: 'fonts/lobster.ttf' },
  { id: 'pacifico', name: 'Pacifico', file: 'fonts/pacifico.ttf' },
  { id: 'greatvibes', name: 'Great Vibes', file: 'fonts/greatvibes.ttf' },
];

const cache = new Map();

export async function loadUserFonts() {
  try {
    const keys = await idbKeys('fonts');
    for (const k of keys) {
      if (!FONTS.find(f => f.id === k)) FONTS.push({ id: k, name: k.replace(/^user:/, '') + ' (yours)', user: true });
    }
  } catch (e) { /* ignore */ }
}

export async function addUserFont(file) {
  const buf = await file.arrayBuffer();
  const font = opentype.parse(buf);
  const id = 'user:' + file.name.replace(/\.(ttf|otf|woff)$/i, '');
  await idbSet('fonts', id, buf);
  cache.set(id, font);
  if (!FONTS.find(f => f.id === id)) FONTS.push({ id, name: id.replace(/^user:/, '') + ' (yours)', user: true });
  return id;
}

export async function getFont(id) {
  if (cache.has(id)) return cache.get(id);
  const meta = FONTS.find(f => f.id === id) || FONTS[0];
  let buf;
  if (meta.user) buf = await idbGet('fonts', meta.id);
  else buf = await (await fetch(meta.file)).arrayBuffer();
  const font = opentype.parse(buf);
  cache.set(id, font);
  return font;
}

export function getFontSync(id) { return cache.get(id); }

// Returns command path (y down) for multi-line text. Units: 1 unit = fontSize/100 of em at size 100.
export function textToCommands(font, text, { letterSpacing = 0, lineHeight = 1.2, align = 'center' } = {}) {
  const size = 100;
  const lines = String(text || '').split('\n');
  const out = [];
  const widths = lines.map(l => lineWidth(font, l, size, letterSpacing));
  const maxW = Math.max(1, ...widths);
  lines.forEach((ln, i) => {
    const y = i * size * lineHeight;
    let x = 0;
    if (align === 'center') x = (maxW - widths[i]) / 2;
    else if (align === 'right') x = maxW - widths[i];
    const glyphs = font.stringToGlyphs(ln);
    for (let g = 0; g < glyphs.length; g++) {
      const glyph = glyphs[g];
      const p = glyph.getPath(x, y, size);
      for (const c of p.commands) {
        if (c.type === 'M' || c.type === 'L') out.push({ t: c.type, x: c.x, y: c.y });
        else if (c.type === 'Q') out.push({ t: 'Q', x1: c.x1, y1: c.y1, x: c.x, y: c.y });
        else if (c.type === 'C') out.push({ t: 'C', x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, x: c.x, y: c.y });
        else if (c.type === 'Z') out.push({ t: 'Z' });
      }
      let adv = (glyph.advanceWidth || 0) * size / font.unitsPerEm;
      if (g < glyphs.length - 1) {
        try { adv += font.getKerningValue(glyph, glyphs[g + 1]) * size / font.unitsPerEm; } catch (e) { }
      }
      x += adv + letterSpacing * size / 100;
    }
  });
  return out;
}

function lineWidth(font, ln, size, letterSpacing) {
  const glyphs = font.stringToGlyphs(ln);
  let w = 0;
  for (let g = 0; g < glyphs.length; g++) {
    w += (glyphs[g].advanceWidth || 0) * size / font.unitsPerEm;
    if (g < glyphs.length - 1) {
      try { w += font.getKerningValue(glyphs[g], glyphs[g + 1]) * size / font.unitsPerEm; } catch (e) { }
      w += letterSpacing * size / 100;
    }
  }
  return w;
}
