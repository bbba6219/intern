import { db, tx, now } from './db.js';
import { SEEDS } from './config.js';
import { norm, randomSlug } from './util.js';
import { addLedger } from './seeds.js';

export const KINDS = ['實習', '管培／校園徵才', '獎學金', '交換／出國', '升學／研究所', '其他'];
export const TERM_SUGGESTIONS = ['暑期', '學期', '寒假', '春季', '秋季', '全年度', '第一梯', '第二梯'];

export const getProgramBySlug = (slug) => db.prepare('SELECT * FROM programs WHERE slug = ?').get(slug);
export const getProgram = (id) => db.prepare('SELECT * FROM programs WHERE id = ?').get(id);
export const getCycle = (id) => db.prepare('SELECT * FROM cycles WHERE id = ?').get(id);
export const aliasesOf = (programId) =>
  db.prepare('SELECT alias FROM program_aliases WHERE program_id = ? ORDER BY id').all(programId).map((r) => r.alias);

export const cyclesOf = (programId) =>
  db.prepare('SELECT * FROM cycles WHERE program_id = ? ORDER BY year DESC, id DESC').all(programId);

export const latestCycle = (programId) => cyclesOf(programId)[0] || null;
export const tracksOf = (cycleId) =>
  db.prepare('SELECT * FROM tracks WHERE cycle_id = ? ORDER BY name').all(cycleId);

export const cycleLabel = (c) => `${c.year} ${c.term}`;

// 搜尋：每個以空白分隔的詞都要出現在 名稱／公司／任一別名 的正規化字串中
export function searchPrograms(q) {
  const tokens = String(q).split(/\s+/).map(norm).filter(Boolean);
  if (!tokens.length) return [];
  const rows = db.prepare(
    `SELECT p.*,
       (SELECT group_concat(alias_norm, '|') FROM program_aliases a WHERE a.program_id = p.id) AS hay,
       (SELECT COUNT(*) FROM reports r JOIN cycles c ON c.id = r.cycle_id
         WHERE c.program_id = p.id AND r.hidden = 0) AS n_reports
     FROM programs p`
  ).all();
  const whole = norm(q);
  return rows
    .map((p) => {
      const hay = `${p.hay || ''}|${norm(p.company)}`;
      if (!tokens.every((t) => hay.includes(t))) return null;
      const exact = (p.hay || '').split('|').includes(whole);
      return { ...p, score: (exact ? 1000 : 0) + p.n_reports };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

export function parseAliases(text) {
  return [...new Set(String(text ?? '').split(/[,，、\n]+/).map((s) => s.trim().replace(/\s+/g, ' ')).filter((s) => s && s.length <= 40))].slice(0, 12);
}

// 硬性衝突：名稱／別名正規化後完全相同 → 一律不能建立
export function findAliasConflicts(names) {
  const out = [];
  for (const n of names) {
    const hit = db.prepare(
      `SELECT p.slug, p.name, a.alias FROM program_aliases a JOIN programs p ON p.id = a.program_id WHERE a.alias_norm = ?`
    ).get(norm(n));
    if (hit) out.push({ input: n, ...hit });
  }
  return out;
}

// 軟性相似：互相包含（「中信實習」vs「中信暑期實習」）或同公司。需使用者勾選確認才能繼續建立
export function findSimilar(names, company = '') {
  const cands = [...new Set(names.map(norm).filter((n) => n.length >= 2))];
  const comp = norm(company);
  const rows = db.prepare(
    `SELECT p.id, p.slug, p.name, p.company, a.alias_norm FROM program_aliases a JOIN programs p ON p.id = a.program_id`
  ).all();
  const hits = new Map();
  for (const r of rows) {
    const sameCompany = comp && norm(r.company) === comp;
    const overlap = cands.some((c) => r.alias_norm !== c && (r.alias_norm.includes(c) || c.includes(r.alias_norm)));
    if (overlap || sameCompany) hits.set(r.id, { slug: r.slug, name: r.name, company: r.company });
  }
  return [...hits.values()].slice(0, 6);
}

export function createProgram({ userId, name, company = '', kind = '其他', description = '', officialUrl = '', aliases = [], confirmedUnique = false }) {
  const all = [name, ...aliases];
  const conflicts = findAliasConflicts(all);
  if (conflicts.length) return { conflicts };
  if (!confirmedUnique) {
    const similar = findSimilar(all, company);
    if (similar.length) return { similar };
  }
  const id = tx(() => {
    const info = db.prepare(
      'INSERT INTO programs (slug, name, company, kind, description, official_url, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(randomSlug(name), name, company, KINDS.includes(kind) ? kind : '其他', description, officialUrl, userId, now());
    const pid = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT OR IGNORE INTO program_aliases (program_id, alias, alias_norm) VALUES (?,?,?)');
    for (const a of all) if (norm(a)) ins.run(pid, a, norm(a));
    if (userId) addLedger(userId, SEEDS.createProgram, 'create_program', pid);
    return pid;
  });
  return { program: getProgram(id) };
}

export function addAlias(programId, alias) {
  if (!norm(alias)) return { error: '別名不能是空的' };
  const c = findAliasConflicts([alias]);
  if (c.length) return { conflicts: c };
  db.prepare('INSERT INTO program_aliases (program_id, alias, alias_norm) VALUES (?,?,?)').run(programId, alias, norm(alias));
  return {};
}

// 開新一屆。forkFrom 有值＝複製那一屆：沿用組別與是否分組，並記錄 forked_from 串起歷屆
export function createCycle({ programId, userId, year, term, hasTracks = true, forkFrom = null }) {
  const dup = db.prepare('SELECT id FROM cycles WHERE program_id = ? AND year = ? AND term = ?').get(programId, year, term);
  if (dup) return { existing: dup.id };
  const src = forkFrom ? getCycle(forkFrom) : null;
  if (forkFrom && (!src || src.program_id !== programId)) return { error: '找不到要複製的屆次' };
  const id = tx(() => {
    const info = db.prepare(
      'INSERT INTO cycles (program_id, year, term, has_tracks, forked_from, created_by, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(programId, year, term, src ? src.has_tracks : (hasTracks ? 1 : 0), src ? src.id : null, userId, now());
    const cid = Number(info.lastInsertRowid);
    if (src?.has_tracks) {
      db.prepare(
        `INSERT INTO tracks (cycle_id, name, name_norm, created_at)
         SELECT ?, name, name_norm, ? FROM tracks WHERE cycle_id = ?`
      ).run(cid, now(), src.id);
    }
    if (userId) addLedger(userId, SEEDS.forkCycle, 'create_cycle', cid);
    return cid;
  });
  return { cycle: getCycle(id) };
}

// 第一位「其他人」回報後，補發建立者獎勵（計劃與屆次各一次）
export function payCreatorBonuses(cycle, reporterId) {
  const prog = getProgram(cycle.program_id);
  if (prog.created_by && prog.created_by !== reporterId && !prog.bonus_paid) {
    db.prepare('UPDATE programs SET bonus_paid = 1 WHERE id = ?').run(prog.id);
    addLedger(prog.created_by, SEEDS.createProgramLater, 'create_program_later', prog.id);
  }
  if (cycle.created_by && cycle.created_by !== reporterId && !cycle.bonus_paid) {
    db.prepare('UPDATE cycles SET bonus_paid = 1 WHERE id = ?').run(cycle.id);
    addLedger(cycle.created_by, SEEDS.forkCycleLater, 'create_cycle_later', cycle.id);
  }
}

// 這一屆的祖先鏈（最近的在前），用於「歷屆對照」
export function lineageOf(cycleId) {
  const out = [];
  let cur = getCycle(cycleId);
  const seen = new Set();
  while (cur?.forked_from && !seen.has(cur.forked_from)) {
    seen.add(cur.forked_from);
    cur = getCycle(cur.forked_from);
    if (cur) out.push(cur);
  }
  return out;
}

export function ensureTrack(cycleId, name) {
  const n = norm(name);
  if (!n) return null;
  const hit = db.prepare('SELECT id FROM tracks WHERE cycle_id = ? AND name_norm = ?').get(cycleId, n);
  if (hit) return hit.id;
  const count = db.prepare('SELECT COUNT(*) c FROM tracks WHERE cycle_id = ?').get(cycleId).c;
  if (count >= 40) return null;
  return Number(db.prepare('INSERT INTO tracks (cycle_id, name, name_norm, created_at) VALUES (?,?,?,?)')
    .run(cycleId, name, n, now()).lastInsertRowid);
}
