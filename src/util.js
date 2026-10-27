import crypto from 'node:crypto';

// 比對用的正規化：全形半形統一、轉小寫、去掉空白與標點
// 「中信 Rising-Star」「中信rising star」會變成同一個字串
export function norm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function cleanText(s, max = 200) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);
}

export function cleanLine(s, max = 60) {
  return cleanText(s, max * 2).replace(/\s+/g, ' ').slice(0, max);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

export const todayTaipei = () =>
  new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

export const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

export const dayNum = (s) => Math.floor(Date.parse(s + 'T00:00:00Z') / 86400000);
export const fromDayNum = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
export const fmtMD = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;

export function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

export function relTime(ms, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return '剛剛';
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

export function randomSlug(base) {
  const ascii = String(base).normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  const tail = crypto.randomBytes(3).toString('hex');
  return ascii ? `${ascii}-${tail}` : `p-${tail}`;
}

export const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) ? n : '/');
