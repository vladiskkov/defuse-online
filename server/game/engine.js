// Рушій «Дефузу»: тактична настолка на гексах.
// Раунд: закупівля → ходи. У кожному ході гравці по черзі активують бійців (T, CT, T, CT…).
// Активація: 2 дії — рух на 4 гекси, постріл, граната, «тримати кут», закладка чи розмінування.
// Постріл: атакуючий кидає кубики атаки, ціль — кубики захисту (обидва кидають самі).
import * as R from '../../shared/rules.js';
import * as X from '../../shared/hex.js';

const SIDES = ['T', 'CT'];
const d6 = (rng) => 1 + Math.floor(rng() * 6);

export class Match {
  constructor({ players, rng = Math.random }) {
    this.rng = rng;
    this.players = players.map((p) => ({
      id: p.id, name: p.name, isBot: !!p.isBot, squad: p.squad,
      money: R.ECONOMY.start, hp: R.HP, alive: true, hex: null,
      pistol: null, primary: null, armor: 0, kit: false,
      nades: { flash: 0, smoke: 0, he: 0, molly: 0 },
      bomb: false, kills: 0, deaths: 0, connected: true,
    }));
    this.score = [0, 0];
    this.lossStreak = [0, 0];
    this.round = 0;
    this.half = 0;
    this.phase = 'idle';
    this.history = [];
    this.events = [];
    this.botMemory = {};
    this.step = 0;
  }

  /* ---------- допоміжне ---------- */
  get(id) { return this.players.find((p) => p.id === id); }
  sideOf(p) { return (p.squad === 0) === (this.half === 0) ? 'T' : 'CT'; }
  squadOfSide(side) { return (side === 'T') === (this.half === 0) ? 0 : 1; }
  team(side) { return this.players.filter((p) => this.sideOf(p) === side); }
  aliveOf(side) { return this.team(side).filter((p) => p.alive); }
  weaponId(p) { return p.primary || p.pistol; }
  weapon(p) { return R.WEAPONS[this.weaponId(p)]; }
  hexOf(p) { return X.HEXES.get(p.hex); }
  nadeCount(p) { return Object.values(p.nades).reduce((a, b) => a + b, 0); }
  occupied(h, except) { return this.players.some((p) => p.alive && p.hex === X.key(h.c, h.r) && p !== except); }
  smokeFn() {
    if (!this.smokes || !this.smokes.size) return null;
    const tiles = new Set();
    for (const k of this.smokes.keys()) { const h = X.HEXES.get(k); tiles.add(Math.floor(h.x) + ',' + Math.floor(h.y)); for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) tiles.add((Math.floor(h.x) + dx) + ',' + (Math.floor(h.y) + dy)); }
    return (x, y) => tiles.has(x + ',' + y);
  }
  sees(a, b) {
    const ha = this.hexOf(a), hb = this.hexOf(b);
    if (!ha || !hb || X.hexDist(ha, hb) > R.VIEW_RANGE) return false;
    return X.los(ha, hb, this.smokeFn());
  }
  visibleEnemies(p) { return this.players.filter((q) => q.alive && q.squad !== p.squad && this.sees(p, q)); }
  squadSees(squad) {
    const mates = this.players.filter((p) => p.alive && p.squad === squad);
    return new Set(this.players.filter((q) => q.alive && q.squad !== squad && mates.some((m) => this.sees(m, q))).map((q) => q.id));
  }
  get clock() { return Math.max(0, R.ROUND_TIME - Math.max(0, this.turn - 1) * R.TURN_SECONDS); }
  emit(e) { this.events.push({ ...e, step: this.step }); }

  /* ---------- раунд ---------- */
  startRound() {
    this.round += 1;
    if (this.round === R.ROUNDS_TOTAL / 2 + 1) this.halftime();
    const pistolRound = this.round === 1 || this.round === R.ROUNDS_TOTAL / 2 + 1;
    this.phase = 'buy';
    this.turn = 0;
    this.active = null; this.pending = null; this.lastSide = null;
    this.smokes = new Map(); this.fires = new Map();
    this.bomb = { state: 'carried', hex: null, turnsLeft: 0, site: null };
    this.planted = false;
    this.roundResult = null;
    this.events = [];
    this.botMemory = {};
    for (const side of SIDES) {
      const spawns = X.FLOOR.filter((h) => h.spawn === side);
      const cx = spawns.reduce((a, h) => a + h.x, 0) / spawns.length, cy = spawns.reduce((a, h) => a + h.y, 0) / spawns.length;
      spawns.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
      const pool = shuffle(spawns.slice(0, 8), this.rng);
      this.team(side).forEach((p, i) => {
        if (!p.alive || pistolRound) { p.primary = null; p.armor = 0; p.kit = false; p.nades = { flash: 0, smoke: 0, he: 0, molly: 0 }; }
        p.pistol = side === 'T' ? 'glock' : 'usp';
        if (p.primary && R.WEAPONS[p.primary].side !== side) p.primary = null;
        const h = pool[i % pool.length];
        Object.assign(p, { hp: R.HP, alive: true, bomb: false, hex: X.key(h.c, h.r), expended: false, overwatch: false, flashed: false, ap: 0, moved: false, shot: false, ready: false, bought: [] });
      });
    }
    const ts = this.team('T');
    if (ts.length) ts[Math.floor(this.rng() * ts.length)].bomb = true;
  }

  halftime() {
    this.half = 1;
    this.lossStreak = [0, 0];
    for (const p of this.players) { p.money = R.ECONOMY.start; p.primary = null; p.armor = 0; p.kit = false; p.nades = { flash: 0, smoke: 0, he: 0, molly: 0 }; }
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
      if (p.nades[item] >= 1) return { ok: false, error: 'Така граната вже є' };
      if (this.nadeCount(p) >= R.MAX_GRENADES) return { ok: false, error: `Максимум ${R.MAX_GRENADES} гранати` };
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
    this.phase = 'play';
    this.startTurn();
  }

  /* ---------- ходи і активації ---------- */
  startTurn() {
    this.turn += 1;
    for (const p of this.players) if (p.alive) p.expended = false;
    this.lastSide = this.turn % 2 === 1 ? 'CT' : 'T'; // ініціатива: T у непарних ходах
    this.emit({ type: 'turn', turn: this.turn });
    this.next();
  }

  next() {
    if (this.phase !== 'play') return;
    const ready = (side) => this.team(side).filter((p) => p.alive && !p.expended);
    const other = this.lastSide === 'T' ? 'CT' : 'T';
    let side = ready(other).length ? other : ready(this.lastSide).length ? this.lastSide : null;
    if (!side) return this.endTurn();
    const p = ready(side)[0];
    this.lastSide = side;
    this.active = p.id;
    Object.assign(p, { ap: R.AP, moved: false, shot: false, overwatch: false });
    this.emit({ type: 'activate', id: p.id });
  }

  endActivation() {
    const p = this.get(this.active);
    if (p) {
      p.expended = true; p.ap = 0; p.flashed = false;
      const f = this.fires.get(p.hex);
      if (p.alive && f && f.squad !== p.squad) { this.emit({ type: 'burn', id: p.id, hex: p.hex }); this.damage(p, R.FIRE_DMG, this.get(f.by), 'molly'); }
    }
    this.active = null;
    if (this.checkEnd()) return;
    this.next();
  }

  endTurn() {
    this.active = null;
    for (const [k, t] of this.smokes) { if (t <= 1) this.smokes.delete(k); else this.smokes.set(k, t - 1); }
    for (const [k, f] of this.fires) { if (f.turns <= 1) this.fires.delete(k); else this.fires.set(k, { ...f, turns: f.turns - 1 }); }
    if (this.bomb.state === 'planted') {
      if (this.bomb.justPlanted) this.bomb.justPlanted = false;
      else if (--this.bomb.turnsLeft <= 0) {
        this.bomb.state = 'exploded';
        this.emit({ type: 'exploded', hex: this.bomb.hex });
        const bh = X.HEXES.get(this.bomb.hex);
        for (const p of this.players) if (p.alive && X.hexDist(this.hexOf(p), bh) <= 3) this.damage(p, 500, null, 'bomb');
      }
    }
    if (this.checkEnd()) return;
    if (this.turn >= R.TURNS && !this.planted) { this.finishRound({ winner: 'CT', reason: 'time' }); return; }
    this.startTurn();
  }

  canPlant(p) { const h = this.hexOf(p); return p.alive && p.bomb && this.sideOf(p) === 'T' && !!h.site && this.bomb.state === 'carried'; }
  canDefuse(p) { return p.alive && this.sideOf(p) === 'CT' && this.bomb.state === 'planted' && X.hexDist(this.hexOf(p), X.HEXES.get(this.bomb.hex)) <= 1; }

  // хто зараз має щось зробити
  waitingFor() {
    if (this.phase !== 'play') return null;
    if (this.pending) {
      const pe = this.pending;
      return { id: pe.stage === 'atk' ? pe.from : pe.to, kind: pe.stage, seconds: R.ROLL_SECONDS };
    }
    if (this.active) return { id: this.active, kind: 'act', seconds: R.ACT_SECONDS };
    return null;
  }

  act(id, a) {
    if (this.phase !== 'play' || this.pending || id !== this.active) return { ok: false, error: 'Зараз не твоя активація' };
    const p = this.get(id);
    this.step += 1;
    const type = a && a.type;
    if (type === 'end') { this.emit({ type: 'endact', id }); this.endActivation(); return { ok: true }; }
    if (type === 'move') return this.doMove(p, a);
    if (type === 'shoot') return this.doShoot(p, a);
    if (type === 'nade') return this.doNade(p, a);
    if (type === 'overwatch') {
      if (p.ap < 1) return { ok: false, error: 'Немає дій' };
      p.overwatch = true; p.ap = 0;
      this.emit({ type: 'overwatch', id: p.id, hex: p.hex });
      this.endActivation();
      return { ok: true };
    }
    if (type === 'plant') {
      if (!this.canPlant(p)) return { ok: false, error: 'Закласти можна лише на точці А або Б' };
      if (p.ap < 2) return { ok: false, error: 'Закладка забирає обидві дії — роби її на початку активації' };
      p.bomb = false;
      Object.assign(this.bomb, { state: 'planted', hex: p.hex, site: this.hexOf(p).site, turnsLeft: R.BOMB_TURNS, justPlanted: true, planter: p.id });
      this.planted = true;
      this.emit({ type: 'planted', id: p.id, hex: p.hex, site: this.bomb.site });
      p.ap = 0;
      this.endActivation();
      return { ok: true };
    }
    if (type === 'defuse') {
      if (!this.canDefuse(p)) return { ok: false, error: 'Стань на бомбу або поруч' };
      const cost = p.kit ? 1 : 2;
      if (p.ap < cost) return { ok: false, error: `Розмінування забирає ${cost} дії` };
      this.bomb.state = 'defused';
      this.emit({ type: 'defused', id: p.id, hex: this.bomb.hex, kit: p.kit });
      p.ap -= cost;
      this.checkEnd();
      return { ok: true };
    }
    return { ok: false, error: 'Невідома дія' };
  }

  doMove(p, a) {
    if (p.ap < 1) return { ok: false, error: 'Немає дій' };
    const start = this.hexOf(p);
    const goal = X.hexAt(a.c, a.r);
    if (!X.walkable(goal)) return { ok: false, error: 'Туди не пройти' };
    const path = X.pathTo(start, goal, R.MOVE, (h) => this.occupied(h, p));
    if (!path || !path.length) return { ok: false, error: `Можна піти лише на ${R.MOVE} гекси` };
    p.ap -= 1; p.moved = true;
    this.runPath(p, path);
    return { ok: true };
  }

  // рух по клітинках з перевіркою «тримання кута» ворогами
  runPath(p, path) {
    const from = p.hex;
    const done = [];
    while (path.length) {
      const h = path.shift();
      p.hex = X.key(h.c, h.r);
      done.push(p.hex);
      if (this.bomb.state === 'dropped' && this.bomb.hex === p.hex && this.sideOf(p) === 'T') {
        this.bomb.state = 'carried'; p.bomb = true; this.emit({ type: 'pickup', id: p.id, hex: p.hex });
      }
      // overwatch: хто тримає кут і бачить — стріляє першим
      const watcher = this.players.find((q) => q.alive && q.overwatch && q.squad !== p.squad && this.sees(q, p));
      if (watcher) {
        this.emit({ type: 'move', id: p.id, squad: p.squad, from, path: done.slice() });
        watcher.overwatch = false;
        this.emit({ type: 'snap', from: watcher.id, to: p.id, hex: p.hex });
        this.startAttack(watcher, p, { overwatch: true, resume: { id: p.id, path } });
        return;
      }
    }
    this.emit({ type: 'move', id: p.id, squad: p.squad, from, path: done });
    this.afterMove(p);
  }

  afterMove(p) {
    // кроки ворогів чути
    const h = this.hexOf(p);
    const listeners = this.players.filter((q) => q.alive && q.squad !== p.squad && X.hexDist(this.hexOf(q), h) <= R.NOISE_RANGE);
    if (listeners.length && !listeners.some((q) => this.sees(q, p))) this.emit({ type: 'noise', squad: p.squad, hex: p.hex });
    this.continueActivation(p);
  }

  continueActivation(p) {
    if (this.checkEnd()) return;
    if (p.id === this.active && (p.ap <= 0 || !p.alive)) this.endActivation();
  }

  doShoot(p, a) {
    if (p.ap < 1) return { ok: false, error: 'Немає дій' };
    if (p.shot) return { ok: false, error: 'Стріляти можна раз за активацію' };
    const t = this.get(a.target);
    if (!t || !t.alive || t.squad === p.squad || !this.sees(p, t)) return { ok: false, error: 'Ціль не видно' };
    p.ap -= 1; p.shot = true;
    this.startAttack(p, t, {});
    return { ok: true };
  }

  startAttack(from, to, { overwatch = false, resume = null }) {
    const hf = this.hexOf(from), ht = this.hexOf(to);
    const n = R.attackNeed({ weapon: this.weaponId(from), dist: X.hexDist(hf, ht), moved: from.moved && from.id === this.active, flashed: from.flashed, overwatch });
    const cover = X.inCover(ht, hf);
    this.pending = {
      kind: 'attack', from: from.id, to: to.id, overwatch, resume, stage: 'atk',
      weapon: this.weaponId(from), need: n.need, mods: n.mods, atk: n.atk,
      save: R.defenseNeed(to), cover, armor: to.armor, atkDice: null, defDice: null,
    };
    this.emit({ type: 'attack', from: from.id, to: to.id, overwatch, need: n.need, mods: n.mods, cover, save: this.pending.save });
  }

  roll(id) {
    const pe = this.pending;
    if (!pe) return { ok: false, error: 'Немає кидка' };
    if (pe.stage === 'atk' && id === pe.from) {
      pe.atkDice = Array.from({ length: pe.atk }, () => d6(this.rng));
      pe.stage = 'def';
      this.step += 1;
      this.emit({ type: 'atkroll', from: pe.from, dice: pe.atkDice, need: pe.need });
      return { ok: true, dice: pe.atkDice };
    }
    if (pe.stage === 'def' && id === pe.to) {
      pe.defDice = Array.from({ length: R.DEF_DICE }, () => d6(this.rng));
      this.step += 1;
      this.resolve();
      return { ok: true, dice: pe.defDice };
    }
    return { ok: false, error: 'Зараз кидає інший гравець' };
  }

  resolve() {
    const pe = this.pending;
    const from = this.get(pe.from), to = this.get(pe.to);
    const r = R.resolveAttack({ weapon: pe.weapon, need: pe.need, atkDice: pe.atkDice, defDice: pe.defDice, save: pe.save, cover: !!pe.cover, armor: pe.armor });
    this.emit({ type: 'result', from: pe.from, to: pe.to, atkDice: pe.atkDice, defDice: pe.defDice, need: pe.need, save: pe.save, cover: pe.cover, ...r, hpBefore: to.hp });
    this.pending = null;
    if (r.damage) this.damage(to, r.damage, from, pe.weapon);
    if (this.checkEnd()) return;
    if (pe.resume) {
      const mover = this.get(pe.resume.id);
      if (mover.alive && pe.resume.path.length) { this.runPath(mover, pe.resume.path); return; }
      if (mover.alive) { this.afterMove(mover); return; }
    }
    const act = this.get(this.active);
    if (act) this.continueActivation(act);
    else this.next();
  }

  doNade(p, a) {
    if (p.ap < 1) return { ok: false, error: 'Немає дій' };
    const type = a.nade;
    if (!R.GRENADES[type] || p.nades[type] <= 0) return { ok: false, error: 'Немає такої гранати' };
    const h = X.hexAt(a.c, a.r);
    const me = this.hexOf(p);
    if (!h || h.kind === 'wall' || X.hexDist(me, h) > R.THROW_RANGE || !X.clearLine(me, h)) return { ok: false, error: `Кинути можна до ${R.THROW_RANGE} гексів і лише туди, куди видно` };
    p.ap -= 1; p.nades[type] -= 1;
    const k = X.key(h.c, h.r);
    const area = [h, ...X.allNeighbors(h)].filter((x) => x.kind !== 'wall').map((x) => X.key(x.c, x.r));
    const e = { type: 'nade', by: p.id, squad: p.squad, nade: type, hex: k, from: p.hex, area };
    if (type === 'smoke') for (const x of area) this.smokes.set(x, 2);
    if (type === 'molly') for (const x of area) if (!this.smokes.has(x)) this.fires.set(x, { turns: 2, by: p.id, squad: p.squad });
    if (type === 'flash') {
      e.blinded = [];
      for (const q of this.players) {
        if (!q.alive || q.squad === p.squad) continue;
        const qh = this.hexOf(q);
        if (X.hexDist(qh, h) <= 2 && X.los(qh, h)) { q.flashed = true; e.blinded.push(q.id); }
      }
    }
    this.emit(e);
    if (type === 'he') {
      for (const q of this.players) {
        if (!q.alive || !area.includes(q.hex)) continue;
        const dmg = q.armor ? R.HE_DMG_VEST : R.HE_DMG;
        this.emit({ type: 'blast', id: q.id, dmg });
        this.damage(q, dmg, p, 'he');
      }
    }
    this.continueActivation(p);
    return { ok: true };
  }

  damage(p, dmg, attacker, cause) {
    if (!p.alive) return;
    p.hp = Math.max(0, p.hp - dmg);
    if (p.hp > 0) return;
    p.alive = false; p.deaths += 1; p.overwatch = false;
    const e = { type: 'kill', id: p.id, by: attacker ? attacker.id : null, cause, hex: p.hex };
    if (attacker && attacker.squad !== p.squad) {
      attacker.kills += 1;
      const reward = R.WEAPONS[cause] ? R.WEAPONS[cause].kill : 300;
      attacker.money = Math.min(R.ECONOMY.max, attacker.money + reward);
      e.reward = reward;
    }
    this.emit(e);
    if (p.bomb) { p.bomb = false; Object.assign(this.bomb, { state: 'dropped', hex: p.hex }); this.emit({ type: 'drop', id: p.id, hex: p.hex }); }
    p.primary = null; p.armor = 0; p.kit = false; p.nades = { flash: 0, smoke: 0, he: 0, molly: 0 };
  }

  checkEnd() {
    if (this.phase !== 'play') return true;
    const tAlive = this.aliveOf('T').length, ctAlive = this.aliveOf('CT').length;
    let end = null;
    if (this.bomb.state === 'exploded') end = { winner: 'T', reason: 'bomb' };
    else if (this.bomb.state === 'defused') end = { winner: 'CT', reason: 'defuse' };
    else if (!ctAlive) end = { winner: 'T', reason: 'elim' };
    else if (!tAlive && this.bomb.state !== 'planted') end = { winner: 'CT', reason: 'elim' };
    if (end) { this.finishRound(end); return true; }
    return false;
  }

  finishRound(end) {
    const E = R.ECONOMY;
    this.pending = null; this.active = null;
    const winSquad = this.squadOfSide(end.winner);
    const loseSquad = 1 - winSquad;
    this.score[winSquad] += 1;
    const winMoney = { elim: E.winElim, bomb: E.winBomb, defuse: E.winDefuse, time: E.winTime }[end.reason];
    this.lossStreak[loseSquad] += 1;
    this.lossStreak[winSquad] = Math.max(0, this.lossStreak[winSquad] - 1);
    const loseMoney = R.lossBonus(this.lossStreak[loseSquad]) + (end.winner === 'CT' && this.planted ? E.plantBonus : 0);
    for (const p of this.players) p.money = Math.min(E.max, p.money + (p.squad === winSquad ? winMoney : loseMoney));
    this.roundResult = { ...end, winSquad, winMoney, loseMoney, round: this.round };
    this.history.push({ round: this.round, winSquad, winner: end.winner, reason: end.reason });
    this.emit({ type: 'roundEnd', ...this.roundResult });
    const over = this.score[0] >= R.ROUNDS_TO_WIN || this.score[1] >= R.ROUNDS_TO_WIN || this.round >= R.ROUNDS_TOTAL;
    this.phase = over ? 'over' : 'roundOver';
    if (over) this.matchResult = { winSquad: this.score[0] === this.score[1] ? null : (this.score[0] > this.score[1] ? 0 : 1), score: this.score.slice() };
  }

  // автоматична дія, коли час вийшов
  timeout() {
    const w = this.waitingFor();
    if (!w) return;
    if (w.kind === 'act') this.act(w.id, { type: 'end' });
    else this.roll(w.id);
  }

  /* ---------- вигляд для гравця ---------- */
  viewFor(viewerId, sinceEvent = 0) {
    const me = this.get(viewerId);
    const spectator = !me;
    const squad = me ? me.squad : 0;
    const seen = spectator ? new Set(this.players.map((p) => p.id)) : this.squadSees(squad);
    const over = this.phase === 'roundOver' || this.phase === 'over';
    const pe = this.pending;
    const involved = (id) => pe && (pe.from === id || pe.to === id);
    const players = this.players.map((p) => {
      const mine = spectator || p.squad === squad;
      const vis = mine || over || !p.alive || seen.has(p.id) || involved(p.id);
      const base = { id: p.id, name: p.name, isBot: p.isBot, squad: p.squad, side: this.sideOf(p), alive: p.alive, kills: p.kills, deaths: p.deaths, connected: p.connected, visible: vis, expended: p.expended };
      if (vis) Object.assign(base, { hex: p.hex, hp: p.hp, armor: p.armor, weapon: this.weaponId(p), bomb: p.bomb, overwatch: mine ? p.overwatch : undefined, flashed: p.flashed });
      if (mine) Object.assign(base, { money: p.money, nades: { ...p.nades }, kit: p.kit, primary: p.primary, pistol: p.pistol, ap: p.id === this.active ? p.ap : 0, moved: p.moved, shot: p.shot, ready: p.ready });
      return base;
    });
    let bomb = { state: this.bomb.state };
    const b = this.bomb;
    if (['planted', 'defused', 'exploded'].includes(b.state)) bomb = { state: b.state, hex: b.hex, site: b.site, turnsLeft: b.turnsLeft };
    else if (b.state === 'dropped') bomb = (spectator || (me && this.sideOf(me) === 'T')) ? { state: 'dropped', hex: b.hex } : { state: 'unknown' };
    return {
      phase: this.phase, round: this.round, half: this.half, turn: this.turn, clock: this.clock,
      score: this.score, players, bomb, me: viewerId, active: this.active,
      pending: pe ? { from: pe.from, to: pe.to, stage: pe.stage, overwatch: pe.overwatch, weapon: pe.weapon, need: pe.need, mods: pe.mods, atk: pe.atk, save: pe.save, cover: pe.cover, atkDice: pe.atkDice } : null,
      smokes: [...this.smokes.keys()], fires: [...this.fires.keys()],
      events: this.filterEvents(squad, spectator, sinceEvent),
      roundResult: this.roundResult, matchResult: this.matchResult || null, history: this.history,
      canPlant: me && this.active === me.id ? this.canPlant(me) : false,
      canDefuse: me && this.active === me.id ? this.canDefuse(me) : false,
      waiting: this.waitingFor(),
    };
  }

  filterEvents(squad, spectator, since) {
    const out = [];
    const isMate = (id) => { const p = this.get(id); return p && p.squad === squad; };
    for (let i = since; i < this.events.length; i++) {
      const e = this.events[i];
      if (spectator) { out.push(e); continue; }
      switch (e.type) {
        case 'move': {
          if (e.squad === squad) { out.push(e); break; }
          // ворог: показуємо лише видимі кроки
          const mates = this.players.filter((p) => p.alive && p.squad === squad);
          const vis = e.path.filter((k) => mates.some((m) => { const mh = this.hexOf(m), h = X.HEXES.get(k); return X.hexDist(mh, h) <= R.VIEW_RANGE && X.los(mh, h, this.smokeFn()); }));
          if (vis.length) out.push({ ...e, path: e.path.slice(e.path.indexOf(vis[0])), from: null });
          break;
        }
        case 'noise': if (e.squad !== squad) out.push(e); break;
        case 'overwatch': if (isMate(e.id)) out.push(e); break;
        case 'nade': out.push(e.squad === squad ? e : { ...e, by: null, from: null }); break;
        case 'pickup': case 'drop': if (isMate(e.id) || this.sideOf(this.get(e.id)) === 'T' && this.squadOfSide('T') === squad) out.push(e); break;
        default: out.push(e);
      }
    }
    return out;
  }
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
