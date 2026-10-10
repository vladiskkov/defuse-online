// Геометрія сітки: прохідність, лінія видимості, пошук шляху. Спільна для сервера і браузера.

export class Grid {
  constructor(map) {
    this.map = map;
    this.h = map.rows.length;
    this.w = map.rows[0].length;
    this.cells = map.rows.map((r) => r.split(''));
  }
  at(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return '#';
    return this.cells[y][x];
  }
  walkable(x, y) { const c = this.at(x, y); return c !== '#' && c !== 'b'; }
  opaque(x, y) { return this.at(x, y) === '#'; }
  isBox(x, y) { return this.at(x, y) === 'b'; }
  site(x, y) { const c = this.at(x, y); return c === 'A' || c === 'B' ? c : null; }
  tilesOf(ch) {
    const out = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (this.cells[y][x] === ch) out.push({ x, y });
    return out;
  }
  callout(x, y) {
    for (const c of this.map.callouts) if (x >= c.x1 && x <= c.x2 && y >= c.y1 && y <= c.y2) return c.name;
    return '';
  }

  // Сусіди по 8 напрямках без зрізання кутів
  neighbors(x, y) {
    const out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (!this.walkable(nx, ny)) continue;
      if (dx && dy && (!this.walkable(x + dx, y) || !this.walkable(x, y + dy))) continue;
      out.push({ x: nx, y: ny });
    }
    return out;
  }

  // BFS: відстані від точки (у кроках)
  distanceField(sx, sy, blocked) {
    const d = new Int16Array(this.w * this.h).fill(-1);
    const q = [sx + sy * this.w];
    d[q[0]] = 0;
    for (let i = 0; i < q.length; i++) {
      const k = q[i], x = k % this.w, y = (k / this.w) | 0;
      for (const n of this.neighbors(x, y)) {
        const nk = n.x + n.y * this.w;
        if (d[nk] !== -1) continue;
        if (blocked && blocked(n.x, n.y)) continue;
        d[nk] = d[k] + 1;
        q.push(nk);
      }
    }
    return d;
  }

  // Найкоротший шлях (без стартової клітинки). null, якщо недосяжно.
  path(sx, sy, tx, ty) {
    if (!this.walkable(tx, ty)) return null;
    if (sx === tx && sy === ty) return [];
    const d = this.distanceField(tx, ty);
    if (d[sx + sy * this.w] < 0) return null;
    const out = [];
    let x = sx, y = sy;
    while (!(x === tx && y === ty)) {
      const cur = d[x + y * this.w];
      let best = null;
      for (const n of this.neighbors(x, y)) {
        const v = d[n.x + n.y * this.w];
        if (v === cur - 1) {
          // перевага прямим крокам — шлях виглядає природніше
          if (!best || (n.x === x || n.y === y)) { best = n; if (n.x === x || n.y === y) break; }
        }
      }
      if (!best) return null;
      out.push(best);
      x = best.x; y = best.y;
    }
    return out;
  }

  // Лінія видимості між центрами клітинок. smoke(x,y) => true, якщо в клітинці дим.
  los(ax, ay, bx, by, smoke) {
    if (ax === bx && ay === by) return true;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    const n = Math.ceil(len * 5);
    let px = ax, py = ay;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = Math.floor(ax + 0.5 + dx * t), y = Math.floor(ay + 0.5 + dy * t);
      if (x === px && y === py) continue;
      px = x; py = y;
      if ((x === ax && y === ay) || (x === bx && y === by)) continue;
      if (this.opaque(x, y)) return false;
      // прослизнути між двома стінами по діагоналі не можна
      if (smoke && smoke(x, y)) return false;
    }
    // дим на кінцях: стоячи в димі, бачиш лише впритул
    if (smoke && (smoke(ax, ay) || smoke(bx, by)) && Math.max(Math.abs(dx), Math.abs(dy)) > 1) return false;
    return true;
  }

  // Чи прикриває ящик ціль від стрільця (ящик на лінії поруч із ціллю)
  cover(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const n = Math.ceil(Math.hypot(dx, dy) * 5);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = Math.floor(ax + 0.5 + dx * t), y = Math.floor(ay + 0.5 + dy * t);
      if (Math.max(Math.abs(x - bx), Math.abs(y - by)) === 1 && Math.max(Math.abs(x - ax), Math.abs(y - ay)) > 1 && this.isBox(x, y)) return true;
    }
    return false;
  }
}

export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
export function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }
