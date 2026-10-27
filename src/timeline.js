import { db } from './db.js';
import { dayNum, fromDayNum, median, norm } from './util.js';

// 順序即時間線順序。tone 只影響顏色，不代表好壞判斷
export const STAGES = [
  { key: 'applied',    label: '完成投遞',               hint: '你送出申請的日期',                     tone: 'start' },
  { key: 'test',       label: '收到測驗通知',           hint: '線上測驗／筆試／性格測驗的通知日',       tone: 'progress' },
  { key: 'docs',       label: '通過書面審查／初審',     hint: '收到初審結果或通過書審的通知日',         tone: 'progress' },
  { key: 'interview1', label: '收到面試通知（一面）',   hint: '通知寄達的日期，不是面試當天',           tone: 'progress' },
  { key: 'interview2', label: '收到面試通知（二面／終面）', hint: '通知寄達的日期',                     tone: 'progress' },
  { key: 'offer',      label: '收到錄取／獲獎通知',     hint: '收到 Offer、錄取或獲獎通知的日期',                     tone: 'good' },
  { key: 'waitlist',   label: '收到備取通知',           hint: '',                                      tone: 'warn' },
  { key: 'rejected',   label: '收到未錄取通知',         hint: '',                                      tone: 'muted' },
];
export const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));

const summarize = (dates) => {
  const days = dates.map(dayNum);
  return {
    n: days.length,
    min: fromDayNum(Math.min(...days)),
    max: fromDayNum(Math.max(...days)),
    median: fromDayNum(median(days)),
  };
};

// 單一屆次的時間線彙整。trackId 為 null 代表所有組別
export function buildTimeline(cycleId, trackId = null) {
  const rows = db.prepare(
    `SELECT stage, track_id, event_date FROM reports WHERE cycle_id = ? AND hidden = 0`
  ).all(cycleId);

  const byStage = new Map();
  const byTrackStage = new Map(); // `${track}|${stage}` -> dates
  for (const r of rows) {
    const k = `${r.track_id}|${r.stage}`;
    if (!byTrackStage.has(k)) byTrackStage.set(k, []);
    byTrackStage.get(k).push(r.event_date);
    if (trackId !== null && r.track_id !== trackId) continue;
    if (!byStage.has(r.stage)) byStage.set(r.stage, []);
    byStage.get(r.stage).push(r.event_date);
  }

  const stages = STAGES.map((s) => ({
    ...s,
    ...(byStage.has(s.key) ? summarize(byStage.get(s.key)) : { n: 0 }),
  }));
  const withData = stages.filter((s) => s.n > 0);
  const total = withData.reduce((a, s) => a + s.n, 0);
  return {
    stages,
    total,
    min: withData.length ? withData.map((s) => s.min).sort()[0] : null,
    max: withData.length ? withData.map((s) => s.max).sort().at(-1) : null,
    matrix: (tid, stage) => {
      const d = byTrackStage.get(`${tid}|${stage}`);
      return d ? summarize(d) : null;
    },
  };
}

// 上一屆：優先沿著 fork 鏈找，找不到就退回「同梯次、較早年份」
export function previousCycle(cycle) {
  const forked = cycle.forked_from && db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.forked_from);
  if (forked) return forked;
  return db.prepare(
    'SELECT * FROM cycles WHERE program_id = ? AND term = ? AND year < ? ORDER BY year DESC LIMIT 1'
  ).get(cycle.program_id, cycle.term, cycle.year) || null;
}

export function previousCycleMedians(cycle, trackName = null) {
  const prev = previousCycle(cycle);
  if (!prev) return null;
  let trackFilter = '';
  const args = [prev.id];
  if (trackName) {
    const t = db.prepare('SELECT id FROM tracks WHERE cycle_id = ? AND name_norm = ?').get(prev.id, norm(trackName));
    if (!t) return { cycle: prev, stages: {} };
    trackFilter = 'AND track_id = ?';
    args.push(t.id);
  }
  const rows = db.prepare(
    `SELECT stage, event_date FROM reports WHERE cycle_id = ? AND hidden = 0 ${trackFilter}`
  ).all(...args);
  const grouped = {};
  for (const r of rows) (grouped[r.stage] ||= []).push(r.event_date);
  return {
    cycle: prev,
    stages: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, summarize(v)])),
  };
}

// 歷屆對照：同一計劃每一屆各階段的中位數（MM/DD 可直接比較不同年度的節奏）
export function programHistory(programId) {
  const cycles = db.prepare('SELECT * FROM cycles WHERE program_id = ? ORDER BY year DESC, id DESC').all(programId);
  const rows = db.prepare(
    `SELECT r.cycle_id, r.stage, r.event_date FROM reports r JOIN cycles c ON c.id = r.cycle_id
     WHERE c.program_id = ? AND r.hidden = 0`
  ).all(programId);
  const by = {};
  for (const r of rows) ((by[r.cycle_id] ||= {})[r.stage] ||= []).push(r.event_date);
  return cycles.map((c) => ({
    cycle: c,
    stages: Object.fromEntries(Object.entries(by[c.id] || {}).map(([k, v]) => [k, summarize(v)])),
  }));
}
