import { Router } from 'express';
import { db, tx, now } from '../db.js';
import { html } from '../html.js';
import { csrfField } from '../layout.js';
import { SEEDS } from '../config.js';
import { norm, cleanLine, safeNext, relTime, fmtMD } from '../util.js';
import { hashPassword, verifyPassword, createSession, destroySession, flash, requireLogin, rateLimit } from '../auth.js';
import { addLedger, REASONS } from '../seeds.js';
import { STAGE_BY_KEY } from '../timeline.js';
import { cycleLabel } from '../programs.js';

export const router = Router();
const authLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });

const authForm = (res, { mode, error = '', next = '/', nickname = '' }) => {
  const signup = mode === 'signup';
  return html`<section class="narrow">
    <h1 class="h1">${signup ? '註冊' : '登入'}</h1>
    ${signup ? html`<p class="muted">不需要 Email。取一個暱稱就好，註冊送 ${SEEDS.signup} 🌱。請記住密碼，目前無法找回。</p>` : ''}
    ${error ? html`<div class="flash flash-error">${error}</div>` : ''}
    <form method="post" class="form" autocomplete="on">
      ${csrfField(res)}<input type="hidden" name="next" value="${next}">
      <label>暱稱 <input name="nickname" required minlength="2" maxlength="16" value="${nickname}" autocomplete="username"></label>
      <label>密碼 <input name="password" type="password" required minlength="8" maxlength="100" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
      <button class="btn" type="submit">${signup ? '建立帳號' : '登入'}</button>
    </form>
    <p class="muted small mt">${signup ? html`已有帳號？<a href="/login?next=${encodeURIComponent(next)}">登入</a>` : html`還沒有帳號？<a href="/signup?next=${encodeURIComponent(next)}">註冊</a>`}</p>
  </section>`;
};

router.get('/signup', (req, res) => res.page('註冊', authForm(res, { mode: 'signup', next: safeNext(req.query.next) })));
router.get('/login', (req, res) => res.page('登入', authForm(res, { mode: 'login', next: safeNext(req.query.next) })));

router.post('/signup', authLimit, async (req, res) => {
  const nickname = cleanLine(req.body.nickname, 16);
  const password = String(req.body.password ?? '');
  const next = safeNext(req.body.next);
  const fail = (error) => res.status(400).page('註冊', authForm(res, { mode: 'signup', error, next, nickname }));
  if (nickname.length < 2) return fail('暱稱至少 2 個字');
  if (password.length < 8) return fail('密碼至少 8 個字元');
  if (db.prepare('SELECT 1 FROM users WHERE nickname_norm = ?').get(norm(nickname))) return fail('這個暱稱已被使用');
  const pw = await hashPassword(password);
  let uid;
  try {
    uid = tx(() => {
      const id = Number(db.prepare('INSERT INTO users (nickname, nickname_norm, pw_hash, created_at) VALUES (?,?,?,?)')
        .run(nickname, norm(nickname), pw, now()).lastInsertRowid);
      addLedger(id, SEEDS.signup, 'signup');
      return id;
    });
  } catch { return fail('這個暱稱已被使用'); }
  createSession(res, uid);
  flash(res, 'ok', `歡迎！已送你 ${SEEDS.signup} 🌱`);
  res.redirect(next);
});

router.post('/login', authLimit, async (req, res) => {
  const nickname = cleanLine(req.body.nickname, 16);
  const next = safeNext(req.body.next);
  const u = db.prepare('SELECT * FROM users WHERE nickname_norm = ?').get(norm(nickname));
  const ok = u && await verifyPassword(String(req.body.password ?? ''), u.pw_hash);
  if (!ok) return res.status(400).page('登入', authForm(res, { mode: 'login', error: '暱稱或密碼不正確', next, nickname }));
  createSession(res, u.id);
  res.redirect(next);
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.redirect('/');
});

router.get('/me', requireLogin, (req, res) => {
  const uid = req.user.id;
  const follows = db.prepare(
    `SELECT f.cycle_id, f.last_seen, c.year, c.term, p.name, p.slug,
       (SELECT COUNT(*) FROM reports r WHERE r.cycle_id = f.cycle_id AND r.created_at > f.last_seen AND r.user_id != ? AND r.hidden = 0) AS fresh
     FROM follows f JOIN cycles c ON c.id = f.cycle_id JOIN programs p ON p.id = c.program_id
     WHERE f.user_id = ? ORDER BY fresh DESC, f.last_seen DESC`
  ).all(uid, uid);
  const reports = db.prepare(
    `SELECT r.*, c.year, c.term, p.name pname, p.slug, t.name tname
     FROM reports r JOIN cycles c ON c.id = r.cycle_id JOIN programs p ON p.id = c.program_id
     LEFT JOIN tracks t ON t.id = r.track_id WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 30`
  ).all(uid);
  const ledger = db.prepare('SELECT * FROM seed_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(uid);
  const qs = db.prepare(
    `SELECT q.*, c.year, c.term, p.slug FROM questions q JOIN cycles c ON c.id = q.cycle_id
     JOIN programs p ON p.id = c.program_id WHERE q.user_id = ? ORDER BY q.id DESC LIMIT 10`
  ).all(uid);

  res.page('我的', html`
    <section>
      <div class="me-head">
        <div><h1 class="h1">${req.user.nickname}</h1><p class="muted">還沒回報進度？回報後才能解鎖明細與回答問題。</p></div>
        <div class="seeds-big"><span>🌱</span><b>${req.user.seeds}</b><small>種子</small></div>
      </div>
      <div class="cols">
        <div>
          <h2>追蹤中</h2>
          ${follows.length ? html`<ul class="list">${follows.map((f) => html`<li>
            <a href="/p/${f.slug}/c/${f.cycle_id}">${f.name} ${f.year} ${f.term}</a>
            ${f.fresh ? html`<span class="badge">${f.fresh} 則新進度</span>` : html`<span class="muted small">沒有新進度</span>`}
          </li>`)}</ul>` : html`<p class="muted">還沒有追蹤任何計劃。在計劃頁按「追蹤」即可，不用再留言卡位。</p>`}
          <h2>我的回報</h2>
          ${reports.length ? html`<ul class="list">${reports.map((r) => html`<li>
            <a href="/p/${r.slug}/c/${r.cycle_id}">${r.pname} ${r.year} ${r.term}${r.tname ? `・${r.tname}` : ''}</a>
            <span>${STAGE_BY_KEY[r.stage].label} <span class="muted">${fmtMD(r.event_date)}</span>${r.hidden ? html` <span class="pill pill-muted">已隱藏</span>` : ''}</span>
          </li>`)}</ul>` : html`<p class="muted">還沒有回報。</p>`}
          ${qs.length ? html`<h2>我的提問</h2><ul class="list">${qs.map((q) => html`<li>
            <a href="/p/${q.slug}/c/${q.cycle_id}?tab=qa#q${q.id}">${q.body.slice(0, 40)}</a>
            <span class="muted small">${{ open: '等待回答', solved: '已採納', auto_paid: '已自動發放', refunded: '已退回' }[q.status]}・🌱${q.bounty}</span>
          </li>`)}</ul>` : ''}
        </div>
        <div>
          <h2>種子紀錄</h2>
          <ul class="list ledger">${ledger.map((l) => html`<li>
            <span>${REASONS[l.reason] || l.reason}<small class="muted"> ${relTime(l.created_at)}</small></span>
            <b class="${l.delta >= 0 ? 'plus' : 'minus'}">${l.delta >= 0 ? '+' : ''}${l.delta}</b>
          </li>`)}</ul>
          <form method="post" action="/logout" class="mt">${csrfField(res)}<button class="btn btn-ghost btn-sm">登出</button></form>
        </div>
      </div>
    </section>`);
});
