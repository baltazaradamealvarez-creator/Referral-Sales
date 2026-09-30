'use strict';

const { openDb } = require('./db');
const { createApp, ensureAdmin } = require('./app');

const db = openDb();
ensureAdmin(db);

const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => {
  console.log(`E&O Spectrum Referrals running on http://localhost:${port}`);
});
