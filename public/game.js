// Клієнт настільного «Дефузу»: 3D-поле із зонами, хід, перестрілки на кубиках d6, радар, закупівля.
import { Grid } from '/shared/geom.js';
import { DUNE } from '/shared/map.js';
import * as R from '/shared/rules.js';
import { ZONES, ZONE, zoneAt, zonePath } from '/shared/zones.js';
import { World3D } from './world3d.js';

const COLORS = { T: '#f0a23a', CT: '#5aa7e8' };
const FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const REASON = { elim: 'усіх суперників знищено', bomb: 'бомба вибухнула', defuse: 'бомбу розміновано', time: 'час вийшов, бомбу не заклали' };
const SITE_UA = { A: 'А', B: 'Б' };
const TIPS = {
  buy: 'Закупівля. Купи зброю, броню й гранати. AK і M4 кидають 2 кубики, пістолет — 1.',
  move: 'Твій хід. Обери, куди перейти (кнопки внизу або тап по зоні на карті), або тримай позицію — тоді в бою отримаєш +1. Натисни «Готово».',
  duel: 'Перестрілка! Натисни «Стріляти» — кинеш кубики. У кого сума більша, той влучає (−1 ❤). Нічия — влучають обидва.',
};
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
const pct = (x) => Math.round(x * 100) + '%';
const hearts = (hp, vest) => '❤'.repeat(Math.max(0, hp)) + '<span class="lost">' + '❤'.repeat(Math.max(0, R.HP - hp)) + '</span>' + (vest ? ' 🦺' : '');
const zname = (z) => (ZONE[z] ? ZONE[z].name : '?');

export class Game {
  constructor({ emit, toast, onLobby }) {
    this.emit = emit; this.toast = toast; this.onLobby = onLobby;
    this.grid = new Grid(DUNE);
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
    this.plan = { action: 'hold', to: null, nade: null, ready: false };
    this.planKey = '';
    this.fightKey = '';
    this.target = null;
    this.nadePick = null;
    this.ghosts = new Map();
    this.noises = [];
    this.teamPlans = {};
    this.effects = [];
    this.buyOpen = false;
    try { this.tipsSeen = JSON.parse(localStorage.getItem('dfz-tips2') || '{}'); } catch { this.tipsSeen = {}; }
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

  /* ================= дані з сервера ================= */
  update(v) {
    const prev = this.view;
    this.offset = v.now - Date.now();
    this.view = v;
    this.byId = Object.fromEntries(v.players.map((p) => [p.id, p]));
    this.me = this.byId[v.me];

    if (v.seq !== this.seq) {
      const fresh = this.seq !== -1 && prev && v.seq === this.seq + 1;
      this.seq = v.seq;
      if (fresh) this.onEvents(v, prev);
      if (this.me) {
        const focus = this.me.alive ? this.me : v.players.find((p) => p.squad === this.me.squad && p.alive && p.zone);
        if (focus && focus.zone) this.followZone(focus.zone);
      }
    }
    if (prev && prev.round !== v.round) { this.ghosts.clear(); this.noises = []; this.effects = []; }
    for (const p of v.players) {
      if (this.me && p.squad !== this.me.squad && p.alive && p.visible && p.zone) this.ghosts.set(p.id, { zone: p.zone, turn: v.turn, round: v.round });
      if (!p.alive) this.ghosts.delete(p.id);
    }

    if (v.phase === 'move') {
      const key = v.round + ':' + v.turn;
      if (key !== this.planKey) {
        this.planKey = key;
        this.plan = v.myPlan ? { ...v.myPlan, ready: !!v.ready } : { action: 'hold', to: null, nade: null, ready: false };
        this.nadePick = null;
        this.teamPlans = v.teamPlans || {};
        this.tip('move');
      }
    }
    if (v.phase === 'duel' && v.fight) {
      const key = v.round + ':' + v.turn + ':' + v.fightRound;
      if (key !== this.fightKey) {
        this.fightKey = key;
        this.target = v.fight.target || (v.fight.enemies.slice().sort((a, b) => a.hp - b.hp)[0] || {}).id;
        this.rolling = false;
        if (v.fightRound === 1) this.effects.push({ type: 'banner', text: `ПЕРЕСТРІЛКА · ${zname(v.fight.zone)}`, start: performance.now() + 300, dur: 1600 });
        this.tip('duel');
      }
    }
    if (v.phase === 'buy' && (!prev || prev.phase !== 'buy' || prev.round !== v.round)) {
      this.buyOpen = !!this.me;
      this.teamPlans = {};
      this.snapNext = true;
      if (this.me && this.me.zone && this.W) this.world.centerOn(ZONE[this.me.zone].center.x, ZONE[this.me.zone].center.y, this.W < 600 ? 22 : 26);
      this.camInit = !!this.W;
      this.tip('buy');
    }
    if (!this.camInit && this.me && this.me.zone && this.W) { this.camInit = true; this.world.centerOn(ZONE[this.me.zone].center.x, ZONE[this.me.zone].center.y, this.W < 600 ? 22 : 26); }
    if (v.phase !== 'buy') this.buyOpen = false;
    this.floorDrawn = '';
    this.renderHud();
    this.renderPanel();
    this.renderBuy();
    this.renderOverlay();
  }

  onReady({ ready, seq }) {
    if (!this.view || seq !== this.view.seq) return;
    const v = this.view;
    for (const [id, r] of Object.entries(ready)) if (this.byId[id]) this.byId[id].ready = r;
    const waiting = v.players.filter((p) => !p.isBot && p.alive && (v.phase !== 'duel' || p.inFight));
    v.readyCount = waiting.filter((p) => ready[p.id]).length;
    this.renderHud();
  }

  onTeamPlan({ id, plan }) { this.teamPlans[id] = plan; this.floorDrawn = ''; }

  tip(kind) {
    if (this.tipsSeen[kind] || !this.me) return;
    this.tipsSeen[kind] = 1;
    try { localStorage.setItem('dfz-tips2', JSON.stringify(this.tipsSeen)); } catch { /* приватний режим */ }
    const box = $('tip');
    box.innerHTML = `<b>Як грати</b><span>${esc(TIPS[kind])}</span><button class="btn small">Зрозуміло</button>`;
    box.hidden = false;
    box.querySelector('button').onclick = () => { box.hidden = true; };
  }

  // що сталося за хід або обмін
  onEvents(v) {
    const now = performance.now();
    this.noises = [];
    for (const e of v.events || []) {
      if (e.type === 'noise') this.noises.push(e.zone);
      if (e.type === 'nade') {
        const z = ZONE[e.zone].center;
        if (e.from) this.world.addThrow(ZONE[e.from].center, z, e.nade, now);
        this.world.addBlast(e.nade, z.x, z.y, now + 380);
      }
      if (e.type === 'flashed' && this.me && e.ids.includes(this.me.id)) this.effects.push({ type: 'whiteout', start: now + 380, dur: 1300 });
      if (e.type === 'planted' || e.type === 'defused' || e.type === 'exploded') this.effects.push({ type: 'banner', text: e.type === 'planted' ? 'Бомбу закладено!' : e.type === 'defused' ? 'Бомбу розміновано!' : 'Вибух!', start: now, dur: 2000 });
    }
    if (v.eventsKind === 'duel') this.showFightCard(v);
    this.renderLog(v);
    this.feedKills(v);
  }

  /* ================= позиції фішок ================= */
  positions() {
    const v = this.view;
    const byZone = {};
    for (const p of v.players) {
      if (!p.zone || (!p.visible && !(this.me && p.squad === this.me.squad))) continue;
      (byZone[p.zone] = byZone[p.zone] || []).push(p);
    }
    const out = {};
    for (const [z, list] of Object.entries(byZone)) {
      list.sort((a, b) => (a.alive === b.alive ? 0 : a.alive ? -1 : 1) || a.squad - b.squad || (a.id < b.id ? -1 : 1));
      const slots = ZONE[z].slots;
      list.forEach((p, i) => { out[p.id] = slots[i % slots.length]; });
    }
    return out;
  }

  /* ================= ввід ================= */
  resize() {
    const r = this.board.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = r.width; this.H = r.height;
    this.labels.width = Math.round(r.width * dpr); this.labels.height = Math.round(r.height * dpr);
    this.lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.world.resize(r.width, r.height);
    if (!this.camInit && this.me && this.me.zone) { this.camInit = true; this.world.centerOn(ZONE[this.me.zone].center.x, ZONE[this.me.zone].center.y, this.W < 600 ? 22 : 26); }
  }

  followZone(z) { if (this.W && ZONE[z]) this.world.follow(ZONE[z].center.x, ZONE[z].center.y); }

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
      if (drag && !drag.moved && pts.size === 0) {
        const t = this.world.pick(e.offsetX, e.offsetY);
        const z = t && (zoneAt(t.x, t.y) || this.nearestZone(t));
        if (z) this.tapZone(z);
      }
      if (pts.size < 2) pinch = null;
      drag = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); drag = null; pinch = null; });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.world.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    $('zoomIn').onclick = () => this.world.zoom(1.25);
    $('zoomOut').onclick = () => this.world.zoom(1 / 1.25);
    $('zoomMe').onclick = () => { if (this.me && this.me.zone) { const c = ZONE[this.me.zone].center; this.world.centerOn(c.x, c.y); } };
    $('rotL').onclick = () => this.world.rotate(-1);
    $('rotR').onclick = () => this.world.rotate(1);
    $('topView').onclick = () => { const top = this.world.toggleTop(); $('topView').classList.toggle('on', top); };
    this.radar.addEventListener('click', (e) => {
      const r = this.radar.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * this.grid.w, y = (e.clientY - r.top) / r.height * this.grid.h;
      this.world.centerOn(Math.floor(x), Math.floor(y));
    });
  }

  nearestZone(t) {
    let best = null, bd = 3;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const z = zoneAt(t.x + dx, t.y + dy);
      const d = Math.hypot(dx, dy);
      if (z && d < bd) { bd = d; best = z; }
    }
    return best;
  }

  bindUi() {
    $('logBtn').onclick = () => { $('logSheet').hidden = !$('logSheet').hidden; };
    $('menuBtn').onclick = () => this.openMenu();
    for (const id of ['logSheet', 'menuSheet']) $(id).addEventListener('click', (e) => { if (e.target.closest('[data-close]')) $(id).hidden = true; });
  }

  /* ================= хід ================= */
  canPlan() { const v = this.view; return v && v.phase === 'move' && this.me && this.me.alive; }
  inFight() { const v = this.view; return v && v.phase === 'duel' && v.fight && this.me && this.me.alive; }

  tapZone(z) {
    if (this.inFight()) return;
    if (!this.canPlan()) return;
    const me = this.me;
    if (this.nadePick) {
      if (z !== me.zone && !ZONE[me.zone].adj.includes(z)) { this.toast('Гранату можна кинути лише у свою або сусідню зону'); return; }
      this.plan.nade = { type: this.nadePick, zone: z };
      this.nadePick = null;
      return this.sendPlan();
    }
    if (z === me.zone) return this.setMove(null);
    if (ZONE[me.zone].adj.includes(z)) return this.setMove(z);
    const path = zonePath(me.zone, z);
    if (path && path.length) { this.setMove(path[0]); this.toast(`За хід — лише в сусідню зону. Іду в бік «${zname(z)}» через «${zname(path[0])}»`); }
  }

  setMove(to) {
    if (!this.canPlan()) return;
    this.plan.action = to ? 'move' : 'hold';
    this.plan.to = to;
    this.plan.ready = false;
    this.sendPlan();
  }

  setAction(action) {
    if (!this.canPlan()) return;
    this.plan.action = this.plan.action === action ? 'hold' : action;
    this.plan.to = null;
    this.plan.ready = false;
    this.sendPlan();
  }

  pickNade(type) {
    if (!this.canPlan()) return;
    if (this.plan.nade && this.plan.nade.type === type) { this.plan.nade = null; this.nadePick = null; return this.sendPlan(); }
    this.nadePick = this.nadePick === type ? null : type;
    this.floorDrawn = '';
    this.renderPanel();
  }

  toggleReady() {
    if (!this.canPlan()) return;
    this.plan.ready = !this.plan.ready;
    this.sendPlan(true);
  }

  sendPlan(now) {
    this.floorDrawn = '';
    this.renderPanel();
    clearTimeout(this.sendT);
    const go = () => this.emit('game:plan', { ...this.plan });
    if (now) go(); else this.sendT = setTimeout(go, 100);
  }

  // куди радимо йти, щоб виконати мету
  goalZone() {
    const v = this.view, me = this.me;
    if (!me || !me.zone) return null;
    const b = v.bomb || {};
    if (b.state === 'planted' || b.state === 'dropped') return b.zone;
    if (me.side === 'T') {
      if (ZONE[me.zone].site) return me.zone;
      const a = zonePath(me.zone, 'asite'), bb = zonePath(me.zone, 'bsite');
      return (a ? a.length : 9) <= (bb ? bb.length : 9) ? 'asite' : 'bsite';
    }
    return null;
  }

  /* ================= перестрілка ================= */
  async fight(action) {
    if (!this.inFight() || this.rolling || this.view.fight.dice) return;
    this.rolling = action;
    this.renderPanel();
    const r1 = await this.emit('duel:act', { action, target: this.target });
    if (r1 && !r1.ok && r1.error) { this.toast(r1.error); this.rolling = false; this.renderPanel(); return; }
    const [res] = await Promise.all([this.emit('duel:roll'), new Promise((ok) => setTimeout(ok, 800))]);
    this.rolling = false;
    if (!res || !res.ok) { this.toast((res && res.error) || 'Не вдалося кинути'); this.renderPanel(); return; }
    if (this.view.fight) { this.view.fight.dice = res.dice; this.view.fight.action = action; this.view.fight.ready = true; }
    this.renderPanel();
  }

  // картка з результатом обміну
  showFightCard(v) {
    const card = $('duelCard');
    card.innerHTML = '';
    const rolls = v.events.filter((e) => e.type === 'roll');
    if (!rolls.length) return;
    const zones = [...new Set(rolls.map((e) => e.zone))];
    let at = 0;
    for (const z of zones) {
      card.append(el('div', 'dc-zone', `⚔ ${esc(zname(z))}`));
      const grid = el('div', 'dc-rolls');
      for (const r of rolls.filter((e) => e.zone === z)) {
        const p = this.byId[r.id];
        const row = el('div', 'dc-roll' + (p && this.me && p.squad === this.me.squad ? ' mine' : ''));
        const dice = r.dice.map((d) => `<span class="d6">${FACES[d]}</span>`).join('');
        const extra = r.action === 'retreat' ? `<span class="muted">відступ: ${r.safe ? 'чисто' : 'під вогнем'}</span>` : (r.bonus ? `<span class="muted">${r.bonus > 0 ? '+' : ''}${r.bonus}</span>` : '');
        row.innerHTML = `<span class="who">${this.tagName(r.id)}</span><span class="dz">${dice}</span>${extra}<b class="sum">${r.action === 'retreat' ? '🏃' : r.total}</b>`;
        row.dataset.at = at; at += 220;
        grid.append(row);
      }
      card.append(grid);
      for (const e of v.events) {
        const inZone = (id) => rolls.some((r) => r.id === id && r.zone === z);
        if (!((e.type === 'shot' && inZone(e.from)) || (e.type === 'hit' && e.retreat && inZone(e.to)))) continue;
        let txt;
        if (e.type === 'hit') txt = `${this.tagName(e.to)} відступав під вогнем — ${e.armor ? '🦺 броня врятувала' : '−1 ❤'}`;
        else if (e.vs === 'retreat') txt = `${this.tagName(e.from)} стріляє в спину ${this.tagName(e.to)} — той тікає`;
        else {
          const hit = v.events.find((h) => h.type === 'hit' && h.from === e.from && h.to === e.to);
          txt = `${this.tagName(e.from)} <b>${e.mine}</b> ${e.hit ? (e.tie ? '=' : '>') : '<'} <b>${e.theirs}</b> ${this.tagName(e.to)} — `
            + (!e.hit ? 'мимо' : e.head ? '<b class="hs">💀 ХЕДШОТ</b>' : hit && hit.armor ? '🦺 броня забрала влучання' : `влучив, −1 ❤${hit && hit.hp <= 0 ? ' 💀' : ''}`)
            + (e.hit && e.tie ? ' (нічия — влучають обидва)' : '');
        }
        const line = el('div', 'dc-line' + (e.type === 'shot' && e.hit ? ' hit' : ''), txt);
        line.dataset.at = at; at += 450;
        card.append(line);
        if (e.type === 'shot') {
          const a = this.slotOf(e.from), b = this.slotOf(e.to);
          if (a && b) this.world.addShot(a, b, e.hit, performance.now() + at - 200);
        }
      }
    }
    card.hidden = false;
    for (const node of card.querySelectorAll('[data-at]')) {
      node.classList.add('wait');
      setTimeout(() => { node.classList.remove('wait'); node.classList.add('show'); }, Number(node.dataset.at));
    }
    clearTimeout(this.cardT);
    this.cardT = setTimeout(() => { card.hidden = true; }, at + 5000);
    card.onclick = () => { card.hidden = true; };
  }

  slotOf(id) { const pos = this.world.playerPos(id); return pos ? { x: pos.x - 0.5, y: pos.z - 0.5 } : null; }

  /* ================= малювання ================= */
  drawFloor(ctx) {
    const v = this.view;
    if (!v || !this.me) return;
    const myZones = new Set(v.players.filter((p) => p.squad === this.me.squad && p.alive && p.zone).map((p) => p.zone));
    const live = v.phase === 'move' || v.phase === 'duel' || v.phase === 'buy';
    const fill = (z, color) => { ctx.fillStyle = color; for (const t of ZONE[z].tiles) ctx.fillRect(t.x, t.y, 1, 1); };
    if (live) for (const z of ZONES) if (!myZones.has(z.id)) fill(z.id, 'rgba(25,18,10,.32)');
    for (const z of Object.keys(v.smokes || {})) fill(z, 'rgba(230,230,230,.35)');
    for (const z of Object.keys(v.fires || {})) fill(z, 'rgba(255,110,40,.35)');
    for (const z of v.fightZones || []) fill(z, 'rgba(230,60,40,.28)');
    if (this.canPlan()) {
      const me = this.me;
      if (this.nadePick) for (const z of [me.zone, ...ZONE[me.zone].adj]) fill(z, 'rgba(255,215,80,.32)');
      else {
        for (const z of ZONE[me.zone].adj) fill(z, z === this.plan.to ? 'rgba(255,255,255,.42)' : 'rgba(255,255,255,.14)');
        if (this.plan.action !== 'move') fill(me.zone, 'rgba(255,255,255,.22)');
      }
      if (this.plan.nade) fill(this.plan.nade.zone, 'rgba(255,170,60,.35)');
    }
    // межі зон
    ctx.strokeStyle = 'rgba(255,248,230,.55)'; ctx.lineWidth = 0.06;
    ctx.beginPath();
    for (const z of ZONES) for (const t of z.tiles) {
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const n = zoneAt(t.x + dx, t.y + dy);
        if (n && n !== z.id) {
          if (dx) { ctx.moveTo(t.x + 1, t.y); ctx.lineTo(t.x + 1, t.y + 1); } else { ctx.moveTo(t.x, t.y + 1); ctx.lineTo(t.x + 1, t.y + 1); }
        }
      }
    }
    ctx.stroke();
    // стрілки планів
    const arrow = (from, to, color, w) => {
      const a = ZONE[from].center, b = ZONE[to].center;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(a.x + 0.5, a.y + 0.5); ctx.lineTo(b.x + 0.5, b.y + 0.5); ctx.stroke();
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.beginPath(); ctx.moveTo(b.x + 0.5, b.y + 0.5);
      ctx.lineTo(b.x + 0.5 - Math.cos(ang - 0.5) * 0.9, b.y + 0.5 - Math.sin(ang - 0.5) * 0.9);
      ctx.lineTo(b.x + 0.5 - Math.cos(ang + 0.5) * 0.9, b.y + 0.5 - Math.sin(ang + 0.5) * 0.9);
      ctx.closePath(); ctx.fill();
    };
    if (v.phase === 'move') {
      for (const [id, pl] of Object.entries(this.teamPlans)) {
        const p = this.byId[id];
        if (p && p.alive && p.zone && pl && pl.action === 'move' && pl.to) arrow(p.zone, pl.to, COLORS[p.side] + 'aa', 0.14);
      }
      if (this.canPlan() && this.plan.action === 'move' && this.plan.to) arrow(this.me.zone, this.plan.to, '#ffffff', 0.2);
    }
  }

  floorKey() {
    const v = this.view;
    if (!v) return '';
    return [v.seq, v.phase, JSON.stringify(this.plan), this.nadePick, JSON.stringify(this.teamPlans), this.me && this.me.zone].join('|');
  }

  draw() {
    if (!this.W) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    const v = this.view;
    this.frame = [];
    if (v) {
      const pos = this.positions();
      const aim = {};
      if (this.inFight()) { const t = this.byId[this.target]; if (t && pos[t.id]) aim[this.me.id] = pos[t.id]; }
      for (const p of v.players) {
        const s = pos[p.id];
        if (!s) continue;
        const item = { id: p.id, name: p.name, side: p.side, x: s.x, y: s.y, alive: p.alive, hp: p.hp, armor: p.armor || 0, bomb: p.bomb, me: this.me && p.id === this.me.id, mate: this.me && p.squad === this.me.squad, inFight: p.inFight, snap: this.snapNext };
        if (aim[p.id]) { item.faceX = aim[p.id].x; item.faceY = aim[p.id].y; }
        this.frame.push(item);
      }
      this.snapNext = false;
      this.world.syncPlayers(this.frame, dt);
      if (!this.areaCache || this.areaCache.seq !== v.seq) {
        const area = (obj, step) => Object.keys(obj || {}).map((z) => ({ x: ZONE[z].center.x, y: ZONE[z].center.y, tiles: ZONE[z].tiles.filter((t) => this.grid.walkable(t.x, t.y)).filter((_, i) => i % step === 0).map((t) => t.x + ',' + t.y) }));
        this.areaCache = { seq: v.seq, smokes: area(v.smokes, 2), fires: area(v.fires, 3) };
      }
      this.world.syncSmokes(this.areaCache.smokes);
      this.world.syncFires(this.areaCache.fires);
      const b = v.bomb;
      const bslot = b && b.zone && ZONE[b.zone] ? ZONE[b.zone].slots[ZONE[b.zone].slots.length - 1] : null;
      this.world.syncBomb(bslot && (b.state === 'planted' || b.state === 'dropped') ? { state: b.state, x: bslot.x, y: bslot.y } : null);
      const key = this.floorKey();
      if (key !== this.floorDrawn) { this.floorDrawn = key; this.world.drawOverlay((ctx) => this.drawFloor(ctx)); }
    }
    this.world.render(now);
    this.drawLabels(now);
    if (!this.radarT || now - this.radarT > 150) { this.radarT = now; this.drawRadar(); }
  }

  drawLabels(now) {
    const ctx = this.lctx, w = this.world, v = this.view;
    ctx.clearRect(0, 0, this.W, this.H);
    if (!v) return;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const adj = this.canPlan() ? new Set(ZONE[this.me.zone].adj) : new Set();
    const goal = this.canPlan() ? this.goalZone() : null;
    const goalStep = goal && this.me.zone !== goal ? (zonePath(this.me.zone, goal) || [])[0] : null;
    for (const z of ZONES) {
      const s = w.project(z.label.x, 0.1, z.label.y);
      if (s.behind || s.x < -60 || s.x > this.W + 60 || s.y < -20 || s.y > this.H + 20) continue;
      const hot = adj.has(z.id);
      const chosen = hot && this.plan.to === z.id;
      const label = (hot ? '▶ ' : '') + z.name.toUpperCase() + (z.id === goalStep ? ' 🎯' : '') + (this.noises.includes(z.id) ? ' 👣' : '');
      ctx.font = `700 ${hot ? 13 : 11}px Inter, sans-serif`;
      const tw = ctx.measureText(label).width + 14;
      ctx.fillStyle = chosen ? 'rgba(255,255,255,.95)' : hot ? 'rgba(30,24,16,.88)' : 'rgba(30,24,16,.6)';
      ctx.beginPath(); ctx.roundRect(s.x - tw / 2, s.y - 11, tw, 22, 11); ctx.fill();
      ctx.fillStyle = chosen ? '#1b1712' : hot ? '#ffe2a8' : 'rgba(255,240,215,.85)';
      ctx.fillText(label, s.x, s.y + 1);
    }
    for (const p of this.frame) {
      if (!p.alive) continue;
      const pos = w.playerPos(p.id);
      if (!pos) continue;
      const s = w.project(pos.x, 1.42, pos.z);
      if (s.behind) continue;
      const nm = p.name.length > 12 ? p.name.slice(0, 11) + '…' : p.name;
      ctx.font = `600 ${p.me ? 12 : 11}px Inter, sans-serif`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(nm, s.x, s.y - 12);
      ctx.fillStyle = p.me ? '#fff' : COLORS[p.side]; ctx.fillText(nm, s.x, s.y - 12);
      if (p.hp !== undefined) {
        ctx.font = '11px sans-serif';
        const hs = '❤'.repeat(p.hp) + '♡'.repeat(Math.max(0, R.HP - p.hp));
        ctx.strokeText(hs, s.x, s.y + 1); ctx.fillStyle = '#ff5a5a'; ctx.fillText(hs, s.x, s.y + 1);
      }
      if (p.bomb) { ctx.font = '12px sans-serif'; ctx.fillText('💣', s.x + 28, s.y - 4); }
    }
    const b = v.bomb;
    if (b && b.state === 'planted' && b.zone) {
      const c = ZONE[b.zone].slots[ZONE[b.zone].slots.length - 1];
      const s = w.project(c.x + 0.5, 0.6, c.y + 0.5);
      ctx.font = '700 14px Oswald, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(s.x - 28, s.y - 11, 56, 20);
      ctx.fillStyle = '#ff5a4a'; ctx.fillText(`💣 ${clock(b.turnsLeft * R.TURN_SECONDS)}`, s.x, s.y);
    }
    this.effects = this.effects.filter((e) => now < e.start + e.dur);
    for (const e of this.effects) {
      const k = (now - e.start) / e.dur;
      if (k < 0) continue;
      ctx.save();
      if (e.type === 'banner') {
        ctx.globalAlpha = Math.min(1, 3 * (1 - k));
        ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(0, this.H * 0.32, this.W, 54);
        ctx.font = '700 26px Oswald, sans-serif'; ctx.fillStyle = '#ff6b5a'; ctx.fillText(e.text, this.W / 2, this.H * 0.32 + 28);
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
      const z = zoneAt(x, y);
      g.fillStyle = ch === '#' ? 'rgba(20,16,10,.88)' : z && ZONE[z].site ? 'rgba(200,120,90,.95)' : 'rgba(205,180,135,.92)';
      g.fillRect(x * S, y * S, S, S);
    }
    g.strokeStyle = 'rgba(60,40,20,.6)'; g.lineWidth = 1;
    for (const z of ZONES) for (const t of z.tiles) for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const n = zoneAt(t.x + dx, t.y + dy);
      if (n && n !== z.id) { g.beginPath(); if (dx) { g.moveTo((t.x + 1) * S, t.y * S); g.lineTo((t.x + 1) * S, (t.y + 1) * S); } else { g.moveTo(t.x * S, (t.y + 1) * S); g.lineTo((t.x + 1) * S, (t.y + 1) * S); } g.stroke(); }
    }
    g.font = '700 14px Oswald, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(120,20,10,.9)';
    g.fillText('A', (ZONE.asite.center.x + 0.5) * S, (ZONE.asite.center.y + 0.5) * S);
    g.fillText('Б', (ZONE.bsite.center.x + 0.5) * S, (ZONE.bsite.center.y + 0.5) * S);
    return c;
  }

  drawRadar() {
    const c = this.radar, g = this.rctx, v = this.view;
    const S = 4;
    if (c.width !== this.grid.w * S) { c.width = this.grid.w * S; c.height = this.grid.h * S; }
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(this.radarBase, 0, 0);
    if (!v || !this.me) return;
    for (const z of this.noises) { const t = ZONE[z].center; g.strokeStyle = '#ff3b2f'; g.lineWidth = 2; g.beginPath(); g.arc((t.x + 0.5) * S, (t.y + 0.5) * S, 7, 0, Math.PI * 2); g.stroke(); }
    for (const [id, gh] of this.ghosts) {
      const p = this.byId[id];
      if (!p || p.visible || !p.alive || gh.round !== v.round || v.turn - gh.turn > 2) continue;
      const t = ZONE[gh.zone].center;
      g.fillStyle = 'rgba(255,59,47,.45)'; g.beginPath(); g.arc((t.x + 0.5) * S, (t.y + 0.5) * S, 4, 0, Math.PI * 2); g.fill();
    }
    const b = v.bomb;
    if (b && b.zone && (b.state === 'planted' || b.state === 'dropped')) { const t = ZONE[b.zone].center; g.fillStyle = '#ff2a1a'; g.fillRect(t.x * S - 2, t.y * S + 4, S + 4, S + 4); }
    for (const p of this.frame || []) {
      if (!p.alive) continue;
      const pos = this.world.playerPos(p.id) || { x: p.x + 0.5, z: p.y + 0.5 };
      g.fillStyle = p.mate ? COLORS[p.side] : '#ff3b2f';
      g.beginPath(); g.arc(pos.x * S, pos.z * S, p.me ? 4.5 : 3.5, 0, Math.PI * 2); g.fill();
      if (p.me) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
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
      if (b.state === 'planted') return `Захищай бомбу на ${SITE_UA[b.site]}: не дай CT розмінувати`;
      if (me.bomb) return ZONE[me.zone] && ZONE[me.zone].site ? 'Ти на точці — заклади бомбу!' : 'У тебе бомба 💣 — неси на точку А або Б';
      if (b.state === 'dropped') return `Бомба лежить: «${zname(b.zone)}» — підбери!`;
      return 'Прикривай бомбу, разом заходьте на А або Б';
    }
    if (b.state === 'planted') return `Бомба на ${SITE_UA[b.site]}! Зайди в зону і розмінуй`;
    return 'Не дай закласти бомбу — тримай точки, час грає на тебе';
  }

  renderHud() {
    const v = this.view;
    if (!v) return;
    const sideScore = (side) => { const sq = v.players.find((p) => p.side === side); return sq ? v.score[sq.squad] : 0; };
    $('scoreT').textContent = sideScore('T');
    $('scoreCT').textContent = sideScore('CT');
    const b = v.bomb || {};
    const time = b.state === 'planted' ? `💣 ${clock(b.turnsLeft * R.TURN_SECONDS)}` : clock(v.clock);
    let label;
    if (v.phase === 'buy') label = `${clock(R.ROUND_TIME)} · Закупівля`;
    else if (v.phase === 'move') label = `${time} · Хід ${v.turn}/${R.TURNS}`;
    else if (v.phase === 'duel') label = `${time} · ⚔ Перестрілка`;
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
    const w = R.WEAPONS[me.weapon || me.primary || me.pistol];
    const nades = me.nades ? Object.entries(me.nades).filter(([, n]) => n).map(([k]) => R.GRENADES[k].icon).join(' ') : '';
    const line = el('div', 'me-line');
    line.innerHTML = `<span class="hearts">${me.alive ? hearts(me.hp, me.vestUp) : '💀'}</span>
      <span>${w ? `${esc(w.name)} ${'🎲'.repeat(w.dice)}` : ''}${me.armor === 2 ? ' · 🪖' : ''}${me.kit ? ' · ✂' : ''}${me.bomb ? ' · 💣' : ''} ${nades}</span>
      <span class="money" style="font-size:15px;margin-left:auto">$${me.money ?? 0}</span>`;
    panel.append(line);

    if (v.phase === 'buy') {
      const row = el('div', 'go');
      const shop = el('button', 'btn', 'Магазин');
      shop.onclick = () => { this.buyOpen = !this.buyOpen; this.renderBuy(); };
      const ready = el('button', 'btn primary', me.ready ? 'Чекаю інших…' : 'Готовий');
      ready.onclick = () => this.emit('game:buyReady', { ready: !me.ready });
      row.append(el('div', 'hint', 'Купи спорядження. Гроші, що лишились, перейдуть у наступний раунд.'), shop, ready);
      panel.append(row);
      return;
    }
    if (v.phase === 'roundOver' || v.phase === 'over') { panel.append(el('div', 'hint', v.phase === 'over' ? 'Матч завершено.' : 'Раунд завершено. Наступний скоро почнеться.')); return; }
    if (!me.alive) { panel.append(el('div', 'hint', 'Ти загинув у цьому раунді. Дивись, як грає команда.')); return; }
    if (v.phase === 'duel') return this.renderFightPanel(panel);
    this.renderMovePanel(panel);
  }

  renderMovePanel(panel) {
    const v = this.view, me = this.me;
    panel.append(el('div', 'where', `Ти в зоні <b>${esc(zname(me.zone))}</b>. Куди далі?`));
    if (v.canPlant || v.canDefuse) {
      const action = v.canPlant ? 'plant' : 'defuse';
      const on = this.plan.action === action;
      const big = el('button', 'btn big ' + (on ? 'chosen ' : 'primary ') + action, on ? (action === 'plant' ? '💣 Закладаю бомбу ✓' : '✂ Розміновую ✓') : (action === 'plant' ? '💣 Закласти бомбу тут' : '✂ Розмінувати бомбу'));
      big.onclick = () => this.setAction(action);
      panel.append(big);
    }
    const goal = this.goalZone();
    const goalStep = goal && me.zone !== goal ? (zonePath(me.zone, goal) || [])[0] : null;
    const moves = el('div', 'moves');
    for (const z of ZONE[me.zone].adj) {
      const on = this.plan.action === 'move' && this.plan.to === z;
      const b = el('button', 'mv' + (on ? ' on' : ''), `→ ${esc(zname(z))}${z === goalStep ? ' 🎯' : ''}${this.noises.includes(z) ? ' 👣' : ''}`);
      b.onclick = () => this.setMove(z);
      moves.append(b);
    }
    const hold = el('button', 'mv hold' + (this.plan.action === 'hold' ? ' on' : ''), `✋ Тримати позицію <small>+${R.HOLD_BONUS} у бою</small>`);
    hold.onclick = () => this.setMove(null);
    moves.append(hold);
    panel.append(moves);

    const cards = Object.entries(R.GRENADES).filter(([k]) => me.nades && me.nades[k]);
    if (cards.length) {
      const row = el('div', 'chips');
      for (const [k, g] of cards) {
        const on = (this.plan.nade && this.plan.nade.type === k) || this.nadePick === k;
        const b = el('button', 'chip' + (on ? ' on' : ''), `${g.icon} ${g.name}${this.plan.nade && this.plan.nade.type === k ? ' → ' + esc(zname(this.plan.nade.zone)) : ''}`);
        b.title = g.desc;
        b.onclick = () => this.pickNade(k);
        row.append(b);
      }
      panel.append(row);
      if (this.nadePick) {
        const zr = el('div', 'chips');
        zr.append(el('span', 'hint', `${R.GRENADES[this.nadePick].desc}. Куди?`));
        for (const z of [me.zone, ...ZONE[me.zone].adj]) {
          const b = el('button', 'chip', esc(zname(z)));
          b.onclick = () => this.tapZone(z);
          zr.append(b);
        }
        panel.append(zr);
      }
    }
    const go = el('div', 'go');
    let hint;
    if (this.plan.action === 'plant') hint = 'Закладаєш бомбу. Якщо в зону зайде ворог — спершу перестрілка.';
    else if (this.plan.action === 'defuse') hint = 'Розміновуєш. Якщо в зоні немає ворогів — перемога.';
    else if (this.plan.action === 'move') hint = `Ідеш у «${zname(this.plan.to)}». Зустрінеш ворога — перестрілка.`;
    else hint = `Стоїш на місці: якщо ворог зайде сюди, у бою маєш +${R.HOLD_BONUS}.`;
    go.append(el('div', 'hint', esc(hint)));
    const ready = el('button', this.plan.ready ? 'btn' : 'btn primary', this.plan.ready ? 'Змінити' : 'Готово ✓');
    ready.onclick = () => this.toggleReady();
    go.append(ready);
    panel.append(go);
  }

  renderFightPanel(panel) {
    const v = this.view, me = this.me, f = v.fight;
    if (!f) {
      const zones = (v.fightZones || []).map((z) => `«${esc(zname(z))}»`).join(', ');
      panel.append(el('div', 'hint', `⚔ Перестрілка${zones ? ' в зоні ' + zones : ''}. Ти поза боєм — чекай свого ходу.`));
      return;
    }
    panel.append(el('div', 'duel-head', `<b>⚔ Перестрілка · ${esc(zname(f.zone))}</b><span>${f.round > 1 ? `обмін ${f.round}` : 'кидай кубики!'}</span>`));
    const w = R.WEAPONS[me.weapon || me.primary || me.pistol];
    const vs = el('div', 'vs');
    const modsHtml = (mods) => mods.map(([k, x]) => `<span class="mod ${x > 0 ? 'up' : 'down'}">${esc(k)} ${x > 0 ? '+' : ''}${x}</span>`).join('');
    vs.append(el('div', 'fighter me', `<div class="fn">${esc(me.name)}</div><div class="hearts">${hearts(me.hp, me.vestUp)}</div><div class="fw">${esc(w.name)} ${'🎲'.repeat(f.myDice)}</div><div class="mods">${modsHtml(f.mods)}</div>`));
    vs.append(el('div', 'vs-x', 'VS'));
    const foes = el('div', 'foes');
    for (const e of f.enemies) {
      const ew = R.WEAPONS[e.weapon];
      const chance = R.winChance(f.myDice, f.bonus, e.dice, e.bonus);
      const card = el('button', 'fighter foe' + (this.target === e.id ? ' on' : ''), `<div class="fn">${esc(this.name(e.id))}</div><div class="hearts">${hearts(e.hp, e.vestUp)}${e.armor >= 2 ? ' 🪖' : ''}</div><div class="fw">${esc(ew.name)} ${'🎲'.repeat(e.dice)}</div><div class="mods">${modsHtml(e.mods)}</div><div class="chance">шанс влучити ${pct(chance)}</div>`);
      card.disabled = !!f.dice || f.enemies.length < 2;
      card.onclick = () => { this.target = e.id; this.renderPanel(); };
      foes.append(card);
    }
    vs.append(foes);
    panel.append(vs);
    if (f.allies.length) panel.append(el('div', 'hint', `Поруч союзники: ${f.allies.map((id) => this.tagName(id)).join(', ')}`));

    const tray = el('div', 'tray');
    if (this.rolling) {
      const n = this.rolling === 'retreat' ? 1 : f.myDice;
      tray.innerHTML = `<div class="dice-row big">${Array.from({ length: n }, () => '<span class="d6 big rolling">⚄</span>').join('')}</div>`;
    } else if (f.dice) {
      const total = f.action === 'retreat' ? null : f.dice.reduce((a, d) => a + d, 0) + f.bonus;
      tray.innerHTML = `<div class="dice-row big">${f.dice.map((d) => `<span class="d6 big">${FACES[d]}</span>`).join('')}${total !== null ? `<span class="sum-big">= ${total}</span>` : `<span class="sum-big">${f.dice[0] >= R.RETREAT_SAFE ? 'тікаю чисто' : 'тікаю під вогнем'}</span>`}</div>
        <div class="hint">Чекаємо, поки кинуть інші…</div>`;
    } else {
      const shoot = el('button', 'btn primary big roll', `🎲 Стріляти${f.bonus ? ` (${f.bonus > 0 ? '+' : ''}${f.bonus})` : ''}`);
      shoot.onclick = () => this.fight('shoot');
      const back = el('button', 'btn retreat', `🏃 Відступити <small>1 кубик: ${R.RETREAT_SAFE}–6 — чисто, 1–${R.RETREAT_SAFE - 1} — −1 ❤</small>`);
      back.disabled = !f.canRetreat;
      back.onclick = () => this.fight('retreat');
      tray.append(shoot, back);
      tray.append(el('div', 'hint', 'У кого сума більша — той влучає (−1 ❤). Нічия — влучають обидва. Хедшот вбиває одразу.'));
    }
    panel.append(tray);
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
    section('Зброя', Object.entries(R.WEAPONS).filter(([, w]) => w.slot === 'primary' && R.sideCanBuy(w.side, side)).map(([id, w]) => ({ id, name: `${w.name} ${'🎲'.repeat(w.dice)}`, price: w.price, owned: me.primary === id, desc: w.desc })));
    const gear = [
      { id: 'vest', name: '🦺 ' + R.GEAR.vest.name, price: R.GEAR.vest.price, owned: me.armor >= 1, desc: R.GEAR.vest.desc },
      { id: 'helmet', name: '🪖 ' + R.GEAR.helmet.name, price: me.armor === 1 ? 350 : R.GEAR.helmet.price, owned: me.armor >= 2, desc: R.GEAR.helmet.desc },
    ];
    if (side === 'CT') gear.push({ id: 'kit', name: '✂ ' + R.GEAR.kit.name, price: R.GEAR.kit.price, owned: me.kit, desc: R.GEAR.kit.desc });
    section('Спорядження', gear);
    const total = Object.values(me.nades || {}).reduce((a, b) => a + b, 0);
    section(`Гранати (${total}/${R.MAX_GRENADES})`, Object.entries(R.GRENADES).map(([id, g]) => ({ id, name: `${g.icon} ${g.name}`, price: g.price, owned: me.nades && me.nades[id] > 0, blocked: total >= R.MAX_GRENADES, desc: g.desc })));
    sheet.append(shop);
    const foot = el('div', 'buyfoot');
    const pistol = R.WEAPONS[me.pistol];
    foot.append(el('div', 'loadout', `Пістолет ${esc(pistol ? pistol.name : '')} 🎲 — завжди з собою`));
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
    this.ovT = setTimeout(show, v.eventsKind === 'duel' ? 3500 : 1500);
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
    s.append(el('div', 'rules-mini', RULES_HTML));
    if (this.view) s.append(this.scoreTable());
    const leave = el('button', 'btn danger', 'Покинути матч');
    leave.style.marginTop = '12px';
    leave.onclick = () => { if (confirm('Покинути матч? Твоє місце займе бот.')) this.onLobby('leave'); };
    s.append(leave);
  }

  /* ================= журнал ================= */
  describe(e) {
    const n = (id) => this.tagName(id);
    switch (e.type) {
      case 'clash': return { cls: 'kill', html: `${n(e.a)} і ${n(e.b)} зіткнулися в зоні «${esc(zname(e.zone))}»` };
      case 'roll': return { cls: '', html: `${n(e.id)} ${e.action === 'retreat' ? 'відступає' : 'стріляє'}: ${e.dice.map((d) => FACES[d]).join(' ')}${e.bonus ? ` ${e.bonus > 0 ? '+' : ''}${e.bonus}` : ''} = <b>${e.total}</b>` };
      case 'shot': if (e.vs === 'retreat') return null; return { cls: e.hit ? 'hit' : 'miss', html: `${n(e.from)} ${e.mine} проти ${e.theirs} ${n(e.to)} — ${e.hit ? (e.head ? '💀 хедшот' : 'влучив') : 'мимо'}` };
      case 'armor': return { cls: '', html: `🦺 Броня ${n(e.id)} забрала влучання` };
      case 'retreat': return { cls: '', html: `🏃 ${n(e.id)} ${e.to ? `відступив у «${esc(zname(e.to))}»` : 'не зміг відступити'}` };
      case 'kill': return { cls: 'kill', html: e.by ? `${n(e.by)} вбиває ${n(e.id)}${e.reward ? ` <span class="muted">+$${e.reward}</span>` : ''}` : `${n(e.id)} гине (${e.cause === 'bomb' ? 'вибух бомби' : e.cause === 'molly' ? 'вогонь' : 'під час відступу'})` };
      case 'nade': return { cls: '', html: `${e.by ? n(e.by) + ' кидає' : 'Прилетіла'} ${R.GRENADES[e.nade].icon} ${esc(R.GRENADES[e.nade].name.toLowerCase())} у «${esc(zname(e.zone))}»` };
      case 'flashed': return e.ids.length ? { cls: '', html: `✷ Осліплені: ${e.ids.map(n).join(', ')}` } : null;
      case 'burn': return { cls: 'hit', html: `🔥 ${n(e.id)} у вогні` };
      case 'planted': return { cls: 'kill', html: `💣 ${n(e.id)} заклав бомбу на точці ${SITE_UA[e.site]}` };
      case 'planfail': return { cls: 'miss', html: `${n(e.id)}: ${esc(e.why)}` };
      case 'defused': return { cls: 'kill', html: `✂ ${n(e.id)} розмінував бомбу!` };
      case 'exploded': return { cls: 'kill', html: '💥 Бомба вибухнула' };
      case 'drop': return { cls: '', html: `${n(e.id)} впустив бомбу в зоні «${esc(zname(e.zone))}»` };
      case 'pickup': return { cls: '', html: `${n(e.id)} підібрав бомбу` };
      case 'noise': return { cls: '', html: `👣 Чути кроки: «${esc(zname(e.zone))}»` };
      default: return null;
    }
  }

  renderLog(v) {
    const log = $('log');
    log.innerHTML = '';
    const items = (v.events || []).map((e) => this.describe(e)).filter(Boolean);
    if (!items.length) { log.append(el('div', 'muted', 'Подій поки немає.')); return; }
    log.append(el('div', 't', v.eventsKind === 'duel' ? 'Останній обмін у перестрілці' : 'Останній хід'));
    for (const d of items) log.append(el('div', 'e ' + d.cls, d.html));
  }

  feedKills(v) {
    const feed = $('feed');
    const delay = v.eventsKind === 'duel' ? 1500 : 600;
    for (const e of v.events || []) {
      if (!['kill', 'planted', 'defused', 'noise', 'clash'].includes(e.type)) continue;
      const d = this.describe(e);
      if (!d) continue;
      const item = el('div', null, d.html);
      setTimeout(() => { feed.append(item); setTimeout(() => item.remove(), 6200); }, delay);
    }
  }
}

export const RULES_HTML = `<b>Правила за хвилину</b>
  <p><b>Мета.</b> T заносять бомбу на точку А або Б і закладають. CT не дають або розміновують. Раунд — ${R.TURNS} ходів (1:55), бомба вибухає через ${R.BOMB_TURNS} ходи.</p>
  <p><b>Хід.</b> Усі одночасно обирають: перейти в сусідню зону, ✋ тримати позицію (+${R.HOLD_BONUS} у бою), кинути гранату, закласти або розмінувати бомбу. Ворогів бачиш лише у своїй зоні, із сусідніх чути кроки 👣.</p>
  <p><b>Перестрілка.</b> Вороги в одній зоні — кожен кидає кубики: пістолет 🎲, AK і M4 🎲🎲. Більша сума влучає: −1 ❤. Нічия — влучають обидва. У кожного 3 ❤.</p>
  <p><b>Хедшот</b> вбиває одразу: дубль з AK (навіть у шолом), дубль з M4 або шістка з пістолета (якщо в цілі немає шолома).</p>
  <p><b>Відступ:</b> 1 кубик. ${R.RETREAT_SAFE}–6 — тікаєш чисто, 1–${R.RETREAT_SAFE - 1} — тікаєш, але −1 ❤.</p>
  <p><b>Броня</b> забирає перше влучання. <b>Гранати:</b> флешка −2 ворогам, дим — у зоні не стріляють 2 ходи, осколкова −1 ❤ усім ворогам у зоні, коктейль — зона горить 2 ходи.</p>`;
