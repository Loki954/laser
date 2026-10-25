// Material presets by laser module power.
// 10 W and 20 W: SculpFun recommended settings for S10 / S30 Pro (10 W) and S30 Pro Max (20 W)
//   (published by nozzler.io, attributed to SculpFun), plus a few tested 10 W values from hobbyistlasercalc.com.
// 5 W: SculpFun settings guide (values "mainly for the S9", rough starting points).
// Real results depend on focus, material batch and air assist — run a material test for important jobs.
import { lsGet, lsSet } from './storage.js';

const P = (name, op, power, speed, passes = 1, extra = {}) => ({ name, op, power, speed, passes, ...extra });

export const PRESETS = {
  5: [
    P('Plywood – engrave', 'fill', 40, 1500, 1, { interval: 10 }),
    P('Plywood 4 mm – cut', 'cut', 85, 200, 3, { air: true }),
    P('MDF 3 mm – cut', 'cut', 90, 300, 3, { air: true }),
    P('Black acrylic 5 mm – cut', 'cut', 85, 200, 6, { air: true }),
    P('Leather – engrave', 'fill', 40, 1500, 1, { interval: 10 }),
    P('Glass (painted) – engrave', 'fill', 70, 1500, 1, { interval: 10 }),
    P('Mirror (back side) – engrave', 'fill', 55, 1500, 1, { interval: 10 }),
    P('Stainless steel – mark', 'fill', 45, 1000, 1, { interval: 12 }),
    P('Tile – mark', 'fill', 60, 1500, 1, { interval: 10 }),
    P('Wood – line engrave', 'line', 40, 1000, 1),
  ],
  10: [
    P('Plywood – engrave', 'fill', 30, 3000, 1, { interval: 10 }),
    P('Plywood 3 mm – cut', 'cut', 100, 480, 1, { air: true }),
    P('Plywood 6 mm – cut', 'cut', 100, 180, 1, { air: true }),
    P('Plywood 10 mm – cut', 'cut', 100, 180, 4, { air: true }),
    P('Basswood – engrave', 'fill', 35, 3500, 1, { interval: 10 }),
    P('Basswood 3 mm – cut', 'cut', 100, 360, 1, { air: true }),
    P('Basswood 6 mm – cut', 'cut', 100, 180, 1, { air: true }),
    P('Cork / tung board 10 mm – cut', 'cut', 100, 300, 2, { air: true }),
    P('Cork / tung board 15 mm – cut', 'cut', 100, 180, 2, { air: true }),
    P('MDF – engrave', 'fill', 15, 3000, 1, { interval: 10 }),
    P('MDF 3.6 mm – cut', 'cut', 100, 240, 2, { air: true }),
    P('Black acrylic – engrave', 'fill', 28, 4500, 1, { interval: 10 }),
    P('Black acrylic 6 mm – cut', 'cut', 100, 180, 2, { air: true }),
    P('Black acrylic 11 mm – cut', 'cut', 100, 180, 11, { air: true }),
    P('Leather – engrave', 'fill', 10, 1800, 1, { interval: 10 }),
    P('Leather 2 mm – cut', 'cut', 70, 350, 2, { air: true }),
    P('Faux leather (PU) – engrave', 'fill', 22, 3500, 1, { interval: 10 }),
    P('Kraft paper – engrave', 'fill', 15, 1800, 1, { interval: 10 }),
    P('Stainless steel – engrave', 'fill', 100, 360, 1, { interval: 12 }),
    P('Wood – line engrave', 'line', 30, 1500, 1),
  ],
  20: [
    P('Plywood – engrave', 'fill', 20, 3000, 1, { interval: 10 }),
    P('Plywood 3 mm – cut', 'cut', 100, 780, 1, { air: true }),
    P('Plywood 6 mm – cut', 'cut', 100, 360, 1, { air: true }),
    P('Plywood 10 mm – cut', 'cut', 100, 300, 2, { air: true }),
    P('Basswood 3 mm – cut', 'cut', 100, 600, 1, { air: true }),
    P('Basswood 6 mm – cut', 'cut', 100, 300, 2, { air: true }),
    P('Cork / tung board 10 mm – cut', 'cut', 100, 300, 2, { air: true }),
    P('Cork / tung board 20 mm – cut', 'cut', 100, 180, 3, { air: true }),
    P('MDF – engrave', 'fill', 18, 3000, 1, { interval: 10 }),
    P('MDF 3.6 mm – cut', 'cut', 100, 300, 1, { air: true }),
    P('Black acrylic 6 mm – cut', 'cut', 100, 300, 3, { air: true }),
    P('Black acrylic 11 mm – cut', 'cut', 100, 180, 6, { air: true }),
    P('Leather – engrave', 'fill', 15, 1800, 1, { interval: 10 }),
    P('Kraft paper – engrave', 'fill', 15, 1800, 1, { interval: 10 }),
    P('Stainless steel – engrave', 'fill', 100, 900, 1, { interval: 12 }),
    P('Wood – line engrave', 'line', 20, 1500, 1),
  ],
};

export const LASER_CLASSES = { 5: '5 W (S9, S6, iCube 5W)', 10: '10 W (S10, S30, S30 Pro, iCube 10W)', 20: '20 W (S30 Pro Max)' };

let laserW = 10;
export function setLaserClass(w) { laserW = PRESETS[w] ? +w : 10; }
export function laserClass() { return laserW; }

export function userPresets() { return lsGet('presets', []); }
export function allPresets(op) {
  return [...userPresets().map(p => ({ ...p, user: true })), ...PRESETS[laserW]].filter(p => !op || p.op === op);
}
export function savePreset(p) {
  const list = userPresets().filter(x => x.name !== p.name);
  list.unshift(p); lsSet('presets', list);
}
export function deletePreset(name) { lsSet('presets', userPresets().filter(x => x.name !== name)); }
