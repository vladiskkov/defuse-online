// Боти: закупівля, хід руху і рішення в дуелі. Бачать лише те, що бачить їхня команда.
import * as R from '../../shared/rules.js';
import { dist, cheb } from '../../shared/geom.js';

export const GUARD = {
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
  if (!p.primary && p.money >= R.WEAPONS[rifle].price + 1000) try_(rifle);
  if (p.primary || p.money >= 3500) {
    try_('helmet'); try_('vest');
    if (side === 'CT' && p.money >= 1500) try_('kit');
    if (p.money >= 300) try_('smoke');
    for (const n of ['flash', 'he', 'molly']) if (p.money >= 1000 && m.rng() < 0.5) try_(n);
  }
}

function memory(m, side) {
  const key = side + m.round;
  if (!m.botMemory[key]) m.botMemory[key] = { site: m.rng() < 0.5 ? 'A' : 'B', alert: null, posts: null, rotated: {}, targets: {} };
  return m.botMemory[key];
}

const pick = (m, arr) => arr[Math.floor(m.rng() * arr.length)];
function nearestOf(p, tiles) {
  let best = tiles[0], bd = Infinity;
  for (const t of tiles) { const d = dist(p, t); if (d < bd) { bd = d; best = t; } }
  return best;
}
function route(m, p, goal, steps) {
  if (!goal) return [];
  const path = m.grid.path(p.x, p.y, goal.x, goal.y);
  return path ? path.slice(0, steps) : [];
}

// Хід руху
export function botPlan(m, p) {
  const side = m.sideOf(p);
  const mem = memory(m, side);
  for (const e of m.lastEvents || []) {
    if ((e.type === 'noise' && e.squad !== p.squad && dist(p, e) <= 14) || (e.type === 'contact')) {
      if (!mem.alert) mem.alert = { x: e.x ?? e.ax, y: e.y ?? e.ay };
    }
  }
  if (m.canDefuse(p)) return { action: 'defuse' };
  if (m.canPlant(p)) return { action: 'plant' };

  let goal = null, quiet = false;
  if (side === 'T') {
    if (m.bomb.state === 'dropped') {
      const ts = m.aliveOf('T').sort((a, b) => dist(a, m.bomb) - dist(b, m.bomb));
      if (ts[0] && ts[0].id === p.id) goal = { x: m.bomb.x, y: m.bomb.y };
    }
    if (!goal && m.bomb.state === 'planted') {
      if (cheb(p, m.bomb) <= 4) return { path: [] }; // тримаємо бомбу
      goal = { x: m.bomb.x, y: m.bomb.y };
    }
    if (!goal) {
      const tiles = m.grid.tilesOf(mem.site);
      if (p.bomb) goal = nearestOf(p, tiles);
      else {
        if (!mem.targets[p.id]) mem.targets[p.id] = pick(m, tiles);
        goal = mem.targets[p.id];
        if (m.grid.site(p.x, p.y)) return { path: [] };
      }
    }
    const d = dist(p, goal);
    quiet = d < 10 && m.rng() < 0.5;
    // дим на точку перед заходом
    if (p.nades.smoke && d < 11 && d > 5 && m.rng() < 0.35) {
      const ts = m.grid.tilesOf(mem.site);
      const tgt = ts[Math.floor(ts.length / 2)];
      if (m.validThrow(p, tgt)) return { quiet, grenade: { type: 'smoke', x: tgt.x, y: tgt.y }, path: route(m, p, goal, (quiet ? R.MOVE_QUIET : R.MOVE_FAST) - R.NADE_MOVE_COST) };
    }
  } else {
    if (m.bomb.state === 'planted') {
      goal = { x: m.bomb.x, y: m.bomb.y };
      quiet = dist(p, goal) < 8;
      if (p.nades.smoke && dist(p, goal) <= R.THROW_RANGE && m.validThrow(p, goal) && m.rng() < 0.6) {
        return { quiet, grenade: { type: 'smoke', x: goal.x, y: goal.y }, path: route(m, p, goal, (quiet ? R.MOVE_QUIET : R.MOVE_FAST) - R.NADE_MOVE_COST) };
      }
    } else {
      if (!mem.posts) {
        mem.posts = {};
        const order = m.rng() < 0.5 ? ['A', 'B', 'mid'] : ['B', 'A', 'mid'];
        m.team('CT').forEach((c, i) => { mem.posts[c.id] = pick(m, GUARD[order[i % order.length]]); });
      }
      goal = mem.posts[p.id] || GUARD.A[0];
      if (mem.alert) {
        const site = mem.alert.x > 18 ? 'A' : 'B';
        if (mem.rotated[p.id] === undefined) mem.rotated[p.id] = m.rng() < 0.7 ? pick(m, GUARD[site]) : null;
        if (mem.rotated[p.id]) goal = mem.rotated[p.id];
      }
      if (p.x === goal.x && p.y === goal.y) return { path: [] };
      quiet = dist(p, goal) < 4;
    }
  }
  return { quiet, path: route(m, p, goal, quiet ? R.MOVE_QUIET : R.MOVE_FAST) };
}

// Рішення в дуелі (потім бот сам «кидає» кубики)
export function botDuel(m, p) {
  const enemies = m.visibleEnemies(p);
  if (!enemies.length) return { action: 'hide' };
  const target = enemies.slice().sort((a, b) => a.hp - b.hp || dist(p, a) - dist(p, b))[0];
  if (m.canDefuse(p) && (p.kit || m.bomb.clock <= R.DUEL_TIME * 2 || m.smokeAt(m.bomb.x, m.bomb.y))) return { action: 'defuse' };
  if (p.hp < 35 && m.rng() < 0.45) {
    const opts = m.hideOptions(p, enemies, m.grid.neighbors(p.x, p.y));
    if (opts[0] && opts[0].safe > 0) return { action: 'hide', x: opts[0].x, y: opts[0].y };
  }
  if (m.duelRound === 1 && p.nades.flash && m.rng() < 0.25 && m.validThrow(p, target) && dist(p, target) > 2) return { action: 'nade:flash', x: target.x, y: target.y };
  if (p.nades.he && target.hp < 60 && m.rng() < 0.3 && m.validThrow(p, target) && dist(p, target) > 2.5) return { action: 'nade:he', x: target.x, y: target.y };
  if (p.nades.molly && m.rng() < 0.15 && m.validThrow(p, target) && dist(p, target) > 2) return { action: 'nade:molly', x: target.x, y: target.y };
  return { action: 'shoot', target: target.id };
}

export function botAct(m, p) {
  if (m.phase === 'move') m.setPlan(p.id, { ...botPlan(m, p), ready: true });
  else if (m.phase === 'duel' && p.duel && !p.duel.ready) {
    const r = m.duelAct(p.id, botDuel(m, p));
    if (!r.ok) m.duelAct(p.id, { action: 'shoot' });
    m.duelRoll(p.id);
  }
}
