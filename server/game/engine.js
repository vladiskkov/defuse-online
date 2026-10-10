// Рушій настільного «Дефузу».
// Раунд: закупівля → ходи (усі одночасно обирають дію) → перестрілки в зонах → … → кінець раунду.
// Чистий код без мережі: кімната (rooms.js) керує таймерами і розсилає стани.
import * as R from '../../shared/rules.js';
import { ZONES, ZONE } from '../../shared/zones.js';

const SIDES = ['T', 'CT'];
const d6 = (rng) => 1 + Math.floor(rng() * 6);
const NADE_ORDER = ['smoke', 'molly', 'flash', 'he'];

export class Match {
  constructor({ players, rng = Math.random }) {
    this.rng = rng;
    this.players = players.map((p) => ({
      id: p.id, name: p.name, isBot: !!p.isBot, squad: p.squad,
      money: R.ECONOMY.start, hp: R.HP, alive: true, zone: null, prev: null,
      pistol: null, primary: null, armor: 0, vestUp: false, kit: false,
      nades: { flash: 0, smoke: 0, he: 0, molly: 0 },
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
  weaponId(p) { return p.primary || p.pistol; }
  weapon(p) { return R.WEAPONS[this.weaponId(p)]; }
  inZone(zone) { return this.players.filter((p) => p.alive && p.zone === zone); }
  enemiesIn(p, zone = p.zone) { return this.inZone(zone).filter((q) => q.squad !== p.squad); }
  nadeCount(p) { return Object.values(p.nades).reduce((a, b) => a + b, 0); }
  smoked(zone) { return (this.smokes[zone] || 0) > 0; }
  burning(zone) { return this.fires[zone] && this.fires[zone].turns > 0; }
  contested(zone) {
    if (this.smoked(zone)) return false;
    const here = this.inZone(zone);
    return here.some((p) => p.squad === 0) && here.some((p) => p.squad === 1);
  }
  get clock() { return Math.max(0, R.ROUND_TIME - Math.max(0, this.turn - 1) * R.TURN_SECONDS); }

  /* ---------- раунд ---------- */
  startRound() {
    this.round += 1;
    if (this.round === R.ROUNDS_TOTAL / 2 + 1) this.halftime();
    const pistolRound = this.round === 1 || this.round === R.ROUNDS_TOTAL / 2 + 1;
    this.phase = 'buy';
    this.turn = 0;
    this.fightRound = 0;
    this.smokes = {}; this.fires = {};
    this.bomb = { state: 'carried', zone: null, turnsLeft: 0, site: null };
    this.planted = false;
    this.roundResult = null;
    this.lastEvents = []; this.lastKind = null;
    this.botMemory = {};
    for (const side of SIDES) {
      for (const p of this.team(side)) {
        if (!p.alive || pistolRound) {
          p.primary = null; p.armor = 0; p.kit = false;
          p.nades = { flash: 0, smoke: 0, he: 0, molly: 0 };
        }
        p.pistol = side === 'T' ? 'glock' : 'usp';
        if (p.primary && R.WEAPONS[p.primary].side !== side) p.primary = null;
        Object.assign(p, { hp: R.HP, alive: true, bomb: false, zone: side === 'T' ? 'tspawn' : 'ctspawn', prev: null, plan: null, ready: false, bought: [], fight: null, held: false, flashed: false });
      }
    }
    const ts = this.team('T');
    if (ts.length) ts[Math.floor(this.rng() * ts.length)].bomb = true;
  }

  halftime() {
    this.half = 1;
    this.lossStreak = [0, 0];
    for (const p of this.players) {
      p.money = R.ECONOMY.start; p.primary = null; p.armor = 0; p.kit = false;
      p.nades = { flash: 0, smoke: 0, he: 0, molly: 0 };
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
    for (const p of this.players) { p.bought = []; p.vestUp = p.armor >= 1; }
    this.startMove();
  }

  startMove() {
    this.phase = 'move';
    this.turn += 1;
    this.fightRound = 0;
    for (const p of this.players) { p.plan = null; p.ready = false; p.fight = null; p.flashed = false; }
  }

  /* ---------- хід ---------- */
  canPlant(p) { return p.alive && p.bomb && this.sideOf(p) === 'T' && !!ZONE[p.zone].site && this.bomb.state === 'carried'; }
  canDefuse(p) { return p.alive && this.sideOf(p) === 'CT' && this.bomb.state === 'planted' && p.zone === this.bomb.zone; }

  setPlan(id, raw) {
    const p = this.get(id);
    if (!p || !p.alive || this.phase !== 'move') return { ok: false };
    p.plan = this.normalizePlan(p, raw || {});
    p.ready = !!(raw && raw.ready);
    return { ok: true, plan: p.plan };
  }

  normalizePlan(p, raw) {
    const plan = { action: 'hold', to: null, nade: null };
    if (raw.action === 'move' && ZONE[p.zone].adj.includes(raw.to)) { plan.action = 'move'; plan.to = raw.to; }
    else if (raw.action === 'plant' && this.canPlant(p)) plan.action = 'plant';
    else if (raw.action === 'defuse' && this.canDefuse(p)) plan.action = 'defuse';
    const n = raw.nade;
    if (n && R.GRENADES[n.type] && p.nades[n.type] > 0 && (n.zone === p.zone || ZONE[p.zone].adj.includes(n.zone))) plan.nade = { type: n.type, zone: n.zone };
    return plan;
  }

  allReady() {
    if (this.phase === 'duel') return this.players.filter((p) => p.fight && p.alive && !p.isBot && p.connected).every((p) => p.fight.ready);
    return this.players.filter((p) => p.alive && !p.isBot && p.connected).every((p) => p.ready);
  }

  resolveMove() {
    const ev = [];
    this.events = ev;
    const alive = this.players.filter((p) => p.alive);
    for (const p of alive) { if (!p.plan) p.plan = this.normalizePlan(p, {}); p.prev = p.zone; p.flashed = false; }

    // 1. дим і вогонь з'являються до руху
    const throws = alive.filter((p) => p.plan.nade).sort((a, b) => NADE_ORDER.indexOf(a.plan.nade.type) - NADE_ORDER.indexOf(b.plan.nade.type));
    for (const p of throws) {
      const { type, zone } = p.plan.nade;
      p.nades[type] -= 1;
      ev.push({ type: 'nade', by: p.id, squad: p.squad, nade: type, zone, from: p.zone });
      if (type === 'smoke') this.smokes[zone] = R.SMOKE_TURNS;
      if (type === 'molly') { if (!this.smoked(zone)) this.fires[zone] = { turns: R.FIRE_TURNS, by: p.id, squad: p.squad }; }
    }

    // 2. рух (зустрічні вороги зустрічаються в одній зоні)
    const moves = alive.filter((p) => p.plan.action === 'move');
    for (const p of moves) p.zone = p.plan.to;
    for (const a of moves) for (const b of moves) {
      if (a.squad < b.squad && a.prev === b.zone && b.prev === a.zone && a.zone !== b.zone) {
        b.zone = a.zone; // розминутися не вийшло — зустрілись
        ev.push({ type: 'clash', a: a.id, b: b.id, zone: a.zone });
      }
    }
    for (const p of alive) {
      p.held = p.plan.action !== 'move';
      if (p.zone !== p.prev) ev.push({ type: 'move', id: p.id, squad: p.squad, from: p.prev, to: p.zone });
    }
    // підібрати бомбу
    if (this.bomb.state === 'dropped') {
      const t = this.inZone(this.bomb.zone).find((p) => this.sideOf(p) === 'T');
      if (t) { this.bomb.state = 'carried'; t.bomb = true; ev.push({ type: 'pickup', id: t.id, zone: t.zone }); }
    }

    // 3. флешки, осколкові, вогонь — після руху
    for (const p of throws) {
      const { type, zone } = p.plan.nade;
      const victims = this.inZone(zone).filter((q) => q.squad !== p.squad);
      if (type === 'flash') { for (const q of victims) q.flashed = true; ev.push({ type: 'flashed', by: p.id, zone, ids: victims.map((q) => q.id) }); }
      if (type === 'he') for (const q of victims) this.damage(q, 1, p, 'he', ev);
    }
    for (const [zone, f] of Object.entries(this.fires)) {
      if (f.turns <= 0) continue;
      for (const q of this.inZone(zone)) if (q.squad !== f.squad) { ev.push({ type: 'burn', id: q.id, zone }); this.damage(q, 1, this.get(f.by), 'molly', ev); }
    }

    // 4. кроки чути в сусідніх зонах
    for (const p of alive) if (p.alive && p.zone !== p.prev) ev.push({ type: 'noise', squad: p.squad, zone: p.zone });

    // 5. бомба
    let justPlanted = false;
    for (const p of alive) {
      if (p.alive && p.plan.action === 'plant' && this.canPlant(p) && (!this.enemiesIn(p).length || this.smoked(p.zone))) {
        p.bomb = false;
        Object.assign(this.bomb, { state: 'planted', zone: p.zone, site: ZONE[p.zone].site, turnsLeft: R.BOMB_TURNS, planter: p.id });
        this.planted = true; justPlanted = true;
        ev.push({ type: 'planted', id: p.id, zone: p.zone, site: this.bomb.site });
      } else if (p.alive && p.plan.action === 'plant') ev.push({ type: 'planfail', id: p.id, why: 'У зоні ворог — закласти не вдалося' });
    }
    if (this.bomb.state === 'planted' && !justPlanted) {
      for (const p of alive) {
        if (!p.alive || !this.canDefuse(p)) continue;
        const tries = p.plan.action === 'defuse' || (p.kit && p.prev !== p.zone);
        if (!tries) continue;
        if (this.enemiesIn(p).length && !this.smoked(p.zone)) { ev.push({ type: 'planfail', id: p.id, why: 'Ворог поруч — розмінувати не вдалося' }); continue; }
        this.bomb.state = 'defused';
        ev.push({ type: 'defused', id: p.id, zone: p.zone, kit: p.kit });
        break;
      }
      if (this.bomb.state === 'planted') {
        this.bomb.turnsLeft -= 1;
        if (this.bomb.turnsLeft <= 0) {
          this.bomb.state = 'exploded';
          ev.push({ type: 'exploded', zone: this.bomb.zone });
          for (const q of this.inZone(this.bomb.zone)) this.damage(q, 99, null, 'bomb', ev, true);
        }
      }
    }
    // 6. дим і вогонь гаснуть
    for (const z of Object.keys(this.smokes)) if (--this.smokes[z] <= 0) delete this.smokes[z];
    for (const z of Object.keys(this.fires)) if (--this.fires[z].turns <= 0) delete this.fires[z];
    for (const p of this.players) { p.plan = null; p.ready = false; }
    return this.afterResolve('move');
  }

  damage(p, n, attacker, cause, ev, pierce = false) {
    if (!p.alive || n <= 0) return 0;
    if (!pierce && n === 1 && p.vestUp) { p.vestUp = false; ev.push({ type: 'armor', id: p.id }); return 0; }
    p.hp = Math.max(0, p.hp - n);
    if (p.hp <= 0) this.kill(p, attacker, cause, ev);
    return n;
  }

  kill(p, attacker, cause, ev) {
    p.alive = false; p.deaths += 1; p.fight = null;
    const e = { type: 'kill', id: p.id, by: attacker ? attacker.id : null, cause, zone: p.zone };
    if (attacker && attacker.squad !== p.squad) {
      attacker.kills += 1;
      const reward = R.WEAPONS[cause] ? R.WEAPONS[cause].kill : 300;
      attacker.money = Math.min(R.ECONOMY.max, attacker.money + reward);
      e.reward = reward;
    }
    ev.push(e);
    if (p.bomb) {
      p.bomb = false;
      Object.assign(this.bomb, { state: 'dropped', zone: p.zone });
      ev.push({ type: 'drop', id: p.id, zone: p.zone });
    }
    p.primary = null; p.armor = 0; p.kit = false; p.vestUp = false; p.nades = { flash: 0, smoke: 0, he: 0, molly: 0 };
  }

  afterResolve(kind) {
    this.lastEvents = this.events;
    this.lastKind = kind;
    // бомбу підбирає T, що лишився в зоні після бою
    if (this.bomb.state === 'dropped') {
      const t = this.inZone(this.bomb.zone).find((p) => this.sideOf(p) === 'T');
      if (t && !this.contested(t.zone)) { this.bomb.state = 'carried'; t.bomb = true; this.events.push({ type: 'pickup', id: t.id, zone: t.zone }); }
    }
    const end = this.checkRoundEnd(kind);
    if (end) { this.finishRound(end); return { events: this.events, roundEnd: end }; }
    if (ZONES.some((z) => this.contested(z.id))) this.startFight();
    else if (kind === 'duel' && this.turn >= R.TURNS && !this.planted) { this.finishRound({ winner: 'CT', reason: 'time' }); return { events: this.events, roundEnd: this.roundResult }; }
    else this.startMove();
    return { events: this.events, roundEnd: null };
  }

  /* ---------- перестрілка ---------- */
  startFight() {
    this.phase = 'duel';
    this.fightRound += 1;
    for (const p of this.players) {
      p.ready = false;
      p.fight = p.alive && this.contested(p.zone) ? { zone: p.zone, action: null, target: null, dice: null, ready: false } : null;
    }
  }

  fightInfo(p) {
    const enemies = this.enemiesIn(p);
    return {
      zone: p.zone,
      enemies,
      mine: R.shotBonus({ weapon: this.weaponId(p), held: p.held, flashed: p.flashed }),
    };
  }

  duelAct(id, raw) {
    const p = this.get(id);
    if (!p || !p.alive || this.phase !== 'duel' || !p.fight) return { ok: false, error: 'Ви не в перестрілці' };
    if (p.fight.dice) return { ok: false, error: 'Кубики вже кинуто' };
    const enemies = this.enemiesIn(p);
    if (raw.action === 'retreat') Object.assign(p.fight, { action: 'retreat', target: null });
    else {
      const t = enemies.find((q) => q.id === raw.target) || enemies.slice().sort((a, b) => a.hp - b.hp)[0];
      if (!t) return { ok: false, error: 'Немає цілі' };
      Object.assign(p.fight, { action: 'shoot', target: t.id });
    }
    return { ok: true };
  }

  duelRoll(id) {
    const p = this.get(id);
    if (!p || !p.alive || this.phase !== 'duel' || !p.fight) return { ok: false };
    if (!p.fight.action) this.duelAct(id, { action: 'shoot' });
    if (!p.fight.dice) {
      const n = p.fight.action === 'retreat' ? 1 : this.weapon(p).dice;
      p.fight.dice = Array.from({ length: n }, () => d6(this.rng));
    }
    p.fight.ready = true;
    return { ok: true, dice: p.fight.dice };
  }

  autoDuel(p) {
    if (!p.fight || p.fight.ready) return;
    this.duelRoll(p.id);
  }

  retreatZone(p) {
    const opts = ZONE[p.zone].adj.filter((z) => !this.inZone(z).some((q) => q.squad !== p.squad));
    if (p.prev && p.prev !== p.zone && opts.includes(p.prev)) return p.prev;
    return opts.length ? opts[Math.floor(this.rng() * opts.length)] : null;
  }

  resolveFight() {
    const ev = [];
    this.events = ev;
    const fighters = this.players.filter((p) => p.alive && p.fight);
    for (const p of fighters) this.autoDuel(p);
    // підсумки кидків
    const sum = {};
    for (const p of fighters) {
      const f = p.fight;
      if (f.action === 'shoot') {
        const b = R.shotBonus({ weapon: this.weaponId(p), held: p.held, flashed: p.flashed });
        sum[p.id] = f.dice.reduce((a, d) => a + d, 0) + b.bonus;
        ev.push({ type: 'roll', id: p.id, zone: f.zone, action: 'shoot', target: f.target, dice: f.dice, mods: b.mods, bonus: b.bonus, total: sum[p.id], weapon: this.weaponId(p) });
      } else {
        ev.push({ type: 'roll', id: p.id, zone: f.zone, action: 'retreat', dice: f.dice, total: f.dice[0], safe: f.dice[0] >= R.RETREAT_SAFE });
      }
    }
    // влучання — одночасно
    const hits = [];
    for (const p of fighters) {
      const f = p.fight;
      if (f.action !== 'shoot') continue;
      const t = this.get(f.target);
      if (!t || !t.fight || t.zone !== p.zone) continue;
      if (t.fight.action === 'retreat') { ev.push({ type: 'shot', from: p.id, to: t.id, vs: 'retreat', hit: false }); continue; }
      const hit = sum[p.id] >= sum[t.id];
      const head = hit && R.isHeadshot(this.weaponId(p), f.dice, t.armor);
      ev.push({ type: 'shot', from: p.id, to: t.id, mine: sum[p.id], theirs: sum[t.id], hit, head, tie: sum[p.id] === sum[t.id] });
      if (hit) hits.push({ p, t, head });
    }
    for (const h of hits) {
      const before = h.t.hp;
      const dealt = this.damage(h.t, h.head ? 99 : 1, h.p, this.weaponId(h.p), ev, h.head);
      ev.push({ type: 'hit', from: h.p.id, to: h.t.id, head: h.head, armor: !dealt && !h.head, hpBefore: before, hp: h.t.hp });
    }
    // відступ
    for (const p of fighters) {
      if (!p.alive || p.fight.action !== 'retreat') continue;
      const safe = p.fight.dice[0] >= R.RETREAT_SAFE;
      const to = this.retreatZone(p);
      if (!safe) { const dealt = this.damage(p, 1, null, 'retreat', ev); ev.push({ type: 'hit', from: null, to: p.id, retreat: true, armor: !dealt, hp: p.hp }); }
      if (p.alive && to) { ev.push({ type: 'retreat', id: p.id, from: p.zone, to, safe }); p.prev = p.zone; p.zone = to; p.held = false; }
      else if (p.alive) ev.push({ type: 'retreat', id: p.id, from: p.zone, to: null, safe });
    }
    return this.afterResolve('duel');
  }

  checkRoundEnd(kind) {
    const tAlive = this.aliveOf('T').length, ctAlive = this.aliveOf('CT').length;
    if (this.bomb.state === 'exploded') return { winner: 'T', reason: 'bomb' };
    if (this.bomb.state === 'defused') return { winner: 'CT', reason: 'defuse' };
    if (!ctAlive) return { winner: 'T', reason: 'elim' };
    if (this.bomb.state !== 'planted') {
      if (!tAlive) return { winner: 'CT', reason: 'elim' };
      if (kind === 'move' && this.turn >= R.TURNS && !ZONES.some((z) => this.contested(z.id))) return { winner: 'CT', reason: 'time' };
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
    for (const p of this.players) { p.money = Math.min(E.max, p.money + (p.squad === winSquad ? winMoney : loseMoney)); p.fight = null; }
    this.roundResult = { ...end, winSquad, winMoney, loseMoney, round: this.round };
    this.history.push({ round: this.round, winSquad, winner: end.winner, reason: end.reason });
    const over = this.score[0] >= R.ROUNDS_TO_WIN || this.score[1] >= R.ROUNDS_TO_WIN || this.round >= R.ROUNDS_TOTAL;
    this.phase = over ? 'over' : 'roundOver';
    if (over) this.matchResult = { winSquad: this.score[0] === this.score[1] ? null : (this.score[0] > this.score[1] ? 0 : 1), score: this.score.slice() };
  }

  /* ---------- вигляд для конкретного гравця (туман війни) ---------- */
  squadZones(squad) { return new Set(this.players.filter((p) => p.alive && p.squad === squad).map((p) => p.zone)); }

  viewFor(viewerId) {
    const me = this.get(viewerId);
    const spectator = !me;
    const squad = me ? me.squad : 0;
    const myZones = this.squadZones(squad);
    const over = this.phase === 'roundOver' || this.phase === 'over';
    const fightZones = new Set(this.players.filter((p) => p.fight).map((p) => p.zone));
    const players = this.players.map((p) => {
      const mine = spectator || p.squad === squad;
      const seen = mine || over || !p.alive || myZones.has(p.zone);
      const base = { id: p.id, name: p.name, isBot: p.isBot, squad: p.squad, side: this.sideOf(p), alive: p.alive, kills: p.kills, deaths: p.deaths, connected: p.connected, visible: seen };
      if (seen) Object.assign(base, { zone: p.zone, hp: p.hp, armor: p.armor, vestUp: p.vestUp, weapon: this.weaponId(p), bomb: p.bomb, inFight: !!p.fight && fightZones.has(p.zone) });
      if (mine) Object.assign(base, { money: p.money, nades: { ...p.nades }, kit: p.kit, ready: this.phase === 'duel' ? !!(p.fight && p.fight.ready) : p.ready, primary: p.primary, pistol: p.pistol, held: p.held, flashed: p.flashed });
      return base;
    });
    let bomb = { state: this.bomb.state };
    const b = this.bomb;
    if (['planted', 'defused', 'exploded'].includes(b.state)) bomb = { state: b.state, zone: b.zone, site: b.site, turnsLeft: b.turnsLeft };
    else if (b.state === 'dropped') bomb = (spectator || (me && this.sideOf(me) === 'T') || myZones.has(b.zone)) ? { state: 'dropped', zone: b.zone } : { state: 'unknown' };
    let fight = null;
    if (me && this.phase === 'duel' && me.fight) {
      const info = this.fightInfo(me);
      fight = {
        zone: me.zone, round: this.fightRound, action: me.fight.action, target: me.fight.target, dice: me.fight.dice, ready: me.fight.ready,
        mods: info.mine.mods, bonus: info.mine.bonus, myDice: info.mine.dice,
        enemies: info.enemies.map((q) => ({ id: q.id, hp: q.hp, armor: q.armor, vestUp: q.vestUp, weapon: this.weaponId(q), ...R.shotBonus({ weapon: this.weaponId(q), held: q.held, flashed: q.flashed }) })),
        allies: this.inZone(me.zone).filter((q) => q.squad === me.squad && q.id !== me.id).map((q) => q.id),
        canRetreat: !!this.retreatZone(me),
      };
    }
    return {
      phase: this.phase, round: this.round, half: this.half, turn: this.turn, fightRound: this.fightRound,
      clock: this.clock, score: this.score, players, bomb, me: viewerId,
      smokes: { ...this.smokes }, fires: Object.fromEntries(Object.entries(this.fires).map(([z, f]) => [z, f.turns])),
      events: this.filterEvents(squad, spectator, myZones), eventsKind: this.lastKind,
      roundResult: this.roundResult, matchResult: this.matchResult || null,
      history: this.history,
      canPlant: me && this.phase === 'move' ? this.canPlant(me) : false,
      canDefuse: me && this.phase === 'move' ? this.canDefuse(me) : false,
      fight,
      fightZones: [...fightZones],
    };
  }

  filterEvents(squad, spectator, myZones) {
    const ev = this.lastEvents || [];
    if (spectator) return ev;
    const isMate = (id) => { const p = this.get(id); return p && p.squad === squad; };
    // зони, де була моя команда до чи після ходу
    const known = new Set(myZones);
    for (const e of ev) if (e.type === 'move' && e.squad === squad) { known.add(e.from); known.add(e.to); }
    const near = new Set();
    for (const z of known) { near.add(z); for (const a of ZONE[z].adj) near.add(a); }
    const out = [];
    for (const e of ev) {
      switch (e.type) {
        case 'move': if (e.squad === squad || known.has(e.to)) out.push(e); break;
        case 'noise': if (e.squad !== squad && near.has(e.zone) && !known.has(e.zone)) out.push(e); break;
        case 'nade': out.push(e.squad === squad ? e : { ...e, by: null, from: null }); break;
        case 'roll': case 'shot': case 'hit': case 'retreat': case 'armor': case 'burn': case 'flashed': case 'clash':
          if (isMate(e.id || e.from || e.to || e.a || e.by) || isMate(e.to) || isMate(e.b) || known.has(e.zone)) out.push(e); break;
        case 'pickup': case 'drop': if (isMate(e.id) || known.has(e.zone)) out.push(e); break;
        case 'planfail': if (isMate(e.id)) out.push(e); break;
        default: out.push(e);
      }
    }
    return out;
  }
}
