// 極簡 HTTP 客戶端：保留 cookie、自動帶 CSRF，直接打 in-process 的 app
export function makeClient(base) {
  const jar = {};
  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i); const v = decodeURIComponent(pair.slice(i + 1));
      if (/Max-Age=0/i.test(c) || v === '') delete jar[k]; else jar[k] = v;
    }
  };
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  const get = async (path) => {
    const res = await fetch(base + path, { headers: { cookie: cookie() }, redirect: 'manual' });
    store(res);
    return { status: res.status, loc: res.headers.get('location'), text: await res.text() };
  };
  const csrf = async () => {
    // /login 的表單一定帶 token（已登入者則從 /rules 之外的頁面取）
    for (const p of ['/login', '/programs/new', '/me']) {
      const { text } = await get(p);
      const m = /name="_csrf" value="([0-9a-f]+)"/.exec(text);
      if (m) return m[1];
    }
    throw new Error('no csrf token found');
  };
  const post = async (path, body = {}) => {
    const token = await csrf();
    const res = await fetch(base + path, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: token, ...body }),
    });
    store(res);
    return { status: res.status, loc: res.headers.get('location'), text: await res.text() };
  };
  // 取出下一次載入會顯示的 flash 文字
  const flash = async (path = '/') => {
    const { text } = await get(path);
    return /class="flash flash-\w+" role="status">([^<]*)</.exec(text)?.[1] ?? '';
  };
  return { get, post, flash, jar };
}
