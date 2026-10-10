// Гекс-сітка поверх карти «Дюна». Спільна для сервера і браузера.
// Гекси «гострим верхом», ряди зі зсувом (odd-r). Координати центрів — у клітинках карти.
import { DUNE } from './map.js';
import { Grid } from './geom.js';

export const SIZE = 0.95;                 // радіус гекса в клітинках
const W = Math.sqrt(3) * SIZE;            // ширина гекса
const H = 1.5 * SIZE;                     // крок між рядами
const OX = 0.9, OY = 1.05;                // зсув сітки, щоб гекси лягали в коридори

export const grid = new Grid(DUNE);

export function center(c, r) { return { x: OX + c * W + (r & 1 ? W / 2 : 0), y: OY + r * H }; }
const toCube = (c, r) => { const q = c - (r - (r & 1)) / 2; return { q, r, s: -q - r }; };
const fromCube = (q, r) => ({ c: q + (r - (r & 1)) / 2, r });
export const key = (c, r) => c + ',' + r;
export const parse = (k) => { const [c, r] = k.split(',').map(Number); return { c, r }; };

export function hexDist(a, b) {
  const A = toCube(a.c, a.r), B = toCube(b.c, b.r);
  return Math.max(Math.abs(A.q - B.q), Math.abs(A.r - B.r), Math.abs(A.s - B.s));
}

const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
function cubeNeighbors(c, r) {
  const { q, r: rr } = toCube(c, r);
  return DIRS.map(([dq, dr]) => fromCube(q + dq, rr + dr));
}

// тип гекса за клітинками під ним: wall — стіна, box — ящик (укриття), floor — підлога
function classify(c, r) {
  const p = center(c, r);
  const cx = Math.floor(p.x), cy = Math.floor(p.y);
  const ch = grid.at(cx, cy);
  if (ch === 'b') return 'box';
  // ящик під гексом (не обов'язково в центрі) — теж укриття
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (grid.at(cx + dx, cy + dy) === 'b' && Math.hypot(cx + dx + 0.5 - p.x, cy + dy + 0.5 - p.y) < 0.75) return 'box';
  }
  if (ch === '#') {
    // якщо майже весь гекс — підлога, вважаємо його прохідним
    let floor = 0, n = 0;
    for (let dy = -0.6; dy <= 0.61; dy += 0.4) for (let dx = -0.6; dx <= 0.61; dx += 0.4) { n++; if (grid.walkable(Math.floor(p.x + dx), Math.floor(p.y + dy))) floor++; }
    return floor / n >= 0.75 ? 'floor' : 'wall';
  }
  return 'floor';
}

export const COLS = Math.ceil((grid.w - OX) / W);
export const ROWS = Math.ceil((grid.h - OY) / H);
export const HEXES = new Map();       // key -> {c, r, x, y, kind, site, spawn, tile}
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  const p = center(c, r);
  if (p.x < 0.5 || p.y < 0.5 || p.x > grid.w - 0.5 || p.y > grid.h - 0.5) continue;
  const kind = classify(c, r);
  const t = { x: Math.floor(p.x), y: Math.floor(p.y) };
  // найближча прохідна клітинка — для пошуку шляху і видимості
  let tile = t;
  if (!grid.walkable(t.x, t.y)) {
    let best = null, bd = 9;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!grid.walkable(t.x + dx, t.y + dy)) continue;
      const d = Math.hypot(t.x + dx + 0.5 - p.x, t.y + dy + 0.5 - p.y);
      if (d < bd) { bd = d; best = { x: t.x + dx, y: t.y + dy }; }
    }
    tile = best || t;
  }
  const ch = grid.at(t.x, t.y);
  HEXES.set(key(c, r), { c, r, x: p.x, y: p.y, kind, tile, site: grid.site(tile.x, tile.y), spawn: ch === 'T' ? 'T' : ch === 'C' ? 'CT' : null });
}

export function hexAt(c, r) { return HEXES.get(key(c, r)) || null; }
export function walkable(h) { return h && h.kind === 'floor'; }

// сусіди, між якими немає стіни
export function neighbors(h) {
  const out = [];
  for (const n of cubeNeighbors(h.c, h.r)) {
    const nh = hexAt(n.c, n.r);
    if (!walkable(nh)) continue;
    if (!clearLine(h, nh)) continue;
    out.push(nh);
  }
  return out;
}

export function allNeighbors(h) { return cubeNeighbors(h.c, h.r).map((n) => hexAt(n.c, n.r)).filter(Boolean); }

// пряма між центрами гексів не проходить крізь стіни (smoke — функція (x,y) для диму)
export function clearLine(a, b, smoke) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const n = Math.ceil(Math.hypot(dx, dy) * 6);
  for (let i = 1; i < n; i++) {
    const x = Math.floor(a.x + dx * i / n), y = Math.floor(a.y + dy * i / n);
    if (grid.opaque(x, y)) return false;
    if (smoke && smoke(x, y)) return false;
  }
  return true;
}

// лінія видимості між гексами
export function los(a, b, smoke) {
  if (a === b) return true;
  if (!clearLine(a, b)) return false;
  if (smoke && hexDist(a, b) > 1 && !clearLine(a, b, smoke)) return false;
  return true;
}

// чи в укритті ціль від стрільця: поруч із ціллю є ящик або стіна з боку стрільця
export function inCover(target, shooter) {
  const vx = shooter.x - target.x, vy = shooter.y - target.y;
  const len = Math.hypot(vx, vy) || 1;
  for (const n of allNeighbors(target)) {
    if (n.kind === 'floor') continue;
    const nx = n.x - target.x, ny = n.y - target.y;
    const cos = (nx * vx + ny * vy) / (Math.hypot(nx, ny) * len);
    if (cos > 0.55) return n.kind; // кут менше ~57° — блокує лінію вогню
  }
  return null;
}

// досяжні гекси за steps кроків (blocked(h) — зайняті)
export function reach(start, steps, blocked) {
  const dist = new Map([[key(start.c, start.r), 0]]);
  const prev = new Map();
  const q = [start];
  while (q.length) {
    const h = q.shift();
    const d = dist.get(key(h.c, h.r));
    if (d >= steps) continue;
    for (const n of neighbors(h)) {
      const k = key(n.c, n.r);
      if (dist.has(k) || (blocked && blocked(n))) continue;
      dist.set(k, d + 1);
      prev.set(k, h);
      q.push(n);
    }
  }
  return { dist, prev };
}

export function pathTo(start, goal, steps, blocked) {
  const { dist, prev } = reach(start, steps, blocked);
  const k = key(goal.c, goal.r);
  if (!dist.has(k)) return null;
  const out = [];
  let cur = goal;
  while (cur !== start) { out.unshift(cur); cur = prev.get(key(cur.c, cur.r)); }
  return out;
}

// найближчий гекс до клітинки карти
export function hexNear(x, y) {
  let best = null, bd = Infinity;
  for (const h of HEXES.values()) {
    if (h.kind === 'wall') continue;
    const d = Math.hypot(h.x - x, h.y - y);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

export const FLOOR = [...HEXES.values()].filter((h) => h.kind === 'floor');
