import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const mem = config.dataDir === ':memory:';
if (!mem) fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(mem ? ':memory:' : path.join(config.dataDir, 'board.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  nickname TEXT NOT NULL,
  nickname_norm TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  seeds INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 一個實習計劃一個入口；name 與所有別名都放在 program_aliases，並以 alias_norm 全站唯一
CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '其他',
  description TEXT NOT NULL DEFAULT '',
  official_url TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  bonus_paid INTEGER NOT NULL DEFAULT 0,   -- 建立者的延後獎勵（第一位其他人回報後發放）
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS program_aliases (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_norm TEXT NOT NULL UNIQUE
);

-- 屆次（例如 2027 暑期）；has_tracks=1 表示有分組別，回報與提問必須選組別
-- forked_from：這一屆是從哪一屆複製出來的，歷屆因此串成一條線
CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  term TEXT NOT NULL,
  has_tracks INTEGER NOT NULL DEFAULT 1,
  forked_from INTEGER REFERENCES cycles(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id),
  bonus_paid INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (program_id, year, term)
);
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (cycle_id, name_norm)
);

-- 結構化進度回報；track_id=0 代表該屆次沒有分組別
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL,
  event_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  confirm_count INTEGER NOT NULL DEFAULT 0,
  flag_count INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  reward INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, cycle_id, track_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_reports_cycle ON reports (cycle_id, hidden);
CREATE TABLE IF NOT EXISTS confirmations (
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, user_id)
);
CREATE TABLE IF NOT EXISTS flags (
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, user_id)
);

-- 「追蹤」取代留言卡位；last_seen 用來算「有幾則新進度」
CREATE TABLE IF NOT EXISTS follows (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (user_id, cycle_id)
);
CREATE TABLE IF NOT EXISTS unlocks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, cycle_id)
);

-- 問答：懸賞種子提問時先託管，採納後付給回答者
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  bounty INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open | solved | auto_paid | refunded
  accepted_answer_id INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_questions_cycle ON questions (cycle_id, status);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (question_id, user_id)
);

-- 種子流水帳：users.seeds 永遠等於這張表的加總
CREATE TABLE IF NOT EXISTS seed_ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON seed_ledger (user_id, id);
`);

// node:sqlite 沒有 transaction helper；單一程序同步執行，BEGIN IMMEDIATE 足夠
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const now = () => Date.now();
