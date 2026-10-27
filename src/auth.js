import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { db, now } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 30 * 86400 * 1000;

function loadSecret() {
  if (config.secret) return config.secret;
  if (config.dataDir === ':memory:') return crypto.randomBytes(32).toString('hex');
  const f = path.join(config.dataDir, 'secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');

function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}

export function setCookie(res, name, value, { maxAge = null, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (config.secureCookies) parts.push('Secure');
  if (maxAge !== null) parts.push(`Max-Age=${maxAge}`);
  res.append('Set-Cookie', parts.join('; '));
}

export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha(token), userId, now(), now() + SESSION_MS);
  setCookie(res, 'sid', token, { maxAge: SESSION_MS / 1000 });
}

export function destroySession(req, res) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(sid));
  setCookie(res, 'sid', '', { maxAge: 0 });
}

export const flash = (res, kind, text) =>
  setCookie(res, 'flash', JSON.stringify({ kind, text }), { maxAge: 30 });

// 身分、CSRF、flash。CSRF token = HMAC(secret, sid 或匿名 id)，POST 一律驗證
export function sessionMiddleware(req, res, next) {
  const c = parseCookies(req.headers.cookie);
  let user = null;
  if (c.sid) {
    user = db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`
    ).get(sha(c.sid), now()) || null;
  }
  let anon = c.anon;
  if (!anon) {
    anon = crypto.randomBytes(16).toString('hex');
    setCookie(res, 'anon', anon, { maxAge: 365 * 86400 });
  }
  req.user = user;
  res.locals.user = user;
  res.locals.csrf = hmac(user ? `sid:${c.sid}` : `anon:${anon}`);

  if (c.flash) {
    try { res.locals.flash = JSON.parse(c.flash); } catch {}
    setCookie(res, 'flash', '', { maxAge: 0 });
  }

  if (req.method === 'POST') {
    const sent = Buffer.from(String(req.body?._csrf ?? ''));
    const want = Buffer.from(res.locals.csrf);
    if (sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) {
      return res.status(403).type('text').send('表單已過期，請回上一頁重新整理後再試一次。');
    }
  }
  next();
}

export function requireLogin(req, res, next) {
  if (req.user) return next();
  flash(res, 'info', '請先登入');
  const back = req.method === 'GET' ? req.originalUrl : (req.get('referer') ? new URL(req.get('referer'), 'http://x').pathname : '/');
  res.redirect(`/login?next=${encodeURIComponent(back)}`);
}

// 簡單的記憶體限流（單機部署足夠；多機請換成共用儲存）
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const k = key(req);
    const t = Date.now();
    const arr = (hits.get(k) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) return res.status(429).type('text').send('操作太頻繁，請稍後再試。');
    arr.push(t);
    hits.set(k, arr);
    if (hits.size > 5000) for (const [kk, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(kk);
    next();
  };
}
