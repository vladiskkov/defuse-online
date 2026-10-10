// Боти для гекс-настолки: закупівля і дії в активації. Бачать лише те, що бачить їхня команда.
import * as R from '../../shared/rules.js';
import * as X from '../../shared/hex.js';

export function botBuy(m, p) {
  const side = m.sideOf(p);
  const rifle = side === 'T' ? 'ak47' : 'm4a1s';
  const try_ = (item) => m.buy(p.id, item).ok;
  const pistolRound = m.round === 1 || m.round === R.ROUNDS_TOTAL / 2 + 1;
  if (pistolRound) { if (m.rng() < 0.6) try_('vest'); else try_('flash'); return; }
  if (!p.primary && p.money >= R.WEAPONS[rifle].price + 650) try_(rifle);
  if (p.primary || p.money >= 3000) {
    try_('helmet'); try_('vest');
    if (side === 'CT' && p.money >= 1200) try_('kit');
    for (const n of ['flash', 'smoke', 'he', 'molly']) if (p.money >= 700 && m.rng() < 0.4) try_(n);
  }
}

function memory(m, side) {
  const key = side + m.round;
  if (!m.botMemory[key]) m.botMemory[key] = { site: m.rng() < 0.5 ? 'A' : 'B', posts: {}, alert: null };
  return m.botMemory[key];
}

// найближчий гекс із набору (за кроками)
function stepToward(m, p, goals) {
  const start = m.hexOf(p);
  const { dist, prev } = X.reach(start, 60, (h) => m.occupied(h, p));
  let best = null, bd = Infinity;
  for (const g of goals) {
    const d = dist.get(X.key(g.c, g.r));
    if (d !== undefined && d < bd) { bd = d; best = g; }
  }
  if (!best || bd === 0) return null;
  // перший відрізок шляху довжиною MOVE
  const path = [];
  let cur = best;
  while (cur !== start) { path.unshift(cur); cur = prev.get(X.key(cur.c, cur.r)); }
  return path[Math.min(R.MOVE, path.length) - 1];
}

export function botAction(m, p) {
  const side = m.sideOf(p);
  const mem = memory(m, side);
  const enemies = m.visibleEnemies(p);
  for (const e of m.events.slice(-20)) if (e.type === 'noise' && e.squad !== p.squad) mem.alert = e.hex;

  if (m.canDefuse(p) && p.ap >= (p.kit ? 1 : 2)) return { type: 'defuse' };
  if (m.canPlant(p) && p.ap >= 2 && !enemies.length) return { type: 'plant' };
  // стріляємо, якщо видно ворога
  if (enemies.length && !p.shot && p.ap >= 1) {
    const t = enemies.slice().sort((a, b) => a.hp - b.hp)[0];
    // граната, якщо ворог далеко або за укриттям
    const th = m.hexOf(t), me = m.hexOf(p);
    const nade = ['he', 'flash', 'molly'].find((k) => p.nades[k] > 0);
    if (nade && m.rng() < 0.3 && X.hexDist(me, th) <= R.THROW_RANGE && X.hexDist(me, th) > 1 && X.clearLine(me, th)) return { type: 'nade', nade, c: th.c, r: th.r };
    return { type: 'shoot', target: t.id };
  }
  if (enemies.length && p.ap >= 1) return { type: 'overwatch' };

  let goals;
  if (side === 'T') {
    if (m.bomb.state === 'dropped') goals = [X.HEXES.get(m.bomb.hex)];
    else if (m.bomb.state === 'planted') {
      const bh = X.HEXES.get(m.bomb.hex);
      if (X.hexDist(m.hexOf(p), bh) <= 3) return { type: 'overwatch' };
      goals = [bh];
    } else {
      goals = X.FLOOR.filter((h) => h.site === mem.site);
      if (!p.bomb && m.hexOf(p).site) return { type: 'overwatch' };
    }
  } else {
    if (m.bomb.state === 'planted') {
      const bh = X.HEXES.get(m.bomb.hex);
      goals = [bh, ...X.neighbors(bh)];
    } else {
      if (!mem.posts[p.id]) {
        const cts = m.team('CT');
        const order = m.rng() < 0.5 ? ['A', 'B', 'A'] : ['B', 'A', 'B'];
        cts.forEach((c, i) => { const s = X.FLOOR.filter((h) => h.site === order[i % 3]); mem.posts[c.id] = s[Math.floor(m.rng() * s.length)]; });
      }
      const post = mem.posts[p.id];
      if (m.hexOf(p) === post || (m.hexOf(p).site && X.hexDist(m.hexOf(p), post) <= 2)) return { type: 'overwatch' };
      goals = [post];
    }
  }
  const to = stepToward(m, p, goals);
  if (!to) return p.ap >= 1 ? { type: 'overwatch' } : { type: 'end' };
  return { type: 'move', c: to.c, r: to.r };
}

// хід бота: дія або кидок
export function botStep(m) {
  const w = m.waitingFor();
  if (!w) return false;
  const p = m.get(w.id);
  if (!p) return false;
  if (w.kind === 'act') {
    const r = m.act(p.id, botAction(m, p));
    if (!r.ok) m.act(p.id, p.ap >= 1 ? { type: 'overwatch' } : { type: 'end' });
  } else m.roll(p.id);
  return true;
}
