// Рушій матчу «Дефуз»: раунди, закупівля, одночасні ходи, дуелі на кубиках, бомба.
// Чистий код без мережі: кімната (rooms.js) керує таймерами і розсилає стани.
import { Grid, dist, cheb } from '../../shared/geom.js';
import * as R from '../../shared/rules.js';
import { DUNE } from '../../shared/map.js';

export const MAPS = { dune: DUNE };
const SIDES = ['T', 'CT'];
const NADE_ORDER = ['smoke', 'molly', 'flash', 'he'];

function rollDice([n, faces, bonus], rng) {
  let s = bonus;
  const rolls = [];
  for (let i = 0; i < n; i++) { const r = 1 + Math.floor(rng() * faces); rolls.push(r); s += r; }
  return { total: s, rolls };
}

export class Match {
  constructor({ players, mapId = 'dune', rng = Math.random }) {
    this.map = MAPS[mapId];
    this.grid = new Grid(this.map);
    this.rng = rng;
    this.players = players.map((p) => ({
      id: p.id, name: p.name, isBot: !!p.isBot, squad: p.squad,
      money: R.ECONOMY.start, hp: R.HP, alive: true, x: 0, y: 0,
      pistol: null, primary: null, armor: 0, kit: false,
      nades: { he: 0, flash: 0, smoke: 0, molly: 0 },
      bomb: false, kills: 0, deaths: 0, connected: true,
    }));
    this.score = [0, 0];
    this.lossStreak = [0, 0];
    this.round = 0;
    this.half = 0;
    this.phase = 'idle';
    this.history = [];        // результати раундів
    this.lastEvents = [];
    this.botMemory = {};
  }

  /* ---------- допоміжне ---------- */
  get(id) { return this.players.find((p) => p.id === id); }
  sideOf(p) { return (p.squad === 0) === (this.half === 0) ? 'T' : 'CT'; }
  squadOfSide(side) { return (side === 'T') === (this.half === 0) ? 0 : 1; }
  team(side) { return this.players.filter((p) => this.sideOf(p) === side); }
  aliveOf(side) { return this.team(side).filter((p) => p.alive); }
  enemies(p) { return this.players.filter((q) => q.alive && q.squad !== p.squad); }
  weapon(p) { return R.WEAPONS[p.primary || p.pistol]; }
  smokeAt(x, y) { return this.smokeTiles.has(x + ',' + y); }
  fireAt(x, y) { return this.fireTiles.has(x + ',' + y); }
  los(a, b) { return this.grid.los(a.x, a.y, b.x, b.y, (x, y) => this.smokeAt(x, y)); }
  nadeCount(p) { return Object.values(p.nades).reduce((a, b) => a + b, 0); }

  rebuildAreas() {
    this.smokeTiles = new Set();
    for (const s of this.smokes) for (const k of s.tiles) this.smokeTiles.add(k);
    this.fireTiles = new Set();
    for (const f of this.fires) for (const k of f.tiles) this.fireTiles.add(k);
  }

  areaTiles(cx, cy, radius, round) {
    const out = [];
    const r = Math.ceil(radius);
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if (this.grid.opaque(x, y)) continue;
      const inside = round ? Math.hypot(x - cx, y - cy) <= radius + 0.3 : cheb({ x, y }, { x: cx, y: cy }) <= radius;
      if (!inside) continue;
      if (!this.grid.los(cx, cy, x, y)) continue;
      out.push(x + ',' + y);
    }
    return out;
  }

  /* ---------- раунд ---------- */
  startRound() {
    this.round += 1;
    if (this.round === R.ROUNDS_TOTAL / 2 + 1) this.halftime();
    const pistolRound = this.round === 1 || this.round === R.ROUNDS_TOTAL / 2 + 1;
    this.phase = 'buy';
    this.turn = 0;
    this.smokes = []; this.fires = [];
    this.rebuildAreas();
    this.bomb = { state: 'carried', x: 0, y: 0, timer: 0, defuser: null, progress: 0, site: null };
    this.planted = false;
    this.roundResult = null;
    this.lastEvents = [];
    this.botMemory = {};
    for (const side of SIDES) {
      const spawns = this.grid.tilesOf(side === 'T' ? 'T' : 'C').filter((t) => this.grid.walkable(t.x, t.y));
      shuffle(spawns, this.rng);
      // спавни тримаємо компактно: беремо клітинки ближче до центру спавну
      const cx = spawns.reduce((a, t) => a + t.x, 0) / spawns.length;
      const cy = spawns.reduce((a, t) => a + t.y, 0) / spawns.length;
      spawns.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
      const pool = spawns.slice(0, 10);
      shuffle(pool, this.rng);
      this.team(side).forEach((p, i) => {
        if (!p.alive || pistolRound) { // загиблі втрачають спорядження
          p.primary = null; p.armor = 0; p.kit = false;
          p.nades = { he: 0, flash: 0, smoke: 0, molly: 0 };
          p.pistol = null;
        }
        if (!p.pistol || R.WEAPONS[p.pistol].side && R.WEAPONS[p.pistol].side !== side) p.pistol = side === 'T' ? 'glock' : 'usp';
        p.hp = R.HP; p.alive = true; p.bomb = false;
        p.x = pool[i % pool.length].x; p.y = pool[i % pool.length].y;
        p.plan = null; p.ready = false; p.bought = []; p.blind = 0;
      });
    }
    const ts = this.team('T');
    if (ts.length) ts[Math.floor(this.rng() * ts.length)].bomb = true;
  }

  halftime() {
    this.half = 1;
    this.lossStreak = [0, 0];
    for (const p of this.players) {
      p.money = R.ECONOMY.start; p.primary = null; p.pistol = null; p.armor = 0; p.kit = false;
      p.nades = { he: 0, flash: 0, smoke: 0, molly: 0 };
    }
  }

  /* ---------- закупівля ---------- */
  buy(id, item) {
    const p = this.get(id);
    if (!p || this.phase !== 'buy') return { ok: false, error: 'Зараз не час закупівлі' };
    const side = this.sideOf(p);
    let price, apply;
    if (R.WEAPONS[item]) {
      const w = R.WEAPONS[item];
      if (!R.sideCanBuy(w.side, side)) return { ok: false, error: 'Ця зброя для іншої сторони' };
      if (p[w.slot] === item) return { ok: false, error: 'Вже є' };
      price = w.price;
      const prev = p[w.slot];
      apply = () => { p[w.slot] = item; return () => { p[w.slot] = prev; }; };
    } else if (R.GRENADES[item]) {
      if (p.nades[item] >= 1) return { ok: false, error: 'Можна мати лише одну таку гранату' };
      if (this.nadeCount(p) >= R.MAX_GRENADES) return { ok: false, error: 'Максимум 3 гранати' };
      price = R.GRENADES[item].price;
      apply = () => { p.nades[item] += 1; return () => { p.nades[item] -= 1; }; };
    } else if (item === 'vest' || item === 'helmet') {
      const lvl = item === 'vest' ? 1 : 2;
      if (p.armor >= lvl) return { ok: false, error: 'Вже є' };
      price = item === 'helmet' && p.armor === 1 ? 350 : R.GEAR[item].price;
      const prev = p.armor;
      apply = () => { p.armor = lvl; return () => { p.armor = prev; }; };
    } else if (item === 'kit') {
      if (side !== 'CT') return { ok: false, error: 'Лише для CT' };
      if (p.kit) return { ok: false, error: 'Вже є' };
      price = R.GEAR.kit.price;
      apply = () => { p.kit = true; return () => { p.kit = false; }; };
    } else return { ok: false, error: 'Невідомий предмет' };
    if (p.money < price) return { ok: false, error: 'Не вистачає грошей' };
    p.money -= price;
    const undo = apply();
    p.bought.push({ price, undo });
    return { ok: true };
  }

  refund(id) {
    const p = this.get(id);
    if (!p || this.phase !== 'buy') return { ok: false };
    while (p.bought.length) { const b = p.bought.pop(); b.undo(); p.money += b.price; }
    return { ok: true };
  }

  endBuy() {
    for (const p of this.players) { p.bought = []; p.ready = false; }
    this.phase = 'plan';
    this.turn = 1;
    for (const p of this.players) { p.plan = null; p.ready = false; }
  }

  /* ---------- планування ---------- */
  setPlan(id, raw) {
    const p = this.get(id);
    if (!p || !p.alive || this.phase !== 'plan') return { ok: false };
    p.plan = this.normalizePlan(p, raw || {});
    p.ready = !!(raw && raw.ready);
    return { ok: true, plan: p.plan };
  }

  canPlant(p) { return p.alive && p.bomb && this.sideOf(p) === 'T' && !!this.grid.site(p.x, p.y); }
  canDefuse(p) { return p.alive && this.sideOf(p) === 'CT' && this.bomb.state === 'planted' && cheb(p, this.bomb) <= 1; }

  normalizePlan(p, raw) {
    const plan = { mode: R.MODES[raw.mode] ? raw.mode : 'hold', path: [], grenade: null, action: null };
    if (raw.action === 'plant' && this.canPlant(p)) plan.action = 'plant';
    if (raw.action === 'defuse' && this.canDefuse(p)) plan.action = 'defuse';
    if (plan.action) { plan.mode = 'hold'; return plan; }
    const g = raw.grenade;
    if (g && R.GRENADES[g.type] && p.nades[g.type] > 0 && Number.isInteger(g.x) && Number.isInteger(g.y)
      && !this.grid.opaque(g.x, g.y) && dist(p, g) <= R.THROW_RANGE + 0.01 && this.grid.los(p.x, p.y, g.x, g.y)) {
      plan.grenade = { type: g.type, x: g.x, y: g.y };
    }
    let steps = R.MODES[plan.mode].steps - (plan.grenade && plan.mode !== 'hold' ? 1 : 0);
    let cx = p.x, cy = p.y;
    if (Array.isArray(raw.path)) {
      for (const s of raw.path.slice(0, Math.max(0, steps))) {
        if (!s || !Number.isInteger(s.x) || !Number.isInteger(s.y)) break;
        if (!this.grid.neighbors(cx, cy).some((n) => n.x === s.x && n.y === s.y)) break;
        plan.path.push({ x: s.x, y: s.y });
        cx = s.x; cy = s.y;
      }
    }
    return plan;
  }

  allReady() { return this.players.filter((p) => p.alive && !p.isBot && p.connected).every((p) => p.ready); }

  /* ---------- розіграш ходу ---------- */
  resolveTurn() {
    const ev = [];
    this.events = ev;
    const alive = this.players.filter((p) => p.alive);
    const st = new Map();
    for (const p of alive) {
      const plan = p.plan || this.normalizePlan(p, {});
      st.set(p.id, { plan, path: plan.path.slice(), moved: 0, shots: this.weapon(p).shots, stopped: false, busy: !!plan.action, hurt: false });
    }
    this.st = st;
    this.seen = new Set();
    this.seenAt = new Map();
    this.visLog = [];

    // такт 0: гранати
    const throws = alive.filter((p) => st.get(p.id).plan.grenade)
      .sort((a, b) => NADE_ORDER.indexOf(st.get(a.id).plan.grenade.type) - NADE_ORDER.indexOf(st.get(b.id).plan.grenade.type));
    for (const p of throws) if (p.alive) this.throwNade(p, st.get(p.id).plan.grenade);
    this.fireTick(0);
    this.combat(0);

    for (let t = 1; t <= R.MAX_STEPS; t++) {
      for (const p of alive) {
        const s = st.get(p.id);
        if (!p.alive || s.stopped || !s.path.length) continue;
        const next = s.path.shift();
        p.x = next.x; p.y = next.y; s.moved += 1;
        ev.push({ t, type: 'move', id: p.id, x: p.x, y: p.y });
        if (this.bomb.state === 'dropped' && this.sideOf(p) === 'T' && p.x === this.bomb.x && p.y === this.bomb.y) {
          this.bomb.state = 'carried'; p.bomb = true;
          ev.push({ t, type: 'pickup', id: p.id });
        }
      }
      this.fireTick(t);
      this.combat(t);
    }
    const T_END = R.MAX_STEPS + 1;

    // шум кроків
    for (const p of alive) {
      const s = st.get(p.id);
      if (p.alive && s.moved > 0 && R.MODES[s.plan.mode].noisy) ev.push({ t: T_END, type: 'noise', id: p.id, x: p.x, y: p.y, squad: p.squad });
    }

    // закладка / розмінування
    for (const p of alive) {
      const s = st.get(p.id);
      if (!p.alive) continue;
      if (s.plan.action === 'plant' && p.bomb && this.grid.site(p.x, p.y)) {
        p.bomb = false;
        Object.assign(this.bomb, { state: 'planted', x: p.x, y: p.y, timer: R.BOMB_TURNS, site: this.grid.site(p.x, p.y), justPlanted: true, planter: p.id });
        this.planted = true;
        ev.push({ t: T_END, type: 'planted', id: p.id, x: p.x, y: p.y, site: this.bomb.site });
      }
    }
    let defusedNow = false;
    if (this.bomb.state === 'planted' && !this.bomb.justPlanted) {
      const defusers = alive.filter((p) => p.alive && st.get(p.id).plan.action === 'defuse');
      const d = defusers.find((p) => p.id === this.bomb.defuser) || defusers[0];
      if (d) {
        this.bomb.progress = this.bomb.defuser === d.id ? this.bomb.progress + 1 : 1;
        this.bomb.defuser = d.id;
        const need = d.kit ? 1 : 2;
        ev.push({ t: T_END, type: 'defusing', id: d.id, progress: this.bomb.progress, need });
        if (this.bomb.progress >= need) { this.bomb.state = 'defused'; defusedNow = true; ev.push({ t: T_END, type: 'defused', id: d.id }); }
      } else { this.bomb.defuser = null; this.bomb.progress = 0; }
      if (!defusedNow) {
        this.bomb.timer -= 1;
        if (this.bomb.timer <= 0) {
          this.bomb.state = 'exploded';
          ev.push({ t: T_END, type: 'exploded', x: this.bomb.x, y: this.bomb.y });
          for (const p of this.players) if (p.alive && dist(p, this.bomb) <= 5) this.hurt(p, 500, null, 'bomb', T_END);
        }
      }
    }
    this.bomb.justPlanted = false;

    // тривалість диму і вогню
    for (const a of [this.smokes, this.fires]) for (const s of a) s.turns -= 1;
    this.smokes = this.smokes.filter((s) => s.turns > 0);
    this.fires = this.fires.filter((s) => s.turns > 0);
    this.rebuildAreas();
    for (const p of this.players) { p.blind = 0; p.plan = null; p.ready = false; }

    this.lastEvents = ev;
    this.lastVis = this.visLog;
    const end = this.checkRoundEnd();
    if (end) this.finishRound(end);
    else this.turn += 1;
    return { events: ev, roundEnd: end };
  }

  throwNade(p, g) {
    p.nades[g.type] -= 1;
    const e = { t: 0, type: 'nade', by: p.id, squad: p.squad, nade: g.type, x: g.x, y: g.y, fx: p.x, fy: p.y };
    this.events.push(e);
    if (g.type === 'smoke') {
      this.smokes.push({ x: g.x, y: g.y, turns: R.GRENADES.smoke.turns, tiles: this.areaTiles(g.x, g.y, R.GRENADES.smoke.radius, true) });
      this.rebuildAreas();
    } else if (g.type === 'molly') {
      // дим гасить вогонь
      const tiles = this.areaTiles(g.x, g.y, 1, false).filter((k) => !this.smokeTiles.has(k));
      this.fires.push({ x: g.x, y: g.y, turns: R.GRENADES.molly.turns, tiles, by: p.id });
      this.rebuildAreas();
    } else if (g.type === 'flash') {
      e.blinded = [];
      for (const q of this.players) {
        if (!q.alive || q.id === p.id) continue;
        if (dist(q, g) <= R.GRENADES.flash.radius + 0.5 && this.grid.los(g.x, g.y, q.x, q.y, (x, y) => this.smokeAt(x, y))) {
          q.blind = 1; e.blinded.push(q.id);
        }
      }
    } else if (g.type === 'he') {
      e.hits = [];
      for (const q of this.players) {
        if (!q.alive) continue;
        const d = dist(q, g);
        if (d > R.GRENADES.he.radius + 0.5 || !this.grid.los(g.x, g.y, q.x, q.y)) continue;
        let dmg = Math.round((45 - 14 * d) * (q.armor ? 0.55 : 1));
        if (dmg <= 0) continue;
        e.hits.push({ id: q.id, dmg });
        this.hurt(q, dmg, p, 'he', 0);
      }
    }
  }

  fireTick(t) {
    if (!this.fires.length) return;
    for (const p of this.players) {
      if (!p.alive || !this.fireAt(p.x, p.y)) continue;
      const f = this.fires.find((f) => f.tiles.includes(p.x + ',' + p.y));
      this.events.push({ t, type: 'burn', id: p.id, dmg: R.FIRE_DAMAGE });
      this.hurt(p, R.FIRE_DAMAGE, f ? this.get(f.by) : null, 'molly', t);
    }
  }

  visibleEnemies(p) {
    return this.enemies(p).filter((q) => this.los(p, q));
  }

  combat(t) {
    const alive = this.players.filter((p) => p.alive);
    const vis = new Map();
    const squadVis = [new Set(), new Set()];
    const fresh = new Set(); // хто щойно побачив ворога цього такту
    for (const p of alive) {
      const v = this.visibleEnemies(p);
      vis.set(p.id, v);
      for (const q of v) squadVis[p.squad].add(q.id);
      for (const q of v) {
        const key = [p.id, q.id].sort().join('|');
        if (!this.seen.has(key)) { this.seen.add(key); this.events.push({ t, type: 'spot', a: p.id, b: q.id, ax: p.x, ay: p.y, bx: q.x, by: q.y }); }
        if (this.seenAt.get(key) === undefined) this.seenAt.set(key, t);
        if (this.seenAt.get(key) === t) fresh.add(p.id);
      }
    }
    this.visLog[t] = squadVis.map((s) => [...s]);
    const shooters = alive.filter((p) => {
      const s = this.st.get(p.id);
      return s && !s.busy && s.shots > 0 && vis.get(p.id).length;
    });
    // хто тримає кут, стріляє першим лише в момент появи ворога
    const first = (p) => this.st.get(p.id).plan.mode === 'hold' && fresh.has(p.id);
    const groups = [shooters.filter(first), shooters.filter((p) => !first(p))];
    for (const group of groups) {
      const shots = [];
      for (const p of group) {
        if (!p.alive) continue;
        const targets = vis.get(p.id).filter((q) => q.alive);
        if (!targets.length) continue;
        targets.sort((a, b) => dist(p, a) - dist(p, b) || a.hp - b.hp);
        shots.push(this.shoot(p, targets[0], t));
      }
      for (const s of shots) if (s.hit) this.hurt(this.get(s.to), s.dmg, this.get(s.from), s.weapon, t);
    }
    // контакт зупиняє рух (крім ухилення)
    for (const p of alive) {
      const s = this.st.get(p.id);
      if (s && p.alive && s.path.length && s.plan.mode !== 'dodge' && vis.get(p.id).some((q) => q.alive)) {
        s.stopped = true;
        this.events.push({ t, type: 'halt', id: p.id });
      }
    }
  }

  shoot(p, target, t) {
    const s = this.st.get(p.id);
    const ts = this.st.get(target.id);
    const w = this.weapon(p);
    s.shots -= 1;
    const mode = R.MODES[s.plan.mode];
    let acc = w.acc + mode.acc;
    const mods = [[w.name, w.acc]];
    if (mode.acc) mods.push([mode.label, mode.acc]);
    if (p.blind) { acc -= R.FLASH_PENALTY; mods.push(['Осліплений', -R.FLASH_PENALTY]); }
    if (w.scoped && s.moved > 0) { acc -= 6; mods.push(['AWP в русі', -6]); }
    const d = dist(p, target);
    let need = R.BASE_NEED;
    const rangePen = Math.max(0, Math.ceil((d - w.range) / 2));
    if (rangePen) mods.push(['Дистанція', -rangePen]);
    need += rangePen;
    const cover = this.grid.cover(p.x, p.y, target.x, target.y);
    if (cover) { need += R.COVER_BONUS; mods.push(['Укриття', -R.COVER_BONUS]); }
    const tm = R.MODES[ts ? ts.plan.mode : 'hold'];
    const evade = ts && (ts.plan.mode === 'dodge' || ts.moved > 0) ? tm.evade : 0;
    if (evade) { need += evade; mods.push([ts.plan.mode === 'dodge' ? 'Ціль ухиляється' : 'Ціль біжить', -evade]); }
    const roll = 1 + Math.floor(this.rng() * 20);
    const total = roll + acc;
    const hit = roll === 20 || (roll !== 1 && total >= need);
    const head = hit && (roll === 20 || total >= need + 12);
    let dmg = 0, dice = null;
    if (hit) {
      const r = rollDice(w.dice, this.rng);
      dice = r.rolls;
      let base = r.total;
      if (head) { base *= w.head; if (target.armor >= 2) base *= w.pen; }
      else if (target.armor >= 1) base *= w.pen;
      dmg = Math.max(1, Math.round(base));
    }
    const e = { t, type: 'shot', from: p.id, to: target.id, fx: p.x, fy: p.y, tx: target.x, ty: target.y, weapon: p.primary || p.pistol, roll, acc, need, total, hit, head, dmg, dice, mods, d: Math.round(d * 10) / 10 };
    this.events.push(e);
    return e;
  }

  hurt(p, dmg, attacker, cause, t) {
    if (!p.alive) return;
    p.hp = Math.max(0, p.hp - dmg);
    if (p.hp > 0) return;
    p.alive = false; p.deaths += 1;
    const ev = { t, type: 'kill', id: p.id, by: attacker ? attacker.id : null, cause, x: p.x, y: p.y };
    if (attacker && attacker.squad !== p.squad) {
      attacker.kills += 1;
      const reward = R.WEAPONS[cause] ? R.WEAPONS[cause].kill : 300;
      attacker.money = Math.min(R.ECONOMY.max, attacker.money + reward);
      ev.reward = reward;
    }
    this.events.push(ev);
    if (p.bomb) {
      p.bomb = false;
      Object.assign(this.bomb, { state: 'dropped', x: p.x, y: p.y });
      this.events.push({ t, type: 'drop', id: p.id, x: p.x, y: p.y });
    }
    p.primary = null; p.armor = 0; p.kit = false; p.nades = { he: 0, flash: 0, smoke: 0, molly: 0 };
  }

  checkRoundEnd() {
    const tAlive = this.aliveOf('T').length, ctAlive = this.aliveOf('CT').length;
    if (this.bomb.state === 'exploded') return { winner: 'T', reason: 'bomb' };
    if (this.bomb.state === 'defused') return { winner: 'CT', reason: 'defuse' };
    if (!ctAlive) return { winner: 'T', reason: 'elim' };
    if (this.bomb.state !== 'planted') {
      if (!tAlive) return { winner: 'CT', reason: 'elim' };
      if (this.turn >= R.ROUND_TURNS) return { winner: 'CT', reason: 'time' };
    }
    return null;
  }

  finishRound(end) {
    const E = R.ECONOMY;
    const winSquad = this.squadOfSide(end.winner);
    const loseSquad = 1 - winSquad;
    this.score[winSquad] += 1;
    const winMoney = { elim: E.winElim, bomb: E.winBomb, defuse: E.winDefuse, time: E.winTime }[end.reason];
    this.lossStreak[loseSquad] += 1;
    this.lossStreak[winSquad] = Math.max(0, this.lossStreak[winSquad] - 1);
    const loseMoney = R.lossBonus(this.lossStreak[loseSquad]) + (end.winner === 'CT' && this.planted ? E.plantBonus : 0);
    for (const p of this.players) {
      const add = p.squad === winSquad ? winMoney : loseMoney;
      p.money = Math.min(E.max, p.money + add);
    }
    this.roundResult = { ...end, winSquad, winMoney, loseMoney, round: this.round };
    this.history.push({ round: this.round, winSquad, winner: end.winner, reason: end.reason });
    const played = this.round;
    const over = this.score[0] >= R.ROUNDS_TO_WIN || this.score[1] >= R.ROUNDS_TO_WIN || played >= R.ROUNDS_TOTAL;
    this.phase = over ? 'over' : 'roundOver';
    if (over) this.matchResult = { winSquad: this.score[0] === this.score[1] ? null : (this.score[0] > this.score[1] ? 0 : 1), score: this.score.slice() };
  }

  /* ---------- вигляд для конкретного гравця (туман війни) ---------- */
  squadSees(squad) {
    const mates = this.players.filter((p) => p.squad === squad && p.alive);
    const seen = new Set();
    for (const q of this.players) {
      if (!q.alive || q.squad === squad) continue;
      if (mates.some((m) => this.los(m, q))) seen.add(q.id);
    }
    return seen;
  }

  viewFor(viewerId) {
    const me = this.get(viewerId);
    const spectator = !me;
    const squad = me ? me.squad : 0;
    const seen = spectator ? new Set(this.players.map((p) => p.id)) : this.squadSees(squad);
    const over = this.phase === 'roundOver' || this.phase === 'over';
    const players = this.players.map((p) => {
      const mine = spectator || p.squad === squad;
      const base = { id: p.id, name: p.name, isBot: p.isBot, squad: p.squad, side: this.sideOf(p), alive: p.alive, kills: p.kills, deaths: p.deaths, connected: p.connected };
      if (mine || over) Object.assign(base, { hp: p.hp, money: mine ? p.money : undefined, x: p.x, y: p.y, pistol: p.pistol, primary: p.primary, armor: p.armor, kit: p.kit, nades: mine ? { ...p.nades } : undefined, bomb: p.bomb, ready: p.ready, visible: true });
      else if (seen.has(p.id)) Object.assign(base, { x: p.x, y: p.y, pistol: p.pistol, primary: p.primary, armor: p.armor, bomb: p.bomb, visible: true, hp: p.hp });
      else base.visible = false;
      if (!p.alive) base.visible = true, base.x = p.x, base.y = p.y;
      return base;
    });
    // бомба
    let bomb = null;
    const mySide = me ? this.sideOf(me) : 'T';
    if (this.bomb) {
      const b = this.bomb;
      if (b.state === 'planted' || b.state === 'defused' || b.state === 'exploded') bomb = { state: b.state, x: b.x, y: b.y, timer: b.timer, site: b.site, progress: b.progress };
      else if (b.state === 'dropped') {
        const visible = spectator || mySide === 'T' || this.players.some((p) => p.alive && p.squad === squad && this.grid.los(p.x, p.y, b.x, b.y, (x, y) => this.smokeAt(x, y)));
        bomb = visible ? { state: 'dropped', x: b.x, y: b.y } : { state: 'unknown' };
      } else bomb = { state: 'carried' };
    }
    return {
      phase: this.phase, round: this.round, half: this.half, turn: this.turn,
      score: this.score, players, bomb, me: viewerId,
      smokes: this.smokes ? this.smokes.map((s) => ({ x: s.x, y: s.y, turns: s.turns, tiles: s.tiles })) : [],
      fires: this.fires ? this.fires.map((s) => ({ x: s.x, y: s.y, turns: s.turns, tiles: s.tiles })) : [],
      events: this.filterEvents(squad, spectator),
      roundResult: this.roundResult, matchResult: this.matchResult || null,
      history: this.history,
      lossStreak: this.lossStreak,
      canPlant: me ? this.canPlant(me) : false,
      canDefuse: me ? this.canDefuse(me) : false,
    };
  }

  filterEvents(squad, spectator) {
    const ev = this.lastEvents || [];
    if (spectator) return ev;
    const vis = this.lastVis || [];
    const isMate = (id) => { const p = this.get(id); return p && p.squad === squad; };
    const seenAt = (id, t) => isMate(id) || (vis[t] && vis[t][squad] && vis[t][squad].includes(id));
    const out = [];
    for (const e of ev) {
      switch (e.type) {
        case 'move': if (seenAt(e.id, e.t) || seenAt(e.id, e.t - 1)) out.push(e); break;
        case 'shot': if (isMate(e.from) || isMate(e.to) || seenAt(e.from, e.t)) out.push(e); break;
        case 'spot': if (isMate(e.a) || isMate(e.b)) out.push(e); break;
        case 'halt': case 'burn': if (isMate(e.id) || seenAt(e.id, e.t)) out.push(e); break;
        case 'nade': out.push(e.squad === squad ? e : { ...e, by: null, fx: null, fy: null, hits: (e.hits || []).filter((h) => isMate(h.id)) }); break;
        case 'noise': {
          if (e.squad === squad) break;
          const near = this.players.some((p) => p.squad === squad && p.alive && dist(p, e) <= 14);
          if (near) out.push({ ...e, x: e.x + Math.round(this.rng() * 2 - 1), y: e.y + Math.round(this.rng() * 2 - 1) });
          break;
        }
        case 'pickup': case 'drop':
          if (isMate(e.id) || seenAt(e.id, e.t)) out.push(e); break;
        case 'defusing': if (isMate(e.id)) out.push(e); break;
        default: out.push(e); // kill, planted, defused, exploded — бачать усі
      }
    }
    return out;
  }
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
