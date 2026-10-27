import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { sessionMiddleware } from './src/auth.js';
import { html } from './src/html.js';
import { installPage } from './src/layout.js';
import { router as home } from './src/routes/home.js';
import { router as account } from './src/routes/account.js';
import { router as programs } from './src/routes/programs.js';
import { router as cycle, sweepQuestions } from './src/routes/cycle.js';

export function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(sessionMiddleware);
  installPage(app);
  app.use(home, account, programs, cycle);
  app.use((req, res) => res.status(404).page('找不到頁面', html`<div class="empty"><p>找不到這個頁面。</p><a class="btn" href="/">回首頁</a></div>`));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).type('text').send('伺服器發生錯誤，請稍後再試。');
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sweepQuestions();
  setInterval(sweepQuestions, 10 * 60 * 1000).unref();
  createApp().listen(config.port, () => console.log(`${config.siteName} listening on http://localhost:${config.port}`));
}
