'use strict';

// Resets a user's password from the server's command line, e.g. in Render's Shell tab:
//   node scripts/reset-password.js admin
// Prints a temporary password; the user must choose a new one when they sign in.
// Also reactivates the account in case it was deactivated.

const { openDb } = require('../src/db');
const auth = require('../src/auth');

const username = process.argv[2];
if (!username) {
  console.error('Usage: node scripts/reset-password.js <username>');
  process.exit(1);
}

const db = openDb();
const user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
if (!user) {
  const names = db.prepare("SELECT username FROM users WHERE role = 'admin' ORDER BY id").all().map((u) => u.username);
  console.error(`No user called "${username}". Admin accounts: ${names.join(', ') || '(none)'}`);
  process.exit(1);
}

const password = auth.tempPassword();
db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, active = 1 WHERE id = ?')
  .run(auth.hashPassword(password), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log(`\n  Password reset for ${user.username} (${user.role})\n    temporary password: ${password}\n  They'll be asked to pick a new one when they sign in.\n`);
