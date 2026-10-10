// Клієнт гри: 3D-карта, хід руху, дуелі з кидком кубиків, радар, закупівля.
import { Grid, dist, cheb } from '/shared/geom.js';
import { DUNE } from '/shared/map.js';
import * as R from '/shared/rules.js';
import { World3D } from './world3d.js';

const MOVE_TICK = 420;                 // мс на крок у повторі руху
const MOVE_END = R.MOVE_FAST + 1;
const BURST_MS = 1300;                 // показ одної черги в дуелі
const COLORS = { T: '#f0a23a', CT: '#5aa7e8' };
const NADE_ICON = { he: '💥', flash: '✷', smoke: '☁', molly: '🔥' };
const REASON = { elim: 'усіх суперників знищено', bomb: 'бомба вибухнула', defuse: 'бомбу розміновано', time: 'час вийшов, бомбу не заклали' };
const SITE_UA = { A: 'А', B: 'Б' };
const ROUTES = {
  T: [['Йти на А', 'A'], ['Йти на Б', 'B'], ['Через мід', 'mid']],
  CT: [['Тримати А', 'A'], ['Тримати Б', 'B'], ['Тримати мід', 'midct']],
};
const SPOTS = { mid: { x: 17, y: 12 }, midct: { x: 17, y: 7 }, A: null, B: null };
const TIPS = {
  buy: 'Закупівля: купи зброю, броню і гранати. Гроші за вбивства і перемоги накопичуються.',
  move: 'Хід руху: натисни «Йти на А/Б» або торкнись карти. Бігом — 6 клітинок, але вороги чують кроки. Тихо — 3 клітинки.',
  duel: 'Контакт! Обери дію і сам кинь кубики. Кожна куля — окремий d20: більше або дорівнює 10 після бонусів — влучання, 20 — хедшот.',
};
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
const pct = (x) => Math.round(x * 100) + '%';

export class Game {
  constructor({ emit, toast, onLobby }) {
    this.emit = emit; this.toast = toast; this.onLobby = onLobby;
    this.grid = new Grid(DUNE);
    for (const s of ['A', 'B']) {
      const ts = this.grid.tilesOf(s);
      const cx = ts.reduce((a, t) => a + t.x, 0) / ts.length, cy = ts.reduce((a, t) => a + t.y, 0) / ts.length;
      SPOTS[s] = ts.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
    }
    this.labels = $('canvas');
    this.lctx = this.labels.getContext('2d');
    this.board = $('board');
    try {
      this.world = new World3D(this.board, this.grid, { mobile: matchMedia('(pointer: coarse)').matches });
    } catch (e) {
      this.toast('Ваш браузер не підтримує 3D (WebGL). Спробуйте Chrome або Safari останньої версії.');
      throw e;
    }
    this.view = null;
    this.seq = -1;
    this.offset = 0;
    this.camInit = false;
    this.plan = this.freshPlan();
    this.planKey = '';
    this.duelKey = '';
    this.sel = null;          // вибір у дуелі
    this.tool = 'move';
    this.ghosts = new Map();
    this.noises = [];
    this.replay = null;
    this.teamPlans = {};
    this.effects = [];
    this.buyOpen = false;
    this.fogCache = null;
    try { this.tipsSeen = JSON.parse(localStorage.getItem('dfz-tips') || '{}'); } catch { this.tipsSeen = {}; }
    this.radar = $('radar');
    this.rctx = this.radar.getContext('2d');
    this.radarBase = this.renderRadarBase();
    this.bindInput();
    this.bindUi();
    new ResizeObserver(() => this.resize()).observe(this.board);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      try { this.draw(); this.tickTimer(); } catch (e) { if (!this.loopErr) { this.loopErr = true; console.error(e); } }
    };
    requestAnimationFrame(loop);
  }

  freshPlan(quiet = false) { return { quiet, path: [], grenade: null, action: null, ready: false }; }

  /* ================= дані з сервера ================= */
  update(v) {
    const prev = this.view;
    this.offset = v.now - Date.now();
    this.view = v;
    this.byId = Object.fromEntries(v.players.map((p) => [p.id, p]));
    this.me = this.byId[v.me];
    this.fogCache = null;

    if (v.seq !== this.seq) {
      const fresh = this.seq !== -1 && prev && v.events && v.events.length && v.seq === this.seq + 1;
      this.seq = v.seq;
      this.replay = null;
      $('duelCard').hidden = true;
      if (fresh) {
        if (v.eventsKind === 'duel') this.startDuelReplay(prev, v);
        else this.startMoveReplay(prev, v);
      }
      const focus = this.me && (this.me.alive ? this.me : v.players.find((p) => p.squad === this.me.squad && p.alive && p.x !== undefined));
      if (focus && focus.x !== undefined) this.follow(focus.x, focus.y);
      this.rememberEvents(v, prev);
    }
    if (prev && prev.round !== v.round) { this.ghosts.clear(); this.noises = []; this.effects = []; }
    for (const p of v.players) {
      if (this.me && p.squad !== this.me.squad && p.alive && p.visible && p.x !== undefined) this.ghosts.set(p.id, { x: p.x, y: p.y, turn: v.turn, round: v.round });
      if (!p.alive) this.ghosts.delete(p.id);
    }

    if (v.phase === 'move') {
      const key = v.round + ':' + v.turn;
      if (key !== this.planKey) {
        this.planKey = key;
        this.plan = v.myPlan ? { ...v.myPlan, ready: !!v.ready } : this.freshPlan(this.plan.quiet);
        this.tool = 'move';
        this.teamPlans = v.teamPlans || {};
        this.tip('move');
      }
    }
    if (v.phase === 'duel') {
      const key = v.round + ':' + v.turn + ':' + v.duelRound;
      if (key !== this.duelKey) {
        this.duelKey = key;
        this.sel = null;
        this.tool = 'move';
        if (v.duel) {
          const d = v.duel;
          this.sel = { action: d.action || 'shoot', target: d.target || (d.enemies[0] && d.enemies[0].id), tile: d.tile, nade: d.nade, rolls: d.rolls, sent: !!d.action };
          if (v.duelRound === 1) this.effects.push({ type: 'banner', text: 'КОНТАКТ!', start: performance.now() + (this.replay ? this.replayLength() : 0), dur: 1500 });
          this.tip('duel');
        }
      } else if (v.duel && this.sel) {
        this.sel.rolls = v.duel.rolls;
      }
    }
    if (v.phase === 'buy' && (!prev || prev.phase !== 'buy' || prev.round !== v.round)) {
      this.buyOpen = !!this.me;
      this.teamPlans = {};
      if (!this.camInit || (prev && prev.round !== v.round)) this.centerOnMe();
      this.tip('buy');
    }
    if (!this.camInit && this.me) this.centerOnMe();
    if (v.phase !== 'buy') this.buyOpen = false;
    this.renderHud();
    this.renderPanel();
    this.renderBuy();
    this.renderOverlay();
  }

  onReady({ ready, seq }) {
    if (!this.view || seq !== this.view.seq) return;
    for (const [id, r] of Object.entries(ready)) if (this.byId[id]) this.byId[id].ready = r;
    const v = this.view;
    const waiting = v.players.filter((p) => !p.isBot && p.alive && (v.phase !== 'duel' || p.inDuel));
    v.readyCount = waiting.filter((p) => ready[p.id]).length;
    this.renderHud();
    if (v.phase === 'duel') this.renderPanel();
  }

  onTeamPlan({ id, plan }) { this.teamPlans[id] = plan; }

  tip(kind) {
    if (this.tipsSeen[kind] || !this.me) return;
    this.tipsSeen[kind] = 1;
    try { localStorage.setItem('dfz-tips', JSON.stringify(this.tipsSeen)); } catch { /* приватний режим */ }
    const box = $('tip');
    box.innerHTML = `<b>Підказка</b><span>${esc(TIPS[kind])}</span><button class="btn small">Зрозуміло</button>`;
    box.hidden = false;
    box.querySelector('button').onclick = () => { box.hidden = true; };
  }

  rememberEvents(v) {
    this.noises = [];
    for (const e of v.events || []) {
      if (e.type === 'noise') this.noises.push({ x: e.x, y: e.y, turn: v.turn });
      if (e.type === 'move' && this.me && this.byId[e.id] && this.byId[e.id].squad !== this.me.squad) this.ghosts.set(e.id, { x: e.x, y: e.y, turn: v.turn, round: v.round });
    }
    this.renderLog(v);
    this.feedKills(v);
  }

  /* ================= повтор ходу і дуелі ================= */
  // спільна основа: знімки позицій на кожен такт і час кожного такту
  buildSnaps(prev, v, tEnd) {
    const snaps = [];
    const start = {};
    for (const p of prev.players) if (p.x !== undefined && p.alive && (p.visible || p.squad === (this.me && this.me.squad))) start[p.id] = { x: p.x, y: p.y };
    snaps[0] = { ...start };
    const byT = Array.from({ length: tEnd + 1 }, () => []);
    for (const e of v.events) byT[Math.min(tEnd, e.t)].push(e);
    const reveal = (t) => {
      for (const e of byT[t]) {
        const pts = e.type === 'burst' ? [[e.from, e.fx, e.fy], [e.to, e.tx, e.ty]] : e.type === 'contact' ? [[e.a, e.ax, e.ay], [e.b, e.bx, e.by]] : [];
        for (const [id, x, y] of pts) if (x !== undefined && !snaps[t][id]) {
          snaps[t][id] = { x, y };
          if (t > 0 && !snaps[t - 1][id]) snaps[t - 1][id] = { x, y };
        }
      }
    };
    reveal(0);
    for (let t = 1; t <= tEnd; t++) {
      snaps[t] = { ...snaps[t - 1] };
      for (const e of byT[t]) if (e.type === 'move') {
        if (!snaps[t - 1][e.id]) snaps[t - 1][e.id] = { x: e.x, y: e.y };
        snaps[t][e.id] = { x: e.x, y: e.y };
      }
      reveal(t);
    }
    const dead = {};
    for (const e of v.events) if (e.type === 'kill') dead[e.id] = e.t;
    return { snaps, byT, dead };
  }

  startMoveReplay(prev, v) {
    const b = this.buildSnaps(prev, v, MOVE_END);
    const times = Array.from({ length: MOVE_END + 2 }, (_, t) => t * MOVE_TICK);
    this.replay = { ...b, start: performance.now(), times, tEnd: MOVE_END, fired: new Set(), prevSmokes: prev.smokes, prevFires: prev.fires, kind: 'move' };
  }

  // дуель: спершу гранати, потім по черзі показуємо кожну чергу з кубиками, потім відхід
  startDuelReplay(prev, v) {
    const b = this.buildSnaps(prev, v, 5);
    const bursts = v.events.filter((e) => e.type === 'burst' || e.type === 'noshot');
    const nades = v.events.filter((e) => e.type === 'nade');
    const t0 = nades.length ? 900 : 200;
    const t1 = t0 + Math.max(1, bursts.length) * BURST_MS;
    const times = [0, t0, t1, t1 + 450, t1 + 900, t1 + 1200, t1 + 1500];
    this.replay = { ...b, start: performance.now(), times, tEnd: 5, fired: new Set(), prevSmokes: prev.smokes, prevFires: prev.fires, kind: 'duel', burstStart: t0 };
    this.showDuelCard(v, t0);
  }

  replayLength() { return this.replay ? this.replay.times[this.replay.tEnd + 1] + 300 : 0; }
  replayTime() { return this.replay ? performance.now() - this.replay.start : Infinity; }
  get replaying() {
    if (this.replay && this.replayTime() > this.replayLength()) this.replay = null;
    return !!this.replay;
  }

  replayPositions() {
    const r = this.replay;
    const tm = this.replayTime();
    let tick = 0;
    while (tick < r.tEnd && tm >= r.times[tick + 1]) tick++;
    const span = Math.max(1, (r.times[tick + 1] || r.times[tick] + 400) - r.times[tick]);
    const frac = Math.min(1, (tm - r.times[tick]) / Math.min(span, 300));
    const out = {};
    const a = r.snaps[tick], b = tick >= 1 ? r.snaps[tick - 1] : r.snaps[0];
    for (const id of Object.keys(a)) {
      const from = b[id] || a[id], to = a[id];
      out[id] = { x: from.x + (to.x - from.x) * frac, y: from.y + (to.y - from.y) * frac, dead: r.dead[id] !== undefined && this.deathShown(r, id, tm) };
    }
    for (let t = 0; t <= tick; t++) {
      if (r.fired.has(t)) continue;
      r.fired.add(t);
      this.spawnEffects(r.byT[t], r);
    }
    return out;
  }

  // коли показати смерть: у дуелі — після черги, що вбила
  deathShown(r, id, tm) {
    if (r.kind === 'duel') {
      const kill = r.killAt && r.killAt[id];
      if (kill !== undefined) return tm >= kill;
    }
    const t = r.dead[id];
    return tm >= r.times[t] + 250;
  }

  spawnEffects(events, r) {
    const now = performance.now();
    let bi = 0;
    for (const e of events) {
      if (e.type === 'burst' || e.type === 'noshot') {
        if (e.type === 'burst') {
          const at = r.start + r.burstStart + bi * BURST_MS;
          e.bullets.forEach((b, k) => {
            this.world.addShot({ x: e.fx, y: e.fy }, { x: e.tx, y: e.ty }, b.hit, at + 350 + k * 180);
          });
          this.effects.push({ type: 'hits', from: e.from, a: { x: e.fx, y: e.fy }, b: { x: e.tx, y: e.ty }, total: e.total, head: e.bullets.some((x) => x.head), start: at + 350, dur: 1400 });
          if (!r.killAt) r.killAt = {};
          const tgt = this.byId[e.to];
          if (tgt && !tgt.alive && r.dead[e.to] !== undefined) r.killAt[e.to] = Math.min(r.killAt[e.to] ?? Infinity, r.burstStart + bi * BURST_MS + 900);
        }
        bi++;
      } else if (e.type === 'nade') {
        const from = e.fx !== null && e.fx !== undefined ? { x: e.fx, y: e.fy } : null;
        if (from) this.world.addThrow(from, { x: e.x, y: e.y }, e.nade, now);
        this.world.addBlast(e.nade, e.x, e.y, now + (from ? 380 : 0));
        if (e.nade === 'flash' && this.me && (e.blinded || []).includes(this.me.id)) this.effects.push({ type: 'whiteout', start: now + 380, dur: 1400 });
      } else if (e.type === 'kill') {
        const at = r.kind === 'duel' && r.killAt && r.killAt[e.id] !== undefined ? r.start + r.killAt[e.id] : now + 300;
        this.effects.push({ type: 'kill', x: e.x, y: e.y, start: at, dur: 1800 });
      } else if (e.type === 'planted' || e.type === 'exploded' || e.type === 'defused') {
        this.effects.push({ type: 'banner', text: e.type === 'planted' ? 'Бомбу закладено!' : e.type === 'defused' ? 'Бомбу розміновано!' : 'Вибух!', start: now, dur: 1800 });
      } else if (e.type === 'contact' && this.me && (this.isMate(e.a) || this.isMate(e.b))) {
        this.effects.push({ type: 'contact', x: (this.isMate(e.a) ? e.bx : e.ax), y: (this.isMate(e.a) ? e.by : e.ay), start: now, dur: 2500 });
      }
    }
  }

  isMate(id) { const p = this.byId[id]; return p && this.me && p.squad === this.me.squad; }

  // картка з кубиками під час повтору дуелі
  showDuelCard(v, t0) {
    const card = $('duelCard');
    card.innerHTML = '';
    let i = 0;
    for (const e of v.events) {
      if (e.type === 'nade' && e.roll !== undefined) {
        const row = el('div', 'dc-row');
        row.dataset.at = 0;
        row.innerHTML = `<div class="dc-who">${this.tagName(e.by)} кидає ${NADE_ICON[e.nade]} ${esc(R.GRENADES[e.nade].name.toLowerCase())}</div>
          <div class="dice-row">${this.dieHtml(e.roll, e.exact ? 'hit' : 'miss', 0)}<span class="dc-res">${e.exact ? 'точно в ціль' : 'відлетіла вбік'}${e.blinded && e.blinded.length ? ' · осліплено: ' + e.blinded.map((id) => esc(this.name(id))).join(', ') : ''}</span></div>`;
        card.append(row);
      }
    }
    for (const e of v.events) {
      if (e.type !== 'burst' && e.type !== 'noshot') continue;
      const delay = t0 + i * BURST_MS;
      const row = el('div', 'dc-row');
      row.dataset.at = delay;
      if (e.type === 'noshot') {
        row.innerHTML = `<div class="dc-who">${this.tagName(e.id)} не стріляє</div><div class="muted small">${esc(e.why)}</div>`;
      } else {
        const w = R.WEAPONS[e.weapon];
        const mods = e.mods.filter((m) => m[1]).map(([k, x]) => `${esc(k)} ${x > 0 ? '+' : ''}${x}`).join(' · ');
        const dice = e.bullets.map((b, k) => this.dieHtml(b.roll, b.head ? 'head' : b.hit ? 'hit' : 'miss', delay + 250 + k * 180, b)).join('');
        const tgt = this.byId[e.to];
        row.innerHTML = `<div class="dc-who">${this.tagName(e.from)} → ${this.tagName(e.to)} <span class="muted">${esc(w.name)}</span></div>
          <div class="dice-row">${dice}<span class="dc-res" data-at="${delay + 250 + e.bullets.length * 180}">${e.total ? `−${e.total} HP${tgt && !tgt.alive ? ' · 💀' : ''}` : 'усі мимо'}</span></div>
          <div class="dc-mods">треба ${e.need}+ · ${mods}${e.bullets.length > 1 ? ` · кожна наступна куля −${R.SPRAY}` : ''}</div>`;
      }
      card.append(row);
      i++;
    }
    for (const e of v.events) {
      if (e.type !== 'hide') continue;
      const row = el('div', 'dc-row');
      row.dataset.at = t0 + Math.max(1, i) * BURST_MS;
      row.innerHTML = `<div class="dc-who">${this.tagName(e.id)} відходить</div><div class="dice-row">${this.dieHtml(e.roll, e.good ? 'hit' : 'miss', 0)}<span class="dc-res">${e.good ? `вдало: по ньому −${R.HIDE_GOOD}` : `незграбно: по ньому лише −${R.HIDE_BAD}`}</span></div>`;
      card.append(row);
    }
    if (!card.children.length) return;
    card.hidden = false;
    // показуємо рядки і кубики по черзі
    for (const node of card.querySelectorAll('[data-at]')) {
      const at = Number(node.dataset.at) || 0;
      node.classList.add('wait');
      setTimeout(() => { node.classList.remove('wait'); node.classList.add('show'); }, at);
    }
    clearTimeout(this.cardT);
    this.cardT = setTimeout(() => { card.hidden = true; }, this.replayLength() + 1500);
    card.onclick = () => { card.hidden = true; };
  }

  dieHtml(roll, cls, delay, b) {
    const dmg = b && b.hit ? `<i>${b.head ? '💀' : ''}−${b.dmg}</i>` : '';
    return `<span class="die ${cls}${roll === 20 ? ' crit' : ''}" data-at="${delay}"><b>${roll}</b>${dmg}</span>`;
  }

  /* ================= ввід ================= */
  resize() {
    const r = this.board.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = r.width; this.H = r.height; this.dpr = dpr;
    this.labels.width = Math.round(r.width * dpr); this.labels.height = Math.round(r.height * dpr);
    this.lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.world.resize(r.width, r.height);
    if (!this.camInit && this.me) this.centerOnMe();
  }

  follow(x, y) { if (this.W) this.world.follow(x, y); }

  centerOnMe() {
    if (!this.me || this.me.x === undefined || !this.W) return;
    this.camInit = true;
    this.world.centerOn(this.me.x, this.me.y, this.W < 600 ? 19 : 22);
  }

  bindInput() {
    const pts = new Map();
    let drag = null, pinch = null;
    const cv = this.labels;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pts.size === 1) drag = { x: e.offsetX, y: e.offsetY, lx: e.offsetX, ly: e.offsetY, moved: false };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        drag = null;
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        if (pinch.d > 0) this.world.zoom(d / pinch.d);
        this.world.pan(cx - pinch.cx, cy - pinch.cy);
        pinch = { d, cx, cy };
      } else if (drag) {
        if (Math.hypot(e.offsetX - drag.x, e.offsetY - drag.y) > 8) drag.moved = true;
        if (drag.moved) { this.world.pan(e.offsetX - drag.lx, e.offsetY - drag.ly); drag.lx = e.offsetX; drag.ly = e.offsetY; }
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (drag && !drag.moved && pts.size === 0) { const t = this.world.pick(e.offsetX, e.offsetY); if (t) this.tap(t); }
      if (pts.size < 2) pinch = null;
      drag = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); drag = null; pinch = null; });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.world.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    $('zoomIn').onclick = () => this.world.zoom(1.25);
    $('zoomOut').onclick = () => this.world.zoom(1 / 1.25);
    $('zoomMe').onclick = () => this.centerOnMe();
    $('rotL').onclick = () => this.world.rotate(-1);
    $('rotR').onclick = () => this.world.rotate(1);
    $('topView').onclick = () => { const top = this.world.toggleTop(); $('topView').classList.toggle('on', top); };
    this.radar.addEventListener('click', (e) => {
      const r = this.radar.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * this.grid.w, y = (e.clientY - r.top) / r.height * this.grid.h;
      this.world.centerOn(Math.floor(x), Math.floor(y));
    });
  }

  bindUi() {
    $('logBtn').onclick = () => { $('logSheet').hidden = !$('logSheet').hidden; };
    $('menuBtn').onclick = () => this.openMenu();
    for (const id of ['logSheet', 'menuSheet']) $(id).addEventListener('click', (e) => { if (e.target.closest('[data-close]')) $(id).hidden = true; });
  }

  /* ================= хід руху ================= */
  canPlan() { const v = this.view; return v && v.phase === 'move' && this.me && this.me.alive; }
  inDuel() { const v = this.view; return v && v.phase === 'duel' && v.duel && this.me && this.me.alive; }

  stepsLeft() {
    return Math.max(0, (this.plan.quiet ? R.MOVE_QUIET : R.MOVE_FAST) - (this.plan.grenade ? R.NADE_MOVE_COST : 0));
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
    if (this.inDuel()) return this.duelTap(t);
    if (!this.canPlan()) return;
    this.plan.ready = false;
    const me = this.me;
    if (this.tool !== 'move') {
      if (!this.validThrow(t.x, t.y)) { this.toast(`Сюди не докинути: потрібна пряма видимість і до ${R.THROW_RANGE} клітинок`); return; }
      this.plan.grenade = { type: this.tool, x: t.x, y: t.y };
      this.tool = 'move';
      this.plan.path = this.plan.path.slice(0, this.stepsLeft());
    } else {
      this.plan.action = null;
      if (t.x === me.x && t.y === me.y) this.plan.path = [];
      else this.routeTo(t);
    }
    this.sendPlan();
  }

  routeTo(t) {
    const p = this.grid.path(this.me.x, this.me.y, t.x, t.y);
    if (!p) { this.toast('Туди не пройти'); return; }
    this.plan.path = p.slice(0, this.stepsLeft());
    this.plan.goal = { x: t.x, y: t.y };
  }

  quickRoute(key) {
    if (!this.canPlan()) return;
    this.plan.action = null; this.plan.ready = false; this.tool = 'move';
    const t = key === 'bomb' ? this.view.bomb : SPOTS[key];
    if (t) this.routeTo(t);
    this.sendPlan();
  }

  setQuiet(q) {
    if (!this.canPlan()) return;
    this.plan.quiet = q; this.plan.ready = false;
    if (this.plan.goal && !this.plan.action) this.routeTo(this.plan.goal);
    else this.plan.path = this.plan.path.slice(0, this.stepsLeft());
    this.sendPlan();
  }

  holdAngle() {
    if (!this.canPlan()) return;
    this.plan.path = []; this.plan.goal = null; this.plan.action = null; this.plan.ready = false;
    this.sendPlan();
  }

  setTool(nade) {
    if (!this.canPlan()) return;
    if (this.plan.grenade && this.plan.grenade.type === nade) { this.plan.grenade = null; this.tool = 'move'; this.plan.ready = false; this.sendPlan(); return; }
    this.tool = this.tool === nade ? 'move' : nade;
    this.plan.action = null;
    this.floorDrawn = '';
    this.renderPanel();
  }

  setAction(action) {
    if (!this.canPlan()) return;
    this.plan.action = this.plan.action === action ? null : action;
    if (this.plan.action) { this.plan.path = []; this.plan.grenade = null; this.tool = 'move'; this.plan.goal = null; }
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
    const { goal, ...plan } = this.plan;
    const go = () => this.emit('game:plan', plan);
    if (now) go(); else this.sendT = setTimeout(go, 120);
  }

  /* ================= дуель ================= */
  duelSetup(targetId) {
    const v = this.view, d = v.duel, me = this.me;
    const e = d.enemies.find((x) => x.id === targetId) || d.enemies[0];
    if (!e) return null;
    const setup = R.shotSetup({ weapon: me.primary || me.pistol, dist: e.d, cover: e.cover, held: d.held, ran: d.ran, flashed: d.flashed });
    return { setup, chance: R.shotChance(setup), enemy: e };
  }

  hideOptions() {
    const v = this.view, me = this.me;
    const enemies = v.duel.enemies.map((e) => this.byId[e.id]).filter((p) => p && p.x !== undefined);
    const smoke = new Set();
    for (const s of v.smokes) for (const k of s.tiles) smoke.add(k);
    const d = this.grid.distanceField(me.x, me.y);
    const out = [];
    for (let i = 0; i < d.length; i++) {
      if (d[i] < 1 || d[i] > R.HIDE_STEPS) continue;
      const x = i % this.grid.w, y = (i / this.grid.w) | 0;
      const safe = enemies.filter((e) => !this.grid.los(e.x, e.y, x, y, (a, b) => smoke.has(a + ',' + b))).length;
      out.push({ x, y, safe, all: safe === enemies.length });
    }
    return out;
  }

  pickAction(action, extra = {}) {
    if (!this.inDuel() || (this.sel && this.sel.rolls)) return;
    this.sel = { ...this.sel, action, ...extra, sent: false };
    if (action === 'hide' && !extra.tile) {
      const best = this.hideOptions().sort((a, b) => b.safe - a.safe)[0];
      this.sel.tile = best ? { x: best.x, y: best.y } : null;
    }
    if (action.startsWith('nade:')) {
      const tgt = this.byId[this.sel.target] || this.byId[this.view.duel.enemies[0]?.id];
      this.tool = 'duelnade';
      this.sel.tile = tgt && this.validThrow(tgt.x, tgt.y) ? { x: tgt.x, y: tgt.y } : null;
    } else this.tool = 'move';
    this.floorDrawn = '';
    this.sendDuel();
  }

  duelTap(t) {
    const s = this.sel;
    if (!s || s.rolls) return;
    // торкнулись ворога — ціль для пострілу
    const enemy = this.view.duel.enemies.find((e) => { const p = this.byId[e.id]; return p && p.x === t.x && p.y === t.y; });
    if (enemy) { this.pickAction('shoot', { target: enemy.id }); return; }
    if (s.action === 'hide') {
      const opt = this.hideOptions().find((o) => o.x === t.x && o.y === t.y);
      if (!opt) { this.toast(`Відскочити можна на ${R.HIDE_STEPS} клітинки`); return; }
      this.pickAction('hide', { tile: { x: t.x, y: t.y } });
    } else if (s.action.startsWith('nade:')) {
      if (!this.validThrow(t.x, t.y)) { this.toast('Сюди не докинути'); return; }
      this.pickAction(s.action, { tile: { x: t.x, y: t.y } });
    }
  }

  sendDuel() {
    const s = this.sel;
    const data = { action: s.action, target: s.target };
    if (s.tile && s.action !== 'shoot') { data.x = s.tile.x; data.y = s.tile.y; }
    this.renderPanel();
    return this.emit('duel:act', data).then((r) => {
      if (r && !r.ok && r.error) this.toast(r.error);
      else if (this.sel === s) s.sent = true;
      return r;
    });
  }

  async rollDice() {
    const s = this.sel;
    if (!s || s.rolls || this.rolling) return;
    this.rolling = true;
    if (!s.sent) { const r = await this.sendDuel(); if (!r || !r.ok) { this.rolling = false; return; } }
    const n = s.action === 'shoot' ? R.WEAPONS[this.me.primary || this.me.pistol].bullets : s.action === 'defuse' ? 0 : 1;
    this.renderTray(n, null);
    const [res] = await Promise.all([this.emit('duel:roll'), new Promise((ok) => setTimeout(ok, 750))]);
    this.rolling = false;
    if (!res || !res.ok) { this.toast((res && res.error) || 'Не вдалося кинути'); this.renderPanel(); return; }
    s.rolls = res.rolls;
    this.renderPanel();
  }

  /* ================= малювання ================= */
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
      for (const m of mates) if (this.grid.los(m.x, m.y, x, y, sm)) { set[x + y * this.grid.w] = 1; break; }
    }
    return (this.fogCache = set);
  }

  drawFloor(ctx) {
    const v = this.view;
    if (!v) return;
    const replaying = !!this.replay;
    const fog = !replaying && v.phase !== 'roundOver' && v.phase !== 'over' ? this.fog() : null;
    if (fog) {
      const smoke = new Set();
      for (const s of v.smokes || []) for (const k of s.tiles) smoke.add(k);
      ctx.fillStyle = 'rgba(20,14,8,.42)';
      for (let y = 0; y < this.grid.h; y++) for (let x = 0; x < this.grid.w; x++) {
        if (!fog[x + y * this.grid.w] && !this.grid.opaque(x, y) && !smoke.has(x + ',' + y)) ctx.fillRect(x, y, 1, 1);
      }
    }
    if (!replaying && this.canPlan()) this.drawPlanning(ctx);
    if (!replaying && this.inDuel()) this.drawDuelFloor(ctx);
    for (const n of this.noises) {
      ctx.strokeStyle = 'rgba(239,90,70,.85)'; ctx.lineWidth = 0.07;
      for (const r of [0.3, 0.55]) { ctx.beginPath(); ctx.arc(n.x + 0.5, n.y + 0.5, r, 0, Math.PI * 2); ctx.stroke(); }
      ctx.font = '0.4px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
      ctx.fillText('👣', n.x + 0.5, n.y + 0.52);
    }
    if (!replaying && this.me) for (const [id, g] of this.ghosts) {
      const p = this.byId[id];
      if (!p || p.visible || !p.alive || g.round !== v.round) continue;
      const age = v.turn - g.turn;
      if (age > 3) continue;
      ctx.globalAlpha = 0.85 - age * 0.18;
      ctx.strokeStyle = COLORS[p.side]; ctx.lineWidth = 0.08; ctx.setLineDash([0.14, 0.1]);
      ctx.beginPath(); ctx.arc(g.x + 0.5, g.y + 0.5, 0.36, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COLORS[p.side]; ctx.font = '700 0.46px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', g.x + 0.5, g.y + 0.53);
      ctx.globalAlpha = 1;
    }
    if (!replaying && v.phase === 'move') {
      for (const [id, pl] of Object.entries(this.teamPlans)) {
        const p = this.byId[id];
        if (!p || !p.alive || p.x === undefined || !pl) continue;
        this.drawPath(ctx, p, pl, COLORS[p.side], 0.6);
      }
      if (this.canPlan()) this.drawPath(ctx, this.me, this.plan, '#fff', 1);
    }
  }

  drawPlanning(ctx) {
    const me = this.me;
    if (this.tool !== 'move') {
      for (let y = me.y - R.THROW_RANGE; y <= me.y + R.THROW_RANGE; y++) for (let x = me.x - R.THROW_RANGE; x <= me.x + R.THROW_RANGE; x++) {
        if (this.grid.opaque(x, y) || !this.validThrow(x, y)) continue;
        ctx.fillStyle = 'rgba(255,220,90,.35)'; ctx.fillRect(x + 0.1, y + 0.1, 0.8, 0.8);
      }
      return;
    }
    const reach = this.reachable();
    if (reach) {
      ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 0.05;
      ctx.fillStyle = 'rgba(255,255,255,.2)';
      for (const i of reach) {
        const x = i % this.grid.w, y = (i / this.grid.w) | 0;
        if (this.grid.isBox(x, y)) continue;
        ctx.fillRect(x + 0.1, y + 0.1, 0.8, 0.8); ctx.strokeRect(x + 0.1, y + 0.1, 0.8, 0.8);
      }
    }
  }

  drawDuelFloor(ctx) {
    const s = this.sel;
    if (!s) return;
    // ціль
    const tgt = this.byId[s.target];
    if (tgt && tgt.x !== undefined && s.action === 'shoot') {
      ctx.strokeStyle = '#ff5a4a'; ctx.lineWidth = 0.09;
      ctx.beginPath(); ctx.arc(tgt.x + 0.5, tgt.y + 0.5, 0.45, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([0.15, 0.12]); ctx.lineWidth = 0.05;
      ctx.beginPath(); ctx.moveTo(this.me.x + 0.5, this.me.y + 0.5); ctx.lineTo(tgt.x + 0.5, tgt.y + 0.5); ctx.stroke(); ctx.setLineDash([]);
    }
    if (s.action === 'hide') {
      for (const o of this.hideOptions()) {
        ctx.fillStyle = o.all ? 'rgba(127,207,106,.45)' : o.safe ? 'rgba(232,195,61,.4)' : 'rgba(255,255,255,.15)';
        ctx.fillRect(o.x + 0.1, o.y + 0.1, 0.8, 0.8);
      }
      if (s.tile) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.08; ctx.strokeRect(s.tile.x + 0.08, s.tile.y + 0.08, 0.84, 0.84); }
    }
    if (s.action && s.action.startsWith('nade:')) {
      const me = this.me;
      for (let y = me.y - R.THROW_RANGE; y <= me.y + R.THROW_RANGE; y++) for (let x = me.x - R.THROW_RANGE; x <= me.x + R.THROW_RANGE; x++) {
        if (!this.grid.opaque(x, y) && this.validThrow(x, y)) { ctx.fillStyle = 'rgba(255,220,90,.22)'; ctx.fillRect(x + 0.1, y + 0.1, 0.8, 0.8); }
      }
      if (s.tile) {
        const r = R.GRENADES[s.action.slice(5)].radius;
        ctx.fillStyle = 'rgba(255,120,50,.3)'; ctx.beginPath(); ctx.arc(s.tile.x + 0.5, s.tile.y + 0.5, r + 0.5, 0, Math.PI * 2); ctx.fill();
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
    const tag = plan.action === 'plant' ? '💣' : plan.action === 'defuse' ? '✂' : (!plan.path || !plan.path.length) ? '◉' : '';
    if (tag) { ctx.font = '0.42px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = color; ctx.fillText(tag, p.x + 0.5, p.y - 0.25); }
    ctx.globalAlpha = 1;
  }

  floorKey() {
    const v = this.view;
    if (!v) return '';
    return [v.seq, v.phase, !!this.replay, this.tool, JSON.stringify(this.plan), JSON.stringify(this.sel), JSON.stringify(this.teamPlans), this.noises.length, this.ghosts.size, this.me && this.me.x, this.me && this.me.y].join('|');
  }

  draw() {
    if (!this.W) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    const v = this.view;
    this.frame = [];
    if (v) {
      const replaying = this.replaying;
      const rpos = replaying ? this.replayPositions() : null;
      const aim = {};
      for (const e of this.effects) if (e.type === 'hits' && now >= e.start - 400 && now < e.start + 700) aim[e.from] = e.b;
      if (!replaying && this.inDuel() && this.sel && this.byId[this.sel.target]) aim[this.me.id] = this.byId[this.sel.target];
      for (const p of v.players) {
        let pos, alive;
        if (rpos) {
          pos = rpos[p.id];
          if (!pos) continue;
          alive = !pos.dead;
        } else {
          if (p.x === undefined || (!p.visible && p.squad !== this.me?.squad)) continue;
          pos = p; alive = p.alive;
        }
        const item = { id: p.id, name: p.name, side: p.side, x: pos.x, y: pos.y, alive, hp: p.hp, armor: p.armor || 0, bomb: p.bomb, me: this.me && p.id === this.me.id, mate: this.me && p.squad === this.me.squad, inDuel: p.inDuel };
        if (aim[p.id]) { item.faceX = aim[p.id].x; item.faceY = aim[p.id].y; }
        this.frame.push(item);
      }
      this.world.syncPlayers(this.frame, dt);
      const early = replaying && this.replayTime() < (this.replay.times[1] || 300) * 0.8;
      this.world.syncSmokes(early ? this.replay.prevSmokes : v.smokes);
      this.world.syncFires(early ? this.replay.prevFires : v.fires);
      this.world.syncBomb(v.bomb);
      const key = this.floorKey();
      if (key !== this.floorDrawn) { this.floorDrawn = key; this.world.drawOverlay((ctx) => this.drawFloor(ctx)); }
    }
    this.world.render(now);
    this.drawLabels(now);
    if (!this.radarT || now - this.radarT > 120) { this.radarT = now; this.drawRadar(); }
  }

  drawLabels(now) {
    const ctx = this.lctx, w = this.world, v = this.view;
    ctx.clearRect(0, 0, this.W, this.H);
    if (!v) return;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    if (w.view.dist < 30) {
      ctx.font = '600 11px Inter, sans-serif';
      for (const co of DUNE.callouts) {
        if (!co.lx) continue;
        const s = w.project(co.lx, 0.05, co.ly);
        if (s.behind || s.x < -50 || s.x > this.W + 50 || s.y < -20 || s.y > this.H + 20) continue;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(240,225,190,.55)'; ctx.strokeText(co.name.toUpperCase(), s.x, s.y);
        ctx.fillStyle = 'rgba(70,45,20,.85)'; ctx.fillText(co.name.toUpperCase(), s.x, s.y);
      }
    }
    for (const p of this.frame) {
      if (!p.alive) continue;
      const pos = w.playerPos(p.id);
      if (!pos) continue;
      const s = w.project(pos.x, 1.42, pos.z);
      if (s.behind) continue;
      const nm = p.name.length > 12 ? p.name.slice(0, 11) + '…' : p.name;
      ctx.font = `600 ${p.me ? 12 : 11}px Inter, sans-serif`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.strokeText(nm, s.x, s.y - 10);
      ctx.fillStyle = p.me ? '#fff' : COLORS[p.side]; ctx.fillText(nm, s.x, s.y - 10);
      if (p.hp !== undefined) {
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(s.x - 17, s.y - 2, 34, 5);
        ctx.fillStyle = p.hp > 50 ? '#7fcf6a' : p.hp > 25 ? '#e8c33d' : '#ef6a5a';
        ctx.fillRect(s.x - 17, s.y - 2, 34 * p.hp / 100, 5);
      }
      if (p.bomb) { ctx.font = '12px sans-serif'; ctx.fillText('💣', s.x + 26, s.y - 4); }
      if (v.phase === 'duel' && p.inDuel && !this.replay) { ctx.font = '700 11px Oswald, sans-serif'; ctx.fillStyle = '#ff5a4a'; ctx.fillText('⚔', s.x - 26, s.y - 4); }
    }
    const b = v.bomb;
    if (b && b.state === 'planted') {
      const s = w.project(b.x + 0.5, 0.6, b.y + 0.5);
      ctx.font = '700 14px Oswald, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(s.x - 26, s.y - 11, 52, 20);
      ctx.fillStyle = '#ff5a4a'; ctx.fillText(`💣 ${clock(b.clock)}`, s.x, s.y);
    }
    this.effects = this.effects.filter((e) => now < e.start + e.dur);
    for (const e of this.effects) {
      const k = (now - e.start) / e.dur;
      if (k < 0) continue;
      ctx.save();
      if (e.type === 'hits') {
        const s = w.project(e.b.x + 0.5, 1.5, e.b.y + 0.5);
        const y = s.y - 26 - k * 30;
        ctx.globalAlpha = Math.min(1, 2.5 * (1 - k));
        ctx.font = '700 22px Oswald, sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.85)';
        const t = e.total ? `${e.head ? '💀 ' : ''}−${e.total}` : 'мимо';
        ctx.strokeText(t, s.x, y); ctx.fillStyle = e.total ? '#ff6b5a' : '#e6e6e6'; ctx.fillText(t, s.x, y);
      } else if (e.type === 'kill') {
        const s = w.project(e.x + 0.5, 1.2, e.y + 0.5);
        ctx.globalAlpha = 1 - k; ctx.font = '26px sans-serif';
        ctx.fillText('💀', s.x, s.y - 20 - k * 25);
      } else if (e.type === 'contact') {
        const s = w.project(e.x + 0.5, 1.6, e.y + 0.5);
        ctx.globalAlpha = Math.min(1, 3 * (1 - k));
        ctx.font = '700 15px Oswald, sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.8)';
        ctx.strokeText('❗ ВОРОГ', s.x, s.y - 30); ctx.fillStyle = '#ff5a4a'; ctx.fillText('❗ ВОРОГ', s.x, s.y - 30);
      } else if (e.type === 'banner') {
        ctx.globalAlpha = Math.min(1, 3 * (1 - k));
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, this.H * 0.35, this.W, 54);
        ctx.font = '700 30px Oswald, sans-serif'; ctx.fillStyle = '#ff6b5a'; ctx.fillText(e.text, this.W / 2, this.H * 0.35 + 28);
      } else if (e.type === 'whiteout') {
        ctx.globalAlpha = Math.max(0, 1 - k) * 0.9;
        ctx.fillStyle = '#fffef4'; ctx.fillRect(0, 0, this.W, this.H);
      }
      ctx.restore();
    }
  }

  /* ================= радар ================= */
  renderRadarBase() {
    const S = 4, c = document.createElement('canvas');
    c.width = this.grid.w * S; c.height = this.grid.h * S;
    const g = c.getContext('2d');
    for (let y = 0; y < this.grid.h; y++) for (let x = 0; x < this.grid.w; x++) {
      const ch = this.grid.at(x, y);
      g.fillStyle = ch === '#' ? 'rgba(20,16,10,.85)' : ch === 'A' || ch === 'B' ? 'rgba(190,120,80,.9)' : ch === 'b' ? 'rgba(120,85,45,.9)' : 'rgba(205,180,135,.9)';
      g.fillRect(x * S, y * S, S, S);
    }
    g.font = '700 14px Oswald, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(120,20,10,.9)';
    g.fillText('A', (SPOTS.A.x + 0.5) * S, (SPOTS.A.y + 0.5) * S);
    g.fillText('Б', (SPOTS.B.x + 0.5) * S, (SPOTS.B.y + 0.5) * S);
    return c;
  }

  drawRadar() {
    const c = this.radar, g = this.rctx, v = this.view;
    const S = 4;
    if (c.width !== this.grid.w * S) { c.width = this.grid.w * S; c.height = this.grid.h * S; }
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(this.radarBase, 0, 0);
    if (!v || !this.me) return;
    for (const s of v.smokes || []) { g.fillStyle = 'rgba(230,230,230,.85)'; g.beginPath(); g.arc((s.x + 0.5) * S, (s.y + 0.5) * S, 2.5 * S, 0, Math.PI * 2); g.fill(); }
    for (const n of this.noises) { g.strokeStyle = '#ff5a4a'; g.lineWidth = 1.5; g.beginPath(); g.arc((n.x + 0.5) * S, (n.y + 0.5) * S, 5, 0, Math.PI * 2); g.stroke(); }
    for (const [id, gh] of this.ghosts) {
      const p = this.byId[id];
      if (!p || p.visible || !p.alive || gh.round !== v.round || v.turn - gh.turn > 3) continue;
      g.strokeStyle = '#ff5a4a'; g.lineWidth = 1.5; g.beginPath(); g.arc((gh.x + 0.5) * S, (gh.y + 0.5) * S, 3.5, 0, Math.PI * 2); g.stroke();
    }
    const b = v.bomb;
    if (b && (b.state === 'planted' || b.state === 'dropped')) { g.fillStyle = '#ff2a1a'; g.fillRect(b.x * S - 1, b.y * S - 1, S + 2, S + 2); }
    for (const p of this.frame || []) {
      if (!p.alive) continue;
      const pos = this.world.playerPos(p.id) || { x: p.x + 0.5, z: p.y + 0.5 };
      g.fillStyle = p.mate ? COLORS[p.side] : '#ff3b2f';
      g.beginPath(); g.arc(pos.x * S, pos.z * S, p.me ? 4 : 3.2, 0, Math.PI * 2); g.fill();
      if (p.me) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
    }
    // рамка видимої області
    const corners = [[0, 0], [this.W, 0], [this.W, this.H], [0, this.H]].map(([x, y]) => this.world.pickGround(x, y)).filter(Boolean);
    if (corners.length === 4) {
      g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1;
      g.beginPath(); corners.forEach((p, i) => (i ? g.lineTo(p.x * S, p.z * S) : g.moveTo(p.x * S, p.z * S))); g.closePath(); g.stroke();
    }
  }

  /* ================= інтерфейс ================= */
  name(id) { const p = this.byId[id]; return p ? p.name : '?'; }
  side(id) { const p = this.byId[id]; return p ? p.side : 'T'; }
  tagName(id) { return `<span class="tag${this.side(id)}">${esc(this.name(id))}</span>`; }

  objective() {
    const v = this.view, me = this.me;
    if (!me) return '';
    if (!me.alive && (v.phase === 'move' || v.phase === 'duel')) return 'Ти загинув — дивись за командою';
    const b = v.bomb || {};
    if (me.side === 'T') {
      if (b.state === 'planted') return `Захищай бомбу на ${SITE_UA[b.site]} до вибуху`;
      if (me.bomb) return 'У тебе бомба 💣 — неси на точку А або Б';
      if (b.state === 'dropped') return 'Бомба на землі — підбери її!';
      return 'Прикривай бомбу і займи точку А або Б';
    }
    if (b.state === 'planted') return `Бомба на ${SITE_UA[b.site]}! Біжи розміновувати`;
    return 'Не дай закласти бомбу — час грає на тебе';
  }

  renderHud() {
    const v = this.view;
    if (!v) return;
    const sideScore = (side) => { const sq = v.players.find((p) => p.side === side); return sq ? v.score[sq.squad] : 0; };
    $('scoreT').textContent = sideScore('T');
    $('scoreCT').textContent = sideScore('CT');
    const b = v.bomb || {};
    let label;
    const time = b.state === 'planted' ? `💣 ${clock(b.clock)}` : clock(v.clock);
    if (v.phase === 'buy') label = `${clock(R.ROUND_TIME)} · Закупівля`;
    else if (v.phase === 'move') label = `${time} · Рух`;
    else if (v.phase === 'duel') label = `${time} · Перестрілка`;
    else if (v.phase === 'roundOver') label = 'Кінець раунду';
    else label = 'Матч завершено';
    $('phaseLabel').textContent = label;
    $('phaseLabel').classList.toggle('bomb', b.state === 'planted');
    let sub = this.objective();
    if ((v.phase === 'move' || v.phase === 'duel') && v.humanCount > 1) sub = `Готові ${v.readyCount}/${v.humanCount} · ${sub}`;
    $('phaseSub').textContent = sub;
  }

  tickTimer() {
    const v = this.view;
    const t = $('timer');
    if (!v || !v.deadline || v.phase === 'over' || v.phase === 'roundOver') { if (t._v !== '') { t._v = ''; t.textContent = ''; } return; }
    const left = Math.max(0, Math.ceil((v.deadline - (Date.now() + this.offset)) / 1000));
    if (t._v !== left) { t._v = left; t.textContent = left; t.classList.toggle('low', left <= 6); }
  }

  renderPanel() {
    const v = this.view, panel = $('panel');
    if (!v) return;
    panel.innerHTML = '';
    const me = this.me;
    if (!me) { panel.append(el('div', 'hint', 'Ви спостерігач.')); return; }
    const w = R.WEAPONS[me.primary || me.pistol];
    const line = el('div', 'me-line');
    const nades = me.nades ? Object.entries(me.nades).filter(([, n]) => n).map(([k]) => NADE_ICON[k]).join('') : '';
    line.innerHTML = `<div class="hpbar"><i style="width:${me.alive ? me.hp : 0}%"></i></div><b>${me.alive ? me.hp + ' HP' : 'Загинув'}</b>
      <span>${w ? esc(w.name) : ''}${me.armor === 2 ? ' · 🪖' : me.armor === 1 ? ' · 🦺' : ''}${me.kit ? ' · ✂' : ''}${me.bomb ? ' · 💣' : ''} ${nades}</span>
      <span class="money" style="font-size:15px;margin-left:auto">$${me.money ?? 0}</span>`;
    panel.append(line);

    if (v.phase === 'buy') {
      const row = el('div', 'go');
      const shop = el('button', 'btn', 'Магазин');
      shop.onclick = () => { this.buyOpen = !this.buyOpen; this.renderBuy(); };
      const ready = el('button', 'btn primary', me.ready ? 'Чекаю інших…' : 'Готовий');
      ready.onclick = () => this.emit('game:buyReady', { ready: !me.ready });
      row.append(el('div', 'hint', 'Купи зброю, броню і гранати. Гроші, що лишились, перейдуть у наступний раунд.'), shop, ready);
      panel.append(row);
      return;
    }
    if (v.phase === 'roundOver' || v.phase === 'over') { panel.append(el('div', 'hint', v.phase === 'over' ? 'Матч завершено.' : 'Раунд завершено. Наступний скоро почнеться.')); return; }
    if (!me.alive) { panel.append(el('div', 'hint', 'Ти загинув у цьому раунді. Дивись, як грає команда.')); return; }
    if (v.phase === 'duel') return this.renderDuelPanel(panel);
    this.renderMovePanel(panel);
  }

  renderMovePanel(panel) {
    const v = this.view, me = this.me;
    // головна дія, коли вона доступна
    if (v.canPlant || v.canDefuse) {
      const action = v.canPlant ? 'plant' : 'defuse';
      const on = this.plan.action === action;
      const big = el('button', 'btn big ' + (on ? '' : 'primary ') + action, on ? (action === 'plant' ? '💣 Закладаю… (скасувати)' : '✂ Розміновую… (скасувати)') : (action === 'plant' ? '💣 Закласти бомбу тут' : `✂ Розмінувати (${me.kit ? R.KIT_DEFUSE_TIME : R.DEFUSE_TIME} с)`));
      big.onclick = () => this.setAction(action);
      panel.append(big);
    }
    // швидкі маршрути
    const routes = el('div', 'routes');
    const list = ROUTES[me.side].slice();
    const b = v.bomb || {};
    if (b.state === 'planted' || (b.state === 'dropped' && me.side === 'T')) list.unshift([b.state === 'planted' && me.side === 'CT' ? 'До бомби ✂' : 'До бомби', 'bomb']);
    for (const [label, key] of list) {
      const btn = el('button', 'btn route', esc(label));
      btn.onclick = () => this.quickRoute(key);
      routes.append(btn);
    }
    panel.append(routes);

    const seg = el('div', 'seg');
    const fast = el('button', !this.plan.quiet ? 'on' : '', `Бігом<small>${R.MOVE_FAST} кл. · чути кроки</small>`);
    fast.onclick = () => this.setQuiet(false);
    const quiet = el('button', this.plan.quiet ? 'on' : '', `Тихо<small>${R.MOVE_QUIET} кл. · без шуму</small>`);
    quiet.onclick = () => this.setQuiet(true);
    const hold = el('button', !this.plan.path.length && !this.plan.action ? 'on' : '', `Тримати кут<small>+${R.HELD} у першому обміні</small>`);
    hold.onclick = () => this.holdAngle();
    seg.append(fast, quiet, hold);
    panel.append(seg);

    const chips = el('div', 'chips');
    for (const [k, g] of Object.entries(R.GRENADES)) {
      if (!me.nades || !me.nades[k]) continue;
      const active = this.tool === k || (this.plan.grenade && this.plan.grenade.type === k);
      const btn = el('button', 'chip' + (active ? ' on' : ''), `${NADE_ICON[k]} ${g.short}`);
      btn.onclick = () => this.setTool(k);
      chips.append(btn);
    }
    if (chips.children.length) panel.append(chips);

    const go = el('div', 'go');
    let hint;
    if (this.tool !== 'move') hint = `Торкнись жовтої клітинки, куди кинути ${R.GRENADES[this.tool].name.toLowerCase()}. Кидок забирає ${R.NADE_MOVE_COST} клітинки руху.`;
    else if (this.plan.action === 'plant') hint = 'Закладаєш бомбу цей хід. Вона вибухне через 40 с.';
    else if (this.plan.action === 'defuse') hint = 'Розміновуєш цей хід. Якщо доживеш — бомбу знешкоджено.';
    else if (!this.plan.path.length) hint = `Стоїш і тримаєш приціл: +${R.HELD} до кидків, якщо ворог вийде на тебе.`;
    else hint = `Маршрут ${this.plan.path.length} кл.${this.plan.quiet ? ', тихо' : ', бігом — вороги поруч почують'}. Побачиш ворога — зупинишся і почнеться дуель.`;
    go.append(el('div', 'hint', esc(hint)));
    const ready = el('button', this.plan.ready ? 'btn' : 'btn primary', this.plan.ready ? 'Змінити' : 'Хід ✓');
    ready.onclick = () => this.toggleReady();
    go.append(ready);
    panel.append(go);
  }

  renderDuelPanel(panel) {
    const v = this.view, me = this.me, d = v.duel, s = this.sel;
    if (!d || !s) {
      const fighters = v.players.filter((p) => p.inDuel).map((p) => this.tagName(p.id));
      panel.append(el('div', 'hint', `⚔ Іде перестрілка${fighters.length ? ': ' + fighters.join(', ') : ''}. Ти поза контактом — чекай наступного ходу.`));
      return;
    }
    const head = el('div', 'duel-head');
    const flags = [d.held ? `тримав кут +${R.HELD}` : '', d.ran ? `вибіг на бігу −${R.RAN}` : '', d.flashed ? `осліплений −${R.FLASHED}` : ''].filter(Boolean).join(' · ');
    head.innerHTML = `<b>⚔ Дуель${v.duelRound > 1 ? ` · обмін ${v.duelRound}` : ''}</b><span>${flags || 'Обери дію і кинь кубики'}</span>`;
    panel.append(head);

    // цілі
    if (d.enemies.length > 1 || s.action === 'shoot') {
      const tg = el('div', 'chips');
      for (const e of d.enemies) {
        const c = this.duelSetup(e.id);
        const btn = el('button', 'chip' + (s.target === e.id ? ' on' : ''), `🎯 ${esc(this.name(e.id))} · ${e.d} кл.${e.cover ? ' · за ящиком' : ''} · ${pct(c.chance.any)}`);
        btn.disabled = !!s.rolls;
        btn.onclick = () => this.pickAction('shoot', { target: e.id });
        tg.append(btn);
      }
      panel.append(tg);
    }

    // дії
    const acts = el('div', 'acts');
    const add = (key, icon, title, desc, on) => {
      const btn = el('button', 'act' + (on ? ' on' : ''), `<span class="ai">${icon}</span><b>${esc(title)}</b><small>${desc}</small>`);
      btn.disabled = !!s.rolls;
      btn.onclick = () => this.pickAction(key, key === 'shoot' ? { target: s.target } : {});
      acts.append(btn);
    };
    const c = this.duelSetup(s.target);
    const w = R.WEAPONS[me.primary || me.pistol];
    if (c) add('shoot', '🔫', 'Стріляти', `${w.bullets} ${w.bullets > 2 ? 'кулі' : 'кулі'} по d20 · влучити ${pct(c.chance.any)} · хедшот ${pct(c.chance.head)}`, s.action === 'shoot');
    add('hide', '🏃', 'Сховатися', `d20 ≥ ${R.HIDE_ROLL}: по тобі −${R.HIDE_GOOD}, інакше −${R.HIDE_BAD}. Відскок на ${R.HIDE_STEPS} кл.`, s.action === 'hide');
    for (const [k, g] of Object.entries(R.GRENADES)) {
      if (!me.nades || !me.nades[k]) continue;
      add('nade:' + k, NADE_ICON[k], g.name, `${g.desc}. d20 ≥ ${R.NADE_ROLL} — точно`, s.action === 'nade:' + k);
    }
    if (d.canDefuse) add('defuse', '✂', 'Розміновувати', `${R.DUEL_TIME} с з ${me.kit ? R.KIT_DEFUSE_TIME : R.DEFUSE_TIME} — без кубиків, але не стріляєш`, s.action === 'defuse');
    panel.append(acts);

    // кубики
    const tray = el('div', 'tray');
    tray.id = 'tray';
    panel.append(tray);
    if (s.rolls) this.renderTray(s.rolls.length, s.rolls);
    else {
      const n = s.action === 'shoot' ? w.bullets : s.action === 'defuse' ? 0 : 1;
      const btn = el('button', 'btn primary big roll', n ? `🎲 Кинути ${n === 1 ? 'кубик' : n + ' кубики'}` : '✂ Розміновувати');
      btn.onclick = () => this.rollDice();
      tray.append(btn);
      let hint = '';
      if (s.action === 'hide') hint = 'Зелені клітинки — там тебе не видно. Торкнись, щоб обрати куди відскочити.';
      else if (s.action && s.action.startsWith('nade:')) hint = 'Торкнись жовтої клітинки, куди кинути гранату.';
      else if (s.action === 'shoot') hint = `Кожна куля: d20 + бонуси ≥ ${R.BASE_NEED} — влучання. Друга куля −${R.SPRAY}, третя −${R.SPRAY * 2} (віддача).`;
      if (hint) tray.append(el('div', 'hint', esc(hint)));
    }
  }

  renderTray(n, rolls) {
    const tray = $('tray');
    if (!tray) return;
    tray.innerHTML = '';
    const row = el('div', 'dice-row big');
    if (!n) { tray.append(el('div', 'hint', 'Розміновуєш… Чекаємо на інших.')); return; }
    for (let i = 0; i < n; i++) {
      const r = rolls ? rolls[i] : null;
      let cls = 'rolling';
      if (r !== null) {
        if (this.sel.action === 'shoot') {
          const c = this.duelSetup(this.sel.target);
          const b = c ? R.bulletResult(r, c.setup.bonus, c.setup.need, i) : { hit: r >= 10, head: r === 20 };
          cls = b.head ? 'head' : b.hit ? 'hit' : 'miss';
        } else cls = r >= (this.sel.action === 'hide' ? R.HIDE_ROLL : R.NADE_ROLL) ? 'hit' : 'miss';
      }
      row.insertAdjacentHTML('beforeend', `<span class="die ${cls}${r === 20 ? ' crit' : ''}"><b>${r === null ? '?' : r}</b></span>`);
    }
    tray.append(row);
    if (rolls) tray.append(el('div', 'hint', 'Кубики кинуто! Остаточний результат — коли всі в дуелі кинуть (суперник може відскочити або засліпити).'));
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
      desc: `${w.bullets} кулі за постріл · ${w.dmg} шкоди · у голову ×${w.head} · влучність +${w.aim}`,
    }));
    section('Зброя', weapons);
    const gear = [
      { id: 'vest', name: R.GEAR.vest.name, price: R.GEAR.vest.price, owned: me.armor >= 1, desc: 'Менше шкоди в тіло' },
      { id: 'helmet', name: R.GEAR.helmet.name, price: me.armor === 1 ? 350 : R.GEAR.helmet.price, owned: me.armor >= 2, desc: 'Захист від хедшотів' },
    ];
    if (side === 'CT') gear.push({ id: 'kit', name: R.GEAR.kit.name, price: R.GEAR.kit.price, owned: me.kit, desc: 'Розмінування за 5 с замість 10' });
    section('Спорядження', gear);
    const total = Object.values(me.nades || {}).reduce((a, b) => a + b, 0);
    section(`Гранати (${total}/${R.MAX_GRENADES})`, Object.entries(R.GRENADES).map(([id, g]) => ({
      id, name: `${NADE_ICON[id]} ${g.name}`, price: g.price, owned: me.nades && me.nades[id] > 0, blocked: total >= R.MAX_GRENADES, desc: g.desc,
    })));
    sheet.append(shop);
    const foot = el('div', 'buyfoot');
    const pistol = R.WEAPONS[me.pistol];
    foot.append(el('div', 'loadout', `Пістолет: ${esc(pistol ? pistol.name : '')} (${pistol ? pistol.bullets : 2} кулі, ${pistol ? pistol.dmg : ''} шкоди) — завжди з собою`));
    const refund = el('button', 'btn', 'Повернути покупки');
    refund.onclick = () => this.emit('game:refund');
    const ready = el('button', 'btn primary', me.ready ? 'Чекаю…' : 'Готовий');
    ready.onclick = () => { this.buyOpen = false; this.renderBuy(); this.emit('game:buyReady', { ready: true }); };
    foot.append(refund, ready);
    sheet.append(foot);
  }

  renderOverlay() {
    const v = this.view, ov = $('roundOverlay');
    if (!v || (v.phase !== 'roundOver' && v.phase !== 'over')) { ov.hidden = true; clearTimeout(this.ovT); return; }
    const show = () => {
      if (this.view !== v) return;
      ov.hidden = false;
      ov.innerHTML = '';
      const box = el('div', 'result');
      const r = v.roundResult;
      if (v.phase === 'over') {
        const mr = v.matchResult;
        const mine = this.me ? this.me.squad : 0;
        box.append(el('div', 'big ' + (mr.winSquad === mine ? 't' : 'ct'), mr.winSquad === null ? 'Нічия' : mr.winSquad === mine ? 'Перемога!' : 'Поразка'));
        box.append(el('div', 'muted', `Рахунок ${mr.score[mine]} : ${mr.score[1 - mine]}`));
      } else if (r) {
        box.append(el('div', 'big ' + (r.winner === 'T' ? 't' : 'ct'), `${r.winner === 'T' ? 'Терористи' : 'Спецназ'} виграли раунд`));
        box.append(el('div', 'muted', REASON[r.reason] || ''));
        if (this.me) box.append(el('div', 'money', `+$${this.me.squad === r.winSquad ? r.winMoney : r.loseMoney}`));
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
    clearTimeout(this.ovT);
    ov.hidden = true;
    this.ovT = setTimeout(show, this.replay ? this.replayLength() + 800 : 0);
  }

  scoreTable() {
    const v = this.view;
    const t = el('table', 'board-table');
    t.innerHTML = '<tr><th>Гравець</th><th>Сторона</th><th>K</th><th>D</th><th>$</th></tr>';
    for (const p of [...v.players].sort((a, b) => a.squad - b.squad || b.kills - a.kills)) {
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
    const rules = el('div', 'rules-mini');
    rules.innerHTML = `<b>Як грати</b>
      <p><b>Рух.</b> Усі ходять одночасно. «Йти на А/Б» прокладе маршрут сам, або торкнись карти. Бігом — ${R.MOVE_FAST} кл., але вороги чують кроки 👣. Тихо — ${R.MOVE_QUIET} кл.</p>
      <p><b>Контакт.</b> Щойно ти і ворог бачите одне одного — обидва зупиняєтесь, і починається дуель.</p>
      <p><b>Дуель.</b> Обери: стріляти (кожна куля — твій кидок d20; ≥ ${R.BASE_NEED} після бонусів — влучання, 20 — хедшот), сховатися (кидок на ухилення), гранату (кидок на точність) або розміновувати. Обидва кидають одночасно.</p>
      <p><b>Бонуси.</b> Тримав кут +${R.HELD}, вибіг на бігу −${R.RAN}, ціль за ящиком −${R.COVER}, осліплений −${R.FLASHED}, кожна наступна куля −${R.SPRAY}.</p>
      <p><b>Час.</b> Раунд 1:55: хід руху = 10 с, обмін у дуелі = 5 с. Бомба вибухає через 40 с, розмінування 10 с (з набором 5 с).</p>`;
    s.append(rules);
    const leave = el('button', 'btn danger', 'Покинути матч');
    leave.style.marginTop = '12px';
    leave.onclick = () => { if (confirm('Покинути матч? Твоє місце займе бот.')) this.onLobby('leave'); };
    s.append(leave);
  }

  /* ================= журнал ================= */
  describe(e) {
    const n = (id) => this.tagName(id);
    switch (e.type) {
      case 'burst': {
        const w = R.WEAPONS[e.weapon];
        const bl = e.bullets.map((b) => `<span class="dice">🎲${b.roll}</span>${b.hit ? (b.head ? '💀' : '✓') : '✗'}`).join(' ');
        return { cls: e.total ? 'hit' : 'miss', html: `${n(e.from)} → ${n(e.to)} з ${esc(w.name)}: ${bl} — ${e.total ? `<b>−${e.total}</b>` : 'мимо'} <span class="muted">(треба ${e.need}+, бонус ${e.bonus >= 0 ? '+' : ''}${e.bonus})</span>` };
      }
      case 'noshot': return { cls: 'miss', html: `${n(e.id)} не стріляє: ${esc(e.why)}` };
      case 'hide': return { cls: '', html: `${n(e.id)} відходить: <span class="dice">🎲${e.roll}</span> — ${e.good ? 'вдало' : 'незграбно'}` };
      case 'contact': return { cls: 'kill', html: `❗ Контакт: ${n(e.a)} і ${n(e.b)} бачать одне одного (${esc(this.grid.callout(e.ax, e.ay) || '?')})` };
      case 'kill': return { cls: 'kill', html: e.by ? `${n(e.by)} вбиває ${n(e.id)}${e.reward ? ` <span class="muted">+$${e.reward}</span>` : ''}` : `${n(e.id)} гине (${e.cause === 'bomb' ? 'вибух бомби' : 'вогонь'})` };
      case 'nade': return { cls: '', html: `${e.by ? n(e.by) + ' кидає' : 'Прилетіла'} ${NADE_ICON[e.nade]} ${esc(R.GRENADES[e.nade].name.toLowerCase())}${e.roll !== undefined ? ` <span class="dice">🎲${e.roll}</span>` : ''}${e.blinded && e.blinded.length ? ` — осліплені: ${e.blinded.map(n).join(', ')}` : ''}${e.hits && e.hits.length ? ` — ${e.hits.map((h) => n(h.id) + ' −' + h.dmg).join(', ')}` : ''}` };
      case 'burn': return { cls: 'hit', html: `${n(e.id)} горить −${e.dmg}` };
      case 'planted': return { cls: 'kill', html: `💣 ${n(e.id)} заклав бомбу на точці ${SITE_UA[e.site]}` };
      case 'defusing': return { cls: '', html: `✂ ${n(e.id)} розміновує: ${e.progress}/${e.need} с` };
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
    const items = (v.events || []).map((e) => this.describe(e)).filter(Boolean);
    if (!items.length) { log.append(el('div', 'muted', 'Подій поки немає.')); return; }
    log.append(el('div', 't', v.eventsKind === 'duel' ? 'Останній обмін у дуелі' : 'Останній хід руху'));
    for (const d of items) log.append(el('div', 'e ' + d.cls, d.html));
  }

  feedKills(v) {
    const feed = $('feed');
    const delay = this.replay ? this.replayLength() * 0.6 : 0;
    for (const e of v.events || []) {
      if (e.type !== 'kill' && e.type !== 'planted' && e.type !== 'defused') continue;
      const item = el('div', null, this.describe(e).html);
      setTimeout(() => { feed.append(item); setTimeout(() => item.remove(), 6200); }, delay);
    }
  }
}
