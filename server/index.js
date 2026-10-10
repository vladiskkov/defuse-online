// Сервер «Дефуз»: статика, вхід, Socket.IO.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';
import { mountAuth, userFromCookieHeader, VERSION } from './auth.js';
import { Rooms } from './rooms.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});

app.get('/healthz', (req, res) => res.send('ok'));
mountAuth(app);
// код гри браузер щоразу перевіряє (ETag), щоб після оновлення ніхто не застряг на старій версії
const fresh = { etag: true, lastModified: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') };
app.use('/shared', express.static(path.join(root, '../shared'), fresh));
app.use('/vendor/three', express.static(path.join(root, '../node_modules/three/build'), { maxAge: '7d' }));
app.use(express.static(path.join(root, '../public'), { ...fresh, extensions: ['html'] }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 32_000, pingInterval: 20000, pingTimeout: 25000 });
const rooms = new Rooms(io);

io.use((socket, next) => {
  const user = userFromCookieHeader(socket.handshake.headers.cookie);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

// простий обмежувач частоти подій
function limiter(socket) {
  let tokens = 30, last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(30, tokens + (now - last) / 100);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

io.on('connection', (socket) => {
  const uid = socket.user.id;
  const allow = limiter(socket);
  let room = rooms.roomOf(uid);
  if (room) room.attach(socket);
  socket.emit('hello', { user: socket.user, room: room ? room.code : null, version: VERSION });

  const on = (ev, fn) => socket.on(ev, (data, cb) => {
    if (!allow()) return typeof cb === 'function' && cb({ ok: false, error: 'Забагато дій, зачекайте секунду' });
    let res;
    try { res = fn(data || {}); } catch (e) { console.error(ev, e); res = { ok: false, error: 'Помилка сервера' }; }
    if (typeof cb === 'function') cb(res || { ok: true });
  });

  on('room:create', ({ size, solo }) => {
    if (room) room.leave(uid), room.detach(socket);
    room = rooms.create(socket.user, { size: Number(size), solo });
    room.attach(socket);
    if (solo) room.start(uid);
    return { ok: true, code: room.code };
  });

  on('room:join', ({ code }) => {
    const r = rooms.get(code);
    if (!r) return { ok: false, error: 'Кімнату не знайдено' };
    if (room && room !== r) { room.leave(uid); room.detach(socket); room = null; }
    const res = r.join(socket.user);
    if (!res.ok) return res;
    room = r;
    room.attach(socket);
    return { ok: true, code: r.code };
  });

  on('room:leave', () => {
    if (!room) return;
    room.leave(uid);
    room.detach(socket);
    // інші вкладки цього гравця теж виходять
    room = null;
    return { ok: true };
  });

  on('room:squad', ({ squad }) => room && room.switchSquad(uid, Number(squad)));
  on('room:bot', ({ squad, i, add }) => room && room.setBot(uid, Number(squad), Number(i), !!add));
  on('room:size', ({ size }) => room && room.setSize(uid, Number(size)));
  on('room:kick', ({ id }) => room && room.kick(uid, String(id)));
  on('room:start', () => room ? room.start(uid) : { ok: false });
  on('room:lobby', () => room && room.backToLobby(uid));

  on('game:buy', ({ item }) => room ? room.buy(uid, String(item)) : { ok: false });
  on('game:refund', () => room ? room.refund(uid) : { ok: false });
  on('game:buyReady', ({ ready }) => room && room.buyReady(uid, ready));
  on('game:plan', (plan) => room ? room.plan(uid, plan) : { ok: false });
  on('duel:act', (data) => room ? room.duelAct(uid, data) : { ok: false });
  on('duel:roll', () => room ? room.duelRoll(uid) : { ok: false });
  on('sync', () => { if (room) room.sendTo(uid); });

  socket.on('disconnect', () => {
    if (room) room.detach(socket);
  });
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => console.log(`Дефуз слухає на :${PORT}`));
