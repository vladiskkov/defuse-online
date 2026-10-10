// Зони карти «Дюна» для настільного режиму: як callout'и в CS2.
// Фішка за хід переходить у сусідню зону. Спільне для сервера і браузера.
import { DUNE } from './map.js';
import { Grid } from './geom.js';

// rects — прямокутники клітинок (включно), з яких складається зона.
export const ZONES = [
  { id: 'tspawn', name: 'Спавн T',     rects: [[11, 22, 24, 26]], color: '#f0a23a' },
  { id: 'outside', name: 'Ворота',     rects: [[19, 20, 34, 21]], color: '#c9a35a' },
  { id: 'long', name: 'Лонг',          rects: [[31, 9, 34, 19]], color: '#b98a4a' },
  { id: 'asite', name: 'Точка А',      rects: [[26, 1, 34, 8]], color: '#e0574a', site: 'A' },
  { id: 'cat', name: 'Кет',            rects: [[19, 9, 27, 14]], color: '#a98bd6' },
  { id: 'mid', name: 'Мід',            rects: [[16, 10, 18, 20]], color: '#8ab06a' },
  { id: 'ctmid', name: 'Двері міду',   rects: [[16, 7, 18, 9]], color: '#6aa8b0' },
  { id: 'ctspawn', name: 'Спавн CT',   rects: [[14, 1, 25, 6]], color: '#5aa7e8' },
  { id: 'bdoors', name: 'Двері Б',     rects: [[11, 1, 13, 6]], color: '#7a8fd0' },
  { id: 'bsite', name: 'Точка Б',      rects: [[1, 1, 10, 8]], color: '#e0574a', site: 'B' },
  { id: 'upper', name: 'Тунелі Б',     rects: [[3, 9, 5, 24], [6, 22, 10, 24]], color: '#9a7a5a' },
  { id: 'lower', name: 'Нижні тунелі', rects: [[6, 16, 15, 17]], color: '#7d6a8a' },
];

export const LINKS = [
  ['tspawn', 'outside'], ['tspawn', 'mid'], ['tspawn', 'upper'],
  ['outside', 'long'], ['long', 'asite'], ['asite', 'cat'], ['asite', 'ctspawn'],
  ['cat', 'mid'], ['mid', 'ctmid'], ['mid', 'lower'], ['ctmid', 'ctspawn'],
  ['ctspawn', 'bdoors'], ['bdoors', 'bsite'], ['bsite', 'upper'], ['upper', 'lower'],
];

export const ZONE = Object.fromEntries(ZONES.map((z) => [z.id, z]));
for (const z of ZONES) z.adj = [];
for (const [a, b] of LINKS) { ZONE[a].adj.push(b); ZONE[b].adj.push(a); }

// клітинки кожної зони, центр і місця для фішок
const grid = new Grid(DUNE);
const owner = new Map();
for (const z of ZONES) {
  z.tiles = [];
  for (const [x1, y1, x2, y2] of z.rects) {
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
      const k = x + ',' + y;
      if (grid.opaque(x, y) || owner.has(k)) continue;
      owner.set(k, z.id);
      z.tiles.push({ x, y });
    }
  }
  const cx = z.tiles.reduce((a, t) => a + t.x, 0) / z.tiles.length;
  const cy = z.tiles.reduce((a, t) => a + t.y, 0) / z.tiles.length;
  const walk = z.tiles.filter((t) => grid.walkable(t.x, t.y));
  walk.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  z.center = walk[0];
  // місця для фішок: рознесені клітинки біля центру
  // спершу рознесені на 2 клітинки, потім — будь-які вільні
  z.slots = [];
  for (const t of walk) {
    if (z.slots.length < 6 && z.slots.every((s) => Math.max(Math.abs(s.x - t.x), Math.abs(s.y - t.y)) >= 2)) z.slots.push(t);
  }
  for (const t of walk) {
    if (z.slots.length >= 8) break;
    if (!z.slots.includes(t)) z.slots.push(t);
  }
  // підпис зони — біля верхнього краю, щоб не накривав фішки
  const top = Math.min(...z.tiles.map((t) => t.y));
  const row = z.tiles.filter((t) => t.y === top);
  z.label = { x: row.reduce((a, t) => a + t.x, 0) / row.length + 0.5, y: top + 0.3 };
}

export function zoneAt(x, y) { return owner.get(x + ',' + y) || null; }

// найкоротший шлях між зонами (список id без стартової)
export function zonePath(from, to) {
  if (from === to) return [];
  const prev = { [from]: null };
  const q = [from];
  while (q.length) {
    const z = q.shift();
    for (const n of ZONE[z].adj) {
      if (n in prev) continue;
      prev[n] = z;
      if (n === to) {
        const path = [n];
        let c = z;
        while (c !== from) { path.unshift(c); c = prev[c]; }
        return path;
      }
      q.push(n);
    }
  }
  return null;
}

export function zoneDist(a, b) { const p = zonePath(a, b); return p ? p.length : 99; }
