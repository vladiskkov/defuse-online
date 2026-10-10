// Рушій матчу «Дефуз».
// Раунд: закупівля → ходи руху → (контакт) → дуелі → … → кінець раунду.
// Чистий код без мережі: кімната (rooms.js) керує таймерами і розсилає стани.
import { Grid, dist, cheb } from '../../shared/geom.js';
import * as R from '../../shared/rules.js';
import { DUNE } from '../../shared/map.js';

export const MAPS = { dune: DUNE };
const SIDES = ['T', 'CT'];
const NADE_ORDER = ['smoke', 'molly', 'flash', 'he'];
const d20 = (rng) => 1 + Math.floor(rng() * 20);

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
    this.history = [];
    this.lastEvents = [];
    this.lastKind = null;
    this.botMemory = {};
  }

  /* ---------- допоміжне ---------- */
  get(id) { return this.players.find((p) => p.id === id); }
  sideOf(p) { return (p.squad === 0) === (this.half === 0) ? 'T' : 'CT'; }
  squadOfSide(side) { return (side === 'T') === (this.half === 0) ? 0 : 1; }
  team(side) { return this.players.filter((p) => this.sideOf(p) === side); }
  aliveOf(side) { return this.team(side).filter((p) => p.alive); }
  enemies(p) { return this.players.filter((q) => q.alive && q.squad !== p.squad); }
  weaponId(p) { return p.primary || p.pistol; }
  weapon(p) { return R.WEAPONS[this.weaponId(p)]; }
  smokeAt(x, y) { return this.smokeTiles.has(x + ',' + y); }
  fireAt(x, y) { return this.fireTiles.has(x + ',' + y); }
  los(a, b) { return this.grid.los(a.x, a.y, b.x, b.y, (x, y) => this.smokeAt(x, y)); }
  visibleEnemies(p) { return this.enemies(p).filter((q) => this.los(p, q)); }
  nadeCount(p) { return Object.values(p.nades).reduce((a, b) => a + b, 0); }
  inDuel(p) { return this.phase === 'duel' && !!p.duel; }

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
      if (!inside || !this.grid.los(cx, cy, x, y)) continue;
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
    this.duelRound = 0;
    this.clock = R.ROUND_TIME;
    this.smokes = []; this.fires = [];
    this.rebuildAreas();
    this.bomb = { state: 'carried', x: 0, y: 0, clock: 0, progress: 0, defuser: null, site: null };
    this.planted = false;
    this.roundResult = null;
    this.lastEvents = []; this.lastKind = null; this.lastVis = [];
    this.botMemory = {};
    for (const side of SIDES) {
      const spawns = this.grid.tilesOf(side === 'T' ? 'T' : 'C').filter((t) => this.grid.walkable(t.x, t.y));
      const cx = spawns.reduce((a, t) => a + t.x, 0) / spawns.length;
      const cy = spawns.reduce((a, t) => a + t.y, 0) / spawns.length;
      spawns.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
      const pool = shuffle(spawns.slice(0, 10), this.rng);
      this.team(side).forEach((p, i) => {
        if (!p.alive || pistolRound) {
          p.primary = null; p.armor = 0; p.kit = false; p.pistol = null;
          p.nades = { he: 0, flash: 0, smoke: 0, molly: 0 };
        }
        if (!p.pistol || (R.WEAPONS[p.pistol].side && R.WEAPONS[p.pistol].side !== side)) p.pistol = side === 'T' ? 'glock' : 'usp';
        if (p.primary && R.WEAPONS[p.primary].side && R.WEAPONS[p.primary].side !== side) p.primary = null;
        p.hp = R.HP; p.alive = true; p.bomb = false;
        p.x = pool[i % pool.length].x; p.y = pool[i % pool.length].y;
        p.plan = null; p.ready = false; p.bought = []; p.flashed = 0; p.held = false; p.ran = false; p.duel = null;
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
      if (w.slot !== 'primary') return { ok: false, error: 'Пістолет уже є' };
      if (!R.sideCanBuy(w.side, side)) return { ok: false, error: 'Ця зброя для іншої сторони' };
      if (p.primary === item) return { ok: false, error: 'Вже є' };
      price = w.price;
      const prev = p.primary;
      apply = () => { p.primary = item; return () => { p.primary = prev; }; };
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
    p.bought.push({ price, undo: apply() });
    return { ok: true };
  }

  refund(id) {
    const p = this.get(id);
    if (!p || this.phase !== 'buy') return { ok: false };
    while (p.bought.length) { const b = p.bought.pop(); b.undo(); p.money += b.price; }
    return { ok: true };
  }

  endBuy() {
    for (const p of this.players) p.bought = [];
    this.startMove();
  }

  startMove() {
    this.phase = 'move';
    this.turn += 1;
    this.duelRound = 0;
    for (const p of this.players) { p.plan = null; p.ready = false; p.duel = null; }
  }

  /* ---------- хід руху ---------- */
  canPlant(p) { return p.alive && p.bomb && this.sideOf(p) === 'T' && !!this.grid.site(p.x, p.y) && this.bomb.state === 'carried'; }
  canDefuse(p) { return p.alive && this.sideOf(p) === 'CT' && this.bomb.state === 'planted' && cheb(p, this.bomb) <= 1; }

  setPlan(id, raw) {
    const p = this.get(id);
    if (!p || !p.alive || this.phase !== 'move') return { ok: false };
    p.plan = this.normalizePlan(p, raw || {});
    p.ready = !!(raw && raw.ready);
    return { ok: true, plan: p.plan };
  }

  normalizePlan(p, raw) {
    const plan = { quiet: !!raw.quiet, path: [], grenade: null, action: null };
    if (raw.action === 'plant' && this.canPlant(p)) plan.action = 'plant';
    if (raw.action === 'defuse' && this.canDefuse(p)) plan.action = 'defuse';
    if (plan.action) return plan;
    const g = raw.grenade;
    if (g && R.GRENADES[g.type] && p.nades[g.type] > 0 && this.validThrow(p, g)) plan.grenade = { type: g.type, x: g.x, y: g.y };
    const steps = Math.max(0, (plan.quiet ? R.MOVE_QUIET : R.MOVE_FAST) - (plan.grenade ? R.NADE_MOVE_COST : 0));
    let cx = p.x, cy = p.y;
    if (Array.isArray(raw.path)) {
      for (const s of raw.path.slice(0, steps)) {
        if (!s || !Number.isInteger(s.x) || !Number.isInteger(s.y)) break;
        if (!this.grid.neighbors(cx, cy).some((n) => n.x === s.x && n.y === s.y)) break;
        plan.path.push({ x: s.x, y: s.y });
        cx = s.x; cy = s.y;
      }
    }
    return plan;
  }

  validThrow(p, g) {
    return g && Number.isInteger(g.x) && Number.isInteger(g.y) && !this.grid.opaque(g.x, g.y)
      && dist(p, g) <= R.THROW_RANGE + 0.01 && this.grid.los(p.x, p.y, g.x, g.y);
  }

  humansToWait() {
    if (this.phase === 'move') return this.players.filter((p) => p.alive && !p.isBot && p.connected);
    if (this.phase === 'duel') return this.players.filter((p) => p.alive && !p.isBot && p.connected && p.duel);
    return [];
  }
  allReady() {
    if (this.phase === 'duel') return this.players.filter((p) => p.duel && p.alive && !p.isBot && p.connected).every((p) => p.duel.ready);
    return this.humansToWait().every((p) => p.ready);
  }

  resolveMove() {
    const ev = [];
    this.events = ev;
    this.visLog = [];
    const alive = this.players.filter((p) => p.alive);
    for (const p of this.players) p.flashed = 0;
    const st = new Map();
    for (const p of alive) {
      const plan = p.plan || this.normalizePlan(p, {});
      st.set(p.id, { plan, path: plan.path.slice(), moved: 0, stopped: false, burned: false });
    }
    // гранати летять на початку ходу
    const throws = alive.filter((p) => st.get(p.id).plan.grenade)
      .sort((a, b) => NADE_ORDER.indexOf(st.get(a.id).plan.grenade.type) - NADE_ORDER.indexOf(st.get(b.id).plan.grenade.type));
    for (const p of throws) if (p.alive) this.throwNade(p, st.get(p.id).plan.grenade, 0, null);
    this.seen = new Set();
    this.checkContacts(0, st);

    for (let t = 1; t <= R.MOVE_FAST; t++) {
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
        if (this.fireAt(p.x, p.y)) s.burned = true;
      }
      this.checkContacts(t, st);
    }
    const T_END = R.MOVE_FAST + 1;

    // вогонь
    for (const p of alive) {
      const s = st.get(p.id);
      if (!p.alive) continue;
      const n = (s.burned ? 1 : 0) + (this.fireAt(p.x, p.y) ? 1 : 0);
      if (n) { ev.push({ t: T_END, type: 'burn', id: p.id, dmg: R.FIRE_DAMAGE * n }); this.hurt(p, R.FIRE_DAMAGE * n, this.fireOwner(p), 'molly', T_END); }
    }
    // шум бігу
    for (const p of alive) {
      const s = st.get(p.id);
      if (p.alive && s.moved > R.MOVE_QUIET && !s.plan.quiet) ev.push({ t: T_END, type: 'noise', id: p.id, x: p.x, y: p.y, squad: p.squad });
    }
    // хто тримав кут, а хто вибіг
    for (const p of alive) {
      const s = st.get(p.id);
      p.held = p.alive && s.moved === 0 && !s.plan.action;
      p.ran = p.alive && s.moved >= 4;
    }
    // закладка і розмінування
    let justPlanted = false;
    for (const p of alive) {
      const s = st.get(p.id);
      if (p.alive && s.plan.action === 'plant' && p.bomb && this.grid.site(p.x, p.y)) {
        p.bomb = false;
        Object.assign(this.bomb, { state: 'planted', x: p.x, y: p.y, clock: R.BOMB_TIME, site: this.grid.site(p.x, p.y), planter: p.id, progress: 0, defuser: null });
        this.planted = true; justPlanted = true;
        ev.push({ t: T_END, type: 'planted', id: p.id, x: p.x, y: p.y, site: this.bomb.site });
      }
    }
    if (!justPlanted) this.defuseStep(alive.filter((p) => p.alive && st.get(p.id).plan.action === 'defuse'), R.MOVE_TIME, T_END);
    this.passTime(R.MOVE_TIME, justPlanted, T_END);

    for (const p of this.players) { p.plan = null; p.ready = false; }
    return this.afterResolve('move');
  }

  // зупинка при контакті і запис видимості для туману війни
  checkContacts(t, st, silent) {
    const alive = this.players.filter((p) => p.alive);
    const squadVis = [new Set(), new Set()];
    for (const p of alive) {
      const v = this.visibleEnemies(p);
      for (const q of v) {
        squadVis[p.squad].add(q.id);
        const key = [p.id, q.id].sort().join('|');
        if (!this.seen.has(key)) {
          this.seen.add(key);
          if (!silent) this.events.push({ t, type: 'contact', a: p.id, b: q.id, ax: p.x, ay: p.y, bx: q.x, by: q.y });
        }
      }
      const s = st && st.get(p.id);
      if (s && v.length && s.path.length && !s.stopped) { s.stopped = true; s.path = []; this.events.push({ t, type: 'halt', id: p.id }); }
    }
    this.visLog[t] = squadVis.map((s) => [...s]);
  }

  fireOwner(p) {
    const f = this.fires.find((f) => f.tiles.includes(p.x + ',' + p.y));
    return f ? this.get(f.by) : null;
  }

  defuseStep(defusers, seconds, t) {
    if (this.bomb.state !== 'planted') return;
    const d = defusers.find((p) => p.id === this.bomb.defuser && this.canDefuse(p)) || defusers.find((p) => this.canDefuse(p));
    if (!d) { this.bomb.defuser = null; this.bomb.progress = 0; return; }
    this.bomb.progress = (this.bomb.defuser === d.id ? this.bomb.progress : 0) + seconds;
    this.bomb.defuser = d.id;
    const need = d.kit ? R.KIT_DEFUSE_TIME : R.DEFUSE_TIME;
    this.events.push({ t, type: 'defusing', id: d.id, progress: Math.min(need, this.bomb.progress), need });
    if (this.bomb.progress >= need) { this.bomb.state = 'defused'; this.events.push({ t, type: 'defused', id: d.id }); }
  }

  passTime(seconds, justPlanted, t) {
    if (this.bomb.state === 'planted' && !justPlanted) {
      this.bomb.clock -= seconds;
      if (this.bomb.clock <= 0) {
        this.bomb.state = 'exploded';
        this.events.push({ t, type: 'exploded', x: this.bomb.x, y: this.bomb.y });
        for (const p of this.players) if (p.alive && dist(p, this.bomb) <= 5) this.hurt(p, 500, null, 'bomb', t);
      }
    }
    if (!this.planted) this.clock = Math.max(0, this.clock - seconds);
    for (const a of [this.smokes, this.fires]) for (const s of a) s.time -= seconds;
    this.smokes = this.smokes.filter((s) => s.time > 0);
    this.fires = this.fires.filter((s) => s.time > 0);
    this.rebuildAreas();
  }

  afterResolve(kind) {
    this.lastEvents = this.events;
    this.lastVis = this.visLog;
    this.lastKind = kind;
    const end = this.checkRoundEnd();
    if (end) { this.finishRound(end); return { events: this.events, roundEnd: end }; }
    if (this.anyContact()) this.startDuel();
    else this.startMove();
    return { events: this.events, roundEnd: null };
  }

  anyContact() { return this.players.some((p) => p.alive && this.visibleEnemies(p).length); }

  /* ---------- дуель ---------- */
  startDuel() {
    this.phase = 'duel';
    this.duelRound += 1;
    for (const p of this.players) {
      p.ready = false; p.plan = null;
      p.duel = p.alive && this.visibleEnemies(p).length ? { action: null, target: null, tile: null, path: null, rolls: null, ready: false } : null;
    }
  }

  duelOptions(p) {
    const enemies = this.visibleEnemies(p);
    return { enemies, first: this.duelRound === 1 };
  }

  // вибір дії в дуелі
  duelAct(id, raw) {
    const p = this.get(id);
    if (!p || !p.alive || this.phase !== 'duel' || !p.duel) return { ok: false, error: 'Ви не в дуелі' };
    if (p.duel.rolls) return { ok: false, error: 'Кубики вже кинуто' };
    const enemies = this.visibleEnemies(p);
    const a = String(raw.action || '');
    const d = p.duel;
    if (a === 'shoot') {
      const tgt = enemies.find((q) => q.id === raw.target) || nearest(p, enemies);
      if (!tgt) return { ok: false, error: 'Немає цілі' };
      Object.assign(d, { action: 'shoot', target: tgt.id, tile: null, path: null });
    } else if (a === 'hide') {
      const path = this.hidePath(p, enemies, raw.x, raw.y);
      if (!path) return { ok: false, error: 'Туди не відійти' };
      Object.assign(d, { action: 'hide', target: null, tile: path[path.length - 1] || { x: p.x, y: p.y }, path });
    } else if (a.startsWith('nade:')) {
      const type = a.slice(5);
      if (!R.GRENADES[type] || p.nades[type] <= 0) return { ok: false, error: 'Немає такої гранати' };
      const tgt = Number.isInteger(raw.x) ? { x: raw.x, y: raw.y } : nearest(p, enemies);
      if (!tgt || !this.validThrow(p, tgt)) return { ok: false, error: 'Сюди не докинути' };
      Object.assign(d, { action: 'nade', nade: type, target: null, tile: { x: tgt.x, y: tgt.y }, path: null });
    } else if (a === 'defuse') {
      if (!this.canDefuse(p)) return { ok: false, error: 'Бомба далеко' };
      Object.assign(d, { action: 'defuse', target: null, tile: null, path: null });
    } else return { ok: false, error: 'Невідома дія' };
    return { ok: true };
  }

  // гравець сам кидає кубики
  duelRoll(id) {
    const p = this.get(id);
    if (!p || !p.alive || this.phase !== 'duel' || !p.duel) return { ok: false };
    const d = p.duel;
    if (!d.action) return { ok: false, error: 'Спершу оберіть дію' };
    if (!d.rolls) {
      const n = d.action === 'shoot' ? this.weapon(p).bullets : d.action === 'defuse' ? 0 : 1;
      d.rolls = Array.from({ length: n }, () => d20(this.rng));
    }
    d.ready = true;
    return { ok: true, rolls: d.rolls };
  }

  autoDuel(p) {
    if (!p.duel || p.duel.ready) return;
    if (!p.duel.action) this.duelAct(p.id, { action: 'shoot' });
    if (!p.duel.action) this.duelAct(p.id, { action: 'hide' });
    this.duelRoll(p.id);
  }

  // шлях відходу: на 1–2 клітинки, бажано туди, де ворог не бачить
  hidePath(p, enemies, tx, ty) {
    const d = this.grid.distanceField(p.x, p.y);
    const cand = [];
    for (let y = p.y - R.HIDE_STEPS; y <= p.y + R.HIDE_STEPS; y++) for (let x = p.x - R.HIDE_STEPS; x <= p.x + R.HIDE_STEPS; x++) {
      const v = d[x + y * this.grid.w];
      if (x < 0 || y < 0 || x >= this.grid.w || y >= this.grid.h || v < 1 || v > R.HIDE_STEPS) continue;
      cand.push({ x, y });
    }
    if (Number.isInteger(tx)) {
      const c = cand.find((c) => c.x === tx && c.y === ty);
      return c ? this.grid.path(p.x, p.y, c.x, c.y) : null;
    }
    const best = this.hideOptions(p, enemies, cand)[0];
    return best ? this.grid.path(p.x, p.y, best.x, best.y) : [];
  }

  hideOptions(p, enemies, cand) {
    return cand.map((c) => ({ ...c, safe: enemies.filter((e) => !this.grid.los(e.x, e.y, c.x, c.y, (x, y) => this.smokeAt(x, y))).length, far: Math.min(...enemies.map((e) => dist(e, c))) }))
      .sort((a, b) => b.safe - a.safe || b.far - a.far);
  }

  resolveDuel() {
    const ev = [];
    this.events = ev;
    this.visLog = [];
    this.seen = new Set();
    const fighters = this.players.filter((p) => p.alive && p.duel);
    for (const p of fighters) this.autoDuel(p);
    const first = this.duelRound === 1;
    this.checkContacts(0, null, true);

    // 0: гранати (кидок на точність)
    const throwers = fighters.filter((p) => p.duel.action === 'nade')
      .sort((a, b) => NADE_ORDER.indexOf(a.duel.nade) - NADE_ORDER.indexOf(b.duel.nade));
    for (const p of throwers) {
      if (!p.alive) continue;
      const roll = p.duel.rolls[0];
      let tile = p.duel.tile;
      if (roll < R.NADE_ROLL) {
        const opts = this.grid.neighbors(tile.x, tile.y).filter((n) => this.grid.los(p.x, p.y, n.x, n.y));
        if (opts.length) tile = opts[Math.floor(this.rng() * opts.length)];
      }
      this.throwNade(p, { type: p.duel.nade, x: tile.x, y: tile.y }, 0, { roll, need: R.NADE_ROLL, exact: roll >= R.NADE_ROLL });
    }

    // 1: постріли — одночасно, тож можливі розміни
    const hits = [];
    for (const p of fighters) {
      if (!p.alive || p.duel.action !== 'shoot') continue;
      const tgt = this.get(p.duel.target);
      if (!tgt || !tgt.alive || !this.los(p, tgt)) { ev.push({ t: 1, type: 'noshot', id: p.id, target: p.duel.target, why: tgt && tgt.alive ? 'Ціль зникла в димі' : 'Ціль уже впала' }); continue; }
      const hideRoll = tgt.duel && tgt.duel.action === 'hide' ? tgt.duel.rolls[0] : null;
      const setup = R.shotSetup({
        weapon: this.weaponId(p), dist: dist(p, tgt), cover: this.grid.cover(p.x, p.y, tgt.x, tgt.y),
        held: first && p.held, ran: first && p.ran, flashed: p.flashed > 0,
        hiding: hideRoll === null ? 0 : (hideRoll >= R.HIDE_ROLL ? R.HIDE_GOOD : R.HIDE_BAD),
      });
      const bullets = p.duel.rolls.map((roll, k) => {
        const b = R.bulletResult(roll, setup.bonus, setup.need, k);
        b.dmg = b.hit ? R.bulletDamage(this.weaponId(p), b.head, tgt.armor) : 0;
        b.spray = -R.SPRAY * k;
        return b;
      });
      const total = bullets.reduce((a, b) => a + b.dmg, 0);
      ev.push({ t: 1, type: 'burst', from: p.id, to: tgt.id, weapon: this.weaponId(p), mods: setup.mods, bonus: setup.bonus, need: setup.need, bullets, total, fx: p.x, fy: p.y, tx: tgt.x, ty: tgt.y, hideRoll });
      if (total) hits.push({ p, tgt, total });
    }
    for (const h of hits) this.hurt(h.tgt, h.total, h.p, this.weaponId(h.p), 1);

    // 2: відхід
    for (const p of fighters) {
      if (!p.alive || p.duel.action !== 'hide') continue;
      ev.push({ t: 2, type: 'hide', id: p.id, roll: p.duel.rolls[0], need: R.HIDE_ROLL, good: p.duel.rolls[0] >= R.HIDE_ROLL });
      p.duel.path.forEach((s, i) => { p.x = s.x; p.y = s.y; ev.push({ t: 2 + i, type: 'move', id: p.id, x: s.x, y: s.y }); });
    }
    this.checkContacts(4, null, true);
    const T_END = 5;
    // розмінування під вогнем
    this.defuseStep(fighters.filter((p) => p.alive && p.duel.action === 'defuse'), R.DUEL_TIME, T_END);
    // вогонь
    for (const p of this.players) if (p.alive && this.fireAt(p.x, p.y)) {
      ev.push({ t: T_END, type: 'burn', id: p.id, dmg: R.FIRE_DAMAGE });
      this.hurt(p, R.FIRE_DAMAGE, this.fireOwner(p), 'molly', T_END);
    }
    this.passTime(R.DUEL_TIME, false, T_END);
    for (const p of this.players) { p.flashed = 0; p.held = false; p.ran = false; }
    return this.afterResolve('duel');
  }

  /* ---------- гранати ---------- */
  throwNade(p, g, t, rollInfo) {
    p.nades[g.type] -= 1;
    const e = { t, type: 'nade', by: p.id, squad: p.squad, nade: g.type, x: g.x, y: g.y, fx: p.x, fy: p.y, ...(rollInfo ? { roll: rollInfo.roll, need: rollInfo.need, exact: rollInfo.exact } : {}) };
    this.events.push(e);
    if (g.type === 'smoke') {
      this.smokes.push({ x: g.x, y: g.y, time: R.SMOKE_TIME, tiles: this.areaTiles(g.x, g.y, R.GRENADES.smoke.radius, true) });
      // дим гасить вогонь
      for (const f of this.fires) f.tiles = f.tiles.filter((k) => !this.smokes[this.smokes.length - 1].tiles.includes(k));
      this.rebuildAreas();
    } else if (g.type === 'molly') {
      const tiles = this.areaTiles(g.x, g.y, 1, false).filter((k) => !this.smokeTiles.has(k));
      this.fires.push({ x: g.x, y: g.y, time: R.FIRE_TIME, tiles, by: p.id });
      this.rebuildAreas();
    } else if (g.type === 'flash') {
      e.blinded = [];
      for (const q of this.players) {
        if (!q.alive || q.id === p.id) continue;
        if (dist(q, g) <= R.GRENADES.flash.radius + 0.5 && this.grid.los(g.x, g.y, q.x, q.y, (x, y) => this.smokeAt(x, y))) {
          q.flashed = 1; e.blinded.push(q.id); // діє в найближчій дуелі
        }
      }
    } else if (g.type === 'he') {
      e.hits = [];
      for (const q of this.players) {
        if (!q.alive) continue;
        const d = dist(q, g);
        if (d > R.GRENADES.he.radius + 0.5 || !this.grid.los(g.x, g.y, q.x, q.y)) continue;
        const dmg = Math.round((57 - 18 * d) * (q.armor ? 0.55 : 1));
        if (dmg <= 0) continue;
        e.hits.push({ id: q.id, dmg });
        this.hurt(q, dmg, p, 'he', t);
      }
    }
  }

  hurt(p, dmg, attacker, cause, t) {
    if (!p.alive) return;
    p.hp = Math.max(0, p.hp - dmg);
    if (p.hp > 0) return;
    p.alive = false; p.deaths += 1; p.duel = null;
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
      if (this.clock <= 0) return { winner: 'CT', reason: 'time' };
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
    for (const p of this.players) p.money = Math.min(E.max, p.money + (p.squad === winSquad ? winMoney : loseMoney));
    for (const p of this.players) p.duel = null;
    this.roundResult = { ...end, winSquad, winMoney, loseMoney, round: this.round };
    this.history.push({ round: this.round, winSquad, winner: end.winner, reason: end.reason });
    const over = this.score[0] >= R.ROUNDS_TO_WIN || this.score[1] >= R.ROUNDS_TO_WIN || this.round >= R.ROUNDS_TOTAL;
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
      const base = { id: p.id, name: p.name, isBot: p.isBot, squad: p.squad, side: this.sideOf(p), alive: p.alive, kills: p.kills, deaths: p.deaths, connected: p.connected, inDuel: !!p.duel && (mine || seen.has(p.id)) };
      if (mine || over) Object.assign(base, { hp: p.hp, money: mine ? p.money : undefined, x: p.x, y: p.y, pistol: p.pistol, primary: p.primary, armor: p.armor, kit: p.kit, nades: mine ? { ...p.nades } : undefined, bomb: p.bomb, ready: this.phase === 'duel' ? !!(p.duel && p.duel.ready) : p.ready, visible: true });
      else if (seen.has(p.id)) Object.assign(base, { x: p.x, y: p.y, pistol: p.pistol, primary: p.primary, armor: p.armor, bomb: p.bomb, visible: true, hp: p.hp });
      else base.visible = false;
      if (!p.alive) Object.assign(base, { visible: true, x: p.x, y: p.y });
      return base;
    });
    let bomb = null;
    const mySide = me ? this.sideOf(me) : 'T';
    if (this.bomb) {
      const b = this.bomb;
      if (b.state === 'planted' || b.state === 'defused' || b.state === 'exploded') bomb = { state: b.state, x: b.x, y: b.y, clock: b.clock, site: b.site, progress: b.progress };
      else if (b.state === 'dropped') {
        const visible = spectator || mySide === 'T' || this.players.some((p) => p.alive && p.squad === squad && this.grid.los(p.x, p.y, b.x, b.y, (x, y) => this.smokeAt(x, y)));
        bomb = visible ? { state: 'dropped', x: b.x, y: b.y } : { state: 'unknown' };
      } else bomb = { state: 'carried' };
    }
    let duel = null;
    if (me && this.phase === 'duel' && me.duel) {
      duel = {
        enemies: this.visibleEnemies(me).map((q) => ({ id: q.id, d: Math.round(dist(me, q) * 10) / 10, cover: this.grid.cover(me.x, me.y, q.x, q.y) })),
        first: this.duelRound === 1, held: this.duelRound === 1 && me.held, ran: this.duelRound === 1 && me.ran, flashed: me.flashed > 0,
        action: me.duel.action, target: me.duel.target, tile: me.duel.tile, nade: me.duel.nade, rolls: me.duel.rolls, ready: me.duel.ready,
        canDefuse: this.canDefuse(me),
      };
    }
    return {
      phase: this.phase, round: this.round, half: this.half, turn: this.turn, duelRound: this.duelRound,
      clock: this.clock, score: this.score, players, bomb, me: viewerId,
      smokes: (this.smokes || []).map((s) => ({ x: s.x, y: s.y, time: s.time, tiles: s.tiles })),
      fires: (this.fires || []).map((s) => ({ x: s.x, y: s.y, time: s.time, tiles: s.tiles })),
      events: this.filterEvents(squad, spectator), eventsKind: this.lastKind,
      roundResult: this.roundResult, matchResult: this.matchResult || null,
      history: this.history, lossStreak: this.lossStreak,
      canPlant: me ? this.canPlant(me) && this.phase === 'move' : false,
      canDefuse: me ? this.canDefuse(me) && this.phase === 'move' : false,
      duel,
    };
  }

  filterEvents(squad, spectator) {
    const ev = this.lastEvents || [];
    if (spectator) return ev;
    const vis = this.lastVis || [];
    const isMate = (id) => { const p = this.get(id); return p && p.squad === squad; };
    const seenAt = (id, t) => isMate(id) || !!(vis[t] && vis[t][squad] && vis[t][squad].includes(id));
    const out = [];
    for (const e of ev) {
      switch (e.type) {
        case 'move': if (this.lastKind === 'duel' ? (isMate(e.id) || this.sawInDuel(e.id, squad)) : (seenAt(e.id, e.t) || seenAt(e.id, e.t - 1))) out.push(e); break;
        case 'burst': case 'noshot': if (isMate(e.from || e.id) || isMate(e.to || e.target) || this.sawInDuel(e.from || e.id, squad)) out.push(e); break;
        case 'contact': if (isMate(e.a) || isMate(e.b)) out.push(e); break;
        case 'halt': case 'burn': case 'hide': if (isMate(e.id) || this.sawInDuel(e.id, squad)) out.push(e); break;
        case 'nade': out.push(e.squad === squad ? e : { ...e, by: null, fx: null, fy: null, roll: undefined, hits: (e.hits || []).filter((h) => isMate(h.id)) }); break;
        case 'noise': {
          if (e.squad === squad) break;
          if (this.players.some((p) => p.squad === squad && p.alive && dist(p, e) <= 14)) out.push({ ...e, x: e.x + Math.round(this.rng() * 2 - 1), y: e.y + Math.round(this.rng() * 2 - 1) });
          break;
        }
        case 'pickup': case 'drop': if (isMate(e.id) || seenAt(e.id, e.t)) out.push(e); break;
        case 'defusing': if (isMate(e.id)) out.push(e); break;
        default: out.push(e);
      }
    }
    return out;
  }

  // у дуелі учасників бачать усі, хто з ними в контакті
  sawInDuel(id, squad) {
    const ev = this.lastEvents || [];
    return ev.some((e) => e.type === 'burst' && ((e.from === id && this.get(e.to)?.squad === squad) || (e.to === id && this.get(e.from)?.squad === squad)))
      || (this.lastVis || []).some((v) => v && v[squad] && v[squad].includes(id));
  }
}

function nearest(p, list) {
  let best = null, bd = Infinity;
  for (const q of list) { const d = dist(p, q); if (d < bd) { bd = d; best = q; } }
  return best;
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
