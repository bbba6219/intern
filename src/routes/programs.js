import { Router } from 'express';
import { html } from '../html.js';
import { csrfField } from '../layout.js';
import { cleanLine, cleanText } from '../util.js';
import { requireLogin, flash, rateLimit } from '../auth.js';
import { SEEDS } from '../config.js';
import {
  getProgramBySlug, latestCycle, createProgram, parseAliases, addAlias, createCycle, aliasesOf,
  searchPrograms, KINDS, TERM_SUGGESTIONS, cyclesOf, cycleLabel,
} from '../programs.js';

export const router = Router();
const writeLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, key: (req) => `prog:${req.user?.id ?? req.ip}` });

const newForm = (res, v = {}, { conflicts = [], similar = [] } = {}) => html`<section class="narrow">
  <h1 class="h1">建立新計劃</h1>
  <p class="muted">實習、管培、校園徵才、獎學金、交換、升學…都可以。每個計劃只會有<b>一個入口</b>，所以建立前請先確認沒有重複。建立成功可得 ${SEEDS.createProgram} 🌱，第一位其他同學回報後再補發 ${SEEDS.createProgramLater} 🌱。</p>
  ${conflicts.length ? html`<div class="flash flash-error">
    <b>這個計劃已經存在，無法重複建立：</b>
    <ul>${conflicts.map((c) => html`<li>「${c.input}」已是 <a href="/p/${c.slug}">${c.name}</a> 的名稱／別名</li>`)}</ul>
    請直接使用既有入口；缺少的叫法可以在該頁「補充別名」。
  </div>` : ''}
  ${similar.length ? html`<div class="flash flash-warn">
    <b>找到看起來相似的計劃，是同一個嗎？</b>
    <ul>${similar.map((c) => html`<li><a href="/p/${c.slug}" target="_blank" rel="noopener">${c.name}</a>${c.company ? html`<span class="muted">（${c.company}）</span>` : ''}</li>`)}</ul>
    如果是同一個，請直接進去使用（去年有人開過就直接「複製成新一屆」）。確定不同才勾選下方確認後建立。
    <label class="check"><input type="checkbox" name="confirm_unique" value="1" form="new-program"> 我已看過，這是不同的計劃</label>
  </div>` : ''}
  <form method="post" class="form" id="new-program">
    ${csrfField(res)}
    <label>計劃名稱 <input name="name" id="np-name" required maxlength="40" value="${v.name || ''}" autocomplete="off" placeholder="例如：○○公司暑期實習、○○基金會獎學金"></label>
    <div id="np-suggest" class="suggest" hidden></div>
    <label>類型
      <select name="kind">${KINDS.map((k) => html`<option ${k === v.kind ? 'selected' : ''}>${k}</option>`)}</select></label>
    <label>主辦單位（選填）<input name="company" maxlength="30" value="${v.company || ''}" placeholder="公司、學校或基金會名稱"></label>
    <label>別名／常見叫法 <small class="muted">用逗號或換行分隔。搜尋這些詞都會找到這個計劃，避免同學各寫各的</small>
      <textarea name="aliases" rows="3" maxlength="300">${v.aliases || ''}</textarea></label>
    <label>簡介（選填）<textarea name="description" rows="3" maxlength="300">${v.description || ''}</textarea></label>
    <label>官方網址（選填）<input name="url" type="url" maxlength="200" value="${v.url || ''}" placeholder="https://"></label>
    <button class="btn" type="submit">建立計劃</button>
  </form>
</section>`;

router.get('/programs/new', requireLogin, (req, res) => {
  res.page('建立新計劃', newForm(res, { name: cleanLine(req.query.name, 40) }));
});

// 輸入名稱時即時提示既有計劃（前端 debounce 呼叫）
router.get('/api/programs/search', (req, res) => {
  const q = String(req.query.q ?? '').slice(0, 60);
  res.json(searchPrograms(q).slice(0, 5).map((p) => ({ slug: p.slug, name: p.name, company: p.company })));
});

router.post('/programs/new', requireLogin, writeLimit, (req, res) => {
  const v = {
    name: cleanLine(req.body.name, 40), company: cleanLine(req.body.company, 30), kind: req.body.kind,
    aliases: cleanText(req.body.aliases, 300), description: cleanText(req.body.description, 300),
    url: cleanLine(req.body.url, 200),
  };
  if (v.name.length < 2) return res.status(400).page('建立新計劃', newForm(res, v));
  if (v.url && !/^https?:\/\//i.test(v.url)) v.url = '';
  const r = createProgram({
    userId: req.user.id, name: v.name, company: v.company, kind: v.kind, description: v.description,
    officialUrl: v.url, aliases: parseAliases(v.aliases), confirmedUnique: req.body.confirm_unique === '1',
  });
  if (r.conflicts) return res.status(409).page('建立新計劃', newForm(res, v, { conflicts: r.conflicts }));
  if (r.similar) return res.status(409).page('建立新計劃', newForm(res, v, { similar: r.similar }));
  flash(res, 'ok', `計劃已建立，+${SEEDS.createProgram} 🌱！接著開第一屆就能開始回報。`);
  res.redirect(`/p/${r.program.slug}`);
});

// 入口：有屆次就直接進到最新一屆，沒有就顯示開第一屆
router.get('/p/:slug', (req, res) => {
  const p = getProgramBySlug(req.params.slug);
  if (!p) return res.status(404).page('找不到計劃', html`<div class="empty"><p>找不到這個計劃。</p><a class="btn" href="/">回首頁</a></div>`);
  const c = latestCycle(p.id);
  if (c) return res.redirect(`/p/${p.slug}/c/${c.id}`);
  res.page(p.name, html`
    <section class="narrow">
      <h1 class="h1">${p.name}</h1>
      <p class="chips"><span class="pill">${p.kind}</span>${aliasesOf(p.id).map((a) => html`<span class="chip">${a}</span>`)}</p>
      <div class="empty">
        <p>這個計劃還沒有任何一屆。</p>
        ${res.locals.user ? cycleForm(res, p) : html`<a class="btn" href="/login?next=${encodeURIComponent(req.originalUrl)}">登入後開第一屆</a>`}
      </div>
    </section>`);
});

// 開新一屆。有既有屆次時預設「複製」最新一屆（沿用組別、串起歷屆）；也可選擇複製哪一屆
export function cycleForm(res, p, { forkFrom = null } = {}) {
  const y = new Date().getFullYear();
  const existing = cyclesOf(p.id);
  const src = forkFrom || existing[0] || null;
  return html`<form method="post" action="/p/${p.slug}/cycles" class="form form-inline">
    ${csrfField(res)}
    <label>年度 <select name="year">${[y + 1, y, y - 1].map((v) => html`<option value="${v}" ${(src ? src.year + 1 : y) === v ? 'selected' : ''}>${v}</option>`)}</select></label>
    <label>梯次 <input name="term" list="terms" required maxlength="12" value="${src ? src.term : ''}" placeholder="暑期、學期、第一梯…"></label>
    <datalist id="terms">${TERM_SUGGESTIONS.map((t) => html`<option value="${t}">`)}</datalist>
    ${existing.length ? html`<label>複製自
      <select name="fork_from"><option value="">不複製（空白開始）</option>
        ${existing.map((c) => html`<option value="${c.id}" ${src && src.id === c.id ? 'selected' : ''}>${cycleLabel(c)}</option>`)}
      </select></label>` : html`<fieldset class="radios"><legend>有分組別／職缺嗎？</legend>
      <label><input type="radio" name="has_tracks" value="1" checked> 有（回報時必須選）</label>
      <label><input type="radio" name="has_tracks" value="0"> 沒有</label>
    </fieldset>`}
    <button class="btn" type="submit">${existing.length ? '複製成新一屆' : '開第一屆'}</button>
  </form>`;
}

router.post('/p/:slug/cycles', requireLogin, writeLimit, (req, res) => {
  const p = getProgramBySlug(req.params.slug);
  if (!p) return res.status(404).type('text').send('not found');
  const year = Number(req.body.year);
  const term = cleanLine(req.body.term, 12);
  const thisYear = new Date().getFullYear();
  if (!term || !Number.isInteger(year) || year < thisYear - 5 || year > thisYear + 2) {
    flash(res, 'error', '年度或梯次不正確');
    return res.redirect(`/p/${p.slug}`);
  }
  const r = createCycle({
    programId: p.id, userId: req.user.id, year, term,
    hasTracks: req.body.has_tracks !== '0', forkFrom: Number(req.body.fork_from) || null,
  });
  if (r.error) { flash(res, 'error', r.error); return res.redirect(`/p/${p.slug}`); }
  if (r.existing) {
    flash(res, 'info', '這一屆已經存在，已帶你過去。');
    return res.redirect(`/p/${p.slug}/c/${r.existing}`);
  }
  flash(res, 'ok', `已建立 ${cycleLabel(r.cycle)}，+${SEEDS.forkCycle} 🌱。成為第一個回報的人可得額外種子！`);
  res.redirect(`/p/${p.slug}/c/${r.cycle.id}`);
});

router.post('/p/:slug/alias', requireLogin, writeLimit, (req, res) => {
  const p = getProgramBySlug(req.params.slug);
  if (!p) return res.status(404).type('text').send('not found');
  const back = req.get('referer') ? new URL(req.get('referer'), 'http://x').pathname : `/p/${p.slug}`;
  const r = addAlias(p.id, cleanLine(req.body.alias, 40));
  if (r.conflicts) {
    const c = r.conflicts[0];
    flash(res, 'error', c.slug === p.slug ? '這個別名已經存在' : `「${c.input}」已屬於另一個計劃：${c.name}`);
  } else if (r.error) flash(res, 'error', r.error);
  else flash(res, 'ok', '別名已加入，搜尋這個詞也會找到此計劃。');
  res.redirect(back.startsWith('/') ? back : '/');
});
