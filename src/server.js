'use strict';

const { openDb } = require('./db');
const { createApp, ensureAdmin } = require('./app');
const { startScheduler } = require('./scheduler');

const db = openDb();
ensureAdmin(db);
startScheduler(db);

const port = Number(process.env.PORT) || 3000;
const app = createApp(db);
// Speed-to-lead alerts and call-back reminders, once a minute.
setInterval(() => {
  try { app.locals.speed.tick(); } catch (e) { console.error('Speed-to-lead check failed:', e); }
}, 60000).unref();
app.listen(port, () => {
  console.log(`E&O Spectrum Referrals running on http://localhost:${port}`);
});

