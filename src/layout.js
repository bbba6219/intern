import { config } from './config.js';
import { db } from './db.js';
import { html, raw } from './html.js';

export const csrfField = (res) => raw(`<input type="hidden" name="_csrf" value="${res.locals.csrf}">`);

function newCountFor(user) {
  if (!user) return 0;
  return db.prepare(
    `SELECT COUNT(*) c FROM reports r JOIN follows f ON f.cycle_id = r.cycle_id
     WHERE f.user_id = ? AND r.created_at > f.last_seen AND r.user_id != ? AND r.hidden = 0`
  ).get(user.id, user.id).c;
}

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8C%B1%3C/text%3E%3C/svg%3E";

export function installPage(app) {
  app.use((req, res, next) => {
    res.page = (title, body, { desc = '', status } = {}) => {
      const user = res.locals.user;
      const fl = res.locals.flash;
      const badge = newCountFor(user);
      const full = title ? `${title}｜${config.siteName}` : `${config.siteName}｜一起上岸`;
      if (status) res.status(status);
      res.type('html').send(String(html`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${full}</title>
<meta name="description" content="${desc || '集中追蹤實習、管培、獎學金等申請計劃的測驗、面試、錄取通知時間線。回報進度賺種子，用種子查詢與提問。'}">
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">🌱</span>${config.siteName}</a>
    <form class="search-mini" action="/search" method="get" role="search">
      <input type="search" name="q" placeholder="搜尋計劃名稱、公司或別名" aria-label="搜尋計劃" value="${req.query.q || ''}">
    </form>
    <nav class="nav">
      <a href="/rules">種子規則</a>
      ${user
        ? html`<a class="nav-me" href="/me">我的${badge ? html`<span class="badge" title="追蹤中的新進度">${badge}</span>` : ''}<span class="seeds-pill">🌱 ${user.seeds}</span></a>`
        : html`<a href="/login">登入</a><a class="btn btn-sm" href="/signup">註冊 +20🌱</a>`}
    </nav>
  </div>
</header>
${fl ? html`<div class="wrap"><div class="flash flash-${fl.kind || 'info'}" role="status">${fl.text}</div></div>` : ''}
<main class="wrap">${body}</main>
<footer class="foot wrap">
  <p>${config.siteName} 由同學共同維護，所有時程皆為使用者自行回報，僅供參考，請以各公司官方公告為準。</p>
</footer>
</body>
</html>`));
    };
    next();
  });
}
