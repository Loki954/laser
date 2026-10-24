// Material starting points. Real values depend on laser power, focus and material — run a material test.
import { lsGet, lsSet } from './storage.js';

export const BUILTIN = [
  { name: 'Wood – photo engrave', op: 'fill', power: 45, speed: 3000, passes: 1, interval: 10 },
  { name: 'Wood – text / logo engrave', op: 'fill', power: 60, speed: 2500, passes: 1, interval: 10 },
  { name: 'Wood – line engrave', op: 'line', power: 50, speed: 1500, passes: 1 },
  { name: 'Plywood 3 mm – cut', op: 'cut', power: 100, speed: 300, passes: 4 },
  { name: 'Plywood 5 mm – cut', op: 'cut', power: 100, speed: 200, passes: 8 },
  { name: 'MDF 3 mm – cut', op: 'cut', power: 100, speed: 250, passes: 5 },
  { name: 'Cardboard – cut', op: 'cut', power: 100, speed: 800, passes: 1 },
  { name: 'Paper – cut', op: 'cut', power: 35, speed: 1500, passes: 1 },
  { name: 'Felt – cut', op: 'cut', power: 80, speed: 800, passes: 1 },
  { name: 'Leather – engrave', op: 'fill', power: 30, speed: 3000, passes: 1, interval: 10 },
  { name: 'Leather 2 mm – cut', op: 'cut', power: 100, speed: 400, passes: 3 },
  { name: 'Dark acrylic 3 mm – cut', op: 'cut', power: 100, speed: 150, passes: 6 },
  { name: 'Anodized aluminium – engrave', op: 'fill', power: 100, speed: 1500, passes: 1, interval: 12 },
  { name: 'Slate / stone – engrave', op: 'fill', power: 60, speed: 2000, passes: 1, interval: 10 },
];

export function userPresets() { return lsGet('presets', []); }
export function allPresets(op) { return [...userPresets().map(p => ({ ...p, user: true })), ...BUILTIN].filter(p => !op || p.op === op); }
export function savePreset(p) {
  const list = userPresets().filter(x => x.name !== p.name);
  list.unshift(p); lsSet('presets', list);
}
export function deletePreset(name) { lsSet('presets', userPresets().filter(x => x.name !== name)); }
