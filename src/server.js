'use strict';

const { openDb } = require('./db');
const { createApp, ensureAdmin } = require('./app');
const { startScheduler } = require('./scheduler');

const db = openDb();
ensureAdmin(db);
startScheduler(db);

const port = Number(process.env.PORT) || 3000;
const app = createApp(db);
// Speed-to-lead alerts, call-backs, reminders and the daily briefings, once a minute.
setInterval(() => {
  try { app.locals.speed.tick(); } catch (e) { console.error('Speed-to-lead check failed:', e); }
  try { app.locals.agent.tick(); } catch (e) { console.error('Reminders/briefing check failed:', e); }
}, 60000).unref();
// WhatsApp alerts reconnect by themselves if an admin linked a phone.
app.locals.whatsapp.start();
const stopAll = () => { app.locals.whatsapp.stop(); process.exit(0); };
process.on('SIGTERM', stopAll);
process.on('SIGINT', stopAll);
app.listen(port, () => {
  console.log(`E&O Spectrum Referrals running on http://localhost:${port}`);
});

