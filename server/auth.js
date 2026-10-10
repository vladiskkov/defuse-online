// Вхід через Google і гостьовий вхід. Сесія — підписана cookie без бази даних.
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const ALLOW_GUESTS = process.env.ALLOW_GUESTS !== 'false';
// версія збірки: після деплою відкриті вкладки перезавантажаться самі
export const VERSION = process.env.RENDER_GIT_COMMIT || String(Date.now());
const COOKIE = 'dfz';
const MAX_AGE = 30 * 24 * 3600 * 1000;
const google = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function sign(data) { return crypto.createHmac('sha256', SECRET).update(data).digest('base64url'); }

export function encodeSession(user) {
  const body = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + MAX_AGE })).toString('base64url');
  return body + '.' + sign(body);
}

export function decodeSession(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const u = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!u.exp || u.exp < Date.now()) return null;
    return { id: u.id, name: u.name, picture: u.picture || null, guest: !!u.guest };
  } catch { return null; }
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function userFromCookieHeader(header) { return decodeSession(parseCookies(header)[COOKIE]); }

function setCookie(res, user) {
  res.cookie(COOKIE, encodeSession(user), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: MAX_AGE, path: '/',
  });
}

export function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
}

export function mountAuth(app) {
  app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, allowGuests: ALLOW_GUESTS, version: VERSION }));

  app.get('/api/me', (req, res) => res.json({ user: userFromCookieHeader(req.headers.cookie) }));

  app.post('/api/auth/google', async (req, res) => {
    if (!google) return res.status(400).json({ error: 'Вхід через Google не налаштовано' });
    try {
      const ticket = await google.verifyIdToken({ idToken: String(req.body.credential || ''), audience: GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      const user = { id: 'g' + p.sub, name: cleanName(p.given_name || p.name || 'Гравець') || 'Гравець', picture: p.picture || null };
      setCookie(res, user);
      res.json({ user });
    } catch (e) {
      res.status(401).json({ error: 'Не вдалося перевірити вхід Google' });
    }
  });

  app.post('/api/auth/guest', (req, res) => {
    if (!ALLOW_GUESTS) return res.status(403).json({ error: 'Гостьовий вхід вимкнено' });
    const name = cleanName(req.body.name);
    if (name.length < 2) return res.status(400).json({ error: 'Ім\'я має бути від 2 символів' });
    const user = { id: 'u' + crypto.randomBytes(8).toString('hex'), name, guest: true };
    setCookie(res, user);
    res.json({ user });
  });

  app.post('/api/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });
}
