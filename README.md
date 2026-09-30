# E&O Spectrum Referrals

A simple web app for entering Spectrum sales referrals and tracking what happens to them.

- **One text box to enter a lead.** Type or paste the customer's info in any order: name, phone, email, address, notes. The app picks out each part and shows what it found. If it got something wrong, "Fix the details" opens the separate fields.
- **Duplicate blocking across all teams.** A lead is rejected when its **phone**, **email** or **address** matches any existing referral, whatever team entered it. The rep only sees *"This lead is a duplicate and cannot be entered."* The app never shows the other lead.
  - Phones are compared by their 10 digits: `(512) 555-0142`, `512.555.0142` and `+1 512 555 0142` all match.
  - Emails are compared without regard to case.
  - Addresses are normalized first, so `123 North Main Street Apt 4B` matches `123 N. Main St #4b`. A different unit number counts as a different address.
- **Statuses:** New → Passed / DNQ / Ordered / Cancelled, with a full history of changes. Managers can also record the Spectrum account or order number.
- **Comments with @mentions.** Use them when something doesn't add up. Typing `@` suggests the people who can see that lead. Mentioned users and the rep who entered the lead get a notification (🔔).
- **Customers view** with search (name, phone, email, address, account #) and filters for status, rep and team.
- **Sales dashboards:** your own numbers, your team's totals, a per-rep breakdown and, for admins, all teams. Filter by today, this week, this month, last month or all time.
- **User management.** Managers add reps to their team, reset passwords (which gives a temporary password) and deactivate or reactivate reps. Admins manage all users, roles and teams. A user signing in with a temporary password must set a new one first.

## Who can see what

| | Rep | Manager | Admin |
|---|---|---|---|
| Enter referrals | ✅ | ✅ | ✅ |
| See referrals | Their own | Their team's | Everyone's |
| Change status / account # | — | Their team's | All |
| Edit lead details | Own, while status is New | Their team's | All |
| Sales numbers | Own + team per-rep counts | Own + team | All teams |
| Add users / reset passwords | — | Reps on their team | Everyone |
| Teams & roles | — | — | ✅ |

Duplicate checking always runs against **every** referral in the system, including ones the user can't see.

## Running it

Requires **Node.js 22.13+**. It uses the built-in `node:sqlite`, so there is no database server to install.

```bash
npm install
npm start            # http://localhost:3000
```

On the first start the app creates an `admin` account and prints a temporary password in the console. Sign in, set your own password, create your teams under **Users & Teams**, then add managers. Managers can add their own reps from there.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/referrals.db` | SQLite database file (back this up) |
| `ADMIN_USERNAME` | `admin` | First admin's username (used only when the database is empty) |
| `ADMIN_PASSWORD` | random | First admin's password (used only when the database is empty) |

Run the tests with `npm test`.

## Putting it online (Render)

The repo includes a `render.yaml` file that sets everything up for you: the server, a 1 GB disk that keeps your data between restarts, and HTTPS.

1. Sign up at [render.com](https://render.com) with your GitHub account and let it see the **Referral-Sales** repository.
2. In the Render dashboard click **New → Blueprint** and pick **Referral-Sales**.
3. Render reads `render.yaml` and asks for **ADMIN_PASSWORD**. Type the password you want for the `admin` account.
4. Click **Apply**. After a few minutes the service shows **Live**, with a link like `https://eo-spectrum-referrals.onrender.com`.
5. Open the link, sign in as `admin`, and change the password from the 👤 menu.
6. Under **Users & Teams**, create your teams and add your managers. Managers then add their own reps.

It uses Render's **Starter** plan, because free plans can't keep a disk and would lose your data. Every push to the `main` branch redeploys automatically, and the data on the disk isn't touched.

**Backups:** admins can click **Download backup** on the Users & Teams page to get a copy of the whole database. You can also turn on disk snapshots in Render.

**On phones:** open the link, then use **Share → Add to Home Screen** (iPhone) or **⋮ → Add to Home screen** (Android) and it opens like an app.

**Other hosts:** it is one Node process plus one SQLite file, so it also runs on Railway, Fly.io or any VPS. Set `DB_FILE` to a path on a persistent volume and serve it over HTTPS.

## Project layout

```
src/server.js      starts the app
src/app.js         API routes and permission rules
src/normalize.js   lead parsing and phone/email/address matching
src/db.js          SQLite schema
src/auth.js        password hashing (scrypt) and sessions
public/            the web UI (plain HTML/CSS/JS, no build step)
test/              API and parsing tests
```
