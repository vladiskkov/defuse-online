// Клієнт гри: карта на canvas, планування ходу, повтор подій з кубиками, закупівля.
import { Grid, dist, cheb } from '/shared/geom.js';
import { DUNE } from '/shared/map.js';
import * as R from '/shared/rules.js';

const TICK_MS = 650;
const T_END = R.MAX_STEPS + 1;
const COLORS = { T: '#f0a23a', CT: '#5aa7e8' };
const NADE_ICON = { he: '💥', flash: '✷', smoke: '☁', molly: '🔥' };
const REASON = {
  elim: 'усіх суперників знищено', bomb: 'бомба вибухнула', defuse: 'бомбу розміновано', time: 'час вийшов',
};
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Game {
  constructor({ emit, toast, onLobby }) {
    this.emit = emit; this.toast = toast; this.onLobby = onLobby;
    this.grid = new Grid(DUNE);
    this.canvas = $('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.board = $('board');
    this.view = null;
    this.seq = -1;
    this.offset = 0;
    this.cam = { x: 18, y: 14, s: 24, init: false };
    this.plan = this.freshPlan();
    this.planKey = '';
    this.tool = 'move';
    this.ghosts = new Map();
    this.noises = [];
    this.replay = null;
    this.teamPlans = {};
    this.effects = [];
    this.buyOpen = false;
    this.fogCache = null;
    this.staticMap = this.renderStatic();
    this.bindInput();
    this.bindUi();
    new ResizeObserver(() => this.resize()).observe(this.board);
    this.resize();
    const loop = () => { this.draw(); this.tickTimer(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  freshPlan(mode = 'walk') { return { mode, path: [], grenade: null, action: null, ready: false }; }

  /* ================= дані з сервера ================= */
  update(v) {
    const prev = this.view;
    this.offset = v.now - Date.now();
    this.view = v;
    this.byId = Object.fromEntries(v.players.map((p) => [p.id, p]));
    this.me = this.byId[v.me];
    this.fogCache = null;
    const key = v.round + ':' + v.turn;

    // новий хід → повтор подій
    if (v.seq !== this.seq) {
      const fresh = this.seq !== -1 && prev && v.events && v.events.length && v.seq === this.seq + 1;
      this.seq = v.seq;
      if (fresh) this.startReplay(prev, v);
      else this.replay = null;
      const focus = this.me && (this.me.alive ? this.me : v.players.find((p) => p.squad === this.me.squad && p.alive && p.x !== undefined));
      if (focus && focus.x !== undefined) this.follow(focus.x, focus.y);
      this.rememberEvents(v);
    }
    if (prev && prev.round !== v.round) { this.ghosts.clear(); this.noises = []; this.effects = []; }
    // запам'ятовуємо побачених ворогів
    for (const p of v.players) {
      if (this.me && p.squad !== this.me.squad && p.alive && p.visible && p.x !== undefined) this.ghosts.set(p.id, { x: p.x, y: p.y, turn: v.turn, round: v.round });
      if (!p.alive) this.ghosts.delete(p.id);
    }

    if (v.phase === 'plan' && key !== this.planKey) {
      this.planKey = key;
      const keepMode = this.plan.mode === 'hold' || this.plan.mode === 'dodge' ? 'walk' : this.plan.mode;
      this.plan = v.myPlan ? { ...v.myPlan, ready: !!v.ready } : this.freshPlan(keepMode);
      this.tool = 'move';
      this.teamPlans = v.teamPlans || {};
    }
    if (v.phase === 'buy' && (!prev || prev.phase !== 'buy' || prev.round !== v.round)) {
      this.buyOpen = !!(this.me);
      this.teamPlans = {};
      if (!this.cam.init || (prev && prev.round !== v.round)) this.centerOnMe();
    }
    if (!this.cam.init && this.me) this.centerOnMe();
    if (v.phase !== 'buy') this.buyOpen = false;
    this.renderHud();
    this.renderPanel();
    this.renderBuy();
    this.renderOverlay();
  }

  onReady({ ready, seq }) {
    if (!this.view || seq !== this.view.seq) return;
    for (const [id, r] of Object.entries(ready)) if (this.byId[id]) this.byId[id].ready = r;
    this.view.readyCount = this.view.players.filter((p) => !p.isBot && p.alive && ready[p.id]).length;
    this.renderHud();
  }

  onTeamPlan({ id, plan }) { this.teamPlans[id] = plan; }

  rememberEvents(v) {
    this.noises = [];
    for (const e of v.events || []) {
      if (e.type === 'noise') this.noises.push({ x: e.x, y: e.y, turn: v.turn });
      if (e.type === 'move' && this.me && this.byId[e.id] && this.byId[e.id].squad !== this.me.squad) this.ghosts.set(e.id, { x: e.x, y: e.y, turn: v.turn, round: v.round });
    }
    this.renderLog(v);
    this.feedKills(v);
  }

  /* ================= повтор ходу ================= */
  startReplay(prev, v) {
    const snaps = [];
    const start = {};
    for (const p of prev.players) if (p.x !== undefined && p.alive && (p.visible || p.squad === (this.me && this.me.squad))) start[p.id] = { x: p.x, y: p.y };
    snaps[0] = { ...start };
    const byT = Array.from({ length: T_END + 1 }, () => []);
    for (const e of v.events) byT[Math.min(T_END, e.t)].push(e);
    // гравці, яких побачили в бою (навіть якщо вони стояли на місці)
    const reveal = (t) => {
      for (const e of byT[t]) {
        const pts = e.type === 'shot' ? [[e.from, e.fx, e.fy], [e.to, e.tx, e.ty]] : e.type === 'spot' ? [[e.a, e.ax, e.ay], [e.b, e.bx, e.by]] : [];
        for (const [id, x, y] of pts) if (x !== undefined && !snaps[t][id]) {
          snaps[t][id] = { x, y };
          if (t > 0 && !snaps[t - 1][id]) snaps[t - 1][id] = { x, y };
        }
      }
    };
    reveal(0);
    for (let t = 1; t <= T_END; t++) {
      snaps[t] = { ...snaps[t - 1] };
      for (const e of byT[t]) if (e.type === 'move') {
        if (!snaps[t - 1][e.id]) snaps[t - 1][e.id] = { x: e.x, y: e.y }; // з'явився з туману
        snaps[t][e.id] = { x: e.x, y: e.y };
      }
      reveal(t);
    }
    const dead = {};
    for (const e of v.events) if (e.type === 'kill') dead[e.id] = e.t;
    this.replay = { start: performance.now(), snaps, byT, dead, fired: new Set(), prevSmokes: prev.smokes, prevFires: prev.fires };
  }

  replayTime() { return this.replay ? performance.now() - this.replay.start : Infinity; }
  get replaying() {
    if (this.replay && this.replayTime() > (T_END + 1) * TICK_MS + 400) this.replay = null;
    return !!this.replay;
  }

  replayPositions() {
    const r = this.replay;
    const tm = this.replayTime();
    const tick = Math.min(T_END, Math.floor(tm / TICK_MS));
    const frac = Math.min(1, (tm - tick * TICK_MS) / (TICK_MS * 0.55));
    const out = {};
    const a = r.snaps[Math.max(0, tick)], b = tick >= 1 ? r.snaps[tick - 1] : r.snaps[0];
    for (const id of Object.keys(a)) {
      const from = (tick >= 1 ? b[id] : a[id]) || a[id];
      const to = a[id];
      out[id] = { x: from.x + (to.x - from.x) * frac, y: from.y + (to.y - from.y) * frac, dead: r.dead[id] !== undefined && (r.dead[id] < tick || (r.dead[id] === tick && frac >= 1)) };
    }
    // події цього такту → ефекти
    for (let t = 0; t <= tick; t++) {
      if (r.fired.has(t)) continue;
      r.fired.add(t);
      this.spawnEffects(r.byT[t], r.snaps[t]);
    }
    if (tm > (T_END + 1) * TICK_MS + 400) this.replay = null;
    return out;
  }

  spawnEffects(events, pos) {
    const now = performance.now();
    let k = 0;
    for (const e of events) {
      if (e.type === 'shot') {
        const a = { x: e.fx, y: e.fy }, b = { x: e.tx, y: e.ty };
        this.effects.push({ type: 'shot', a, b, hit: e.hit, head: e.head, start: now + 250 + k * 120, dur: 1500, label: `🎲${e.roll}${e.acc >= 0 ? '+' : ''}${e.acc}=${e.total} / ${e.need}`, dmg: e.hit ? (e.head ? '💀 ' : '−') + e.dmg : 'мимо' });
        k++;
      } else if (e.type === 'nade') {
        this.effects.push({ type: 'nade', nade: e.nade, x: e.x, y: e.y, from: e.fx !== null && e.fx !== undefined ? { x: e.fx, y: e.fy } : null, start: now, dur: 1200 });
      } else if (e.type === 'kill') {
        this.effects.push({ type: 'kill', x: e.x, y: e.y, start: now + 400, dur: 1800 });
      } else if (e.type === 'planted' || e.type === 'exploded' || e.type === 'defused') {
        this.effects.push({ type: 'banner', text: e.type === 'planted' ? 'Бомбу закладено!' : e.type === 'defused' ? 'Бомбу розміновано!' : 'Вибух!', start: now, dur: 1800 });
      }
    }
  }

  /* ================= ввід ================= */
  resize() {
    const r = this.board.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = r.width; this.H = r.height; this.dpr = dpr;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fit = Math.min(r.width / this.grid.w, r.height / this.grid.h);
    if (!this.cam.init) this.cam.s = Math.max(this.fit, Math.min(30, r.width < 600 ? 26 : this.fit));
    this.clampCam();
  }

  // плавно перевести камеру до точки, якщо вона поза центром екрана
  follow(x, y) {
    if (!this.W) return;
    const c = this.cam;
    const hw = this.W / c.s / 2, hh = this.H / c.s / 2;
    if (Math.abs(x + 0.5 - c.x) < hw * 0.6 && Math.abs(y + 0.5 - c.y) < hh * 0.6) return;
    this.camAnim = { fx: c.x, fy: c.y, tx: x + 0.5, ty: y + 0.5, start: performance.now() };
  }

  centerOnMe() {
    if (!this.me || this.me.x === undefined || !this.W) return;
    this.cam.init = true;
    this.cam.s = this.W < 600 ? 26 : Math.max(this.fit, 22);
    this.cam.x = this.me.x + 0.5; this.cam.y = this.me.y + 0.5;
    this.clampCam();
  }

  clampCam() {
    const c = this.cam;
    c.s = Math.max(this.fit * 0.95, Math.min(56, c.s));
    const hw = this.W / c.s / 2, hh = this.H / c.s / 2;
    c.x = hw * 2 >= this.grid.w ? this.grid.w / 2 : Math.max(hw, Math.min(this.grid.w - hw, c.x));
    c.y = hh * 2 >= this.grid.h ? this.grid.h / 2 : Math.max(hh, Math.min(this.grid.h - hh, c.y));
  }

  toTile(px, py) {
    const c = this.cam;
    return { x: Math.floor((px - this.W / 2) / c.s + c.x), y: Math.floor((py - this.H / 2) / c.s + c.y) };
  }

  bindInput() {
    const pts = new Map();
    let drag = null, pinch = null;
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pts.size === 1) drag = { x: e.offsetX, y: e.offsetY, cx: this.cam.x, cy: this.cam.y, moved: false };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: this.cam.s };
        drag = null;
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        this.cam.s = pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d;
        this.clampCam();
      } else if (drag) {
        const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
        if (Math.hypot(dx, dy) > 8) drag.moved = true;
        if (drag.moved) { this.cam.x = drag.cx - dx / this.cam.s; this.cam.y = drag.cy - dy / this.cam.s; this.clampCam(); }
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (drag && !drag.moved && pts.size === 0) this.tap(this.toTile(e.offsetX, e.offsetY));
      if (pts.size < 2) pinch = null;
      drag = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); drag = null; pinch = null; });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.cam.s *= e.deltaY < 0 ? 1.12 : 1 / 1.12; this.clampCam(); }, { passive: false });
    $('zoomIn').onclick = () => { this.cam.s *= 1.25; this.clampCam(); };
    $('zoomOut').onclick = () => { this.cam.s /= 1.25; this.clampCam(); };
    $('zoomMe').onclick = () => this.centerOnMe();
  }

  bindUi() {
    $('logBtn').onclick = () => { $('logSheet').hidden = !$('logSheet').hidden; };
    $('menuBtn').onclick = () => this.openMenu();
    for (const id of ['logSheet', 'menuSheet']) $(id).addEventListener('click', (e) => { if (e.target.closest('[data-close]')) $(id).hidden = true; });
  }

  /* ================= планування ================= */
  canPlan() {
    const v = this.view;
    return v && v.phase === 'plan' && this.me && this.me.alive;
  }

  stepsLeft(mode = this.plan.mode, grenade = this.plan.grenade) {
    return Math.max(0, R.MODES[mode].steps - (grenade && mode !== 'hold' ? 1 : 0));
  }

  reachable() {
    if (!this.canPlan() || this.plan.action) return null;
    const steps = this.stepsLeft();
    if (!steps) return null;
    const d = this.grid.distanceField(this.me.x, this.me.y);
    const set = new Set();
    for (let i = 0; i < d.length; i++) if (d[i] > 0 && d[i] <= steps) set.add(i);
    return set;
  }

  validThrow(x, y) {
    const me = this.me;
    return !this.grid.opaque(x, y) && dist(me, { x, y }) <= R.THROW_RANGE + 0.01 && this.grid.los(me.x, me.y, x, y);
  }

  tap(t) {
    if (!this.canPlan()) return;
    if (this.plan.ready) { this.plan.ready = false; }
    const me = this.me;
    if (this.tool !== 'move') {
      if (!this.validThrow(t.x, t.y)) { this.toast('Сюди не докинути: потрібна пряма видимість і до 8 клітинок'); return; }
      this.plan.grenade = { type: this.tool, x: t.x, y: t.y };
      this.tool = 'move';
      this.plan.path = this.plan.path.slice(0, this.stepsLeft());
    } else {
      if (this.plan.action) this.plan.action = null;
      if (t.x === me.x && t.y === me.y) this.plan.path = [];
      else {
        if (this.plan.mode === 'hold') this.plan.mode = 'walk';
        const p = this.grid.path(me.x, me.y, t.x, t.y);
        if (!p) return;
        this.plan.path = p.slice(0, this.stepsLeft());
      }
    }
    this.sendPlan();
  }

  setMode(mode) {
    if (!this.canPlan()) return;
    this.plan.mode = mode;
    this.plan.action = null;
    this.plan.ready = false;
    this.plan.path = mode === 'hold' ? [] : this.plan.path.slice(0, this.stepsLeft());
    this.sendPlan();
  }

  setTool(nade) {
    if (!this.canPlan()) return;
    if (this.plan.grenade && this.plan.grenade.type === nade) { this.plan.grenade = null; this.tool = 'move'; this.plan.ready = false; this.sendPlan(); return; }
    this.tool = this.tool === nade ? 'move' : nade;
    this.plan.action = null;
    this.renderPanel();
  }

  setAction(action) {
    if (!this.canPlan()) return;
    this.plan.action = this.plan.action === action ? null : action;
    if (this.plan.action) { this.plan.path = []; this.plan.grenade = null; this.tool = 'move'; }
    this.plan.ready = false;
    this.sendPlan();
  }

  toggleReady() {
    if (!this.canPlan()) return;
    this.plan.ready = !this.plan.ready;
    this.sendPlan(true);
  }

  sendPlan(now) {
    this.renderPanel();
    clearTimeout(this.sendT);
    const go = () => this.emit('game:plan', { ...this.plan }).then((r) => {
      if (r && r.ok && r.plan && !this.plan.ready) { /* сервер міг обрізати шлях */ }
    });
    if (now) go(); else this.sendT = setTimeout(go, 120);
  }

  /* ================= малювання ================= */
  // розмір шрифту в клітинках, але не дрібніше за minPx пікселів на екрані
  fs(units, minPx) { return Math.max(units, minPx / this.cam.s); }

  renderStatic() {
    const S = 32;
    const c = document.createElement('canvas');
    c.width = this.grid.w * S; c.height = this.grid.h * S;
    const g = c.getContext('2d');
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let y = 0; y < this.grid.h; y++) for (let x = 0; x < this.grid.w; x++) {
      const ch = this.grid.at(x, y);
      const X = x * S, Y = y * S;
      if (ch === '#') {
        g.fillStyle = '#2a241c'; g.fillRect(X, Y, S, S);
        continue;
      }
      const v = Math.floor(rnd() * 10);
      g.fillStyle = `rgb(${196 + v},${164 + v},${112 + v})`;
      g.fillRect(X, Y, S, S);
      if (ch === 'A' || ch === 'B') { g.fillStyle = 'rgba(200,60,40,.16)'; g.fillRect(X, Y, S, S); }
      if (ch === 'T') { g.fillStyle = 'rgba(240,162,58,.13)'; g.fillRect(X, Y, S, S); }
      if (ch === 'C') { g.fillStyle = 'rgba(90,167,232,.15)'; g.fillRect(X, Y, S, S); }
      g.strokeStyle = 'rgba(0,0,0,.06)'; g.strokeRect(X + 0.5, Y + 0.5, S - 1, S - 1);
      if (ch === 'b') {
        g.fillStyle = '#8a6136'; g.fillRect(X + 3, Y + 3, S - 6, S - 6);
        g.strokeStyle = '#5e4022'; g.lineWidth = 2; g.strokeRect(X + 4, Y + 4, S - 8, S - 8);
        g.beginPath(); g.moveTo(X + 4, Y + 4); g.lineTo(X + S - 4, Y + S - 4); g.moveTo(X + S - 4, Y + 4); g.lineTo(X + 4, Y + S - 4); g.stroke();
        g.lineWidth = 1;
      }
    }
    // тіні стін
    for (let y = 0; y < this.grid.h; y++) for (let x = 0; x < this.grid.w; x++) {
      if (this.grid.at(x, y) !== '#') continue;
      const X = x * S, Y = y * S;
      g.fillStyle = '#3a3226';
      if (this.grid.at(x, y + 1) !== '#') g.fillRect(X, Y + S - 6, S, 6);
      g.fillStyle = 'rgba(0,0,0,.25)';
      if (this.grid.at(x, y + 1) !== '#') g.fillRect(X, Y + S, S, 4);
    }
    // літери точок
    g.font = `700 ${S * 3}px Oswald, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(150,40,30,.28)';
    for (const ch of ['A', 'B']) {
      const ts = this.grid.tilesOf(ch);
      const cx = ts.reduce((a, t) => a + t.x, 0) / ts.length + 0.5, cy = ts.reduce((a, t) => a + t.y, 0) / ts.length + 0.5;
      g.fillText(ch === 'A' ? 'A' : 'Б', cx * S, cy * S);
    }
    return c;
  }

  fog() {
    if (this.fogCache) return this.fogCache;
    const v = this.view;
    const set = new Uint8Array(this.grid.w * this.grid.h);
    if (!v || !this.me) return (this.fogCache = null);
    const smoke = new Set();
    for (const s of v.smokes) for (const k of s.tiles) smoke.add(k);
    const sm = (x, y) => smoke.has(x + ',' + y);
    const mates = v.players.filter((p) => p.squad === this.me.squad && p.alive && p.x !== undefined);
    for (let y = 0; y < this.grid.h; y++) for (let x = 0; x < this.grid.w; x++) {
      if (this.grid.opaque(x, y)) continue;
      for (const m of mates) if (Math.abs(m.x - x) + Math.abs(m.y - y) < 40 && this.grid.los(m.x, m.y, x, y, sm)) { set[x + y * this.grid.w] = 1; break; }
    }
    return (this.fogCache = set);
  }

  draw() {
    const ctx = this.ctx, c = this.cam, v = this.view;
    if (!this.W) return;
    if (this.camAnim) {
      const a = this.camAnim, k = Math.min(1, (performance.now() - a.start) / 600), e = 1 - Math.pow(1 - k, 3);
      c.x = a.fx + (a.tx - a.fx) * e; c.y = a.fy + (a.ty - a.fy) * e; this.clampCam();
      if (k >= 1) this.camAnim = null;
    }
    ctx.fillStyle = '#120f0b';
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.save();
    ctx.translate(this.W / 2, this.H / 2);
    ctx.scale(c.s, c.s);
    ctx.translate(-c.x, -c.y);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.staticMap, 0, 0, this.grid.w, this.grid.h);
    if (!v) { ctx.restore(); return; }
    const now = performance.now();
    const replaying = this.replaying;
    const rpos = replaying ? this.replayPositions() : null;

    // туман
    const fog = !replaying && v.phase !== 'roundOver' && v.phase !== 'over' ? this.fog() : null;
    if (fog) {
      ctx.fillStyle = 'rgba(10,8,5,.5)';
      for (let y = 0; y < this.grid.h; y++) for (let x = 0; x < this.grid.w; x++) if (!fog[x + y * this.grid.w] && !this.grid.opaque(x, y)) ctx.fillRect(x, y, 1, 1);
    }

    // підписи зон
    if (c.s > 15) {
      ctx.font = `600 ${this.fs(0.42, 10)}px Inter, sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(60,40,20,.55)';
      for (const co of DUNE.callouts) if (co.lx) ctx.fillText(co.name.toUpperCase(), co.lx, co.ly);
    }

    // дим і вогонь (під час повтору — стан до ходу, поки граната не впала)
    const smokes = replaying && this.replayTime() < TICK_MS * 0.6 ? this.replay.prevSmokes : v.smokes;
    const fires = replaying && this.replayTime() < TICK_MS * 0.6 ? this.replay.prevFires : v.fires;
    for (const f of fires || []) for (const k of f.tiles) {
      const [x, y] = k.split(',').map(Number);
      ctx.fillStyle = `rgba(240,${90 + 40 * Math.sin(now / 150 + x + y)},30,.55)`;
      ctx.fillRect(x, y, 1, 1);
    }
    for (const s of smokes || []) {
      for (const k of s.tiles) {
        const [x, y] = k.split(',').map(Number);
        ctx.fillStyle = 'rgba(200,200,200,.82)';
        ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 0.72, 0, Math.PI * 2); ctx.fill();
      }
    }

    // планування: досяжні клітинки, гранати
    if (!replaying && this.canPlan()) this.drawPlanning(ctx);

    // бомба
    const b = v.bomb;
    if (b && (b.state === 'planted' || b.state === 'dropped')) {
      const pulse = b.state === 'planted' ? 0.15 * Math.sin(now / 200) : 0;
      ctx.fillStyle = '#d33'; ctx.strokeStyle = '#300'; ctx.lineWidth = 0.06;
      ctx.beginPath(); ctx.roundRect(b.x + 0.25 - pulse / 2, b.y + 0.3 - pulse / 2, 0.5 + pulse, 0.4 + pulse, 0.08); ctx.fill(); ctx.stroke();
      if (b.state === 'planted') {
        ctx.fillStyle = '#fff'; ctx.font = '700 0.32px Oswald, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(b.timer, b.x + 0.5, b.y + 0.51);
      }
    }

    // шум
    for (const n of this.noises) {
      const ph = (now / 900) % 1;
      ctx.strokeStyle = `rgba(239,106,90,${0.8 - ph * 0.7})`; ctx.lineWidth = 0.07;
      ctx.beginPath(); ctx.arc(n.x + 0.5, n.y + 0.5, 0.3 + ph * 0.7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(239,106,90,.9)'; ctx.font = '0.42px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('👣', n.x + 0.5, n.y + 0.5);
    }

    // привиди (де бачили ворога)
    if (!replaying && this.me) for (const [id, g] of this.ghosts) {
      const p = this.byId[id];
      if (!p || p.visible || !p.alive || g.round !== v.round) continue;
      const age = v.turn - g.turn;
      if (age > 3) continue;
      ctx.globalAlpha = 0.55 - age * 0.12;
      ctx.strokeStyle = COLORS[p.side]; ctx.lineWidth = 0.07; ctx.setLineDash([0.12, 0.1]);
      ctx.beginPath(); ctx.arc(g.x + 0.5, g.y + 0.5, 0.34, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COLORS[p.side]; ctx.font = '700 0.4px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', g.x + 0.5, g.y + 0.52);
      ctx.globalAlpha = 1;
    }

    // плани команди
    if (!replaying && v.phase === 'plan') {
      for (const [id, pl] of Object.entries(this.teamPlans)) {
        const p = this.byId[id];
        if (!p || !p.alive || p.x === undefined || !pl) continue;
        this.drawPath(ctx, p, pl, COLORS[p.side], 0.45);
      }
      if (this.canPlan()) this.drawPath(ctx, this.me, this.plan, '#fff', 1);
    }

    // гравці
    for (const p of v.players) {
      let pos;
      if (rpos) {
        pos = rpos[p.id];
        if (!pos) continue;
        if (pos.dead) { this.drawBody(ctx, pos, p); continue; }
      } else {
        if (p.x === undefined || (!p.visible && p.squad !== this.me?.squad)) continue;
        if (!p.alive) { this.drawBody(ctx, p, p); continue; }
        pos = p;
      }
      this.drawPlayer(ctx, p, pos);
    }

    // ефекти
    this.effects = this.effects.filter((e) => now < e.start + e.dur);
    for (const e of this.effects) this.drawEffect(ctx, e, now);
    ctx.restore();
  }

  drawPlanning(ctx) {
    const me = this.me;
    if (this.tool !== 'move') {
      const g = R.GRENADES[this.tool];
      for (let y = me.y - 8; y <= me.y + 8; y++) for (let x = me.x - 8; x <= me.x + 8; x++) {
        if (this.grid.opaque(x, y) || !this.validThrow(x, y)) continue;
        ctx.fillStyle = 'rgba(255,230,120,.28)'; ctx.fillRect(x + 0.1, y + 0.1, 0.8, 0.8);
      }
      return;
    }
    const reach = this.reachable();
    if (reach) {
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 0.04;
      ctx.fillStyle = 'rgba(255,255,255,.12)';
      for (const i of reach) {
        const x = i % this.grid.w, y = (i / this.grid.w) | 0;
        ctx.fillRect(x + 0.1, y + 0.1, 0.8, 0.8); ctx.strokeRect(x + 0.1, y + 0.1, 0.8, 0.8);
      }
    }
  }

  drawPath(ctx, p, plan, color, alpha) {
    ctx.globalAlpha = alpha;
    if (plan.path && plan.path.length) {
      ctx.strokeStyle = color; ctx.lineWidth = 0.09; ctx.setLineDash(alpha < 1 ? [0.15, 0.12] : []);
      ctx.beginPath(); ctx.moveTo(p.x + 0.5, p.y + 0.5);
      for (const s of plan.path) ctx.lineTo(s.x + 0.5, s.y + 0.5);
      ctx.stroke(); ctx.setLineDash([]);
      plan.path.forEach((s, i) => {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(s.x + 0.5, s.y + 0.5, i === plan.path.length - 1 ? 0.18 : 0.08, 0, Math.PI * 2); ctx.fill();
      });
    }
    if (plan.grenade) {
      const g = plan.grenade, r = R.GRENADES[g.type].radius;
      ctx.strokeStyle = color; ctx.lineWidth = 0.06; ctx.setLineDash([0.1, 0.1]);
      ctx.beginPath(); ctx.moveTo(p.x + 0.5, p.y + 0.5);
      const mx = (p.x + g.x) / 2 + 0.5, my = (p.y + g.y) / 2 + 0.5 - dist(p, g) * 0.25;
      ctx.quadraticCurveTo(mx, my, g.x + 0.5, g.y + 0.5); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = g.type === 'smoke' ? 'rgba(220,220,220,.25)' : g.type === 'molly' ? 'rgba(240,120,30,.25)' : g.type === 'flash' ? 'rgba(255,255,200,.2)' : 'rgba(240,80,50,.25)';
      ctx.beginPath(); ctx.arc(g.x + 0.5, g.y + 0.5, r + 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.font = '0.6px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
      ctx.fillText(NADE_ICON[g.type], g.x + 0.5, g.y + 0.5);
    }
    const tag = plan.action === 'plant' ? '💣' : plan.action === 'defuse' ? '✂' : plan.mode === 'hold' ? '◉' : plan.mode === 'dodge' ? '↯' : '';
    if (tag) { ctx.font = '0.42px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = color; ctx.fillText(tag, p.x + 0.5, p.y - 0.25); }
    ctx.globalAlpha = 1;
  }

  drawPlayer(ctx, p, pos) {
    const isMe = this.me && p.id === this.me.id;
    const col = COLORS[p.side];
    const x = pos.x + 0.5, y = pos.y + 0.5;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.ellipse(x, y + 0.3, 0.32, 0.12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, 0.36, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = isMe ? 0.09 : 0.05; ctx.strokeStyle = isMe ? '#fff' : 'rgba(0,0,0,.6)'; ctx.stroke();
    ctx.fillStyle = '#1b1712'; ctx.font = '700 0.32px Oswald, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(p.side === 'T' ? 'T' : 'CT', x, y + 0.02);
    if (p.bomb) { ctx.fillStyle = '#d33'; ctx.fillRect(x + 0.18, y - 0.42, 0.24, 0.18); }
    if (p.hp !== undefined && p.alive) {
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x - 0.38, y + 0.42, 0.76, 0.09);
      ctx.fillStyle = p.hp > 50 ? '#7fcf6a' : p.hp > 25 ? '#e8c33d' : '#ef6a5a';
      ctx.fillRect(x - 0.38, y + 0.42, 0.76 * p.hp / 100, 0.09);
    }
    if (this.cam.s > 14) {
      const f = this.fs(0.28, 10);
      ctx.font = `600 ${f}px Inter, sans-serif`; ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = f * 0.28;
      const nm = p.name.length > 10 ? p.name.slice(0, 9) + '…' : p.name;
      ctx.strokeText(nm, x, y - 0.55); ctx.fillText(nm, x, y - 0.55);
    }
  }

  drawBody(ctx, pos, p) {
    const x = pos.x + 0.5, y = pos.y + 0.5;
    ctx.strokeStyle = COLORS[p.side]; ctx.globalAlpha = 0.6; ctx.lineWidth = 0.1;
    ctx.beginPath(); ctx.moveTo(x - 0.22, y - 0.22); ctx.lineTo(x + 0.22, y + 0.22); ctx.moveTo(x + 0.22, y - 0.22); ctx.lineTo(x - 0.22, y + 0.22); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawEffect(ctx, e, now) {
    const k = (now - e.start) / e.dur;
    if (k < 0) return;
    ctx.save();
    if (e.type === 'shot') {
      const a = e.a, b = e.b;
      if (k < 0.25) {
        ctx.strokeStyle = e.hit ? 'rgba(255,240,150,.95)' : 'rgba(255,255,255,.5)'; ctx.lineWidth = 0.05;
        const ox = e.hit ? 0 : 0.35;
        ctx.beginPath(); ctx.moveTo(a.x + 0.5, a.y + 0.5); ctx.lineTo(b.x + 0.5 + ox, b.y + 0.5 - ox); ctx.stroke();
      }
      ctx.globalAlpha = Math.min(1, 2.5 * (1 - k));
      const tx = b.x + 0.5, ty = b.y - 0.15 - k * 0.6;
      const f1 = this.fs(0.36, 13), f2 = this.fs(0.5, 17);
      ctx.font = `700 ${f1}px Oswald, sans-serif`; ctx.textAlign = 'center'; ctx.lineWidth = f1 * 0.28; ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.strokeText(e.label, tx, ty - f2 * 0.8); ctx.fillStyle = '#ffe08a'; ctx.fillText(e.label, tx, ty - f2 * 0.8);
      ctx.font = `700 ${f2}px Oswald, sans-serif`;
      ctx.strokeText(e.dmg, tx, ty + 0.05); ctx.fillStyle = e.hit ? '#ff6b5a' : '#ddd'; ctx.fillText(e.dmg, tx, ty + 0.05);
    } else if (e.type === 'nade') {
      const r = R.GRENADES[e.nade].radius + 0.5;
      if (e.from && k < 0.3) {
        const q = k / 0.3;
        const x = e.from.x + (e.x - e.from.x) * q + 0.5, y = e.from.y + (e.y - e.from.y) * q + 0.5 - Math.sin(q * Math.PI) * 1.2;
        ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(x, y, 0.12, 0, Math.PI * 2); ctx.fill();
      } else {
        const q = Math.min(1, (k - 0.3) / 0.7);
        ctx.globalAlpha = 1 - q;
        ctx.fillStyle = e.nade === 'flash' ? '#fffbe0' : e.nade === 'he' ? '#ff7a3a' : e.nade === 'molly' ? '#ff9a2a' : '#ddd';
        ctx.beginPath(); ctx.arc(e.x + 0.5, e.y + 0.5, r * (0.4 + q * 0.6), 0, Math.PI * 2); ctx.fill();
      }
    } else if (e.type === 'kill') {
      ctx.globalAlpha = 1 - k;
      ctx.font = '0.9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('💀', e.x + 0.5, e.y - 0.2 - k * 0.5);
    } else if (e.type === 'banner') {
      ctx.restore(); ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.globalAlpha = Math.min(1, 3 * (1 - k));
      ctx.font = '700 28px Oswald, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, 40, this.W, 50);
      ctx.fillStyle = '#ff6b5a'; ctx.fillText(e.text, this.W / 2, 75);
    }
    ctx.restore();
  }

  /* ================= інтерфейс ================= */
  name(id) { const p = this.byId[id]; return p ? p.name : '?'; }
  side(id) { const p = this.byId[id]; return p ? p.side : 'T'; }
  tagName(id) { return `<span class="tag${this.side(id)}">${esc(this.name(id))}</span>`; }

  renderHud() {
    const v = this.view;
    if (!v || !this.me && !v.players) return;
    const sideScore = (side) => {
      const sq = v.players.find((p) => p.side === side);
      return sq ? v.score[sq.squad] : 0;
    };
    $('scoreT').textContent = sideScore('T');
    $('scoreCT').textContent = sideScore('CT');
    const mySide = this.me ? this.me.side : '';
    let label = '', sub = `Раунд ${v.round} з ${R.ROUNDS_TOTAL} · ти за ${mySide === 'T' ? 'T' : 'CT'}`;
    if (v.phase === 'buy') label = 'Закупівля';
    else if (v.phase === 'plan') {
      label = `Хід ${v.turn}` + (v.bomb && v.bomb.state === 'planted' ? ` · 💣 ${v.bomb.timer}` : ` з ${R.ROUND_TURNS}`);
      if (v.humanCount > 1) sub = `Готові: ${v.readyCount}/${v.humanCount} · ` + sub;
    } else if (v.phase === 'roundOver') label = 'Кінець раунду';
    else if (v.phase === 'over') label = 'Матч завершено';
    $('phaseLabel').textContent = label;
    $('phaseSub').textContent = sub;
  }

  tickTimer() {
    const v = this.view;
    const t = $('timer');
    if (!v || !v.deadline || v.phase === 'over') { t.textContent = ''; return; }
    const left = Math.max(0, Math.ceil((v.deadline - (Date.now() + this.offset)) / 1000));
    if (t._v !== left) { t._v = left; t.textContent = left; t.classList.toggle('low', left <= 8 && v.phase === 'plan'); }
  }

  renderPanel() {
    const v = this.view, panel = $('panel');
    if (!v) return;
    panel.innerHTML = '';
    const me = this.me;
    if (!me) { panel.append(el('div', 'hint', 'Ви спостерігач.')); return; }
    const w = R.WEAPONS[me.primary || me.pistol];
    const line = el('div', 'me-line');
    line.innerHTML = `<div class="hpbar"><i style="width:${me.alive ? me.hp : 0}%"></i></div><b>${me.alive ? me.hp + ' HP' : 'Загинув'}</b>
      <span>${w ? esc(w.name) : ''}${me.armor === 2 ? ' · 🪖' : me.armor === 1 ? ' · 🦺' : ''}${me.kit ? ' · ✂' : ''}${me.bomb ? ' · 💣' : ''}</span>
      <span class="money" style="font-size:15px;margin-left:auto">$${me.money ?? 0}</span>`;
    panel.append(line);

    if (v.phase === 'buy') {
      const row = el('div', 'go');
      const shop = el('button', 'btn', 'Магазин');
      shop.onclick = () => { this.buyOpen = !this.buyOpen; this.renderBuy(); };
      const ready = el('button', 'btn primary', me.ready ? 'Чекаю інших…' : 'Готовий');
      ready.onclick = () => this.emit('game:buyReady', { ready: !me.ready });
      const hint = el('div', 'hint', 'Купуйте спорядження. Гроші, що лишились, перейдуть у наступний раунд.');
      row.append(hint, shop, ready);
      panel.append(row);
      return;
    }
    if (v.phase !== 'plan') { panel.append(el('div', 'hint', v.phase === 'over' ? 'Матч завершено.' : 'Раунд завершено. Наступний скоро почнеться.')); return; }
    if (!me.alive) { panel.append(el('div', 'hint', 'Ви загинули в цьому раунді. Дивіться, як грає команда.')); return; }

    const seg = el('div', 'seg');
    for (const [k, m] of Object.entries(R.MODES)) {
      const b = el('button', this.plan.mode === k && !this.plan.action ? 'on' : '', `${m.label}<small>${k === 'hold' ? 'першим' : k === 'dodge' ? '−4 по тобі' : m.steps + ' кл.'}</small>`);
      b.title = m.hint;
      b.onclick = () => this.setMode(k);
      seg.append(b);
    }
    panel.append(seg);

    const chips = el('div', 'chips');
    for (const [k, g] of Object.entries(R.GRENADES)) {
      const n = me.nades ? me.nades[k] : 0;
      if (!n) continue;
      const active = this.tool === k || (this.plan.grenade && this.plan.grenade.type === k);
      const b = el('button', 'chip' + (active ? ' on' : ''), `${NADE_ICON[k]} ${g.short}`);
      b.onclick = () => this.setTool(k);
      chips.append(b);
    }
    if (v.canPlant) { const b = el('button', 'chip act' + (this.plan.action === 'plant' ? ' on' : ''), '💣 Закласти'); b.onclick = () => this.setAction('plant'); chips.append(b); }
    if (v.canDefuse) { const b = el('button', 'chip act' + (this.plan.action === 'defuse' ? ' on' : ''), '✂ Розмінувати'); b.onclick = () => this.setAction('defuse'); chips.append(b); }
    if (chips.children.length) panel.append(chips);

    const go = el('div', 'go');
    let hint;
    if (this.tool !== 'move') hint = `Торкніться клітинки, куди кинути ${R.GRENADES[this.tool].name.toLowerCase()}. Кидок забирає 1 крок.`;
    else if (this.plan.action === 'plant') hint = 'Закладаєте бомбу весь хід. Стріляти не зможете.';
    else if (this.plan.action === 'defuse') hint = `Розміновуєте весь хід. Потрібно ходів: ${me.kit ? 1 : 2}.`;
    else if (this.plan.mode === 'hold') hint = 'Стоїте на місці й стріляєте першим, коли ворог з\'явиться.';
    else hint = this.plan.path.length ? `Маршрут: ${this.plan.path.length} з ${this.stepsLeft()} кл. ${R.MODES[this.plan.mode].hint}.` : `Торкніться карти, щоб прокласти маршрут (до ${this.stepsLeft()} кл.).`;
    go.append(el('div', 'hint', esc(hint)));
    const ready = el('button', 'btn primary', this.plan.ready ? 'Змінити' : 'Готово ✓');
    if (this.plan.ready) ready.className = 'btn';
    ready.onclick = () => this.toggleReady();
    go.append(ready);
    panel.append(go);
  }

  renderBuy() {
    const v = this.view, sheet = $('buySheet');
    if (!v || v.phase !== 'buy' || !this.me || !this.buyOpen) { sheet.hidden = true; return; }
    const me = this.me, side = me.side;
    sheet.hidden = false;
    sheet.innerHTML = '';
    const head = el('div', 'sheet-head');
    head.innerHTML = `<h3>Закупівля · ${side}</h3><span class="money">$${me.money}</span>`;
    const close = el('button', 'icon', '✕'); close.onclick = () => { this.buyOpen = false; this.renderBuy(); };
    head.append(close);
    sheet.append(head);
    const shop = el('div', 'shop');
    const section = (title, items) => {
      const s = el('div');
      s.append(el('h4', null, title));
      const grid = el('div', 'items');
      for (const it of items) {
        const b = el('button', 'item' + (it.owned ? ' owned' : ''));
        b.innerHTML = `<b>${esc(it.name)}</b><span>${esc(it.desc)}</span><span class="price">${it.owned ? '✓ є' : '$' + it.price}</span>`;
        b.disabled = it.owned || it.price > me.money || it.blocked;
        b.onclick = () => this.emit('game:buy', { item: it.id }).then((r) => { if (r && !r.ok && r.error) this.toast(r.error); });
        grid.append(b);
      }
      s.append(grid);
      shop.append(s);
    };
    const weapons = Object.entries(R.WEAPONS).filter(([, w]) => w.slot === 'primary' && R.sideCanBuy(w.side, side)).map(([id, w]) => ({
      id, name: w.name, price: w.price, owned: me.primary === id,
      desc: `d20+${w.acc} · ${w.dice[0]}d${w.dice[1]}+${w.dice[2]} · ${w.shots} постр./хід`,
    }));
    section('Зброя', weapons);
    const gear = [
      { id: 'vest', name: R.GEAR.vest.name, price: R.GEAR.vest.price, owned: me.armor >= 1, desc: 'Менше шкоди в тіло' },
      { id: 'helmet', name: R.GEAR.helmet.name, price: me.armor === 1 ? 350 : R.GEAR.helmet.price, owned: me.armor >= 2, desc: 'Захист від хедшотів' },
    ];
    if (side === 'CT') gear.push({ id: 'kit', name: R.GEAR.kit.name, price: R.GEAR.kit.price, owned: me.kit, desc: 'Розмінування за 1 хід' });
    section('Спорядження', gear);
    const total = Object.values(me.nades || {}).reduce((a, b) => a + b, 0);
    const nadeDesc = { he: 'До 45 шкоди поруч', flash: '−8 до кидків на хід', smoke: 'Ховає на 3 ходи', molly: 'Вогонь на 2 ходи' };
    section(`Гранати (${total}/${R.MAX_GRENADES})`, Object.entries(R.GRENADES).map(([id, g]) => ({
      id, name: `${NADE_ICON[id]} ${g.name}`, price: g.price, owned: me.nades && me.nades[id] > 0, blocked: total >= R.MAX_GRENADES, desc: nadeDesc[id],
    })));
    sheet.append(shop);
    const foot = el('div', 'buyfoot');
    const pistol = R.WEAPONS[me.pistol];
    foot.append(el('div', 'loadout', `Пістолет: ${esc(pistol ? pistol.name : '')} (завжди з собою)`));
    const refund = el('button', 'btn', 'Повернути покупки');
    refund.onclick = () => this.emit('game:refund');
    const ready = el('button', 'btn primary', me.ready ? 'Чекаю…' : 'Готовий');
    ready.onclick = () => { this.buyOpen = false; this.renderBuy(); this.emit('game:buyReady', { ready: true }); };
    foot.append(refund, ready);
    sheet.append(foot);
  }

  renderOverlay() {
    const v = this.view, ov = $('roundOverlay');
    if (!v || (v.phase !== 'roundOver' && v.phase !== 'over')) { ov.hidden = true; return; }
    const show = () => {
      if (this.view !== v) return;
      ov.hidden = false;
      ov.innerHTML = '';
      const box = el('div', 'result');
      const r = v.roundResult;
      if (v.phase === 'over') {
        const mr = v.matchResult;
        const mine = this.me ? this.me.squad : 0;
        const txt = mr.winSquad === null ? 'Нічия' : mr.winSquad === mine ? 'Перемога!' : 'Поразка';
        box.append(el('div', 'big ' + (mr.winSquad === mine ? 't' : 'ct'), txt));
        box.append(el('div', 'muted', `Рахунок ${mr.score[mine]} : ${mr.score[1 - mine]}`));
      } else if (r) {
        box.append(el('div', 'big ' + (r.winner === 'T' ? 't' : 'ct'), `${r.winner === 'T' ? 'Терористи' : 'Спецназ'} виграли раунд`));
        box.append(el('div', 'muted', REASON[r.reason] || ''));
        if (this.me) {
          const won = this.me.squad === r.winSquad;
          box.append(el('div', 'money', `+$${won ? r.winMoney : r.loseMoney}`));
        }
      }
      box.append(this.scoreTable());
      if (v.phase === 'over') {
        const row = el('div', 'stack');
        const again = el('button', 'btn primary big', 'Ще раз');
        again.onclick = () => this.emit('room:lobby');
        const leave = el('button', 'btn', 'Вийти');
        leave.onclick = () => this.onLobby('leave');
        row.append(again, leave);
        box.append(row);
      }
      ov.append(box);
    };
    // даємо подивитися повтор останнього ходу
    clearTimeout(this.ovT);
    const wait = this.replay ? (T_END + 1) * TICK_MS + 600 : 0;
    ov.hidden = true;
    this.ovT = setTimeout(show, wait);
  }

  scoreTable() {
    const v = this.view;
    const t = el('table', 'board-table');
    t.innerHTML = '<tr><th>Гравець</th><th>Сторона</th><th>K</th><th>D</th><th>$</th></tr>';
    const rows = [...v.players].sort((a, b) => a.squad - b.squad || b.kills - a.kills);
    for (const p of rows) {
      const tr = el('tr', this.me && p.id === this.me.id ? 'me' : '');
      tr.innerHTML = `<td>${esc(p.name)}${p.connected === false ? ' ⏸' : ''}</td><td class="tag${p.side}">${p.side}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.money !== undefined ? p.money : '—'}</td>`;
      t.append(tr);
    }
    return t;
  }

  openMenu() {
    const s = $('menuSheet');
    s.hidden = false;
    s.innerHTML = '<div class="sheet-head"><h3>Матч</h3><button class="icon" data-close>✕</button></div>';
    if (this.view) s.append(this.scoreTable());
    const legend = el('div', 'muted small');
    legend.innerHTML = 'Торкніться карти — маршрут. Перетягуйте — рух камери, двома пальцями — масштаб. 👣 — чути кроки ворога, <b>?</b> — де його бачили востаннє.';
    s.append(legend);
    const leave = el('button', 'btn danger', 'Покинути матч');
    leave.style.marginTop = '12px';
    leave.onclick = () => { if (confirm('Покинути матч? Ваше місце займе бот.')) this.onLobby('leave'); };
    s.append(leave);
  }

  /* ================= журнал ================= */
  describe(e) {
    const n = (id) => this.tagName(id);
    switch (e.type) {
      case 'shot': {
        const w = R.WEAPONS[e.weapon];
        const mods = e.mods.map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ');
        const dice = e.dice && e.dice.length ? ` (${e.dice.join('+')}${w.dice[2] ? '+' + w.dice[2] : ''}${e.head ? ', хедшот ×' + w.head : ''})` : '';
        return { cls: e.hit ? 'hit' : 'miss', html: `${n(e.from)} → ${n(e.to)} з ${esc(w.name)}: <span class="dice">🎲${e.roll}</span>${e.acc >= 0 ? '+' : ''}${e.acc} = ${e.total} проти ${e.need}${mods ? ` <span class="muted">[${esc(mods)}]</span>` : ''} — ${e.hit ? `<b>${e.head ? 'ХЕДШОТ' : 'влучання'} −${e.dmg}</b>${dice}` : 'промах'}` };
      }
      case 'kill': return { cls: 'kill', html: e.by ? `${n(e.by)} вбиває ${n(e.id)}${e.reward ? ` <span class="muted">+$${e.reward}</span>` : ''}` : `${n(e.id)} гине (${e.cause === 'bomb' ? 'вибух бомби' : 'вогонь'})` };
      case 'nade': return { cls: '', html: `${e.by ? n(e.by) + ' кидає' : 'Прилетіла'} ${NADE_ICON[e.nade]} ${esc(R.GRENADES[e.nade].name.toLowerCase())}${e.blinded && e.blinded.length ? ` — осліплені: ${e.blinded.map(n).join(', ')}` : ''}${e.hits && e.hits.length ? ` — ${e.hits.map((h) => n(h.id) + ' −' + h.dmg).join(', ')}` : ''}` };
      case 'spot': return { cls: '', html: `${n(e.a)} і ${n(e.b)} бачать одне одного` };
      case 'burn': return { cls: 'hit', html: `${n(e.id)} горить −${e.dmg}` };
      case 'planted': return { cls: 'kill', html: `💣 ${n(e.id)} заклав бомбу на точці ${e.site === 'A' ? 'А' : 'Б'}` };
      case 'defusing': return { cls: '', html: `✂ ${n(e.id)} розміновує: ${e.progress}/${e.need}` };
      case 'defused': return { cls: 'kill', html: `✂ ${n(e.id)} розмінував бомбу!` };
      case 'exploded': return { cls: 'kill', html: '💥 Бомба вибухнула' };
      case 'drop': return { cls: '', html: `${n(e.id)} впустив бомбу` };
      case 'pickup': return { cls: '', html: `${n(e.id)} підібрав бомбу` };
      case 'noise': return { cls: '', html: `👣 Чути кроки біля «${esc(this.grid.callout(e.x, e.y) || '?')}»` };
      default: return null;
    }
  }

  renderLog(v) {
    const log = $('log');
    log.innerHTML = '';
    if (!v.events || !v.events.length) { log.append(el('div', 'muted', 'Подій поки немає.')); return; }
    let lastT = -1;
    for (const e of v.events) {
      const d = this.describe(e);
      if (!d) continue;
      if (e.t !== lastT) { lastT = e.t; log.append(el('div', 't', e.t === 0 ? 'Гранати і старт' : e.t > R.MAX_STEPS ? 'Кінець ходу' : `Крок ${e.t}`)); }
      log.append(el('div', 'e ' + d.cls, d.html));
    }
  }

  feedKills(v) {
    const feed = $('feed');
    for (const e of v.events || []) {
      if (e.type !== 'kill' && e.type !== 'planted' && e.type !== 'defused') continue;
      const d = this.describe(e);
      const item = el('div', null, d.html);
      setTimeout(() => { feed.append(item); setTimeout(() => item.remove(), 6200); }, Math.min(T_END, e.t) * TICK_MS + 500);
    }
  }
}
