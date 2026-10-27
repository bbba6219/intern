import { Router } from 'express';
import { db, tx, now } from '../db.js';
import { html, raw } from '../html.js';
import { csrfField } from '../layout.js';
import { SEEDS } from '../config.js';
import {
  cleanLine, cleanText, isDateStr, todayTaipei, dayNum, fromDayNum, fmtMD, relTime,
} from '../util.js';
import { requireLogin, flash, rateLimit } from '../auth.js';
import { addLedger, balanceOf } from '../seeds.js';
import {
  getCycle, getProgram, cyclesOf, aliasesOf, tracksOf, ensureTrack, cycleLabel, lineageOf, payCreatorBonuses,
} from '../programs.js';
import { STAGES, STAGE_BY_KEY, buildTimeline, previousCycleMedians, programHistory } from '../timeline.js';
import { cycleForm } from './programs.js';

export const router = Router();
const actionLimit = rateLimit({ windowMs: 60 * 1000, max: 30, key: (req) => `act:${req.user?.id ?? req.ip}` });
const DAY = 86400000;

// ───────────── 規則判斷 ─────────────
const isContributor = (userId, cycleId) =>
  !!db.prepare('SELECT 1 FROM reports WHERE user_id = ? AND cycle_id = ? AND hidden = 0 LIMIT 1').get(userId, cycleId);
const hasUnlock = (userId, cycleId) =>
  !!db.prepare('SELECT 1 FROM unlocks WHERE user_id = ? AND cycle_id = ?').get(userId, cycleId);
const canViewDetails = (user, cycleId) => !!user && (isContributor(user.id, cycleId) || hasUnlock(user.id, cycleId));

// 逾期結算：有回答→懸賞給最早的回答者；沒有→退回提問者。每次載入問答與定時器都會呼叫
export function sweepQuestions() {
  const cutoff = now() - SEEDS.questionTtlDays * DAY;
  const old = db.prepare(`SELECT * FROM questions WHERE status = 'open' AND created_at < ?`).all(cutoff);
  for (const q of old) {
    tx(() => {
      const cur = db.prepare('SELECT status FROM questions WHERE id = ?').get(q.id);
      if (cur.status !== 'open') return;
      const a = db.prepare('SELECT * FROM answers WHERE question_id = ? ORDER BY id LIMIT 1').get(q.id);
      if (a) {
        addLedger(a.user_id, q.bounty, 'answer_auto', q.id);
        db.prepare(`UPDATE questions SET status = 'auto_paid', accepted_answer_id = ?, resolved_at = ? WHERE id = ?`).run(a.id, now(), q.id);
      } else {
        addLedger(q.user_id, q.bounty, 'ask_refund', q.id);
        db.prepare(`UPDATE questions SET status = 'refunded', resolved_at = ? WHERE id = ?`).run(now(), q.id);
      }
    });
  }
}

// ───────────── 檢視 ─────────────
const STATUS_TEXT = { open: '等待回答', solved: '已採納', auto_paid: '已自動發放', refunded: '無人回答・已退回' };

function axisFor(tl) {
  if (!tl.min) return null;
  let start = dayNum(tl.min) - 2;
  let end = dayNum(tl.max) + 2;
  if (end - start < 14) end = start + 14;
  const span = end - start;
  const step = span <= 30 ? 5 : span <= 90 ? 15 : 30;
  const ticks = [];
  for (let d = start; d <= end; d += step) ticks.push({ d, pct: ((d - start) / span) * 100 });
  return { start, span, ticks, pos: (date) => ((dayNum(date) - start) / span) * 100 };
}

function timelineView(cycle, tl, prev, hasTracks) {
  if (!tl.total) {
    return html`<div class="empty">
      <p><b>還沒有人回報這一屆的進度。</b></p>
      <p class="muted">成為第一個！每個階段第一位回報的人有搶先加碼 +${SEEDS.firstInTrackStage} 🌱。</p>
    </div>`;
  }
  const ax = axisFor(tl);
  return html`<div class="tl" role="list">
    <div class="tl-axis" aria-hidden="true">${ax.ticks.map((t) => html`<span style="left:${t.pct.toFixed(2)}%">${fmtMD(fromDayNum(t.d))}</span>`)}</div>
    ${tl.stages.map((s) => {
      const p = prev?.stages?.[s.key];
      if (!s.n) {
        return html`<div class="tl-row tl-empty" role="listitem">
          <div class="tl-label"><b>${s.label}</b><span class="muted small">尚無回報</span></div>
          <div class="tl-track"></div><div class="tl-dates muted small">${prev && p ? html`上一屆中位 ${fmtMD(p.median)}` : ''}</div></div>`;
      }
      const left = ax.pos(s.min);
      const width = Math.max(ax.pos(s.max) - left, 1.2);
      return html`<div class="tl-row tone-${s.tone}" role="listitem">
        <div class="tl-label"><b>${s.label}</b><span class="muted small">${s.n} 則回報${s.n < 3 ? '・樣本少' : ''}</span></div>
        <div class="tl-track">
          ${ax.ticks.map((t) => html`<i class="tl-grid" style="left:${t.pct.toFixed(2)}%"></i>`)}
          <div class="tl-range" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></div>
          <div class="tl-median" style="left:${ax.pos(s.median).toFixed(2)}%" title="中位數 ${fmtMD(s.median)}"></div>
        </div>
        <div class="tl-dates"><b>${s.min === s.max ? fmtMD(s.min) : `${fmtMD(s.min)} – ${fmtMD(s.max)}`}</b>
          <span class="muted small">中位 ${fmtMD(s.median)}${prev && p ? ` ・ 上一屆 ${fmtMD(p.median)}（${p.n}）` : ''}</span></div>
      </div>`;
    })}
  </div>
  <p class="muted small">長條＝最早到最晚，圓點＝中位數。${prev ? `「上一屆」指 ${cycleLabel(prev.cycle)}。` : ''}</p>`;
}

function matrixView(cycle, tl, tracks, slug) {
  const cols = STAGES.filter((s) => tl.stages.find((x) => x.key === s.key).n > 0);
  if (!tracks.length || !cols.length) return '';
  return html`<h3 class="mt">各組別對照</h3>
  <div class="table-wrap"><table class="table matrix">
    <thead><tr><th>組別</th>${cols.map((c) => html`<th>${c.label.replace('收到', '').replace('通知', '')}</th>`)}</tr></thead>
    <tbody>${tracks.map((t) => html`<tr>
      <th><a href="/p/${slug}/c/${cycle.id}?track=${t.id}">${t.name}</a></th>
      ${cols.map((c) => {
        const m = tl.matrix(t.id, c.key);
        return m ? html`<td><b>${fmtMD(m.median)}</b> <span class="muted small">×${m.n}</span></td>` : html`<td class="muted">–</td>`;
      })}
    </tr>`)}</tbody></table></div>`;
}

function historyView(programId, currentId, slug) {
  const hist = programHistory(programId).filter((h) => Object.keys(h.stages).length || h.cycle.id === currentId);
  if (hist.length < 2) return '';
  const cols = STAGES.filter((s) => hist.some((h) => h.stages[s.key]));
  if (!cols.length) return '';
  return html`<h3 class="mt">歷屆對照 <small class="muted">各階段中位日期</small></h3>
  <div class="table-wrap"><table class="table matrix">
    <thead><tr><th>屆次</th>${cols.map((c) => html`<th>${c.label.replace('收到', '').replace('通知', '')}</th>`)}</tr></thead>
    <tbody>${hist.map((h) => html`<tr class="${h.cycle.id === currentId ? 'cur' : ''}">
      <th><a href="/p/${slug}/c/${h.cycle.id}">${cycleLabel(h.cycle)}</a></th>
      ${cols.map((c) => {
        const m = h.stages[c.key];
        return m ? html`<td><b>${fmtMD(m.median)}</b> <span class="muted small">×${m.n}</span></td>` : html`<td class="muted">–</td>`;
      })}
    </tr>`)}</tbody></table></div>`;
}

function reportsView(res, cycle, tracks, filter, user, slug) {
  const total = db.prepare('SELECT COUNT(*) c FROM reports WHERE cycle_id = ? AND hidden = 0').get(cycle.id).c;
  if (!canViewDetails(user, cycle.id)) {
    return html`<div class="locked">
      <h3>🔒 完整回報明細</h3>
      <p>這一屆有 <b>${total}</b> 則回報，包含每個人的日期與備註。</p>
      <p class="muted">在這一屆回報過進度的人免費查看；也可以用 ${SEEDS.unlockCost} 🌱 永久解鎖。上面的時間線與各組別對照不需要解鎖。</p>
      ${user
        ? html`<form method="post" action="/c/${cycle.id}/unlock">${csrfField(res)}
            <button class="btn" ${user.seeds < SEEDS.unlockCost ? 'disabled' : ''}>花 ${SEEDS.unlockCost} 🌱 解鎖</button>
            ${user.seeds < SEEDS.unlockCost ? html`<span class="muted small"> 種子不足，先回報進度吧</span>` : ''}</form>`
        : html`<a class="btn" href="/login?next=${encodeURIComponent(`/p/${slug}/c/${cycle.id}?tab=reports`)}">登入</a>`}
    </div>`;
  }
  const where = ['r.cycle_id = ?', 'r.hidden = 0'];
  const args = [cycle.id];
  if (filter.track) { where.push('r.track_id = ?'); args.push(filter.track); }
  if (filter.stage && STAGE_BY_KEY[filter.stage]) { where.push('r.stage = ?'); args.push(filter.stage); }
  const rows = db.prepare(
    `SELECT r.*, u.nickname, t.name tname,
       EXISTS(SELECT 1 FROM confirmations x WHERE x.report_id = r.id AND x.user_id = ?) AS i_confirmed
     FROM reports r JOIN users u ON u.id = r.user_id LEFT JOIN tracks t ON t.id = r.track_id
     WHERE ${where.join(' AND ')} ORDER BY r.event_date DESC, r.id DESC LIMIT 100`
  ).all(user.id, ...args);
  return html`
    <form class="filters" method="get">
      <input type="hidden" name="tab" value="reports">
      ${cycle.has_tracks ? html`<select name="track" onchange="this.form.submit()"><option value="">全部組別</option>
        ${tracks.map((t) => html`<option value="${t.id}" ${filter.track === t.id ? 'selected' : ''}>${t.name}</option>`)}</select>` : ''}
      <select name="stage" onchange="this.form.submit()"><option value="">全部階段</option>
        ${STAGES.map((s) => html`<option value="${s.key}" ${filter.stage === s.key ? 'selected' : ''}>${s.label}</option>`)}</select>
    </form>
    ${rows.length ? html`<ul class="reports">${rows.map((r) => html`<li id="r${r.id}">
      <div class="r-main">
        <span class="stage-dot tone-${STAGE_BY_KEY[r.stage].tone}"></span>
        <b>${STAGE_BY_KEY[r.stage].label}</b>
        <span class="r-date">${r.event_date}</span>
        ${r.tname ? html`<span class="pill">${r.tname}</span>` : ''}
      </div>
      ${r.note ? html`<p class="r-note">${r.note}</p>` : ''}
      <div class="r-meta muted small">${r.nickname}・${relTime(r.created_at)}
        ${r.confirm_count ? html`・<span class="plus">${r.confirm_count} 人也一樣</span>` : ''}
        ${r.user_id !== user.id ? html`
          <form method="post" action="/r/${r.id}/confirm" class="inline">${csrfField(res)}<button class="linkbtn" ${r.i_confirmed ? 'disabled' : ''}>${r.i_confirmed ? '已確認' : '我也一樣'}</button></form>
          <form method="post" action="/r/${r.id}/flag" class="inline" onsubmit="return confirm('確定要舉報這則回報嗎？')">${csrfField(res)}<button class="linkbtn">舉報</button></form>` : ''}
      </div>
    </li>`)}</ul>` : html`<p class="muted">沒有符合條件的回報。</p>`}`;
}

function qaView(res, cycle, tracks, user, slug) {
  sweepQuestions();
  const qs = db.prepare(
    `SELECT q.*, u.nickname, t.name tname FROM questions q JOIN users u ON u.id = q.user_id
     LEFT JOIN tracks t ON t.id = q.track_id WHERE q.cycle_id = ? ORDER BY (q.status = 'open') DESC, q.id DESC LIMIT 50`
  ).all(cycle.id);
  const contributor = user && isContributor(user.id, cycle.id);
  const answersOf = db.prepare(
    `SELECT a.*, u.nickname,
       (SELECT group_concat(DISTINCT t.name) FROM reports r JOIN tracks t ON t.id = r.track_id
         WHERE r.user_id = a.user_id AND r.cycle_id = ? AND r.hidden = 0) AS tracks
     FROM answers a JOIN users u ON u.id = a.user_id WHERE a.question_id = ? ORDER BY a.id`
  );
  return html`
    <div class="ask card">
      <h3>提問</h3>
      ${user ? html`<form method="post" action="/c/${cycle.id}/ask" class="form">
        ${csrfField(res)}
        ${cycle.has_tracks ? html`<label>你問的是哪一組／職缺？
          <select name="track" required><option value="">請選擇</option>${tracks.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select></label>` : ''}
        <label>相關階段（選填）
          <select name="stage"><option value="">不指定</option>${STAGES.map((s) => html`<option value="${s.key}">${s.label}</option>`)}</select></label>
        <label>問題 <textarea name="body" rows="3" required minlength="8" maxlength="500" placeholder="寫清楚一點，例如：有人在 ○○ 組收到面試通知嗎？是寄信還是電話？"></textarea></label>
        <label>懸賞 🌱 <input type="number" name="bounty" min="${SEEDS.askMin}" max="${SEEDS.askMax}" value="${SEEDS.askMin}" required>
          <small class="muted">先託管，採納才付給回答者；${SEEDS.questionTtlDays} 天沒人答會退回。你目前有 ${user.seeds} 🌱</small></label>
        <button class="btn" ${user.seeds < SEEDS.askMin ? 'disabled' : ''}>送出提問</button>
      </form>` : html`<p class="muted">登入後可以提問。<a href="/login?next=${encodeURIComponent(`/p/${slug}/c/${cycle.id}?tab=qa`)}">登入</a></p>`}
    </div>
    ${qs.length ? qs.map((q) => {
      const answers = answersOf.all(cycle.id, q.id);
      return html`<article class="card q" id="q${q.id}">
        <div class="q-head"><span class="pill status-${q.status}">${STATUS_TEXT[q.status]}</span>
          <span class="bounty">🌱 ${q.bounty}</span>${q.tname ? html`<span class="pill">${q.tname}</span>` : ''}
          ${q.stage ? html`<span class="pill pill-muted">${STAGE_BY_KEY[q.stage]?.label}</span>` : ''}</div>
        <p class="q-body">${q.body}</p>
        <p class="muted small">${q.nickname}・${relTime(q.created_at)}</p>
        ${answers.length ? html`<ul class="answers">${answers.map((a) => html`<li class="${q.accepted_answer_id === a.id ? 'accepted' : ''}">
          <p>${a.body}</p>
          <p class="muted small">${a.nickname}${a.tracks ? `（已回報：${a.tracks}）` : ''}・${relTime(a.created_at)}
            ${q.accepted_answer_id === a.id ? html` <b class="plus">✓ 已採納</b>` : ''}
            ${user && user.id === q.user_id && q.status === 'open' ? html`
              <form method="post" action="/q/${q.id}/accept" class="inline">${csrfField(res)}<input type="hidden" name="answer" value="${a.id}">
              <button class="linkbtn">採納並付 🌱${q.bounty}</button></form>` : ''}</p>
        </li>`)}</ul>` : ''}
        ${q.status === 'open' && user && user.id !== q.user_id && !answers.some((a) => a.user_id === user.id)
          ? (contributor ? html`<form method="post" action="/q/${q.id}/answer" class="form answer-form">${csrfField(res)}
              <textarea name="body" rows="2" required minlength="8" maxlength="500" placeholder="分享你的經驗，被採納可得 ${q.bounty} 🌱"></textarea>
              <button class="btn btn-sm">回答</button></form>`
            : html`<p class="muted small">在這一屆回報過進度的人才能回答（也能因此賺 ${q.bounty} 🌱）。</p>`) : ''}
      </article>`;
    }) : html`<p class="muted">還沒有人提問。</p>`}`;
}

function sidebar(res, cycle, program, tracks, user, slug) {
  const mine = user ? db.prepare(
    `SELECT r.*, t.name tname FROM reports r LEFT JOIN tracks t ON t.id = r.track_id
     WHERE r.user_id = ? AND r.cycle_id = ? ORDER BY r.event_date DESC`
  ).all(user.id, cycle.id) : [];
  const today = todayTaipei();
  return html`<aside class="side">
    <div class="card">
      <h3>回報我的進度 <span class="pill pill-good">+${SEEDS.report} 🌱</span></h3>
      ${user ? html`<form method="post" action="/c/${cycle.id}/report" class="form">
        ${csrfField(res)}
        <label>階段
          <select name="stage" required>${STAGES.map((s) => html`<option value="${s.key}">${s.label}</option>`)}</select></label>
        ${cycle.has_tracks ? html`<label>投遞的組別／職缺 <small class="muted">必填，讓大家知道這是哪一組</small>
          <select name="track" id="track-select">
            <option value="">請選擇</option>${tracks.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select></label>
          <label>找不到？新增組別 <input name="new_track" maxlength="30" placeholder="輸入完整名稱，例如：資訊工程組"></label>` : ''}
        <label>日期 <small class="muted">收到通知的那一天</small>
          <input type="date" name="date" value="${today}" max="${today}" required></label>
        <label>備註（選填）<input name="note" maxlength="80" placeholder="例如：Email 通知、面試日 11/3"></label>
        <button class="btn">送出回報</button>
      </form>
      ${mine.length ? html`<div class="mine"><h4>我已回報</h4><ul>${mine.map((r) => html`<li>${STAGE_BY_KEY[r.stage].label}${r.tname ? `・${r.tname}` : ''} <span class="muted">${fmtMD(r.event_date)}</span>${r.hidden ? ' （已隱藏）' : ''}</li>`)}</ul>
        <p class="muted small">同階段同組別重新送出會更新日期，不會重複領種子。</p></div>` : ''}`
      : html`<p class="muted">登入後回報，免費解鎖完整明細，還能提問與回答。</p>
        <a class="btn" href="/login?next=${encodeURIComponent(`/p/${slug}/c/${cycle.id}`)}">登入</a>
        <a class="btn btn-ghost" href="/signup?next=${encodeURIComponent(`/p/${slug}/c/${cycle.id}`)}">註冊 +${SEEDS.signup} 🌱</a>`}
    </div>
  </aside>`;
}

router.get('/p/:slug/c/:id', (req, res) => {
  const cycle = getCycle(Number(req.params.id));
  const program = cycle && getProgram(cycle.program_id);
  if (!cycle) return res.status(404).page('找不到', html`<div class="empty"><p>找不到這一屆。</p><a class="btn" href="/">回首頁</a></div>`);
  if (program.slug !== req.params.slug) return res.redirect(`/p/${program.slug}/c/${cycle.id}`);

  const user = req.user;
  const tab = ['timeline', 'reports', 'qa'].includes(req.query.tab) ? req.query.tab : 'timeline';
  const tracks = tracksOf(cycle.id);
  const trackId = Number(req.query.track) || null;
  const activeTrack = trackId ? tracks.find((t) => t.id === trackId) : null;
  const tl = buildTimeline(cycle.id, activeTrack ? activeTrack.id : null);
  const prev = previousCycleMedians(cycle, activeTrack?.name);
  const cycles = cyclesOf(program.id);
  const ancestors = lineageOf(cycle.id);
  const forks = db.prepare('SELECT * FROM cycles WHERE forked_from = ? ORDER BY year').all(cycle.id);
  const following = user && db.prepare('SELECT 1 FROM follows WHERE user_id = ? AND cycle_id = ?').get(user.id, cycle.id);
  const nReports = db.prepare('SELECT COUNT(*) c FROM reports WHERE cycle_id = ? AND hidden = 0').get(cycle.id).c;
  const last = db.prepare('SELECT MAX(created_at) t FROM reports WHERE cycle_id = ? AND hidden = 0').get(cycle.id).t;
  const base = `/p/${program.slug}/c/${cycle.id}`;
  const creator = cycle.created_by && db.prepare('SELECT nickname FROM users WHERE id = ?').get(cycle.created_by);

  let content;
  if (tab === 'reports') {
    content = reportsView(res, cycle, tracks, { track: trackId, stage: String(req.query.stage || '') }, user, program.slug);
  } else if (tab === 'qa') {
    content = qaView(res, cycle, tracks, user, program.slug);
  } else {
    content = html`
      ${cycle.has_tracks && tracks.length ? html`<nav class="tabs tabs-wrap" aria-label="組別">
        <a href="${base}" class="${!activeTrack ? 'on' : ''}">全部組別</a>
        ${tracks.map((t) => html`<a href="${base}?track=${t.id}" class="${activeTrack?.id === t.id ? 'on' : ''}">${t.name}</a>`)}
      </nav>` : ''}
      ${timelineView(cycle, tl, prev, cycle.has_tracks)}
      ${!activeTrack ? matrixView(cycle, tl, tracks, program.slug) : ''}
      ${historyView(program.id, cycle.id, program.slug)}`;
  }

  // 看過就算已讀
  if (user && following) db.prepare('UPDATE follows SET last_seen = ? WHERE user_id = ? AND cycle_id = ?').run(now(), user.id, cycle.id);

  res.page(`${program.name} ${cycleLabel(cycle)}`, html`
    <section class="chead">
      <p class="crumb"><a href="/">首頁</a> › <span class="pill">${program.kind}</span>${program.company ? html` ${program.company}` : ''}</p>
      <div class="chead-row">
        <h1 class="h1">${program.name}</h1>
        ${user ? html`<form method="post" action="/c/${cycle.id}/follow">${csrfField(res)}
          <button class="btn ${following ? 'btn-ghost' : ''}">${following ? '✓ 追蹤中' : '＋ 追蹤新進度'}</button></form>`
          : html`<a class="btn" href="/login?next=${encodeURIComponent(base)}">＋ 追蹤新進度</a>`}
      </div>
      <p class="chips">${aliasesOf(program.id).filter((a) => a !== program.name).map((a) => html`<span class="chip">${a}</span>`)}
        ${user ? html`<details class="mini"><summary>補充別名</summary>
          <form method="post" action="/p/${program.slug}/alias" class="form form-inline">${csrfField(res)}
            <input name="alias" maxlength="40" required placeholder="同學常用的另一種叫法"><button class="btn btn-sm">加入</button></form></details>` : ''}</p>
      ${program.description ? html`<p class="muted">${program.description}</p>` : ''}
      ${program.official_url ? html`<p class="small"><a href="${program.official_url}" target="_blank" rel="noopener nofollow">官方網站 ↗</a></p>` : ''}

      <div class="cycles">
        ${cycles.map((c) => html`<a href="/p/${program.slug}/c/${c.id}" class="cy ${c.id === cycle.id ? 'on' : ''}">${cycleLabel(c)}</a>`)}
        ${user ? html`<details class="mini fork"><summary>＋ 複製成新一屆</summary>${cycleForm(res, program, { forkFrom: cycle })}</details>` : ''}
      </div>
      ${ancestors.length || forks.length ? html`<p class="lineage small muted">
        ${ancestors.length ? html`複製自 ${[...ancestors].reverse().map((a) => html`<a href="/p/${program.slug}/c/${a.id}">${cycleLabel(a)}</a>`).reduce((acc, x) => acc.length ? [...acc, ' → ', x] : [x], [])} → <b>${cycleLabel(cycle)}</b>` : ''}
        ${forks.length ? html`${ancestors.length ? '・' : ''}已被複製為 ${forks.map((f) => html`<a href="/p/${program.slug}/c/${f.id}">${cycleLabel(f)}</a> `)}` : ''}
      </p>` : ''}
      <div class="stats">
        <div><b>${nReports}</b><span>則回報</span></div>
        <div><b>${cycle.has_tracks ? tracks.length : '–'}</b><span>個組別</span></div>
        <div><b>${last ? relTime(last) : '–'}</b><span>最近更新</span></div>
        ${creator ? html`<div><b>${creator.nickname}</b><span>開這一屆</span></div>` : ''}
      </div>
    </section>

    <nav class="tabs" aria-label="內容">
      <a href="${base}" class="${tab === 'timeline' ? 'on' : ''}">時間線</a>
      <a href="${base}?tab=reports" class="${tab === 'reports' ? 'on' : ''}">回報明細</a>
      <a href="${base}?tab=qa" class="${tab === 'qa' ? 'on' : ''}">問答</a>
    </nav>
    <div class="layout">
      <div class="main">${content}</div>
      ${sidebar(res, cycle, program, tracks, user, program.slug)}
    </div>`,
  { desc: `${program.name} ${cycleLabel(cycle)} 的測驗、面試、錄取通知時間線與同學回報。` });
});

router.get('/api/cycles/:id/timeline', (req, res) => {
  const cycle = getCycle(Number(req.params.id));
  if (!cycle) return res.status(404).json({ error: 'not found' });
  const tl = buildTimeline(cycle.id, Number(req.query.track) || null);
  res.json({ cycle: cycleLabel(cycle), total: tl.total, stages: tl.stages.map(({ key, label, n, min, median, max }) => ({ key, label, n, min, median, max })) });
});

// ───────────── 動作 ─────────────
const back = (req, cycle, extra = '') => {
  const program = getProgram(cycle.program_id);
  return `/p/${program.slug}/c/${cycle.id}${extra}`;
};
const loadCycle = (req, res) => {
  const c = getCycle(Number(req.params.id));
  if (!c) res.status(404).type('text').send('not found');
  return c;
};

router.post('/c/:id/follow', requireLogin, actionLimit, (req, res) => {
  const cycle = loadCycle(req, res); if (!cycle) return;
  const has = db.prepare('SELECT 1 FROM follows WHERE user_id = ? AND cycle_id = ?').get(req.user.id, cycle.id);
  if (has) db.prepare('DELETE FROM follows WHERE user_id = ? AND cycle_id = ?').run(req.user.id, cycle.id);
  else db.prepare('INSERT INTO follows (user_id, cycle_id, last_seen) VALUES (?,?,?)').run(req.user.id, cycle.id, now());
  flash(res, 'ok', has ? '已取消追蹤' : '已追蹤，有新進度會在「我的」顯示數量，不用再留言卡位了');
  res.redirect(back(req, cycle));
});

router.post('/c/:id/report', requireLogin, actionLimit, (req, res) => {
  const cycle = loadCycle(req, res); if (!cycle) return;
  const fail = (m) => { flash(res, 'error', m); res.redirect(back(req, cycle)); };
  const stage = String(req.body.stage || '');
  if (!STAGE_BY_KEY[stage]) return fail('請選擇階段');
  const date = String(req.body.date || '');
  const today = todayTaipei();
  if (!isDateStr(date) || date > today || dayNum(date) < dayNum(today) - 500) return fail('日期不正確（不能是未來，也不能太久以前）');
  const note = cleanLine(req.body.note, 80);
  const recent = db.prepare('SELECT COUNT(*) c FROM reports WHERE user_id = ? AND created_at > ?').get(req.user.id, now() - DAY).c;
  if (recent >= SEEDS.maxReportsPerDay) return fail('今天回報太多次了，明天再來');

  let trackId = 0;
  if (cycle.has_tracks) {
    const newName = cleanLine(req.body.new_track, 30);
    if (newName) trackId = ensureTrack(cycle.id, newName);
    else {
      const t = db.prepare('SELECT id FROM tracks WHERE id = ? AND cycle_id = ?').get(Number(req.body.track) || 0, cycle.id);
      trackId = t?.id || 0;
    }
    if (!trackId) return fail('請選擇你投遞的組別（找不到就在下方新增）');
  }

  const result = tx(() => {
    const existing = db.prepare('SELECT id FROM reports WHERE user_id = ? AND cycle_id = ? AND track_id = ? AND stage = ?')
      .get(req.user.id, cycle.id, trackId, stage);
    if (existing) {
      db.prepare('UPDATE reports SET event_date = ?, note = ?, updated_at = ? WHERE id = ?').run(date, note, now(), existing.id);
      return { updated: true };
    }
    const alreadyRewarded = db.prepare('SELECT 1 FROM reports WHERE user_id = ? AND cycle_id = ? AND stage = ? AND hidden = 0').get(req.user.id, cycle.id, stage);
    const someoneBefore = db.prepare('SELECT 1 FROM reports WHERE cycle_id = ? AND track_id = ? AND stage = ? AND hidden = 0').get(cycle.id, trackId, stage);
    const info = db.prepare(
      `INSERT INTO reports (user_id, cycle_id, track_id, stage, event_date, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`
    ).run(req.user.id, cycle.id, trackId, stage, date, note, now(), now());
    const rid = Number(info.lastInsertRowid);
    let reward = 0; let bonus = 0;
    if (!alreadyRewarded) {
      reward = SEEDS.report;
      addLedger(req.user.id, reward, 'report', rid);
      if (!someoneBefore) { bonus = SEEDS.firstInTrackStage; addLedger(req.user.id, bonus, 'first_bonus', rid); }
    }
    db.prepare('UPDATE reports SET reward = ? WHERE id = ?').run(reward + bonus, rid);
    payCreatorBonuses(cycle, req.user.id);
    return { reward, bonus };
  });

  if (result.updated) flash(res, 'ok', '已更新你的回報');
  else if (result.reward) flash(res, 'ok', `已記錄！+${result.reward} 🌱${result.bonus ? `，搶先回報再 +${result.bonus} 🌱` : ''}`);
  else flash(res, 'ok', '已記錄（這個階段你已領過種子，換組別回報不重複計）');
  res.redirect(back(req, cycle));
});

router.post('/r/:id/confirm', requireLogin, actionLimit, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ? AND hidden = 0').get(Number(req.params.id));
  if (!r) return res.status(404).type('text').send('not found');
  const cycle = getCycle(r.cycle_id);
  if (r.user_id === req.user.id) { flash(res, 'error', '不能確認自己的回報'); return res.redirect(back(req, cycle, '?tab=reports')); }
  if (!canViewDetails(req.user, cycle.id)) { flash(res, 'error', '請先解鎖這一屆的明細'); return res.redirect(back(req, cycle)); }
  const msg = tx(() => {
    if (db.prepare('SELECT 1 FROM confirmations WHERE report_id = ? AND user_id = ?').get(r.id, req.user.id)) return '你已經確認過了';
    db.prepare('INSERT INTO confirmations (report_id, user_id, created_at) VALUES (?,?,?)').run(r.id, req.user.id, now());
    const n = r.confirm_count + 1;
    db.prepare('UPDATE reports SET confirm_count = ? WHERE id = ?').run(n, r.id);
    if (n <= SEEDS.confirmReceivedCap) addLedger(r.user_id, SEEDS.confirmReceived, 'confirm_received', r.id);
    const today = db.prepare(`SELECT COUNT(*) c FROM seed_ledger WHERE user_id = ? AND reason = 'confirm_given' AND created_at > ?`).get(req.user.id, now() - DAY).c;
    if (today < SEEDS.confirmGivenDailyCap) { addLedger(req.user.id, SEEDS.confirmGiven, 'confirm_given', r.id); return `已確認，+${SEEDS.confirmGiven} 🌱`; }
    return '已確認';
  });
  flash(res, 'ok', msg);
  res.redirect(back(req, cycle, `?tab=reports#r${r.id}`));
});

router.post('/r/:id/flag', requireLogin, actionLimit, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ? AND hidden = 0').get(Number(req.params.id));
  if (!r) return res.status(404).type('text').send('not found');
  const cycle = getCycle(r.cycle_id);
  if (r.user_id === req.user.id) { flash(res, 'error', '不能舉報自己的回報'); return res.redirect(back(req, cycle, '?tab=reports')); }
  tx(() => {
    if (db.prepare('SELECT 1 FROM flags WHERE report_id = ? AND user_id = ?').get(r.id, req.user.id)) return;
    db.prepare('INSERT INTO flags (report_id, user_id, created_at) VALUES (?,?,?)').run(r.id, req.user.id, now());
    const n = r.flag_count + 1;
    db.prepare('UPDATE reports SET flag_count = ? WHERE id = ?').run(n, r.id);
    if (n >= 3) {
      db.prepare('UPDATE reports SET hidden = 1, reward = 0 WHERE id = ?').run(r.id);
      if (r.reward > 0) addLedger(r.user_id, -r.reward, 'report_hidden', r.id);
    }
  });
  flash(res, 'ok', '已收到舉報，謝謝');
  res.redirect(back(req, cycle, '?tab=reports'));
});

router.post('/c/:id/unlock', requireLogin, actionLimit, (req, res) => {
  const cycle = loadCycle(req, res); if (!cycle) return;
  const ok = tx(() => {
    if (canViewDetails(req.user, cycle.id)) return true;
    if (balanceOf(req.user.id) < SEEDS.unlockCost) return false;
    addLedger(req.user.id, -SEEDS.unlockCost, 'unlock', cycle.id);
    db.prepare('INSERT INTO unlocks (user_id, cycle_id, created_at) VALUES (?,?,?)').run(req.user.id, cycle.id, now());
    return true;
  });
  flash(res, ok ? 'ok' : 'error', ok ? '已解鎖這一屆的完整明細' : '種子不足，先回報進度賺種子吧');
  res.redirect(back(req, cycle, '?tab=reports'));
});

router.post('/c/:id/ask', requireLogin, actionLimit, (req, res) => {
  const cycle = loadCycle(req, res); if (!cycle) return;
  const fail = (m) => { flash(res, 'error', m); res.redirect(back(req, cycle, '?tab=qa')); };
  const body = cleanText(req.body.body, 500);
  if (body.length < 8) return fail('問題請寫清楚一點（至少 8 個字）');
  const bounty = Math.trunc(Number(req.body.bounty));
  if (!(bounty >= SEEDS.askMin && bounty <= SEEDS.askMax)) return fail(`懸賞需介於 ${SEEDS.askMin}–${SEEDS.askMax} 🌱`);
  let trackId = 0;
  if (cycle.has_tracks) {
    const t = db.prepare('SELECT id FROM tracks WHERE id = ? AND cycle_id = ?').get(Number(req.body.track) || 0, cycle.id);
    if (!t) return fail('請選擇你問的是哪一組');
    trackId = t.id;
  }
  const stage = STAGE_BY_KEY[req.body.stage] ? req.body.stage : '';
  if (db.prepare('SELECT COUNT(*) c FROM questions WHERE user_id = ? AND created_at > ?').get(req.user.id, now() - DAY).c >= SEEDS.maxQuestionsPerDay) {
    return fail('今天提問太多次了，明天再來');
  }
  const qid = tx(() => {
    if (balanceOf(req.user.id) < bounty) return null;
    const id = Number(db.prepare(
      'INSERT INTO questions (cycle_id, track_id, stage, user_id, body, bounty, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(cycle.id, trackId, stage, req.user.id, body, bounty, now()).lastInsertRowid);
    addLedger(req.user.id, -bounty, 'ask', id);
    return id;
  });
  if (!qid) return fail('種子不足，回報進度可以賺種子');
  flash(res, 'ok', `已送出，託管 ${bounty} 🌱。有人回答並被採納才會付出，沒人答會退回。`);
  res.redirect(back(req, cycle, `?tab=qa#q${qid}`));
});

router.post('/q/:id/answer', requireLogin, actionLimit, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(req.params.id));
  if (!q) return res.status(404).type('text').send('not found');
  const cycle = getCycle(q.cycle_id);
  const fail = (m) => { flash(res, 'error', m); res.redirect(back(req, cycle, `?tab=qa#q${q.id}`)); };
  const body = cleanText(req.body.body, 500);
  if (q.status !== 'open') return fail('這個問題已結束');
  if (q.user_id === req.user.id) return fail('不能回答自己的問題');
  if (!isContributor(req.user.id, cycle.id)) return fail('需要先在這一屆回報過進度才能回答');
  if (body.length < 8) return fail('回答請寫清楚一點（至少 8 個字）');
  try {
    db.prepare('INSERT INTO answers (question_id, user_id, body, created_at) VALUES (?,?,?,?)').run(q.id, req.user.id, body, now());
  } catch { return fail('你已經回答過這個問題了'); }
  flash(res, 'ok', '已回答，被提問者採納（或 7 天後自動發放）可得懸賞');
  res.redirect(back(req, cycle, `?tab=qa#q${q.id}`));
});

router.post('/q/:id/accept', requireLogin, actionLimit, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(req.params.id));
  if (!q) return res.status(404).type('text').send('not found');
  const cycle = getCycle(q.cycle_id);
  const ok = tx(() => {
    const cur = db.prepare('SELECT status FROM questions WHERE id = ?').get(q.id);
    const a = db.prepare('SELECT * FROM answers WHERE id = ? AND question_id = ?').get(Number(req.body.answer) || 0, q.id);
    if (!a || cur.status !== 'open' || q.user_id !== req.user.id) return false;
    addLedger(a.user_id, q.bounty, 'answer_paid', q.id);
    db.prepare(`UPDATE questions SET status = 'solved', accepted_answer_id = ?, resolved_at = ? WHERE id = ?`).run(a.id, now(), q.id);
    return true;
  });
  flash(res, ok ? 'ok' : 'error', ok ? `已採納，${q.bounty} 🌱 已付給回答者` : '無法採納這則回答');
  res.redirect(back(req, cycle, `?tab=qa#q${q.id}`));
});
