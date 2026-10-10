// Клієнт «Дефузу»: 3D-поле з гексами, активації по черзі, атака і захист на кубиках d6.
import { Grid } from '/shared/geom.js';
import { DUNE } from '/shared/map.js';
import * as R from '/shared/rules.js';
import * as X from '/shared/hex.js';
import { World3D } from './world3d.js';

const COLORS = { T: '#f0a23a', CT: '#5aa7e8' };
const FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const REASON = { elim: 'усіх суперників знищено', bomb: 'бомба вибухнула', defuse: 'бомбу розміновано', time: 'час вийшов, бомбу не заклали' };
const SITE_UA = { A: 'А', B: 'Б' };
const TIPS = {
  buy: 'Закупівля: зброя, броня, гранати. AK і M4 кидають 4 кубики атаки, пістолет — 3.',
  act: 'Твоя активація: 2 дії. Торкнись підсвіченого гекса — рух на 4 гекси. Торкнись ворога — постріл. «Тримати кут» — вистрілиш першим, коли ворог вийде на тебе.',
  atk: 'Ти стріляєш! Кинь кубики атаки: кожен, що ≥ потрібного, — влучання, шістка — хедшот. Потім ціль кине захист.',
  def: 'По тобі стріляють! Кинь кубики захисту: кожен блок гасить одне влучання. Укриття дає ще один блок.',
};
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
const pct = (x) => Math.round(x * 100) + '%';
const hexOf = (k) => (k ? X.HEXES.get(k) : null);
const hpBar = (hp) => `<span class="hpbar"><i style="width:${Math.max(0, hp)}%;background:${hp > 50 ? '#7fcf6a' : hp > 25 ? '#e8c33d' : '#ef6a5a'}"></i></span><b>${hp}</b>`;

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
    this.mode = 'move';          // move | nade:<type>
    this.sel = null;             // вибраний гекс для руху
    this.target = null;          // вибраний ворог
    this.routes = {};
    this.blips = [];
    this.lastSeen = new Map();
    this.effects = [];
    this.buyOpen = false;
    try { this.tipsSeen = JSON.parse(localStorage.getItem('dfz-tips3') || '{}'); } catch { this.tipsSeen = {}; }
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
    if (prev && prev.round !== v.round) { this.lastSeen.clear(); this.blips = []; this.effects = []; this.routes = {}; this.snapNext = true; }
    if (v.seq !== this.seq) { this.seq = v.seq; this.onEvents(v.events || []); }
    for (const p of v.players) {
      if (this.me && p.squad !== this.me.squad && p.alive && p.visible && p.hex) this.lastSeen.set(p.id, { hex: p.hex, turn: v.turn });
      if (!p.alive) this.lastSeen.delete(p.id);
    }
    if (!this.myTurn()) { this.sel = null; this.mode = 'move'; }
    if (this.target && (!this.byId[this.target] || !this.byId[this.target].visible || !this.byId[this.target].alive)) this.target = null;
    if (v.phase === 'buy' && (!prev || prev.phase !== 'buy' || prev.round !== v.round)) {
      this.buyOpen = !!this.me;
      this.snapNext = true;
      this.centerOnMe(true);
      this.tip('buy');
    }
    if (!this.camInit && this.me && this.W) this.centerOnMe(true);
    if (v.phase !== 'buy') this.buyOpen = false;
    if (this.myTurn()) this.tip('act');
    if (v.pending && this.me && v.pending.stage === 'atk' && v.pending.from === this.me.id) this.tip('atk');
    if (v.pending && this.me && v.pending.stage === 'def' && v.pending.to === this.me.id) this.tip('def');
    this.floorDrawn = '';
    this.renderHud();
    this.renderPanel();
    this.renderBuy();
    this.renderOverlay();
  }

  onReady() { /* у покроковому режимі не потрібно */ }
  onTeamPlan() { /* не потрібно */ }

  tip(kind) {
    if (this.tipsSeen[kind] || !this.me) return;
    this.tipsSeen[kind] = 1;
    try { localStorage.setItem('dfz-tips3', JSON.stringify(this.tipsSeen)); } catch { /* приватний режим */ }
    const box = $('tip');
    box.innerHTML = `<b>Як грати</b><span>${esc(TIPS[kind])}</span><button class="btn small">Зрозуміло</button>`;
    box.hidden = false;
    box.querySelector('button').onclick = () => { box.hidden = true; };
  }

  onEvents(events) {
    const now = performance.now();
    for (const e of events) {
      if (e.type === 'move') {
        this.routes[e.id] = { key: e.path[e.path.length - 1] + ':' + this.seq, pts: e.path.map((k) => { const h = hexOf(k); return { x: h.x, y: h.y }; }) };
        if (this.me && e.squad === this.me.squad) this.followHex(e.path[e.path.length - 1]);
      }
      if (e.type === 'activate') {
        const p = this.byId[e.id];
        if (p && p.hex && (p.visible || (this.me && p.squad === this.me.squad))) this.followHex(p.hex);
      }
      if (e.type === 'noise') this.blips.push({ hex: e.hex, turn: this.view.turn, t: now });
      if (e.type === 'nade') {
        const h = hexOf(e.hex);
        if (e.from) { const f = hexOf(e.from); this.world.addThrow({ x: f.x - 0.5, y: f.y - 0.5 }, { x: h.x - 0.5, y: h.y - 0.5 }, e.nade, now); }
        this.world.addBlast(e.nade, h.x - 0.5, h.y - 0.5, now + 380);
        if (e.nade === 'flash' && this.me && (e.blinded || []).includes(this.me.id)) this.effects.push({ type: 'whiteout', start: now + 380, dur: 1300 });
      }
      if (e.type === 'snap') this.effects.push({ type: 'banner', text: '👁 Постріл з кута!', start: now, dur: 1500 });
      if (e.type === 'result') this.showResult(e);
      if (e.type === 'planted' || e.type === 'defused' || e.type === 'exploded') this.effects.push({ type: 'banner', text: e.type === 'planted' ? 'Бомбу закладено!' : e.type === 'defused' ? 'Бомбу розміновано!' : 'Вибух!', start: now, dur: 2000 });
      if (e.type === 'turn' && e.turn > 1) this.effects.push({ type: 'banner', text: `Хід ${e.turn}`, start: now, dur: 1100, small: true });
      this.logEvent(e);
    }
    this.blips = this.blips.filter((b) => this.view.turn - b.turn <= 1);
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
    if (!this.camInit && this.me) this.centerOnMe(true);
  }

  centerOnMe(zoom) {
    if (!this.me || !this.me.hex || !this.W) return;
    const h = hexOf(this.me.hex);
    this.camInit = true;
    this.world.centerOn(h.x - 0.5, h.y - 0.5, zoom ? (this.W < 600 ? 20 : 24) : undefined);
  }

  followHex(k) { const h = hexOf(k); if (h && this.W) this.world.follow(h.x - 0.5, h.y - 0.5); }

  bindInput() {
    const pts = new Map();
    let drag = null, pinch = null;
    const cv = this.labels;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pts.size === 1) drag = { x: e.offsetX, y: e.offsetY, lx: e.offsetX, ly: e.offsetY, moved: false };
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; drag = null; }
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
        const g = this.world.pickGround(e.offsetX, e.offsetY);
        if (g) this.tapPoint(g.x, g.z);
      }
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
      this.world.centerOn(Math.floor((e.clientX - r.left) / r.width * this.grid.w), Math.floor((e.clientY - r.top) / r.height * this.grid.h));
    });
  }

  bindUi() {
    $('logBtn').onclick = () => { $('logSheet').hidden = !$('logSheet').hidden; };
    $('menuBtn').onclick = () => this.openMenu();
    for (const id of ['logSheet', 'menuSheet']) $(id).addEventListener('click', (e) => { if (e.target.closest('[data-close]')) $(id).hidden = true; });
  }

  /* ================= моя активація ================= */
  myTurn() { const v = this.view; return v && v.phase === 'play' && this.me && v.active === this.me.id && !v.pending && this.me.alive; }
  ap() { return this.me ? this.me.ap || 0 : 0; }

  occupiedFn() {
    const taken = new Set(this.view.players.filter((p) => p.alive && p.hex && p.id !== this.me.id).map((p) => p.hex));
    return (h) => taken.has(X.key(h.c, h.r));
  }

  reachable() {
    if (!this.myTurn() || this.ap() < 1) return null;
    return X.reach(hexOf(this.me.hex), R.MOVE, this.occupiedFn());
  }

  enemiesVisible() { return this.view.players.filter((p) => this.me && p.squad !== this.me.squad && p.alive && p.visible && p.hex); }

  shotPreview(t) {
    const me = this.me, mh = hexOf(me.hex), th = hexOf(t.hex);
    const n = R.attackNeed({ weapon: me.weapon, dist: X.hexDist(mh, th), moved: me.moved, flashed: me.flashed, overwatch: false });
    const cover = X.inCover(th, mh);
    const save = t.armor >= 1 ? R.SAVE_VEST : R.SAVE;
    const ex = R.expected({ weapon: me.weapon, need: n.need, save, cover: !!cover, armor: t.armor || 0, hp: t.hp });
    return { ...n, cover, save, ex, dist: X.hexDist(mh, th) };
  }

  tapPoint(x, y) {
    const h = X.hexNear(x, y);
    if (!h || !this.myTurn()) return;
    const k = X.key(h.c, h.r);
    // ворог — ціль
    const enemy = this.enemiesVisible().find((p) => p.hex === k);
    if (enemy) { this.target = enemy.id; this.sel = null; this.mode = 'move'; this.floorDrawn = ''; return this.renderPanel(); }
    if (this.mode.startsWith('nade:')) {
      const me = hexOf(this.me.hex);
      if (h.kind === 'wall' || X.hexDist(me, h) > R.THROW_RANGE || !X.clearLine(me, h)) { this.toast(`Кинути можна до ${R.THROW_RANGE} гексів, туди, куди видно`); return; }
      return this.send({ type: 'nade', nade: this.mode.slice(5), c: h.c, r: h.r });
    }
    const reach = this.reachable();
    if (!reach || !reach.dist.has(k) || k === this.me.hex) { if (k !== this.me.hex) this.toast(this.ap() < 1 ? 'Дії закінчились' : `За дію — до ${R.MOVE} гексів`); return; }
    if (this.sel === k) return this.send({ type: 'move', c: h.c, r: h.r });
    this.sel = k; this.target = null; this.floorDrawn = '';
    this.renderPanel();
  }

  async send(a) {
    if (this.sending) return;
    this.sending = true;
    const r = await this.emit('game:act', a);
    this.sending = false;
    if (r && !r.ok && r.error) this.toast(r.error);
    this.sel = null; this.mode = 'move'; this.floorDrawn = '';
  }

  async rollDice() {
    if (this.rolling) return;
    this.rolling = true;
    this.renderPanel();
    const [r] = await Promise.all([this.emit('game:roll'), new Promise((ok) => setTimeout(ok, 750))]);
    this.rolling = false;
    if (r && !r.ok && r.error) this.toast(r.error);
    this.renderPanel();
  }

  /* ================= картка результату ================= */
  showResult(e) {
    const card = $('duelCard');
    card.innerHTML = '';
    const w = R.WEAPONS[this.byId[e.from] ? this.byId[e.from].weapon || 'glock' : 'glock'];
    const atk = e.atkDice.map((d) => `<span class="d6 ${d === 6 ? 'crit' : d >= e.need && d !== 1 ? 'hit' : 'miss'}">${FACES[d]}</span>`).join('');
    const def = e.defDice.map((d) => `<span class="d6 ${d === 6 ? 'crit' : d >= e.save && d !== 1 ? 'hit' : 'miss'}">${FACES[d]}</span>`).join('');
    const nHits = e.atkDice.filter((d) => d !== 6 && d >= e.need && d !== 1).length, nCrit = e.atkDice.filter((d) => d === 6).length;
    const nSaves = e.defDice.filter((d) => d >= e.save && d !== 1).length + (e.cover ? 1 : 0);
    const dead = this.byId[e.to] && !this.byId[e.to].alive;
    const rows = [
      `<div class="dc-zone">${this.tagName(e.from)} → ${this.tagName(e.to)}</div>`,
      `<div class="dc-roll mine-a"><span class="who">Атака ${e.need}+</span><span class="dz">${atk}</span><b class="sum">${nHits + nCrit}</b></div>`,
      `<div class="dc-roll"><span class="who">Захист ${e.save}+${e.cover ? ' 🛡+1' : ''}</span><span class="dz">${def}</span><b class="sum">${nSaves}</b></div>`,
      `<div class="dc-line ${e.damage ? 'hit' : ''}">${e.damage ? `Пройшло: ${e.hits ? `${e.hits} влуч.` : ''}${e.hits && e.crits ? ' + ' : ''}${e.crits ? `<b class="hs">${e.crits} хедшот</b>` : ''} → <b>−${e.damage} HP</b>${dead ? ' · 💀' : ''}` : 'Усе заблоковано — без шкоди'}</div>`,
    ];
    rows.forEach((html, i) => { const d = el('div', null, html); d.dataset.at = i * 350; card.append(d); });
    card.hidden = false;
    for (const node of card.querySelectorAll('[data-at]')) { node.classList.add('wait'); setTimeout(() => { node.classList.remove('wait'); node.classList.add('show'); }, Number(node.dataset.at)); }
    const a = this.world.playerPos(e.from), b = this.world.playerPos(e.to);
    if (a && b) for (let i = 0; i < e.atkDice.length; i++) this.world.addShot({ x: a.x - 0.5, y: a.z - 0.5 }, { x: b.x - 0.5, y: b.z - 0.5 }, i < e.hits + e.crits, performance.now() + 300 + i * 140);
    if (e.damage && b) this.effects.push({ type: 'dmg', id: e.to, text: `−${e.damage}${e.crits ? ' 💀' : ''}`, start: performance.now() + 900, dur: 1600 });
    clearTimeout(this.cardT);
    this.cardT = setTimeout(() => { card.hidden = true; }, 5200);
    card.onclick = () => { card.hidden = true; };
    void w;
  }

  /* ================= малювання ================= */
  drawFloor(ctx) {
    const v = this.view;
    if (!v) return;
    const hexPath = (h, s = 0.93) => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 180 * (60 * i - 30);
        const x = h.x + X.SIZE * s * Math.cos(a), y = h.y + X.SIZE * s * Math.sin(a);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
    };
    // сітка
    ctx.strokeStyle = 'rgba(255,250,235,.32)'; ctx.lineWidth = 0.035;
    for (const h of X.FLOOR) { hexPath(h); ctx.stroke(); }
    for (const k of v.smokes || []) { const h = hexOf(k); hexPath(h, 1); ctx.fillStyle = 'rgba(235,235,235,.35)'; ctx.fill(); }
    for (const k of v.fires || []) { const h = hexOf(k); hexPath(h, 1); ctx.fillStyle = 'rgba(255,110,40,.35)'; ctx.fill(); }
    // моя активація: досяжні гекси
    if (this.myTurn()) {
      if (this.mode.startsWith('nade:')) {
        const me = hexOf(this.me.hex);
        for (const h of X.HEXES.values()) {
          if (h.kind === 'wall' || X.hexDist(me, h) > R.THROW_RANGE || !X.clearLine(me, h)) continue;
          hexPath(h, 0.86); ctx.fillStyle = 'rgba(255,215,80,.28)'; ctx.fill();
        }
      } else {
        const reach = this.reachable();
        if (reach) for (const [k, d] of reach.dist) {
          if (k === this.me.hex) continue;
          const h = hexOf(k);
          hexPath(h, 0.86);
          ctx.fillStyle = k === this.sel ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.17)'; ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 0.05; ctx.stroke();
        }
        if (this.sel && reach) {
          // шлях
          const path = X.pathTo(hexOf(this.me.hex), hexOf(this.sel), R.MOVE, this.occupiedFn()) || [];
          const me = hexOf(this.me.hex);
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.16;
          ctx.beginPath(); ctx.moveTo(me.x, me.y); for (const h of path) ctx.lineTo(h.x, h.y); ctx.stroke();
        }
      }
      // лінія до цілі
      if (this.target) {
        const t = this.byId[this.target], a = hexOf(this.me.hex), b = t && hexOf(t.hex);
        if (b) { ctx.strokeStyle = '#ff5a4a'; ctx.lineWidth = 0.1; ctx.setLineDash([0.3, 0.2]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]); }
      }
    }
    // активний боєць
    if (v.active) { const p = this.byId[v.active]; const h = p && p.visible && hexOf(p.hex); if (h) { hexPath(h, 1); ctx.strokeStyle = COLORS[p.side]; ctx.lineWidth = 0.14; ctx.stroke(); } }
    // видимі вороги
    for (const p of this.enemiesVisible()) { const h = hexOf(p.hex); hexPath(h, 0.96); ctx.strokeStyle = this.target === p.id ? '#ff2a1a' : 'rgba(255,80,60,.8)'; ctx.lineWidth = this.target === p.id ? 0.16 : 0.08; ctx.stroke(); }
    // жетони «?» — де чули кроки або бачили ворога
    const marks = [...this.blips.map((b) => b.hex)];
    for (const [id, s] of this.lastSeen) { const p = this.byId[id]; if (p && !p.visible && p.alive && v.turn - s.turn <= 1) marks.push(s.hex); }
    for (const k of marks) {
      const h = hexOf(k);
      hexPath(h, 0.7); ctx.fillStyle = 'rgba(200,40,30,.55)'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '700 0.9px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', h.x, h.y + 0.05);
    }
  }

  floorKey() {
    const v = this.view;
    if (!v) return '';
    return [v.seq, v.active, !!v.pending, this.sel, this.target, this.mode, this.me && this.me.hex, this.me && this.me.ap, this.blips.length].join('|');
  }

  draw() {
    if (!this.W) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    const v = this.view;
    this.frame = [];
    if (v) {
      for (const p of v.players) {
        const h = hexOf(p.hex);
        if (!h || (!p.visible && !(this.me && p.squad === this.me.squad))) continue;
        const r = this.routes[p.id];
        const item = { id: p.id, name: p.name, side: p.side, x: h.x - 0.5, y: h.y - 0.5, alive: p.alive, hp: p.hp, armor: p.armor || 0, bomb: p.bomb, me: this.me && p.id === this.me.id, mate: this.me && p.squad === this.me.squad, snap: this.snapNext, route: r && r.pts };
        if (this.myTurn() && this.target && p.id === this.me.id) { const t = hexOf(this.byId[this.target].hex); item.faceX = t.x - 0.5; item.faceY = t.y - 0.5; }
        this.frame.push(item);
      }
      this.snapNext = false;
      this.world.syncPlayers(this.frame, dt);
      this.routes = {};
      if (!this.areaCache || this.areaCache.seq !== v.seq) {
        const tiles = (keys) => keys.flatMap((k) => { const h = hexOf(k); return [Math.floor(h.x) + ',' + Math.floor(h.y)]; });
        const groups = (keys) => keys.length ? [{ x: 0, y: 0, tiles: tiles(keys) }] : [];
        this.areaCache = { seq: v.seq, smokes: groups(v.smokes || []), fires: groups(v.fires || []) };
      }
      this.world.syncSmokes(this.areaCache.smokes);
      this.world.syncFires(this.areaCache.fires);
      const b = v.bomb, bh = b && hexOf(b.hex);
      this.world.syncBomb(bh && (b.state === 'planted' || b.state === 'dropped') ? { state: b.state, x: bh.x - 0.5, y: bh.y - 0.5 } : null);
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
    if (w.view.dist < 32) {
      ctx.font = '600 11px Inter, sans-serif';
      for (const co of DUNE.callouts) {
        if (!co.lx) continue;
        const s = w.project(co.lx, 0.05, co.ly);
        if (s.behind || s.x < -50 || s.x > this.W + 50 || s.y < -20 || s.y > this.H + 20) continue;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(240,225,190,.6)'; ctx.strokeText(co.name.toUpperCase(), s.x, s.y);
        ctx.fillStyle = 'rgba(70,45,20,.9)'; ctx.fillText(co.name.toUpperCase(), s.x, s.y);
      }
    }
    for (const p of this.frame) {
      if (!p.alive) continue;
      const pos = w.playerPos(p.id);
      if (!pos) continue;
      const s = w.project(pos.x, 1.42, pos.z);
      if (s.behind) continue;
      const vp = this.byId[p.id];
      const nm = (p.name.length > 11 ? p.name.slice(0, 10) + '…' : p.name) + (vp.overwatch ? ' 👁' : '') + (v.active === p.id ? ' ▶' : '');
      ctx.font = `600 ${p.me ? 12 : 11}px Inter, sans-serif`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(nm, s.x, s.y - 12);
      ctx.fillStyle = p.me ? '#fff' : COLORS[p.side]; ctx.fillText(nm, s.x, s.y - 12);
      if (p.hp !== undefined) {
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(s.x - 18, s.y - 2, 36, 5);
        ctx.fillStyle = p.hp > 50 ? '#7fcf6a' : p.hp > 25 ? '#e8c33d' : '#ef6a5a'; ctx.fillRect(s.x - 18, s.y - 2, 36 * p.hp / 100, 5);
      }
      if (p.bomb) { ctx.font = '12px sans-serif'; ctx.fillText('💣', s.x + 28, s.y - 4); }
    }
    const b = v.bomb;
    if (b && b.state === 'planted' && b.hex) {
      const h = hexOf(b.hex), s = w.project(h.x, 0.6, h.y);
      ctx.font = '700 14px Oswald, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(s.x - 34, s.y - 11, 68, 20);
      ctx.fillStyle = '#ff5a4a'; ctx.fillText(`💣 ${b.turnsLeft} ${b.turnsLeft === 1 ? 'хід' : 'ходи'}`, s.x, s.y);
    }
    this.effects = this.effects.filter((e) => now < e.start + e.dur);
    for (const e of this.effects) {
      const k = (now - e.start) / e.dur;
      if (k < 0) continue;
      ctx.save();
      if (e.type === 'banner') {
        ctx.globalAlpha = Math.min(1, 3 * (1 - k));
        const y = e.small ? this.H * 0.18 : this.H * 0.32;
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, y, this.W, e.small ? 36 : 54);
        ctx.font = `700 ${e.small ? 20 : 26}px Oswald, sans-serif`; ctx.fillStyle = e.small ? '#ffe2a8' : '#ff6b5a'; ctx.fillText(e.text, this.W / 2, y + (e.small ? 18 : 28));
      } else if (e.type === 'whiteout') {
        ctx.globalAlpha = Math.max(0, 1 - k) * 0.9; ctx.fillStyle = '#fffef4'; ctx.fillRect(0, 0, this.W, this.H);
      } else if (e.type === 'dmg') {
        const pos = w.playerPos(e.id);
        if (pos) {
          const s = w.project(pos.x, 1.6, pos.z);
          ctx.globalAlpha = Math.min(1, 2.5 * (1 - k));
          ctx.font = '700 22px Oswald, sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.85)';
          ctx.strokeText(e.text, s.x, s.y - 30 - k * 30); ctx.fillStyle = '#ff5a4a'; ctx.fillText(e.text, s.x, s.y - 30 - k * 30);
        }
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
      g.fillStyle = ch === '#' ? 'rgba(20,16,10,.88)' : ch === 'A' || ch === 'B' ? 'rgba(200,120,90,.95)' : ch === 'b' ? 'rgba(120,85,45,.95)' : 'rgba(205,180,135,.92)';
      g.fillRect(x * S, y * S, S, S);
    }
    g.font = '700 14px Oswald, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(120,20,10,.9)';
    g.fillText('A', 30.5 * S, 4.5 * S); g.fillText('Б', 4.5 * S, 4 * S);
    return c;
  }

  drawRadar() {
    const c = this.radar, g = this.rctx, v = this.view, S = 4;
    if (c.width !== this.grid.w * S) { c.width = this.grid.w * S; c.height = this.grid.h * S; }
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(this.radarBase, 0, 0);
    if (!v || !this.me) return;
    for (const b of this.blips) { const h = hexOf(b.hex); g.strokeStyle = '#ff3b2f'; g.lineWidth = 2; g.beginPath(); g.arc(h.x * S, h.y * S, 6, 0, Math.PI * 2); g.stroke(); }
    const b = v.bomb;
    if (b && b.hex && (b.state === 'planted' || b.state === 'dropped')) { const h = hexOf(b.hex); g.fillStyle = '#ff2a1a'; g.fillRect(h.x * S - 4, h.y * S - 4, 8, 8); }
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
    if (!me.alive && v.phase === 'play') return 'Ти загинув — дивись за командою';
    const b = v.bomb || {};
    if (me.side === 'T') {
      if (b.state === 'planted') return `Захищай бомбу на ${SITE_UA[b.site]} — вибух через ${b.turnsLeft} ход.`;
      if (me.bomb) return hexOf(me.hex) && hexOf(me.hex).site ? 'Ти на точці — заклади бомбу (2 дії)!' : 'У тебе бомба 💣 — неси на точку А або Б';
      if (b.state === 'dropped') return 'Бомба лежить на землі — підбери!';
      return 'Прикривай бомбу і займай точку А або Б';
    }
    if (b.state === 'planted') return `Бомба на ${SITE_UA[b.site]}! Підійди впритул і розмінуй`;
    return 'Не дай закласти бомбу — тримай точки';
  }

  renderHud() {
    const v = this.view;
    if (!v) return;
    const sideScore = (side) => { const sq = v.players.find((p) => p.side === side); return sq ? v.score[sq.squad] : 0; };
    $('scoreT').textContent = sideScore('T');
    $('scoreCT').textContent = sideScore('CT');
    const b = v.bomb || {};
    let label;
    if (v.phase === 'buy') label = `${clock(R.ROUND_TIME)} · Закупівля`;
    else if (v.phase === 'play') {
      const who = v.pending ? '🎲 Перестрілка' : v.active === v.me ? 'ТВІЙ ХІД' : v.active ? `Ходить ${this.name(v.active)}` : '';
      label = `${b.state === 'planted' ? `💣 ${b.turnsLeft} хід.` : clock(v.clock)} · Хід ${v.turn}/${R.TURNS} · ${who}`;
    } else if (v.phase === 'roundOver') label = 'Кінець раунду';
    else label = 'Матч завершено';
    $('phaseLabel').textContent = label;
    $('phaseLabel').classList.toggle('bomb', b.state === 'planted');
    $('phaseSub').textContent = this.objective();
  }

  tickTimer() {
    const v = this.view, t = $('timer');
    if (!v || !v.deadline || v.phase === 'over' || v.phase === 'roundOver') { if (t._v !== '') { t._v = ''; t.textContent = ''; } return; }
    const left = Math.max(0, Math.ceil((v.deadline - (Date.now() + this.offset)) / 1000));
    const mine = v.phase === 'buy' || (v.waiting && v.waiting.id === v.me);
    const val = mine ? left : '';
    if (t._v !== val) { t._v = val; t.textContent = val; t.classList.toggle('low', mine && left <= 6); }
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
    line.innerHTML = `${me.alive ? hpBar(me.hp) : '💀'}<span>${w ? `${esc(w.name)} ${'🎲'.repeat(w.atk)}` : ''}${me.armor >= 1 ? ' · 🦺' : ''}${me.armor === 2 ? '🪖' : ''}${me.kit ? ' · ✂' : ''}${me.bomb ? ' · 💣' : ''} ${nades}</span>
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
    if (v.phase !== 'play') { panel.append(el('div', 'hint', v.phase === 'over' ? 'Матч завершено.' : 'Раунд завершено. Наступний скоро почнеться.')); return; }
    if (v.pending) return this.renderAttack(panel);
    if (!me.alive) { panel.append(el('div', 'hint', 'Ти загинув у цьому раунді. Дивись, як грає команда.')); return; }
    if (this.myTurn()) return this.renderActivation(panel);
    const act = this.byId[v.active];
    const left = v.players.filter((p) => p.alive && p.squad === me.squad && !p.expended).length;
    panel.append(el('div', 'wait-turn', `<b>${act ? `Ходить ${this.tagName(act.id)}` : 'Чекаємо…'}</b><span>${me.expended ? 'Ти вже ходив у цьому ході' : 'Твоя черга скоро'}${me.overwatch ? ' · 👁 ти тримаєш кут' : ''}${left > 1 ? ` · у команди ще ${left} активац.` : ''}</span>`));
  }

  renderActivation(panel) {
    const v = this.view, me = this.me;
    const pips = '●'.repeat(this.ap()) + '<span class="lost">' + '●'.repeat(Math.max(0, R.AP - this.ap())) + '</span>';
    panel.append(el('div', 'duel-head', `<b>Твоя активація</b><span class="pips">дії: ${pips}</span>`));
    if (v.canPlant || v.canDefuse) {
      const action = v.canPlant ? 'plant' : 'defuse';
      const cost = action === 'plant' ? 2 : (me.kit ? 1 : 2);
      const b = el('button', 'btn big primary ' + action, action === 'plant' ? '💣 Закласти бомбу (2 дії)' : `✂ Розмінувати (${cost} ${cost === 1 ? 'дія' : 'дії'})`);
      b.disabled = this.ap() < cost;
      b.onclick = () => this.send({ type: action });
      panel.append(b);
    }
    // ціль
    if (this.target) {
      const t = this.byId[this.target];
      const pv = this.shotPreview(t);
      const mods = pv.mods.map(([k, x]) => `<span class="mod down">${esc(k)} +${x}</span>`).join('');
      const box = el('div', 'target');
      box.innerHTML = `<div class="tg-head">🎯 ${this.tagName(t.id)} ${hpBar(t.hp)} ${t.armor >= 1 ? '🦺' : ''}${t.armor === 2 ? '🪖' : ''}</div>
        <div class="tg-line">${pv.atk}🎲 атаки, влучання на <b>${pv.need}+</b> · ціль блокує на ${pv.save}+${pv.cover ? ' · <b>🛡 укриття +1 блок</b>' : ' · без укриття'}</div>
        <div class="mods">${mods}</div>
        <div class="tg-odds">шанс влучити ${pct(pv.ex.hit)} · ≈${pv.ex.dmg} шкоди · вбити ${pct(pv.ex.kill)}</div>`;
      const shoot = el('button', 'btn big primary roll', '🔫 Стріляти (1 дія)');
      shoot.disabled = this.ap() < 1 || me.shot;
      if (me.shot) shoot.textContent = 'Вже стріляв у цій активації';
      shoot.onclick = () => this.send({ type: 'shoot', target: t.id });
      box.append(shoot);
      panel.append(box);
    } else if (this.sel) {
      const go = el('button', 'btn big primary', '🏃 Йти сюди (1 дія)');
      go.onclick = () => { const h = hexOf(this.sel); this.send({ type: 'move', c: h.c, r: h.r }); };
      panel.append(go);
    }
    const enemies = this.enemiesVisible();
    const row = el('div', 'acts2');
    if (enemies.length && !this.target) {
      for (const e of enemies) {
        const pv = this.shotPreview(e);
        const b = el('button', 'act2 shoot', `🎯 ${esc(e.name)}<small>${pct(pv.ex.hit)} · ≈${pv.ex.dmg}</small>`);
        b.onclick = () => { this.target = e.id; this.sel = null; this.floorDrawn = ''; this.renderPanel(); };
        row.append(b);
      }
    }
    const ow = el('button', 'act2', `👁 Тримати кут<small>завершує хід, стріляєш першим</small>`);
    ow.disabled = this.ap() < 1;
    ow.onclick = () => this.send({ type: 'overwatch' });
    row.append(ow);
    for (const [k, g] of Object.entries(R.GRENADES)) {
      if (!me.nades || !me.nades[k]) continue;
      const on = this.mode === 'nade:' + k;
      const b = el('button', 'act2' + (on ? ' on' : ''), `${g.icon} ${g.name}<small>${on ? 'торкнись жовтого гекса' : '1 дія'}</small>`);
      b.disabled = this.ap() < 1;
      b.onclick = () => { this.mode = on ? 'move' : 'nade:' + k; this.sel = null; this.target = null; this.floorDrawn = ''; this.renderPanel(); };
      row.append(b);
    }
    const end = el('button', 'act2 end', `⏭ Завершити<small>${this.ap() ? 'пропустити решту дій' : ''}</small>`);
    end.onclick = () => this.send({ type: 'end' });
    row.append(end);
    panel.append(row);
    const hint = this.mode.startsWith('nade:') ? R.GRENADES[this.mode.slice(5)].desc
      : this.sel ? 'Торкнись гекса ще раз або натисни «Йти сюди».'
        : this.target ? 'Стріляти можна раз за активацію. Після руху влучність гірша на 1.'
          : `Білі гекси — куди можна піти (до ${R.MOVE}). Торкнись ворога, щоб прицілитись.`;
    panel.append(el('div', 'hint', esc(hint)));
  }

  renderAttack(panel) {
    const v = this.view, pe = v.pending, me = this.me;
    const iAtk = pe.from === me.id && pe.stage === 'atk', iDef = pe.to === me.id && pe.stage === 'def';
    const mods = pe.mods.map(([k, x]) => `<span class="mod down">${esc(k)} +${x}</span>`).join('');
    panel.append(el('div', 'duel-head', `<b>${pe.overwatch ? '👁 Постріл з кута' : '🔫 Постріл'}</b><span>${this.tagName(pe.from)} → ${this.tagName(pe.to)}</span>`));
    const info = el('div', 'atk-info');
    info.innerHTML = `<div>Атака: <b>${pe.atk}🎲</b> влучання на <b>${pe.need}+</b> (шістка — хедшот) <span class="mods">${mods}</span></div>
      <div>Захист: <b>${R.DEF_DICE}🎲</b> блок на <b>${pe.save}+</b>${pe.cover ? ' · 🛡 укриття дає ще 1 блок' : ''}</div>`;
    panel.append(info);
    const tray = el('div', 'tray');
    if (pe.atkDice) tray.innerHTML = `<div class="dice-row big">${pe.atkDice.map((d) => `<span class="d6 big ${d === 6 ? 'crit' : d >= pe.need && d !== 1 ? 'hit' : 'miss'}">${FACES[d]}</span>`).join('')}</div>`;
    if (this.rolling) {
      const n = iAtk ? pe.atk : R.DEF_DICE;
      tray.insertAdjacentHTML('beforeend', `<div class="dice-row big">${Array.from({ length: n }, () => '<span class="d6 big rolling">⚄</span>').join('')}</div>`);
    } else if (iAtk) {
      const b = el('button', 'btn big primary roll', `🎲 Кинути атаку (${pe.atk} кубики)`);
      b.onclick = () => this.rollDice();
      tray.append(b);
    } else if (iDef) {
      const hits = pe.atkDice.filter((d) => d >= pe.need && d !== 1).length;
      tray.append(el('div', 'hint', hits ? `У тебе летить ${hits} влуч. Блокуй!` : 'Усі кулі мимо — але кинь захист'));
      const b = el('button', 'btn big primary roll', `🛡 Кинути захист (${R.DEF_DICE} кубики)`);
      b.onclick = () => this.rollDice();
      tray.append(b);
    } else {
      tray.append(el('div', 'hint', pe.stage === 'atk' ? `${esc(this.name(pe.from))} кидає атаку…` : `${esc(this.name(pe.to))} кидає захист…`));
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
    const wdesc = (w) => `${w.atk}🎲 атаки на ${w.hit}+ · ${w.dmg} шкоди, хедшот ${w.crit}${w.critHelmet < w.crit ? ` (у шолом ${w.critHelmet})` : ', навіть у шолом'} · дальність ${w.range}`;
    section('Зброя', Object.entries(R.WEAPONS).filter(([, w]) => w.slot === 'primary' && R.sideCanBuy(w.side, side)).map(([id, w]) => ({ id, name: w.name, price: w.price, owned: me.primary === id, desc: wdesc(w) })));
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
    foot.append(el('div', 'loadout', `Пістолет ${esc(pistol ? pistol.name : '')}: ${pistol ? wdesc(pistol) : ''} — завжди з собою`));
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
        const mr = v.matchResult, mine = this.me ? this.me.squad : 0;
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
        const again = el('button', 'btn primary big', 'Ще раз'); again.onclick = () => this.emit('room:lobby');
        const leave = el('button', 'btn', 'Вийти'); leave.onclick = () => this.onLobby('leave');
        row.append(again, leave);
        box.append(row);
      }
      ov.append(box);
    };
    clearTimeout(this.ovT);
    ov.hidden = true;
    this.ovT = setTimeout(show, 2600);
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
      case 'turn': return { cls: 't', html: `— Хід ${e.turn} —` };
      case 'activate': return { cls: '', html: `▶ Ходить ${n(e.id)}` };
      case 'move': return null;
      case 'overwatch': return { cls: '', html: `👁 ${n(e.id)} тримає кут` };
      case 'snap': return { cls: 'kill', html: `👁 ${n(e.from)} стріляє з кута в ${n(e.to)}` };
      case 'attack': return null;
      case 'atkroll': return null;
      case 'result': return { cls: e.damage ? 'hit' : 'miss', html: `${n(e.from)} → ${n(e.to)}: атака ${e.atkDice.map((d) => FACES[d]).join('')} (${e.need}+), захист ${e.defDice.map((d) => FACES[d]).join('')} (${e.save}+${e.cover ? ', укриття' : ''}) — ${e.damage ? `<b>−${e.damage}</b>${e.crits ? ' 💀' : ''}` : 'заблоковано'}` };
      case 'kill': return { cls: 'kill', html: e.by ? `${n(e.by)} вбиває ${n(e.id)}${e.reward ? ` <span class="muted">+$${e.reward}</span>` : ''}` : `${n(e.id)} гине (${e.cause === 'bomb' ? 'вибух бомби' : 'вогонь'})` };
      case 'nade': return { cls: '', html: `${e.by ? n(e.by) + ' кидає' : 'Прилетіла'} ${R.GRENADES[e.nade].icon} ${esc(R.GRENADES[e.nade].name.toLowerCase())}${e.blinded && e.blinded.length ? ` — засліплені: ${e.blinded.map(n).join(', ')}` : ''}` };
      case 'blast': return { cls: 'hit', html: `💥 ${n(e.id)} −${e.dmg}` };
      case 'burn': return { cls: 'hit', html: `🔥 ${n(e.id)} у вогні −${R.FIRE_DMG}` };
      case 'planted': return { cls: 'kill', html: `💣 ${n(e.id)} заклав бомбу на ${SITE_UA[e.site]}` };
      case 'defused': return { cls: 'kill', html: `✂ ${n(e.id)} розмінував бомбу!` };
      case 'exploded': return { cls: 'kill', html: '💥 Бомба вибухнула' };
      case 'drop': return { cls: '', html: `${n(e.id)} впустив бомбу` };
      case 'pickup': return { cls: '', html: `${n(e.id)} підібрав бомбу` };
      case 'noise': return { cls: '', html: '👣 Чути кроки — на карті жетон «?»' };
      default: return null;
    }
  }

  logEvent(e) {
    const d = this.describe(e);
    if (!d) return;
    const log = $('log');
    if (log.firstChild && log.firstChild.classList && log.firstChild.classList.contains('muted')) log.innerHTML = '';
    log.prepend(el('div', d.cls === 't' ? 't' : 'e ' + d.cls, d.html));
    while (log.children.length > 80) log.lastChild.remove();
    if (['kill', 'planted', 'defused', 'snap'].includes(e.type)) {
      const item = el('div', null, d.html);
      $('feed').append(item);
      setTimeout(() => item.remove(), 6000);
    }
  }
}

export const RULES_HTML = `<b>Правила</b>
  <p><b>Мета.</b> T заносять бомбу на точку А або Б і закладають (2 дії). CT не дають або розміновують (2 дії, з набором — 1). Раунд — ${R.TURNS} ходів, бомба вибухає через ${R.BOMB_TURNS}.</p>
  <p><b>Хід.</b> Гравці ходять по черзі: T → CT → T → CT… Кожен боєць за свою активацію має <b>${R.AP} дії</b>: рух на ${R.MOVE} гекси, постріл (раз за активацію), граната, закладка/розмінування. «👁 Тримати кут» завершує активацію: щойно ворог вийде тобі на лінію вогню — стріляєш першим.</p>
  <p><b>Постріл.</b> Ти кидаєш кубики атаки (пістолет 3🎲, AK/M4 4🎲): кожен ≥ потрібного — влучання, шістка — хедшот. Ціль кидає 3🎲 захисту: кожен ≥ 5 (з бронежилетом ≥ 4) блокує влучання, шістка блокує й хедшот. За ящиком чи кутом стіни — ще 1 блок, але з флангу укриття не працює.</p>
  <p><b>Штрафи.</b> Постріл після руху, задалеко або з кута — влучання на 1 гірше. Засліплений флешкою — на 2.</p>
  <p><b>Шкода як у CS2:</b> 100 HP, AK — 27 за влучання і 50 за хедшот, M4 — 23/40, пістолети — 14–17/30–35. Шолом зменшує хедшоти, крім AK.</p>
  <p><b>Туман війни.</b> Бачиш тих, кого бачить твоя команда. Кроки ворогів поруч позначаються жетоном «?».</p>`;
