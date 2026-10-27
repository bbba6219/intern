process.env.DATA_DIR = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClient } from './helpers.js';

const { createApp } = await import('../server.js');
const { db } = await import('../src/db.js');
const { sweepQuestions } = await import('../src/routes/cycle.js');
const { SEEDS } = await import('../src/config.js');

const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const seedsOf = (nick) => db.prepare('SELECT seeds FROM users WHERE nickname = ?').get(nick).seeds;
const ledgerSum = (nick) => db.prepare('SELECT COALESCE(SUM(delta),0) s FROM seed_ledger WHERE user_id = (SELECT id FROM users WHERE nickname = ?)').get(nick).s;
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

async function signup(nick) {
  const c = makeClient(base);
  const r = await c.post('/signup', { nickname: nick, password: 'password123', next: '/' });
  assert.equal(r.status, 302, `signup ${nick}`);
  return c;
}

let alice, bob, carol, slug, cycleId;

test('網站一開始沒有任何預設計劃', async () => {
  assert.equal(db.prepare('SELECT COUNT(*) c FROM programs').get().c, 0);
  const home = await makeClient(base).get('/');
  assert.match(home.text, /還沒有任何計劃/);
});

test('註冊送種子、暱稱不可重複、錯誤密碼無法登入', async () => {
  alice = await signup('alice');
  assert.equal(seedsOf('alice'), SEEDS.signup);
  const dup = await makeClient(base).post('/signup', { nickname: 'ALICE', password: 'password123' });
  assert.equal(dup.status, 400);
  const bad = await makeClient(base).post('/login', { nickname: 'alice', password: 'wrongpass1' });
  assert.equal(bad.status, 400);
  bob = await signup('bob');
  carol = await signup('carol');
});

test('沒有帶 CSRF token 的 POST 會被拒絕', async () => {
  const res = await fetch(`${base}/signup`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'nickname=evil&password=password123' });
  assert.equal(res.status, 403);
});

test('建立計劃：獲得獎勵，完全重複會被擋下', async () => {
  const r = await alice.post('/programs/new', {
    name: '示範公司 暑期實習', company: '示範公司', kind: '實習', aliases: '示範學期實習, Demo Summer',
  });
  assert.equal(r.status, 302);
  slug = r.loc.split('/').pop();
  assert.equal(seedsOf('alice'), SEEDS.signup + SEEDS.createProgram);

  // 名稱／別名正規化後相同（大小寫、空白、標點不同）→ 硬性擋下
  const dup = await bob.post('/programs/new', { name: 'demo-summer', kind: '實習' });
  assert.equal(dup.status, 409);
  assert.match(dup.text, /已經存在，無法重複建立/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM programs').get().c, 1);
});

test('建立計劃：相似計劃需要確認才能建立', async () => {
  const body = { name: '示範公司暑期', kind: '實習', company: '示範公司' };
  const warn = await bob.post('/programs/new', body);
  assert.equal(warn.status, 409);
  assert.match(warn.text, /看起來相似/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM programs').get().c, 1);
  const ok = await bob.post('/programs/new', { ...body, name: '示範公司獎學金', confirm_unique: '1', kind: '獎學金' });
  assert.equal(ok.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM programs').get().c, 2);
});

test('別名搜尋：不同叫法導到同一個計劃', async () => {
  const c = makeClient(base);
  for (const q of ['示範學期實習', 'demo summer', 'DEMO-SUMMER']) {
    const r = await c.get(`/search?q=${encodeURIComponent(q)}`);
    assert.match(r.text, new RegExp(`/p/${slug}`), q);
  }
  const added = await alice.post(`/p/${slug}/alias`, { alias: '示範 RS' });
  assert.equal(added.status, 302);
  assert.match((await c.get('/search?q=%E7%A4%BA%E7%AF%84rs')).text, new RegExp(`/p/${slug}`));
});

test('開第一屆、組別必填、搶先加碼、同階段不重複領獎', async () => {
  const r = await alice.post(`/p/${slug}/cycles`, { year: new Date().getFullYear(), term: '暑期', has_tracks: '1' });
  assert.equal(r.status, 302);
  cycleId = Number(r.loc.split('/').pop());
  const before = seedsOf('alice');

  await alice.post(`/c/${cycleId}/report`, { stage: 'test', date: today });
  assert.match(await alice.flash(), /請選擇你投遞的組別/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reports').get().c, 0);

  await alice.post(`/c/${cycleId}/report`, { stage: 'test', date: today, new_track: '資訊組', note: 'Email' });
  assert.equal(seedsOf('alice'), before + SEEDS.report + SEEDS.firstInTrackStage);
  assert.equal(db.prepare('SELECT bonus_paid FROM programs WHERE slug = ?').get(slug).bonus_paid, 0);

  const mid = seedsOf('alice');
  await alice.post(`/c/${cycleId}/report`, { stage: 'test', date: today, new_track: '資訊組', note: '改備註' });
  assert.equal(seedsOf('alice'), mid);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reports').get().c, 1);

  await alice.post(`/c/${cycleId}/report`, { stage: 'offer', date: '2999-01-01', new_track: '資訊組' });
  assert.match(await alice.flash(), /日期不正確/);
});

test('第一位「其他人」回報後，建立者補發延後獎勵（只發一次）', async () => {
  const a0 = seedsOf('alice');
  const track = db.prepare('SELECT id FROM tracks WHERE cycle_id = ?').get(cycleId).id;
  await bob.post(`/c/${cycleId}/report`, { stage: 'test', date: today, track: String(track) });
  assert.equal(seedsOf('alice'), a0 + SEEDS.createProgramLater + SEEDS.forkCycleLater);
  await carol.post(`/c/${cycleId}/report`, { stage: 'interview1', date: today, track: String(track) });
  assert.equal(seedsOf('alice'), a0 + SEEDS.createProgramLater + SEEDS.forkCycleLater);
  // bob 建了第二個計劃(+5)，回報 test 不是第一位 → 沒有搶先加碼
  assert.equal(seedsOf('bob'), SEEDS.signup + SEEDS.createProgram + SEEDS.report);
});

test('時間線彙整正確，組別對照與 JSON API 一致', async () => {
  const api = JSON.parse((await makeClient(base).get(`/api/cycles/${cycleId}/timeline`)).text);
  const t = api.stages.find((s) => s.key === 'test');
  assert.equal(t.n, 2);
  assert.equal(t.min, today);
  const page = (await makeClient(base).get(`/p/${slug}/c/${cycleId}`)).text;
  assert.match(page, /各組別對照/);
  assert.match(page, /資訊組/);
});

test('完整明細需回報或解鎖；解鎖扣種子且永久有效', async () => {
  const dave = await signup('dave');
  const locked = await dave.get(`/p/${slug}/c/${cycleId}?tab=reports`);
  assert.match(locked.text, /完整回報明細/);
  assert.doesNotMatch(locked.text, /改備註/);
  await dave.post(`/c/${cycleId}/unlock`);
  assert.equal(seedsOf('dave'), SEEDS.signup - SEEDS.unlockCost);
  assert.match((await dave.get(`/p/${slug}/c/${cycleId}?tab=reports`)).text, /改備註/);
  await dave.post(`/c/${cycleId}/unlock`);
  assert.equal(seedsOf('dave'), SEEDS.signup - SEEDS.unlockCost);
});

test('確認(我也一樣)：獎勵、不可重複、不可自我確認', async () => {
  const rid = db.prepare(`SELECT id FROM reports WHERE user_id = (SELECT id FROM users WHERE nickname='alice')`).get().id;
  const a0 = seedsOf('alice'); const c0 = seedsOf('carol');
  await carol.post(`/r/${rid}/confirm`);
  assert.equal(seedsOf('alice'), a0 + SEEDS.confirmReceived);
  assert.equal(seedsOf('carol'), c0 + SEEDS.confirmGiven);
  await carol.post(`/r/${rid}/confirm`);
  assert.equal(seedsOf('alice'), a0 + SEEDS.confirmReceived);
  await alice.post(`/r/${rid}/confirm`);
  assert.equal(seedsOf('alice'), a0 + SEEDS.confirmReceived);
});

test('舉報達 3 人自動隱藏並收回獎勵', async () => {
  const eve = await signup('eve');
  const track = db.prepare('SELECT id FROM tracks WHERE cycle_id = ?').get(cycleId).id;
  await eve.post(`/c/${cycleId}/report`, { stage: 'offer', date: today, track: String(track) });
  const rid = db.prepare(`SELECT id FROM reports WHERE stage='offer'`).get().id;
  const e0 = seedsOf('eve');
  for (const c of [alice, bob, carol]) await c.post(`/r/${rid}/flag`);
  assert.equal(db.prepare('SELECT hidden FROM reports WHERE id = ?').get(rid).hidden, 1);
  assert.equal(seedsOf('eve'), e0 - (SEEDS.report + SEEDS.firstInTrackStage));
  const api = JSON.parse((await makeClient(base).get(`/api/cycles/${cycleId}/timeline`)).text);
  assert.equal(api.stages.find((s) => s.key === 'offer').n, 0);
});

test('問答：託管 → 只有回報者能答 → 採納付款', async () => {
  const track = db.prepare('SELECT id FROM tracks WHERE cycle_id = ?').get(cycleId).id;
  const b0 = seedsOf('bob');
  await bob.post(`/c/${cycleId}/ask`, { body: '有人收到面試通知了嗎？', bounty: '5' });
  assert.match(await bob.flash(), /請選擇你問的是哪一組/);
  await bob.post(`/c/${cycleId}/ask`, { body: '卡', bounty: '5', track: String(track) });
  assert.match(await bob.flash(), /至少 8 個字/);

  await bob.post(`/c/${cycleId}/ask`, { body: '資訊組有人收到面試通知了嗎？是寄信嗎？', bounty: '5', track: String(track) });
  assert.equal(seedsOf('bob'), b0 - 5);
  const q = db.prepare('SELECT * FROM questions').get();

  const frank = await signup('frank');
  await frank.post(`/q/${q.id}/answer`, { body: '我也不知道但想拿種子' });
  assert.match(await frank.flash(), /需要先在這一屆回報過進度/);

  await carol.post(`/q/${q.id}/answer`, { body: '我在資訊組，昨天用 Email 收到了。' });
  const ans = db.prepare('SELECT id FROM answers').get();
  const c0 = seedsOf('carol');
  await alice.post(`/q/${q.id}/accept`, { answer: String(ans.id) });
  assert.equal(db.prepare('SELECT status FROM questions').get().status, 'open');
  await bob.post(`/q/${q.id}/accept`, { answer: String(ans.id) });
  assert.equal(seedsOf('carol'), c0 + 5);
  assert.equal(db.prepare('SELECT status FROM questions').get().status, 'solved');
});

test('逾期結算：有回答→給最早回答者；沒回答→退回', async () => {
  const track = db.prepare('SELECT id FROM tracks WHERE cycle_id = ?').get(cycleId).id;
  const ask = async (c, text) => { await c.post(`/c/${cycleId}/ask`, { body: text, bounty: '6', track: String(track) }); return db.prepare('SELECT MAX(id) id FROM questions').get().id; };
  const q1 = await ask(bob, '逾期有回答的問題：面試地點在哪裡？');
  const q2 = await ask(bob, '逾期沒人回答的問題：有人收到備取嗎？');
  await carol.post(`/q/${q1}/answer`, { body: '地點在總公司十樓會議室。' });
  const b0 = seedsOf('bob'); const c0 = seedsOf('carol');
  db.prepare('UPDATE questions SET created_at = created_at - ? WHERE id IN (?, ?)').run(8 * 86400000, q1, q2);
  sweepQuestions();
  assert.equal(db.prepare('SELECT status FROM questions WHERE id = ?').get(q1).status, 'auto_paid');
  assert.equal(seedsOf('carol'), c0 + 6);
  assert.equal(db.prepare('SELECT status FROM questions WHERE id = ?').get(q2).status, 'refunded');
  assert.equal(seedsOf('bob'), b0 + 6);
  sweepQuestions();
  assert.equal(seedsOf('carol'), c0 + 6);
});

test('Fork：複製上一屆沿用組別、記錄來源、歷屆串在一起', async () => {
  const y = new Date().getFullYear();
  const a0 = seedsOf('alice');
  const bobR = await bob.post(`/p/${slug}/cycles`, { year: String(y + 1), term: '暑期', fork_from: String(cycleId) });
  assert.equal(bobR.status, 302);
  const newId = Number(bobR.loc.split('/').pop());
  const c = db.prepare('SELECT * FROM cycles WHERE id = ?').get(newId);
  assert.equal(c.forked_from, cycleId);
  assert.equal(c.has_tracks, 1);
  assert.deepEqual(db.prepare('SELECT name FROM tracks WHERE cycle_id = ?').all(newId).map((t) => t.name), ['資訊組']);
  assert.equal(seedsOf('alice'), a0);
  const dup = await bob.post(`/p/${slug}/cycles`, { year: String(y + 1), term: '暑期', fork_from: String(cycleId) });
  assert.equal(dup.loc.split('/').pop(), String(newId));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cycles').get().c, 2);

  const track = db.prepare('SELECT id FROM tracks WHERE cycle_id = ?').get(newId).id;
  await carol.post(`/c/${newId}/report`, { stage: 'test', date: today, track: String(track) });
  const page = (await makeClient(base).get(`/p/${slug}/c/${newId}`)).text;
  assert.match(page, /複製自/);
  assert.match(page, /上一屆/);
  assert.match(page, /歷屆對照/);
});

test('未登入不能寫入，會導向登入', async () => {
  const r = await makeClient(base).post(`/c/${cycleId}/report`, { stage: 'test', date: today });
  assert.equal(r.status, 302);
  assert.match(r.loc, /^\/login/);
});

test('種子帳本與餘額永遠一致', () => {
  for (const { nickname } of db.prepare('SELECT nickname FROM users').all()) {
    assert.equal(seedsOf(nickname), ledgerSum(nickname), nickname);
  }
});

test('HTML 輸出會跳脫使用者輸入（XSS）', async () => {
  const evil = await signup('xss');
  await evil.post('/programs/new', { name: '<script>alert(1)</script> 計劃', kind: '其他' });
  const page = (await makeClient(base).get('/search?q=%3Cscript%3E')).text;
  assert.doesNotMatch(page, /<script>alert/);
});
