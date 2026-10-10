// Кімнати: лобі, місця в командах, боти, таймери фаз матчу.
import crypto from 'node:crypto';
import { Match } from './game/engine.js';
import { botBuy, botAct } from './game/bot.js';
import * as R from '../shared/rules.js';

const BOT_NAMES = ['Сашко', 'Марічка', 'Тарас', 'Оксана', 'Богдан', 'Ярина', 'Остап', 'Леся', 'Петро', 'Зоя'];
const REPLAY_MS = 4200; // скільки клієнт показує повтор ходу чи дуелі
const ROUND_OVER_MS = 6000;

export class Rooms {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    setInterval(() => this.sweep(), 60_000).unref();
  }

  code() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do { c = Array.from(crypto.randomBytes(5), (b) => abc[b % abc.length]).join(''); } while (this.rooms.has(c));
    return c;
  }

  create(user, { size, solo }) {
    size = [1, 2, 3].includes(size) ? size : 1;
    const room = new Room(this, this.code(), user, size, !!solo);
    this.rooms.set(room.code, room);
    return room;
  }

  get(code) { return this.rooms.get(String(code || '').toUpperCase()); }

  roomOf(uid) {
    for (const r of this.rooms.values()) if (r.hasUser(uid)) return r;
    return null;
  }

  sweep() {
    const now = Date.now();
    for (const [code, r] of this.rooms) {
      if (r.sockets.size === 0 && now - r.touched > 10 * 60_000) { r.destroy(); this.rooms.delete(code); }
    }
  }
}

class Room {
  constructor(rooms, code, host, size, solo) {
    this.rooms = rooms;
    this.io = rooms.io;
    this.code = code;
    this.hostId = host.id;
    this.size = size;
    this.solo = solo;
    this.seats = [Array(size).fill(null), Array(size).fill(null)];
    this.seats[0][0] = { id: host.id, name: host.name, picture: host.picture || null };
    this.sockets = new Map();
    this.status = 'lobby';
    this.match = null;
    this.timer = null;
    this.deadline = 0;
    this.seq = 0;
    this.touched = Date.now();
    this.botN = 0;
    if (solo) {
      for (let s = 0; s < 2; s++) for (let i = 0; i < size; i++) if (!this.seats[s][i]) this.seats[s][i] = this.makeBot();
    }
  }

  makeBot() {
    const name = 'Бот ' + BOT_NAMES[this.botN % BOT_NAMES.length];
    this.botN += 1;
    return { id: 'bot' + this.botN + '_' + this.code, name, isBot: true };
  }

  hasUser(uid) { return this.seats.some((s) => s.some((x) => x && x.id === uid)); }
  seatOf(uid) {
    for (let s = 0; s < 2; s++) { const i = this.seats[s].findIndex((x) => x && x.id === uid); if (i >= 0) return { squad: s, i }; }
    return null;
  }

  /* ---------- з'єднання ---------- */
  attach(socket) {
    const uid = socket.user.id;
    if (!this.sockets.has(uid)) this.sockets.set(uid, new Set());
    this.sockets.get(uid).add(socket);
    socket.join(this.code);
    this.touched = Date.now();
    if (this.match) { const p = this.match.get(uid); if (p) p.connected = true; }
    this.broadcast();
  }

  detach(socket) {
    const set = this.sockets.get(socket.user.id);
    if (set) { set.delete(socket); if (!set.size) this.sockets.delete(socket.user.id); }
    socket.leave(this.code);
    this.touched = Date.now();
    if (this.match && !this.sockets.has(socket.user.id)) {
      const p = this.match.get(socket.user.id);
      if (p) p.connected = false;
      this.maybeAdvance();
    }
    this.broadcast();
  }

  /* ---------- лобі ---------- */
  join(user) {
    if (this.hasUser(user.id)) return { ok: true };
    if (this.solo) return { ok: false, error: 'Це гра з ботами' };
    if (this.status !== 'lobby') return { ok: false, error: 'Матч уже йде. Дочекайтеся кінця.' };
    for (let s = 0; s < 2; s++) {
      const order = s === 0 ? [0, 1] : [1, 0];
      for (const sq of order) {
        const i = this.seats[sq].findIndex((x) => !x);
        if (i >= 0) { this.seats[sq][i] = { id: user.id, name: user.name, picture: user.picture || null }; this.broadcast(); return { ok: true }; }
      }
    }
    // замінюємо бота
    for (let sq = 0; sq < 2; sq++) {
      const i = this.seats[sq].findIndex((x) => x && x.isBot);
      if (i >= 0) { this.seats[sq][i] = { id: user.id, name: user.name, picture: user.picture || null }; this.broadcast(); return { ok: true }; }
    }
    return { ok: false, error: 'Кімната заповнена' };
  }

  leave(uid) {
    const seat = this.seatOf(uid);
    if (!seat) return;
    if (this.status === 'playing' && this.match) {
      // у матчі місце займає бот
      const p = this.match.get(uid);
      if (p) { p.isBot = true; p.name = p.name + ' (бот)'; p.connected = true; }
      this.seats[seat.squad][seat.i] = { id: uid, name: (p ? p.name : 'Бот'), isBot: true, left: true };
    } else this.seats[seat.squad][seat.i] = null;
    const humans = this.seats.flat().filter((x) => x && !x.isBot);
    if (!humans.length) { this.destroy(); this.rooms.rooms.delete(this.code); return; }
    if (this.hostId === uid) this.hostId = humans[0].id;
    this.maybeAdvance();
    this.broadcast();
  }

  switchSquad(uid, squad) {
    if (this.status !== 'lobby' || ![0, 1].includes(squad)) return;
    const seat = this.seatOf(uid);
    if (!seat || seat.squad === squad) return;
    let i = this.seats[squad].findIndex((x) => !x);
    if (i < 0) i = this.seats[squad].findIndex((x) => x && x.isBot);
    if (i < 0) return;
    const me = this.seats[seat.squad][seat.i];
    this.seats[seat.squad][seat.i] = this.seats[squad][i] && this.seats[squad][i].isBot ? this.seats[squad][i] : null;
    this.seats[squad][i] = me;
    this.broadcast();
  }

  setBot(uid, squad, i, add) {
    if (uid !== this.hostId || this.status !== 'lobby') return;
    const row = this.seats[squad];
    if (!row || i < 0 || i >= this.size) return;
    if (add && !row[i]) row[i] = this.makeBot();
    if (!add && row[i] && row[i].isBot) row[i] = null;
    this.broadcast();
  }

  setSize(uid, size) {
    if (uid !== this.hostId || this.status !== 'lobby' || ![1, 2, 3].includes(size)) return;
    const people = this.seats.map((row) => row.filter(Boolean));
    if (people.some((row) => row.filter((x) => !x.isBot).length > size)) return { ok: false, error: 'Спершу хтось має перейти в іншу команду' };
    this.size = size;
    this.seats = people.map((row) => {
      const humans = row.filter((x) => !x.isBot), bots = row.filter((x) => x.isBot);
      const out = [...humans, ...bots].slice(0, size);
      while (out.length < size) out.push(null);
      return out;
    });
    this.broadcast();
    return { ok: true };
  }

  kick(uid, target) {
    if (uid !== this.hostId || target === uid || this.status !== 'lobby') return;
    const seat = this.seatOf(target);
    if (!seat) return;
    this.seats[seat.squad][seat.i] = null;
    const socks = this.sockets.get(target);
    if (socks) for (const s of socks) { s.emit('kicked'); s.leave(this.code); }
    this.sockets.delete(target);
    this.broadcast();
  }

  start(uid) {
    if (uid !== this.hostId) return { ok: false, error: 'Почати може лише господар кімнати' };
    if (this.status !== 'lobby') return { ok: false };
    if (this.seats.some((row) => row.some((x) => !x))) return { ok: false, error: 'Заповніть усі місця гравцями або ботами' };
    const players = [];
    for (let s = 0; s < 2; s++) for (const x of this.seats[s]) players.push({ id: x.id, name: x.name, isBot: !!x.isBot, squad: s });
    this.match = new Match({ players });
    for (const p of this.match.players) p.connected = p.isBot || this.sockets.has(p.id);
    this.status = 'playing';
    this.nextRound();
    return { ok: true };
  }

  backToLobby(uid) {
    if (this.status !== 'playing' || !this.match || this.match.phase !== 'over') return;
    this.clearTimer();
    this.status = 'lobby';
    this.match = null;
    // ті, хто вийшов під час матчу, звільняють місце
    for (const row of this.seats) for (let i = 0; i < row.length; i++) if (row[i] && row[i].left) row[i] = null;
    if (this.solo) for (let s = 0; s < 2; s++) for (let i = 0; i < this.size; i++) if (!this.seats[s][i]) this.seats[s][i] = this.makeBot();
    this.broadcast();
    if (this.solo) this.start(this.hostId);
  }

  /* ---------- перебіг матчу ---------- */
  clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  schedule(ms, fn) { this.clearTimer(); this.deadline = Date.now() + ms; this.timer = setTimeout(fn, ms); }

  nextRound() {
    const m = this.match;
    m.startRound();
    for (const p of m.players) if (p.isBot) { botBuy(m, p); p.ready = true; }
    this.schedule(R.BUY_SECONDS * 1000, () => this.startPhase());
    this.broadcast();
  }

  // початок фази руху або дуелі: боти діють одразу, людям — таймер
  startPhase(afterReplay = false) {
    const m = this.match;
    if (m.phase === 'buy') m.endBuy();
    this.botsAct();
    const secs = m.phase === 'duel' ? R.DUEL_SECONDS : R.PLAN_SECONDS;
    this.phaseOpensAt = Date.now() + (afterReplay ? REPLAY_MS : 0);
    this.schedule(secs * 1000 + (afterReplay ? REPLAY_MS : 0), () => this.resolve());
    this.broadcast();
    this.maybeAdvance();
  }

  botsAct() {
    const m = this.match;
    for (const p of m.players) if (p.isBot && p.alive) {
      try { botAct(m, p); } catch (e) { console.error('bot', e); if (m.phase === 'move') m.setPlan(p.id, { ready: true }); else m.autoDuel(p); }
    }
  }

  maybeAdvance() {
    const m = this.match;
    if (!m || this.status !== 'playing') return;
    const humans = m.players.filter((p) => !p.isBot && p.connected);
    if (!humans.length) return; // нікого немає — чекаємо таймера
    if (m.phase === 'buy' && humans.every((p) => p.ready)) {
      this.schedule(600, () => this.startPhase());
    } else if ((m.phase === 'move' || m.phase === 'duel') && m.allReady()) {
      // не розігруємо, поки клієнти ще показують повтор попередньої фази
      const wait = Math.max(400, (this.phaseOpensAt || 0) - Date.now());
      this.schedule(wait, () => this.resolve());
    }
  }

  resolve() {
    const m = this.match;
    if (!m || (m.phase !== 'move' && m.phase !== 'duel')) return;
    this.clearTimer();
    let result;
    try { result = m.phase === 'move' ? m.resolveMove() : m.resolveDuel(); } catch (e) { console.error('resolve failed', e); return; }
    this.seq += 1;
    if (result.roundEnd) {
      this.broadcast();
      if (m.phase === 'over') { this.deadline = 0; return; }
      this.schedule(REPLAY_MS + ROUND_OVER_MS, () => this.nextRound());
    } else {
      this.startPhase(true);
    }
  }

  /* ---------- дії гравців у матчі ---------- */
  buy(uid, item) {
    const r = this.match && this.match.buy(uid, item);
    if (r && r.ok) this.sendTo(uid);
    return r || { ok: false };
  }
  refund(uid) { const r = this.match && this.match.refund(uid); if (r && r.ok) this.sendTo(uid); return r || { ok: false }; }
  buyReady(uid, ready) {
    const m = this.match;
    if (!m || m.phase !== 'buy') return;
    const p = m.get(uid);
    if (p) p.ready = !!ready;
    this.broadcast();
    this.maybeAdvance();
  }
  plan(uid, plan) {
    const m = this.match;
    if (!m || m.phase !== 'move') return { ok: false };
    const p = m.get(uid);
    if (!p || p.isBot) return { ok: false };
    const r = m.setPlan(uid, plan);
    if (!r.ok) return r;
    // план бачать тіммейти
    for (const q of m.players) if (q.squad === p.squad && q.id !== uid) this.emitTo(q.id, 'teamPlan', { id: uid, plan: r.plan, ready: p.ready });
    this.broadcastLight();
    this.maybeAdvance();
    return { ok: true, plan: r.plan };
  }
  duelAct(uid, data) {
    const m = this.match;
    if (!m || m.phase !== 'duel') return { ok: false, error: 'Дуель уже закінчилась' };
    const r = m.duelAct(uid, data || {});
    if (r.ok) this.sendTo(uid);
    return r;
  }
  duelRoll(uid) {
    const m = this.match;
    if (!m || m.phase !== 'duel') return { ok: false };
    const r = m.duelRoll(uid);
    if (!r.ok) return r;
    this.broadcastLight();
    this.maybeAdvance();
    return r;
  }

  /* ---------- розсилка ---------- */
  emitTo(uid, ev, data) { const set = this.sockets.get(uid); if (set) for (const s of set) s.emit(ev, data); }

  lobbyState() {
    return {
      code: this.code, hostId: this.hostId, size: this.size, solo: this.solo, status: this.status,
      seats: this.seats.map((row) => row.map((x) => x && { id: x.id, name: x.name, isBot: !!x.isBot, picture: x.picture || null, online: x.isBot || this.sockets.has(x.id) })),
    };
  }

  viewFor(uid) {
    const m = this.match;
    if (!m) return null;
    const v = m.viewFor(uid);
    v.seq = this.seq;
    v.deadline = this.deadline;
    v.now = Date.now();
    // готовність команди і власний план
    const me = m.get(uid);
    if (me) {
      v.myPlan = me.plan;
      v.ready = me.ready;
      v.teamPlans = Object.fromEntries(m.players.filter((q) => q.squad === me.squad && q.id !== uid && q.plan).map((q) => [q.id, q.plan]));
    }
    const waiting = m.phase === 'duel' ? m.players.filter((p) => !p.isBot && p.alive && p.duel) : m.players.filter((p) => !p.isBot && p.alive);
    v.readyCount = waiting.filter((p) => (m.phase === 'duel' ? p.duel.ready : p.ready)).length;
    v.humanCount = waiting.length;
    return v;
  }

  sendTo(uid) {
    this.emitTo(uid, 'room', this.lobbyState());
    if (this.match) this.emitTo(uid, 'game', this.viewFor(uid));
  }

  broadcast() { for (const uid of this.sockets.keys()) this.sendTo(uid); }

  // лише лічильник готовності, без повтору подій
  broadcastLight() {
    const m = this.match;
    if (!m) return;
    const ready = Object.fromEntries(m.players.map((p) => [p.id, m.phase === 'duel' ? !!(p.duel && p.duel.ready) : !!p.ready]));
    for (const uid of this.sockets.keys()) this.emitTo(uid, 'ready', { ready, seq: this.seq });
  }

  destroy() { this.clearTimer(); }
}
