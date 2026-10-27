import { Router } from 'express';
import { db } from '../db.js';
import { html } from '../html.js';
import { SEEDS } from '../config.js';
import { relTime, fmtMD } from '../util.js';
import { searchPrograms, latestCycle, cycleLabel, aliasesOf, KINDS } from '../programs.js';
import { STAGE_BY_KEY } from '../timeline.js';

export const router = Router();

function programCard(p) {
  const c = latestCycle(p.id);
  const aliases = aliasesOf(p.id).filter((a) => a !== p.name).slice(0, 4);
  return html`<a class="pcard" href="/p/${p.slug}">
    <div class="pcard-head">
      <h3>${p.name}</h3>
      ${c ? html`<span class="pill">${cycleLabel(c)}</span>` : html`<span class="pill pill-muted">尚未開始</span>`}
    </div>
    <p class="muted small">${p.kind}${p.company ? `・${p.company}` : ''}</p>
    ${aliases.length ? html`<p class="chips">${aliases.map((a) => html`<span class="chip">${a}</span>`)}</p>` : ''}
    <p class="pcard-foot muted">${p.n_reports} 則進度回報</p>
  </a>`;
}

router.get('/', (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const programs = db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM reports r JOIN cycles c ON c.id = r.cycle_id
        WHERE c.program_id = p.id AND r.hidden = 0) AS n_reports,
       (SELECT MAX(r.created_at) FROM reports r JOIN cycles c ON c.id = r.cycle_id WHERE c.program_id = p.id) AS last_at
     FROM programs p ${kind ? 'WHERE p.kind = ?' : ''} ORDER BY n_reports DESC, last_at DESC, p.id LIMIT 24`
  ).all(...(kind ? [kind] : []));

  const recent = db.prepare(
    `SELECT r.*, u.nickname, p.name pname, p.slug, c.year, c.term, t.name tname
     FROM reports r JOIN users u ON u.id = r.user_id JOIN cycles c ON c.id = r.cycle_id
     JOIN programs p ON p.id = c.program_id LEFT JOIN tracks t ON t.id = r.track_id
     WHERE r.hidden = 0 ORDER BY r.created_at DESC LIMIT 8`
  ).all();

  res.page('', html`
    <section class="hero">
      <h1>每個申請計劃，<br class="br-sm">只有一個入口。</h1>
      <p class="lead">實習、管培、校園徵才、獎學金、交換…測驗、面試、錄取通知什麼時候來？<br>不用再翻十幾個討論串。回報你的進度，大家一起看見完整時間線。</p>
      <form class="search-big" action="/search" method="get" role="search">
        <input type="search" name="q" placeholder="搜尋計劃名稱、公司或別名" aria-label="搜尋計劃" autofocus>
        <button class="btn" type="submit">搜尋</button>
      </form>
      <p class="muted small">同一個計劃的不同叫法都會導到同一頁。找不到？<a href="/programs/new">自己建立一個</a>，建立者有種子獎勵。</p>
    </section>

    <section class="how">
      <div class="how-item"><span class="how-n">1</span><h3>回報時一定選組別</h3><p>每則進度都綁定組別／職缺，不再有人問「你是哪一組？」。</p></div>
      <div class="how-item"><span class="how-n">2</span><h3>一鍵複製成新一屆</h3><p>去年有人開過？直接複製成今年，組別沿用，歷屆結果串在一起可對照。</p></div>
      <div class="how-item"><span class="how-n">3</span><h3>種子換答案</h3><p>回報進度賺種子；提問用種子懸賞，有人答才付，沒人答退回。</p></div>
    </section>

    <section>
      <div class="sec-head">
        <h2>計劃</h2>
        <a href="/programs/new" class="link">＋ 建立計劃</a>
      </div>
      <nav class="tabs tabs-wrap" aria-label="類型">
        <a href="/" class="${!kind ? 'on' : ''}">全部</a>
        ${KINDS.map((k) => html`<a href="/?kind=${encodeURIComponent(k)}" class="${kind === k ? 'on' : ''}">${k}</a>`)}
      </nav>
      ${programs.length
        ? html`<div class="grid">${programs.map(programCard)}</div>`
        : html`<div class="empty">
            <p><b>${kind ? `還沒有「${kind}」類型的計劃。` : '這裡還沒有任何計劃。'}</b></p>
            <p class="muted">所有計劃都由同學主動建立。你申請的計劃如果還沒人開，成為第一個建立者吧：建立可得 ${SEEDS.createProgram} 🌱，之後有人回報再補發 ${SEEDS.createProgramLater} 🌱。</p>
            <a class="btn" href="/programs/new">建立第一個計劃</a>
          </div>`}
    </section>

    ${recent.length ? html`<section>
      <div class="sec-head"><h2>最新進度</h2></div>
      <ul class="feed">${recent.map((r) => html`<li>
        <span class="feed-time">${relTime(r.created_at)}</span>
        <span><b>${r.nickname}</b> 在 <a href="/p/${r.slug}/c/${r.cycle_id}">${r.pname} ${r.year} ${r.term}</a>${r.tname ? html`（${r.tname}）` : ''}
        回報「${STAGE_BY_KEY[r.stage].label}」<span class="muted">${fmtMD(r.event_date)}</span></span>
      </li>`)}</ul>
    </section>` : ''}
  `);
});

router.get('/search', (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 60);
  if (!q) return res.redirect('/');
  const results = searchPrograms(q);
  res.page(`搜尋「${q}」`, html`
    <section>
      <h1 class="h1">搜尋「${q}」</h1>
      ${results.length
        ? html`<div class="grid">${results.map(programCard)}</div>
               <p class="muted small mt">不是你要找的？<a href="/programs/new?name=${encodeURIComponent(q)}">建立「${q}」</a>（會先檢查是否重複）</p>`
        : html`<div class="empty">
            <p>找不到「${q}」相關的計劃。</p>
            <p class="muted">也許別人用不同的叫法，試試公司名稱或縮寫；確定沒有的話，由你來建立，之後同學就能在同一個入口追蹤。</p>
            <a class="btn" href="/programs/new?name=${encodeURIComponent(q)}">建立「${q}」</a>
          </div>`}
    </section>`);
});

router.get('/rules', (req, res) => {
  res.page('種子規則', html`
    <article class="prose">
      <h1>🌱 種子規則</h1>
      <p>種子是這個站的「互助貨幣」：誰回報進度，誰就能查詢與提問。目的是解決「問了沒人答、原 po 不回」的問題。</p>
      <h2>怎麼賺種子</h2>
      <table class="table">
        <tr><td>註冊</td><td>+${SEEDS.signup}</td></tr>
        <tr><td>建立一個新計劃（建立前會檢查重複）</td><td>+${SEEDS.createProgram}</td></tr>
        <tr><td>……第一位<b>其他人</b>在你的計劃回報後，補發</td><td>+${SEEDS.createProgramLater}</td></tr>
        <tr><td>開新一屆或複製上一屆</td><td>+${SEEDS.forkCycle}</td></tr>
        <tr><td>……第一位其他人在你開的那一屆回報後，補發</td><td>+${SEEDS.forkCycleLater}</td></tr>
        <tr><td>在某個計劃屆次回報一個新階段的進度</td><td>+${SEEDS.report}</td></tr>
        <tr><td>搶先：你是該組別該階段的第一位回報者</td><td>+${SEEDS.firstInTrackStage}</td></tr>
        <tr><td>你的回報被別人按「我也一樣」確認（每則最多 ${SEEDS.confirmReceivedCap} 次）</td><td>+${SEEDS.confirmReceived} / 次</td></tr>
        <tr><td>你確認別人的回報（每天最多 ${SEEDS.confirmGivenDailyCap} 次）</td><td>+${SEEDS.confirmGiven}</td></tr>
        <tr><td>你的回答被提問者採納</td><td>＋該題懸賞</td></tr>
      </table>
      <h2>怎麼花種子</h2>
      <table class="table">
        <tr><td>查看某一屆的完整回報明細（回報過該屆的人免費，解鎖後永久有效）</td><td>−${SEEDS.unlockCost}</td></tr>
        <tr><td>提問並設定懸賞（${SEEDS.askMin}–${SEEDS.askMax}）</td><td>−懸賞（先託管）</td></tr>
      </table>
      <p class="muted">時間線的彙整數字（最早、最晚、中位數、各組別對照）永遠公開，不需要種子。</p>
      <h2>提問怎麼運作</h2>
      <ol>
        <li>提問必須選組別，種子先託管。</li>
        <li>只有在該屆回報過進度的人可以回答，所以答的人一定是參加者。</li>
        <li>提問者按「採納」，懸賞付給回答者。</li>
        <li>超過 ${SEEDS.questionTtlDays} 天沒採納：若有人回答，懸賞自動給<b>最早</b>的回答者；沒有人回答，全額退回。<b>不會有人白答、也不會有人白問。</b></li>
      </ol>
      <h2>一個計劃，一個入口</h2>
      <p>計劃只能由使用者建立，建立前會比對名稱與別名：完全相同的不能重複建立，看起來相似的需要你確認不是同一個。
      每年同一個計劃請在原入口「複製成新一屆」，組別會自動沿用，歷屆結果串在一起，可以對照每年的通知節奏。</p>
      <h2>為什麼沒有「卡」</h2>
      <p>想追蹤新進度請按「追蹤」，有新回報會在「我的」顯示數量，不需要留言卡位。</p>
      <h2>防濫用</h2>
      <p>同一人在同一屆同一階段只能領一次獎勵；回報可被舉報，達 3 位使用者舉報會先隱藏並收回獎勵；每日有回報與提問次數上限；建立者的延後獎勵要等其他人實際使用才發放。</p>
    </article>`);
});

router.get('/healthz', (req, res) => res.type('text').send('ok'));
