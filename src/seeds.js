import { db, now } from './db.js';

// 必須在 tx() 內呼叫，確保流水帳與餘額一致
export function addLedger(userId, delta, reason, ref = '') {
  db.prepare('INSERT INTO seed_ledger (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)')
    .run(userId, delta, reason, String(ref), now());
  db.prepare('UPDATE users SET seeds = seeds + ? WHERE id = ?').run(delta, userId);
}

export const balanceOf = (userId) =>
  db.prepare('SELECT seeds FROM users WHERE id = ?').get(userId)?.seeds ?? 0;

export const REASONS = {
  signup: '註冊禮',
  create_program: '建立新計劃',
  create_program_later: '你建立的計劃有人回報了（補發）',
  create_cycle: '開新一屆／複製屆次',
  create_cycle_later: '你開的這一屆有人回報了（補發）',
  report: '回報進度',
  first_bonus: '搶先回報加碼',
  confirm_received: '回報被確認',
  confirm_given: '確認他人回報',
  report_hidden: '回報被隱藏，收回獎勵',
  unlock: '解鎖回報明細',
  ask: '提問懸賞（託管）',
  answer_paid: '回答被採納',
  answer_auto: '回答獲得懸賞（逾期自動發放）',
  ask_refund: '提問無人回答，退回懸賞',
};
