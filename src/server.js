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
  try { app.locals.coach.tick(); } catch (e) { console.error('Seller coach check failed:', e.message); }
}, 60000).unref();
// WhatsApp alerts reconnect by themselves if an admin linked a phone.
app.locals.whatsapp.start();
let stopping=false;
const stopAll = async () => {
  if(stopping)return;stopping=true;server.close();
  const deadline=setTimeout(()=>process.exit(1),8000);deadline.unref();
  try{await app.locals.whatsapp.stop();}
  catch(e){console.error('WhatsApp shutdown could not finish:',e.message);}
  finally{clearTimeout(deadline);process.exit(0);}
};
process.on('SIGTERM', stopAll);
process.on('SIGINT', stopAll);
const server=app.listen(port, () => {
  console.log(`E&O Spectrum Referrals running on http://localhost:${port}`);
});
