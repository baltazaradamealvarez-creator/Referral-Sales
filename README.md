# E&O Spectrum Referrals

A simple web app for entering Spectrum sales referrals, dispatching them and tracking what happens to them.

- **Easy entry.** Type or paste the customer's info in any order and any format. The app picks out the name, phone, email, address and services (Internet, TV, Mobile, Voice). Anything it doesn't recognise, like "current provider: AT&T", "call after 5" or a second phone number, is kept in the notes, and the original text is always saved. Reps can also tap **Use template** to fill in a form the admin sets up. **Ctrl + Enter** sends.
- **Duplicate blocking across all teams.** A lead is rejected when its **phone**, **email** or **address** matches any existing referral, whatever team entered it. The rep only sees *"This lead is a duplicate and cannot be entered."* Admins and dispatch get a **Duplicates** page showing who tried, what matched, and the lead it matched.
  - Phones are compared by their 10 digits, emails without regard to case, and addresses after normalizing (`123 North Main Street Apt 4B` matches `123 N. Main St #4b`; a different unit counts as a different address).
- **Dispatch.** Dispatchers see every lead from every team. They get leads assigned to them (or grab one with **Take it**), and they update the status, the Spectrum account or order number and the install date. **My Queue** shows their open leads. Admins can turn on **auto-assign**, which gives each new lead to the dispatcher with the fewest open leads.
- **Board.** A Kanban view with a column for each status (New, Passed, DNQ, Ordered, Cancelled). Drag a card to change its status. Closed leads only show for a chosen period (the last 7, 30 or 90 days, or all time) so the board stays readable.
- **Entering for someone else.** Managers, dispatch and admins can enter a lead on a rep's behalf, and the rep gets the credit.
- **Comments with @mentions** and **notifications** (🔔) for mentions, status changes, assignments and comments on your leads. These can also go out by **email** through [Resend](https://resend.com), and each user can turn email off under **My account**.
- **Customers view** with search and filters for status, service, rep, team and dispatcher, plus **Export CSV**.
- **Sales dashboards:** your own numbers, your team's totals and a per-rep breakdown. Admins and dispatch also see every team, each dispatcher's workload and sales by service.
- **Dashboard (Home).** Everyone gets a dashboard for their own scope: reps see their own numbers, managers their team, dispatch and admins everything, with a filter by team or rep. It shows key numbers compared with the previous period, a daily trend chart, the status mix, a funnel, services, a leaderboard, team and dispatch workload, stale leads, upcoming installs and recent activity. **Customize** lets each person add, remove and reorder widgets, and the layout is saved to their account. Periods: today, 7/30/90 days, this or last month, this year, all time, or custom dates.
- **Insights.** Plain-language notes worked out from the numbers, for example: "Conversion is 35%, down 9 points", "14 leads have sat in New for 3+ days", "Voice leads convert best", "23 open leads have no dispatcher". Each one links to the matching leads.
- **Search** in the top bar (press **/**) finds customers by name, phone, email, address or account number, and admins and managers can also find users. It only shows what you're allowed to see.
- **Dark mode** that follows your device, or pick Light or Dark under 👤 or **My account**.
- **Built for phones:** a bottom tab bar, list rows that turn into cards, and a full-width search.
- **Forgot password:** sign-in page → **Forgot your password?** → a 6-digit code is emailed (valid 15 minutes, 5 tries) → choose a new password and you're signed in. Users can also sign in with their email address.
- **Welcome emails** with sign-in details when you add someone, and an option to email a temporary password when you reset one. Emails come from **E&O Referrals** (you can change the name on the Admin page) instead of a bare "noreply", and you can set a reply-to address.
- **Account activity (admins):** who's active today or this week, who has never signed in, passwords over 90 days old, and failed sign-ins. Each user has a last-active time, a password-changed date and a **History** of sign-ins (time, device, IP). **Sign out other devices** is under My account.
- **Invite links (admins).** On the Admin page, create a sign-up link that sets the new person's **role and team**, how many people can use it (1 to 100) and when it expires (1 to 30 days). Send it by text or email. People open it, enter their name, email, phone, username and password, and are signed straight in. The role and team always come from the link, never from the form. You get a notification, each sign-up is in the audit log, and you can turn a link off at any time.
- **Help & how-to** in the app (account menu → Help, or the Help tab): a role-aware guide to entering leads, duplicates, statuses, the Board, dispatch and admin tasks, with search. New users see a one-time "New here?" prompt pointing to it.
- **WhatsApp alerts (linked phone).** Under Admin → Settings → **WhatsApp alerts**, connect and scan the QR code with a phone (Linked devices, like WhatsApp Web), then pick the dispatch group. Every new lead is then posted to that group automatically, in the same format as Copy for WhatsApp. Anyone can add their **WhatsApp number** under Account → Profile and switch on **Send my alerts to WhatsApp** to get their alerts there too.
  - Messages go out one at a time from a paced queue, wait while the link is down, and reconnect by themselves. Admins get an in-app alert if the phone unlinks.
  - **This uses an unofficial link (the Baileys library), so WhatsApp may disconnect or block the number. Use a separate number just for alerts.** The app's own and phone notifications always go out regardless.
  - The link's session is kept on the disk next to the database (`whatsapp-auth/`).
- **Instant new-lead alerts.** Every active dispatcher is alerted the moment a lead comes in: in the app, as a phone notification, and on WhatsApp if they turned it on. Switch this off in Admin → Settings.
- **WhatsApp hand-off to dispatch.** After a lead is sent, and on every lead's page:
  - **📋 Copy for WhatsApp** puts a ready-to-paste message on the clipboard: name, phone, address, date of birth, email, services, notes and rep.
  - **🟢 Open WhatsApp** opens WhatsApp with the message filled in, straight to the dispatch number if one is set.
  - Either button warns when something dispatch needs is missing.
  - The message format and dispatch number are set under Admin → Settings.
- **Date of birth** is read from the entry box ("DOB: 01/31/1980", "Fecha de nacimiento: …", or an unlabelled birth-year date), can be edited, and is checked to be a real date. A missing one shows as a tip.
- **Speed to lead.** Each new lead shows ⏱ *Waiting* until dispatch, a manager or an admin first works it (status change, comment, or taking it), then ⚡ *Answered in …*.
  - After 15 minutes the assigned dispatcher is alerted, or every dispatcher if the lead is unassigned.
  - After 60 minutes admins are alerted. Optionally, the lead moves to the least-busy other dispatcher.
  - Only working hours count. The minutes, working hours, time zone and hand-off are set under Admin → Settings.
  - A **Speed to lead** widget shows average and typical response times, the share answered on time, and who's waiting now.
- **Call-back reminders.** On any lead, tap *In 1 hour*, *Tomorrow 10am* or pick a time. A notification arrives when it's time to call, and upcoming call-backs show in a **My call-backs** widget.
- **The app on your phone.** It installs to the home screen like an app. **Phone notifications** (Account → Profile) push every alert to the phone, even when the app is closed; on iPhone the app must first be added to the Home Screen. With no signal the app still opens: new leads are saved on the phone and sent automatically when the connection is back, and anything that couldn't be sent (a duplicate, say) is listed.
- **Address suggestions.** As an address is typed, the app suggests the full address with city and zip, and offers "Did you mean …?" for the address read from the entry box. It uses the free Photon service (OpenStreetMap), or Geoapify if `GEOAPIFY_API_KEY` is set. If the lookup is down, entry is never blocked.
- **Tidy navigation.** The top bar holds only the day-to-day pages. Everything else is in one hub with sub-tabs across the top:
  - **Admin** (admins): Users & teams, Invite links, Past sales, Payments, Affiliate, Duplicates, Audit log, Settings, My account.
  - **Account** (everyone else): Profile, Payments and Affiliate when switched on, and Help.
  - **My Queue** appears only for dispatchers. Managers keep **My Team** in the top bar.
- **Affiliate program.** When an admin switches it on (Affiliate page), everyone gets a personal sign-up link to share by copy, text, the phone's share sheet or email. People who join through it become reps on the inviter's team, optionally after admin approval. When a recruit's lead is **Ordered**, the people above them earn a share of that sale's commission: 15% for the person who invited them and 5% for the person above that, on top of the seller's pay. The percentages and number of levels (up to 5) are set on the Affiliate page. Admins set a default commission per sale and can change it on each lead. Earnings come from sales only, never from sign-ups. A cancelled order takes its earnings back, even after payout, by deducting from the next one. Members see who they invited, earnings per person and what they're owed, but never the customers' names. Admins see what everyone is owed, **Mark paid** with a note, and can set "invited by" for people who joined before the program.
- **Lead quality score.** While a lead is typed, a bar shows its quality from 0 to 100%, red to green. Name, phone and address are worth 25% each, email 15% and services 10%. The bar lists what would raise the score, such as "Add the last name too" or "Did you mean @gmail.com?" with a one-tap fix. Obvious fakes are refused with a clear message: placeholder or keyboard-mash names ("Test", "asdf", "N/A", names with digits), impossible phone numbers (123-456-7890, 111-111-1111, fake area codes) and throw-away or placeholder emails (mailinator.com, test@…). The customer's name is required. Every lead stores its score, shown as a coloured % in the list, on the Board and on the lead page with tips.
- **Email invites.** Type one or more addresses in **Email it to** when creating an invite link (or tap **Email** on an active link). Each person gets a "Create my account" email with an optional personal message. The list shows who each link was emailed to.
- **Past sales block list (admins).** Under Admin → **Past sales**, upload old sales spreadsheets (.xlsx or .csv). Every phone number and street address in them is added to the duplicate check, so those customers can't be entered again. Columns such as Phone, Address / Address Line 1, Line 2, City, State and Zip are read automatically, and sheets without a header row (like pay reports) have their addresses picked out of the cells. You see a preview (counts only) before anything is saved. Only the normalized phone and address are stored: no names, account numbers or amounts. They never appear in customer lists, search or reports. Removing an upload stops its entries blocking.
- **Payments.** Managers (and any rep or dispatcher an admin switches on) get a **Payments** tab to record how they're paid: a bank account (IBAN, or account number plus routing number for US banks and a bank code or SWIFT elsewhere), Bit, or a Bitcoin wallet, with the country. IBANs and US routing numbers are checked for typos. Saving needs the person's password, and they get an email every time their details change. Details are encrypted at rest (AES-256-GCM). People see only the last 4 digits, while admins can reveal full details from the Payments page, and every reveal is audit-logged.
- **Welcome email with a quick guide.** Every welcome email, whether from an invite link or when an admin adds someone, explains in four steps how to enter a lead, plus duplicates, statuses, @mentions, adding the app to the home screen, and tips for managers, dispatchers and admins. Invite sign-ups never get a password by email.
- **User management.** Managers add reps to their team, reset passwords and deactivate or reactivate reps. Admins manage all users, roles, teams and settings, and can download a backup.

## Who can see what

| | Rep | Manager | Dispatch | Admin |
|---|---|---|---|---|
| Enter referrals | ✅ | ✅ (can credit their reps) | ✅ (can credit any rep) | ✅ (can credit any rep) |
| See referrals | Their own | Their team's | Everyone's | Everyone's |
| Change status, account #, install date | — | Their team's | All | All |
| Assign leads to dispatch | — | — | ✅ | ✅ |
| Edit lead details | Own, while status is New | Their team's | All | All |
| Board | Own leads (read only) | Team (drag to update) | All (drag to update) | All (drag to update) |
| Duplicates log | — | — | ✅ | ✅ |
| Sales numbers | Own + team per-rep counts | Own + team | All teams + dispatch | All teams + dispatch |
| Add users / reset passwords | — | Reps on their team | — | Everyone |
| Teams, roles, settings, backup | — | — | — | ✅ |

Duplicate checking always runs against **every** referral in the system, including ones the user can't see.

## Running it

Requires **Node.js 22.13+**. It uses the built-in `node:sqlite`, so there is no database server to install.

```bash
npm install
npm start            # http://localhost:3000
```

On the first start the app creates an `admin` account and prints a temporary password in the console. Sign in, set your own password, create your teams under **Admin**, then add managers. Managers can add their own reps from there.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/referrals.db` | SQLite database file (back this up) |
| `ADMIN_USERNAME` | `admin` | First admin's username (used only when the database is empty) |
| `ADMIN_PASSWORD` | random | First admin's password (used only when the database is empty) |
| `RESEND_API_KEY` | — | Turns on email alerts. Leave it unset to keep email off. |
| `GEOAPIFY_API_KEY` | — | Optional. Uses Geoapify for address suggestions (free tier: 3,000 a day) instead of the free Photon service. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated | Optional. Keys for phone notifications; if unset they're generated once and kept in the database. |
| `PAYMENT_ENCRYPTION_KEY` | a key file next to the database | Encrypts payout details. Set any long random string and keep it safe: changing or losing it makes saved payout details unreadable, so people would need to re-enter them. Without it, a `payment.key` file is created next to the database on the disk. Keep a copy, because it isn't in the backup download. |
| `EMAIL_FROM` | `onboarding@resend.dev` | Sending address, on a domain you verified in Resend. The display name ("E&O Referrals") is added automatically and can be changed on the Admin page. |
| `APP_URL` | Render's own URL | The site address used for links in emails. Only needed with a custom domain. |

Run the tests with `npm test`.

**Locked out?** Run this on the server (in Render: your service → **Shell**) to reset any account, including the admin:

```bash
node scripts/reset-password.js admin
```

It prints a temporary password, and you'll pick a new one when you sign in.

**Upgrades:** when a new version starts, it upgrades the existing database automatically and keeps all users, leads and comments.

## Putting it online (Render)

The repo includes a `render.yaml` file that sets everything up for you: the server, a 1 GB disk that keeps your data between restarts, and HTTPS.

1. Sign up at [render.com](https://render.com) with your GitHub account and let it see the **Referral-Sales** repository.
2. In the Render dashboard click **New → Blueprint** and pick **Referral-Sales**.
3. Render reads `render.yaml` and asks for **ADMIN_PASSWORD**. Type the password you want for the `admin` account.
4. Click **Apply**. After a few minutes the service shows **Live**, with a link like `https://eo-spectrum-referrals.onrender.com`.
5. Open the link, sign in as `admin`, and change the password from the 👤 menu.
6. Under **Admin**, create your teams and add your managers. Managers then add their own reps.

It uses Render's **Starter** plan, because free plans can't keep a disk and would lose your data. Every push to the `main` branch redeploys automatically, and the data on the disk isn't touched.

**Email alerts:** in Render, open your service → **Environment** and add `RESEND_API_KEY` (from Resend → API Keys) and `EMAIL_FROM`, for example `E&O Referrals <alerts@yourdomain.com>`, using a domain you've verified in Resend. Save, and Render restarts the app. Then on the **Admin** page click **Send me a test email**. If something is wrong, it shows Resend's error message. Everyone adds their email address under 👤 → **My account**. Admins and managers can also add it when creating a user.

**Backups:** admins can click **Download backup** on the Admin page to get a copy of the whole database. You can also turn on disk snapshots in Render.

**On phones:** open the link, then use **Share → Add to Home Screen** (iPhone) or **⋮ → Add to Home screen** (Android) and it opens like an app.

**Other hosts:** it is one Node process plus one SQLite file, so it also runs on Railway, Fly.io or any VPS. Set `DB_FILE` to a path on a persistent volume and serve it over HTTPS.

## Project layout

```
src/server.js      starts the app
src/app.js         API routes and permission rules
scripts/           reset-password.js for locked-out accounts
src/email.js       emails through Resend (alerts, welcome, reset codes)
src/dashboard.js   dashboard numbers and insights
src/normalize.js   lead parsing and phone/email/address matching
src/db.js          SQLite schema and automatic upgrades
src/auth.js        password hashing (scrypt) and sessions
public/            the web UI (plain HTML/CSS/JS, no build step)
test/              API and parsing tests
```
