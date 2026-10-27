import path from 'node:path';

export const config = {
  port: Number(process.env.PORT) || 3000,
  // ':memory:' is supported for tests
  dataDir: process.env.DATA_DIR || path.resolve('data'),
  secret: process.env.SESSION_SECRET || '',
  trustProxy: process.env.TRUST_PROXY === '1',
  secureCookies: process.env.COOKIE_SECURE === '1',
  siteName: '申請進度板',
};

// 種子規則：全部集中在這裡，/rules 頁面也讀這份，避免文件與實作不一致
export const SEEDS = {
  signup: 20,               // 註冊禮
  report: 10,               // 每個計劃屆次的每個階段，第一次回報
  firstInTrackStage: 5,     // 該組別該階段的第一位回報者額外加碼
  confirmReceived: 2,       // 回報被別人「我也一樣」確認，每次 +2
  confirmReceivedCap: 5,    // 每則回報最多被獎勵幾次確認
  confirmGiven: 1,          // 幫別人確認的人 +1
  confirmGivenDailyCap: 5,  // 每天最多領幾次
  unlockCost: 3,            // 未回報者查看某屆次完整回報明細
  askMin: 5,                // 提問懸賞下限
  askMax: 30,
  questionTtlDays: 7,       // 超過天數沒被採納：有回答→給最早回答者；沒回答→退回
  createProgram: 5,         // 建立新計劃：立即
  createProgramLater: 10,   // 第一位「其他人」回報後再補發，避免亂建垃圾計劃刷種子
  forkCycle: 2,             // 開新一屆／複製上一屆：立即
  forkCycleLater: 5,        // 同上，第一位其他人回報後補發
  maxReportsPerDay: 30,
  maxQuestionsPerDay: 5,
};
