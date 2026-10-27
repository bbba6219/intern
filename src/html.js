import { esc } from './util.js';

// 安全模板：html`...${x}...` 會自動跳脫插值，除非是 raw() 或另一個 html``
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);

function render(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(String(v));
}

export const html = (strings, ...vals) =>
  new Raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? render(vals[i]) : ''), ''));
