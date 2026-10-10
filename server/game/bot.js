// Боти настільного режиму: закупівля, хід і рішення в перестрілці.
import * as R from '../../shared/rules.js';
import { ZONE, zonePath, zoneDist } from '../../shared/zones.js';

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
    for (const n of ['flash', 'smoke', 'he', 'molly']) if (p.money >= 700 && m.rng() < 0.45) try_(n);
  }
}

function memory(m, side) {
  const key = side + m.round;
  if (!m.botMemory[key]) m.botMemory[key] = { site: m.rng() < 0.5 ? 'asite' : 'bsite', route: null, posts: null, alert: null, rotated: {} };
  return m.botMemory[key];
}

const pick = (m, a) => a[Math.floor(m.rng() * a.length)];
const step = (from, to) => { const p = zonePath(from, to); return p && p.length ? p[0] : null; };

export function botPlan(m, p) {
  const side = m.sideOf(p);
  const mem = memory(m, side);
  for (const e of m.lastEvents || []) if (e.type === 'noise' && e.squad !== p.squad && !mem.alert) mem.alert = e.zone;
  if (m.canDefuse(p)) return { action: 'defuse' };
  if (m.canPlant(p)) return { action: 'plant' };
  let goal = null, nade = null;
  if (side === 'T') {
    if (m.bomb.state === 'dropped') goal = m.bomb.zone;
    else if (m.bomb.state === 'planted') goal = m.bomb.zone;
    else goal = mem.site;
    // чекаємо команду біля входу на точку, якщо інші відстали
    const next = step(p.zone, goal);
    if (next && ZONE[next].site && !p.bomb && m.rng() < 0.3) return { action: 'hold' };
    // граната в зону, куди заходимо
    if (next && ZONE[next].site) {
      const n = ['flash', 'smoke', 'he'].find((k) => p.nades[k] > 0);
      if (n && m.rng() < 0.6) nade = { type: n, zone: next };
    }
    if (p.zone === goal) return { action: 'hold', nade };
    return { action: 'move', to: next, nade };
  }
  // CT
  if (m.bomb.state === 'planted') {
    const next = step(p.zone, m.bomb.zone);
    if (next === m.bomb.zone && p.nades.smoke && m.rng() < 0.5) nade = { type: 'smoke', zone: next };
    return next ? { action: 'move', to: next, nade } : { action: 'hold' };
  }
  if (!mem.posts) {
    mem.posts = {};
    const order = m.rng() < 0.5 ? ['asite', 'bsite', 'ctmid'] : ['bsite', 'asite', 'ctmid'];
    m.team('CT').forEach((c, i) => { mem.posts[c.id] = order[i % order.length]; });
  }
  goal = mem.posts[p.id] || 'asite';
  if (mem.alert) {
    const site = zoneDist(mem.alert, 'asite') <= zoneDist(mem.alert, 'bsite') ? 'asite' : 'bsite';
    if (mem.rotated[p.id] === undefined) mem.rotated[p.id] = m.rng() < 0.6 ? site : null;
    if (mem.rotated[p.id]) goal = mem.rotated[p.id];
  }
  if (p.zone === goal) {
    // молотов або осколкова в сусідню зону, звідки чути кроки
    if (mem.alert && ZONE[p.zone].adj.includes(mem.alert)) {
      const n = ['molly', 'he', 'flash'].find((k) => p.nades[k] > 0);
      if (n && m.rng() < 0.5) nade = { type: n, zone: mem.alert };
    }
    return { action: 'hold', nade };
  }
  return { action: 'move', to: step(p.zone, goal) };
}

export function botDuel(m, p) {
  const enemies = m.enemiesIn(p);
  if (p.hp === 1 && enemies.length > 1 && m.retreatZone(p) && m.rng() < 0.5) return { action: 'retreat' };
  const target = enemies.slice().sort((a, b) => a.hp - b.hp)[0];
  return { action: 'shoot', target: target && target.id };
}

export function botAct(m, p) {
  if (m.phase === 'move') m.setPlan(p.id, { ...botPlan(m, p), ready: true });
  else if (m.phase === 'duel' && p.fight && !p.fight.ready) { m.duelAct(p.id, botDuel(m, p)); m.duelRoll(p.id); }
}
