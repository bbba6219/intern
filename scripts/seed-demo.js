// 產生「示範」資料，只用來看版面。所有名稱都標示【示範】，內容為隨機生成，不是真實時程。
// 用法：DATA_DIR=./data-demo npm run seed:demo
import { db, tx, now } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { createProgram, createCycle, ensureTrack } from '../src/programs.js';
import { addLedger } from '../src/seeds.js';
import { fromDayNum, dayNum } from '../src/util.js';

if (db.prepare('SELECT COUNT(*) c FROM programs').get().c > 0) {
  console.log('資料庫已有計劃，略過示範資料');
  process.exit(0);
}

// 固定亂數種子，結果可重現
let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pw = await hashPassword('demo-password');
const users = [];
for (let i = 1; i <= 24; i++) {
  const id = tx(() => {
    const uid = Number(db.prepare('INSERT INTO users (nickname, nickname_norm, pw_hash, created_at) VALUES (?,?,?,?)')
      .run(`示範同學${i}`, `示範同學${i}`, pw, now()).lastInsertRowid);
    addLedger(uid, 20, 'signup');
    return uid;
  });
  users.push(id);
}

const { program } = createProgram({
  userId: users[0], name: '【示範】星河科技 暑期實習', company: '星河科技（虛構）', kind: '實習',
  description: '這是示範資料，用來預覽版面；公司與日期皆為虛構。', aliases: ['【示範】星河實習', 'Starriver Summer'],
});
const { program: sch } = createProgram({
  userId: users[1], name: '【示範】遠見基金會獎學金', company: '遠見基金會（虛構）', kind: '獎學金',
  description: '示範資料。', aliases: ['【示範】遠見獎學金'],
});

const stagesFlow = [
  ['applied', 0, 6], ['test', 14, 5], ['interview1', 30, 7], ['interview2', 42, 5], ['offer', 55, 6],
];
function fill(cycleId, baseDate, tracks, nUsers, skew) {
  const tids = tracks.map((t) => ensureTrack(cycleId, t));
  for (let u = 0; u < nUsers; u++) {
    const uid = users[(u + skew) % users.length];
    const tid = tids[Math.floor(rnd() * tids.length)];
    let reached = true;
    for (const [stage, off, jitter] of stagesFlow) {
      if (!reached) break;
      const d = fromDayNum(dayNum(baseDate) + off + Math.round((rnd() - 0.5) * 2 * jitter) + (tid % 3));
      try {
        db.prepare(`INSERT INTO reports (user_id, cycle_id, track_id, stage, event_date, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(uid, cycleId, tid, stage, d, '', now() - Math.floor(rnd() * 5 * 86400000), now());
      } catch { /* 同人同組同階段已存在 */ }
      reached = rnd() < 0.72;
    }
  }
}

const y = new Date().getFullYear();
const c1 = createCycle({ programId: program.id, userId: users[0], year: y - 1, term: '暑期' }).cycle;
for (const t of ['軟體工程組', '資料科學組', '產品設計組', '行銷企劃組']) ensureTrack(c1.id, t);
fill(c1.id, `${y - 1}-03-04`, ['軟體工程組', '資料科學組', '產品設計組', '行銷企劃組'], 22, 0);
const c2 = createCycle({ programId: program.id, userId: users[2], year: y, term: '暑期', forkFrom: c1.id }).cycle;
fill(c2.id, `${y}-03-01`, ['軟體工程組', '資料科學組', '產品設計組', '行銷企劃組'], 18, 3);

const s1 = createCycle({ programId: sch.id, userId: users[1], year: y, term: '全年度', hasTracks: false }).cycle;
const docs = [['applied', 0, 4], ['docs', 20, 4], ['interview1', 34, 4], ['offer', 48, 5]];
for (let u = 0; u < 9; u++) {
  let reached = true;
  for (const [stage, off, j] of docs) {
    if (!reached) break;
    const d = fromDayNum(dayNum(`${y}-05-10`) + off + Math.round((rnd() - 0.5) * 2 * j));
    db.prepare(`INSERT INTO reports (user_id, cycle_id, track_id, stage, event_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(users[u + 4], s1.id, 0, stage, d, now() - Math.floor(rnd() * 3 * 86400000), now());
    reached = rnd() < 0.7;
  }
}
console.log(`示範資料完成：/p/${program.slug}  /p/${sch.slug}（帳號 示範同學1…24，密碼 demo-password）`);
