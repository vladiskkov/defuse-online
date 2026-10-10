// Екрани: вхід, головна, лобі. Зв'язок із сервером через Socket.IO.
import { Game } from './game.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let me = null, socket = null, room = null, game = null, size = 1, config = {};

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

let toastT;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 3200);
}

function emit(ev, data) {
  return new Promise((resolve) => {
    if (!socket) return resolve({ ok: false });
    socket.timeout(8000).emit(ev, data || {}, (err, res) => resolve(err ? { ok: false, error: 'Немає зв\'язку з сервером' } : res));
  });
}

function err(id, msg) { const e = $(id); e.textContent = msg || ''; e.hidden = !msg; }

/* ---------- вхід ---------- */
async function init() {
  config = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  const { user } = await fetch('/api/me').then((r) => r.json()).catch(() => ({}));
  if (user) { me = user; connect(); } else showLogin();
}

function showLogin() {
  show('login');
  $('guestForm').hidden = !config.allowGuests;
  $('guestOr').hidden = !(config.allowGuests && config.googleClientId);
  if (config.googleClientId) {
    const render = () => {
      if (!window.google || !google.accounts) return setTimeout(render, 200);
      google.accounts.id.initialize({ client_id: config.googleClientId, callback: onGoogle, ux_mode: 'popup' });
      google.accounts.id.renderButton($('googleBtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'uk' });
    };
    render();
  }
}

async function onGoogle({ credential }) {
  const r = await fetch('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) }).then((r) => r.json()).catch(() => ({ error: 'Немає зв\'язку' }));
  if (r.error) return err('loginError', r.error);
  me = r.user; connect();
}

$('guestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('guestName').value.trim();
  const r = await fetch('/api/auth/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then((r) => r.json()).catch(() => ({ error: 'Немає зв\'язку' }));
  if (r.error) return err('loginError', r.error);
  me = r.user; connect();
});

$('logoutBtn').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  if (socket) socket.disconnect();
  socket = null; me = null;
  if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
  showLogin();
};

/* ---------- з'єднання ---------- */
function connect() {
  $('meName').textContent = me.name;
  socket = io({ transports: ['websocket', 'polling'] });
  socket.on('connect_error', (e) => { if (e.message === 'unauthorized') { socket.disconnect(); showLogin(); } });
  socket.on('hello', ({ room: code }) => {
    if (code) return; // стан кімнати прийде окремо
    room = null;
    const invite = new URLSearchParams(location.search).get('r');
    if (invite) {
      history.replaceState(null, '', '/');
      emit('room:join', { code: invite }).then((r) => { if (!r.ok) { showHome(); err('homeError', r.error); } });
    } else showHome();
  });
  socket.on('room', (state) => {
    room = state;
    if (state.status === 'lobby') renderLobby();
    else ensureGame();
  });
  socket.on('game', (v) => { ensureGame(); game.update(v); });
  socket.on('ready', (d) => game && game.onReady(d));
  socket.on('teamPlan', (d) => game && game.onTeamPlan(d));
  socket.on('kicked', () => { room = null; showHome(); toast('Господар прибрав вас із кімнати'); });
  socket.on('disconnect', () => toast('Зв\'язок втрачено. Перепідключаюся…'));
  socket.io.on('reconnect', () => emit('sync'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && socket) emit('sync'); });
}

function ensureGame() {
  if (!game) { game = new Game({ emit, toast, onLobby: leaveRoom }); window.dfz = game; }
  if ($('game').hidden) { show('game'); requestAnimationFrame(() => game.resize()); }
}

async function leaveRoom() {
  await emit('room:leave');
  room = null;
  showHome();
}

/* ---------- головна ---------- */
function showHome() {
  show('home');
  err('homeError');
}

for (const b of $('sizeSeg').querySelectorAll('button')) {
  b.onclick = () => {
    size = Number(b.dataset.size);
    for (const x of $('sizeSeg').children) x.classList.toggle('on', x === b);
  };
}
$('soloBtn').onclick = async () => {
  const r = await emit('room:create', { size, solo: true });
  if (!r.ok) err('homeError', r.error || 'Не вдалося створити гру');
};
$('createBtn').onclick = async () => {
  const r = await emit('room:create', { size, solo: false });
  if (!r.ok) err('homeError', r.error || 'Не вдалося створити кімнату');
};
$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('joinCode').value.trim().toUpperCase();
  if (code.length !== 5) return err('homeError', 'Код має 5 символів');
  const r = await emit('room:join', { code });
  if (!r.ok) err('homeError', r.error);
});

/* ---------- лобі ---------- */
function renderLobby() {
  show('lobby');
  err('lobbyError');
  const host = room.hostId === me.id;
  $('roomCode').textContent = room.code;
  const segEl = $('lobbySize');
  segEl.classList.toggle('disabled', !host);
  for (const b of segEl.children) {
    b.classList.toggle('on', Number(b.dataset.size) === room.size);
    b.onclick = () => host && emit('room:size', { size: Number(b.dataset.size) }).then((r) => r && r.error && err('lobbyError', r.error));
  }
  const teams = $('teams');
  teams.innerHTML = '';
  const mine = room.seats.findIndex((row) => row.some((x) => x && x.id === me.id));
  room.seats.forEach((row, squad) => {
    const t = document.createElement('div');
    t.className = 'team' + (squad === 1 ? ' ct' : '');
    t.innerHTML = `<h4>Команда ${squad + 1}<small>${squad === 0 ? 'Спершу за T' : 'Спершу за CT'}</small></h4>`;
    row.forEach((x, i) => {
      const s = document.createElement('div');
      if (!x) {
        s.className = 'seat empty';
        s.innerHTML = '<span class="nm">Вільно</span>';
        if (host) {
          const add = document.createElement('button'); add.className = 'btn small'; add.textContent = '+ бот';
          add.onclick = () => emit('room:bot', { squad, i, add: true });
          s.append(add);
        }
      } else {
        s.className = 'seat';
        s.innerHTML = `<span class="dot ${x.online ? '' : 'off'}"></span><span class="nm">${x.isBot ? '🤖 ' : ''}${esc(x.name)}${x.id === room.hostId ? ' 👑' : ''}${x.id === me.id ? ' (ви)' : ''}</span>`;
        if (host && x.id !== me.id) {
          const rm = document.createElement('button'); rm.className = 'x'; rm.textContent = '✕'; rm.title = 'Прибрати';
          rm.onclick = () => x.isBot ? emit('room:bot', { squad, i, add: false }) : emit('room:kick', { id: x.id });
          s.append(rm);
        }
      }
      t.append(s);
    });
    if (mine !== squad && mine >= 0) {
      const sw = document.createElement('button'); sw.className = 'btn small'; sw.textContent = 'Перейти сюди';
      sw.onclick = () => emit('room:squad', { squad });
      t.append(sw);
    }
    teams.append(t);
  });
  const empty = room.seats.flat().filter((x) => !x).length;
  $('lobbyHint').textContent = host
    ? (empty ? `Вільних місць: ${empty}. Надішліть друзям запрошення або додайте ботів.` : 'Усі на місцях — можна починати.')
    : 'Чекаємо, поки господар кімнати почне матч.';
  $('startBtn').hidden = !host;
  $('startBtn').disabled = empty > 0;
}

$('startBtn').onclick = async () => {
  const r = await emit('room:start');
  if (r && !r.ok && r.error) err('lobbyError', r.error);
};
$('leaveLobby').onclick = leaveRoom;
$('copyInvite').onclick = async () => {
  const url = `${location.origin}/?r=${room.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Дефуз', text: 'Заходь у мою кімнату в «Дефуз»', url });
    else { await navigator.clipboard.writeText(url); toast('Посилання скопійовано'); }
  } catch { /* скасовано */ }
};

init();
