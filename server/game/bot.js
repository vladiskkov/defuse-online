// Прості боти: закупівля і план ходу. Бачать лише те, що бачить їхня команда.
import * as R from '../../shared/rules.js';
import { dist, cheb } from '../../shared/geom.js';

const GUARD = {
  A: [{ x: 28, y: 7 }, { x: 33, y: 3 }, { x: 27, y: 2 }, { x: 30, y: 6 }],
  B: [{ x: 7, y: 2 }, { x: 9, y: 7 }, { x: 2, y: 7 }, { x: 6, y: 7 }],
  mid: [{ x: 17, y: 7 }, { x: 22, y: 5 }],
};

export function botBuy(m, p) {
  const side = m.sideOf(p);
  const rifle = side === 'T' ? 'ak47' : 'm4a1s';
  const try_ = (item) => m.buy(p.id, item).ok;
  const pistolRound = m.round === 1 || m.round === R.ROUNDS_TOTAL / 2 + 1;
  if (pistolRound) {
    if (m.rng() < 0.6) try_('vest'); else { try_('flash'); try_('he'); }
    return;
  }
  const full = R.WEAPONS[rifle].price + 1000;
  if (!p.primary && p.money >= full) try_(rifle);
  if (p.primary || p.money >= 3500) {
    try_('helmet'); try_('vest');
    if (side === 'CT' && p.money >= 1500) try_('kit');
    if (side === 'CT' && p.money >= 300) try_('smoke');
    const nades = ['smoke', 'flash', 'he', 'molly'];
    for (const n of nades) if (p.money >= 1200 && m.rng() < 0.6) try_(n);
  }
}

function teamMemory(m, side) {
  const key = side + m.round;
  if (!m.botMemory[key]) m.botMemory[key] = { site: m.rng() < 0.5 ? 'A' : 'B', lastSeen: {}, alert: null };
  return m.botMemory[key];
}

function siteTiles(m, site) { return m.grid.tilesOf(site); }

function stepToward(m, p, target, steps) {
  if (!target) return [];
  const path = m.grid.path(p.x, p.y, target.x, target.y);
  return path ? path.slice(0, steps) : [];
}

function pick(m, arr) { return arr[Math.floor(m.rng() * arr.length)]; }

export function botPlan(m, p) {
  const side = m.sideOf(p);
  const mem = teamMemory(m, side);
  const seenIds = m.squadSees(p.squad);
  const visibleEnemies = m.enemies(p).filter((q) => seenIds.has(q.id));
  const mine = m.visibleEnemies(p);
  for (const q of visibleEnemies) mem.lastSeen[q.id] = { x: q.x, y: q.y, turn: m.turn };
  if (visibleEnemies.length && !mem.alert) mem.alert = { x: visibleEnemies[0].x, y: visibleEnemies[0].y };
  // чуємо кроки ворогів
  for (const e of m.lastEvents || []) {
    if (e.type === 'noise' && e.squad !== p.squad && dist(p, e) <= 14 && !mem.alert) mem.alert = { x: e.x, y: e.y };
  }

  // гранати в контакті
  const plan = { mode: 'walk', path: [], grenade: null, action: null };
  const inSmoke = m.bomb.state === 'planted' && m.smokeAt(m.bomb.x, m.bomb.y);
  if (m.canDefuse(p) && (!mine.length || inSmoke || m.bomb.timer <= 2 || p.kit)) return { action: 'defuse' };
  // ретейк: дим на бомбу і заходимо
  if (side === 'CT' && m.bomb.state === 'planted' && p.nades.smoke && !inSmoke
    && dist(p, m.bomb) <= R.THROW_RANGE && m.grid.los(p.x, p.y, m.bomb.x, m.bomb.y)) {
    return { mode: 'walk', path: stepToward(m, p, m.bomb, 1), grenade: { type: 'smoke', x: m.bomb.x, y: m.bomb.y } };
  }
  if (side === 'CT' && inSmoke && dist(p, m.bomb) <= 6) {
    return { mode: 'dodge', path: stepToward(m, p, m.bomb, 2) };
  }
  if (m.canPlant(p) && !mine.length) return { action: 'plant' };

  if (mine.length) {
    const target = mine.sort((a, b) => dist(p, a) - dist(p, b))[0];
    const nade = ['he', 'molly', 'flash'].find((n) => p.nades[n] > 0);
    if (nade && m.rng() < 0.45 && dist(p, target) <= R.THROW_RANGE && dist(p, target) > (nade === 'flash' ? 0 : 2.5)
      && m.grid.los(p.x, p.y, target.x, target.y)) {
      plan.grenade = { type: nade, x: target.x, y: target.y };
    }
    if (p.hp < 35 && m.rng() < 0.5) {
      // відступити за ріг
      const back = retreat(m, p, mine);
      return { mode: 'dodge', path: back, grenade: plan.grenade };
    }
    // ретейк з флешкою
    if (side === 'CT' && m.bomb.state === 'planted' && p.nades.flash && dist(p, target) <= R.THROW_RANGE && m.grid.los(p.x, p.y, target.x, target.y)) {
      return { mode: 'walk', path: [], grenade: { type: 'flash', x: target.x, y: target.y } };
    }
    // ретейк: бомба скоро вибухне — йдемо на неї, ухиляючись
    if (side === 'CT' && m.bomb.state === 'planted' && m.bomb.timer <= 3) {
      return { mode: 'dodge', path: stepToward(m, p, m.bomb, plan.grenade ? 1 : 2), grenade: plan.grenade };
    }
    if (m.rng() < 0.15) return { mode: 'dodge', path: [], grenade: plan.grenade };
    return { mode: 'hold', path: [], grenade: plan.grenade };
  }

  let goal = null, mode = 'run';
  if (side === 'T') {
    if (m.bomb.state === 'dropped') {
      const ts = m.aliveOf('T').sort((a, b) => dist(a, m.bomb) - dist(b, m.bomb));
      if (ts[0] && ts[0].id === p.id) goal = { x: m.bomb.x, y: m.bomb.y };
    }
    if (!goal && m.bomb.state === 'planted') {
      if (cheb(p, m.bomb) <= 4) return { mode: 'hold' };
      goal = { x: m.bomb.x, y: m.bomb.y };
    }
    if (!goal) {
      const tiles = siteTiles(m, mem.site);
      if (!mem.targets) mem.targets = {};
      if (!mem.targets[p.id]) mem.targets[p.id] = p.bomb ? tiles[Math.floor(tiles.length / 2)] : pick(m, tiles);
      if (p.bomb) mem.targets[p.id] = tiles.find((t) => m.grid.site(t.x, t.y)) && nearestOf(p, tiles);
      goal = mem.targets[p.id];
      // чекати на тіммейтів біля входу, якщо інші відстали
      if (m.grid.site(p.x, p.y) && !p.bomb) return { mode: 'hold' };
    }
    const d = goal ? dist(p, goal) : 0;
    if (d < 9) mode = 'walk';
    if (d < 9 && m.turn < 4 && m.rng() < 0.3) mode = 'hold';
  } else {
    if (m.bomb.state === 'planted') goal = { x: m.bomb.x, y: m.bomb.y };
    else {
      if (!mem.posts) {
        mem.posts = {};
        const cts = m.team('CT');
        const order = m.rng() < 0.5 ? ['A', 'B', 'mid'] : ['B', 'A', 'mid'];
        cts.forEach((c, i) => { mem.posts[c.id] = pick(m, GUARD[order[i % order.length]]); });
      }
      goal = mem.posts[p.id] || GUARD.A[0];
      // підмога, якщо команда когось помітила
      if (mem.alert && mem.alert.y < 16) {
        const sideSite = mem.alert.x > 18 ? 'A' : 'B';
        if (!mem.rotated) mem.rotated = {};
        if (mem.rotated[p.id] === undefined) mem.rotated[p.id] = m.rng() < 0.7 ? pick(m, GUARD[sideSite]) : null;
        if (mem.rotated[p.id]) goal = mem.rotated[p.id];
      }
      if (goal && p.x === goal.x && p.y === goal.y) return { mode: 'hold' };
    }
    const d = goal ? dist(p, goal) : 0;
    mode = d < (m.bomb.state === 'planted' ? 9 : 4) ? 'walk' : 'run';
  }
  // запасна граната — дим на вхід на точку
  if (side === 'T' && p.nades.smoke && m.turn > 3 && m.rng() < 0.15) {
    const s = siteTiles(m, mem.site);
    const tgt = s[Math.floor(s.length / 2)];
    if (dist(p, tgt) <= R.THROW_RANGE && m.grid.los(p.x, p.y, tgt.x, tgt.y)) plan.grenade = { type: 'smoke', x: tgt.x, y: tgt.y };
  }
  const steps = R.MODES[mode].steps - (plan.grenade && mode !== 'hold' ? 1 : 0);
  return { mode, path: stepToward(m, p, goal, steps), grenade: plan.grenade };
}

function nearestOf(p, tiles) {
  let best = tiles[0], bd = Infinity;
  for (const t of tiles) { const d = dist(p, t); if (d < bd) { bd = d; best = t; } }
  return best;
}

function retreat(m, p, enemies) {
  let best = [], bestScore = -1;
  for (const n of m.grid.neighbors(p.x, p.y)) {
    for (const n2 of [n, ...m.grid.neighbors(n.x, n.y)]) {
      const hidden = enemies.filter((e) => !m.grid.los(e.x, e.y, n2.x, n2.y)).length;
      const score = hidden * 10 + Math.min(...enemies.map((e) => dist(e, n2)));
      if (score > bestScore) {
        bestScore = score;
        best = n2 === n ? [n] : [n, n2];
      }
    }
  }
  return best;
}
