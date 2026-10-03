# E&O Spectrum Referrals

A simple web app for entering Spectrum sales referrals, dispatching them and tracking what happens to them.

- **Easy entry.** Type or paste the customer's info in any order and any format. The app picks out the name, phone, email, address and services (Internet, TV, Mobile, Voice). Anything it doesn't recognise, like "current provider: AT&T", "call after 5" or a second phone number, is kept in the notes, and the original text is always saved. Reps can also tap **Use template** to fill in a form the admin sets up. **Ctrl + Enter** sends.
- **Duplicate blocking across all teams.** A lead is rejected when its **phone**, **email** or **address** matches any existing referral, whatever team entered it. The rep only sees *"This lead is a duplicate and cannot be entered."* Admins and dispatch get a **Duplicates** page showing who tried, what matched, and the lead it matched.
  - Phones are compared by their 10 digits, emails without regard to case, and addresses after normalizing (`123 North Main Street Apt 4B` matches `123 N. Main St #4b`; a different unit counts as a different address).
- **Dispatch.** Dispatchers see every lead from every team. They get leads assigned to them (or grab one with **Take it**), and they update the status, the Spectrum account or order number and the install date. **My Queue** shows their open leads. Admins can turn on **auto-assign**, which gives each new lead to the dispatcher with the fewest open leads.
- **Board.** A Kanban view with a column for each status (New, Working, Passed, DNQ, Ordered, Cancelled). Drag a card to change its status. Closed leads only show for a chosen period (the last 7, 30 or 90 days, or all time) so the board stays readable.
- **Working.** Use this status while contacting or following up with a customer, before qualification. Working counts as open in queues, workload balancing, reports and dashboards. Reply “working”, “working on it”, “en proceso” or “trabajando” to the lead on WhatsApp to set it; explicit qualification or sale outcomes take precedence.
- **Remove test customer records.** Admins can open a customer and choose **Delete record**. Confirmation names the customer and explains that deletion is permanent. The action removes associated comments/history, reverses related affiliate earnings and writes an audit entry. No records are removed automatically.
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
  - WhatsApp's “Waiting for this message” notice means a recipient cannot decrypt a message yet. The bot supplies original outgoing messages when WhatsApp requests a decryption retry, including after deployments. Its retry cache is encrypted, bounded to 500 recent messages and 8 MB, and serves messages up to seven days old only to the original chat or a verified phone/privacy-ID alias. Quiet groups permit retries only for lead posts originally sent in quiet format; old acknowledgments and interactive posts cannot be replayed into them. Nothing is replayed on startup. Shutdown waits for pending session-key writes, and Admin diagnostics report retry availability and session-save errors without message content. Messages sent before this recovery cache was added may remain unavailable.
- **Working leads from the WhatsApp group (two-way).**
  - A **reply** to a lead's post becomes a note on the lead, shown as *via WhatsApp*. The **first dispatcher to reply takes the lead** (it's assigned to them).
  - Status words in English or Spanish change the status: *approved/aprobado*, *passed/pasó*, *DNQ/no califica*, *cancelled/cancelado*. Admins choose whether "approved" means **Ordered** or **Passed**. If a reply mentions more than one outcome, the bot asks which one.
  - **@owner / @dueño**, or a WhatsApp @-mention of the rep, sends the note to the rep who entered the lead. Other WhatsApp notes don't ping reps.
  - **#123** at the start works when there's no post to reply to.
  - **help / ayuda** posts the bilingual instructions. Admins can post them from Settings, and they're offered when the group is picked.
  - People are recognised by the WhatsApp number saved on their profile, including WhatsApp's privacy ids once seen. Only known people can act, and only within their app permissions: reps add notes, while dispatch, managers and admins change status.
  - Each message is handled once (WhatsApp can deliver one twice after a reconnect). Messages older than a day are ignored. Bot replies are rate-limited.
- **Quiet WhatsApp groups for Spectrum.** Under **Admin → Settings → WhatsApp alerts**, either set **Dispatch group behavior → Quiet** or choose an **Additional quiet group · Spectrum** and turn on its lead posts. Existing dispatch behavior stays interactive by default. Quiet posts contain only name, phone, address, date of birth, email, services and optionally the original lead's Notes field. They use a fixed format, with no lead number, rep name, portal link or reply footer. Preview it in Settings; no sample is sent to the group.
  - Reply to a lead's post to save a text comment in the CRM. Replies to those captured replies stay attached to the same lead. External participants need no CRM account: their comments show their WhatsApp display name and an external-participant label. Everyone in a configured Spectrum quiet group is authorized by default to update the leads posted in that group and submit order PDFs, including members with no CRM account or saved phone number. App permissions outside that group stay unchanged. Recognized dispatchers retain first-dispatcher assignment.
  - **Spectrum group permissions:** Settings defaults to **Everyone in the group**. There is no participant registration step. Access stays limited to leads shared in that configured quiet group, and sender names appear in comments, status history, activity and audit logs. An optional **Selected numbers only** mode retains the individual number list and immediate access removal for groups that need it. The test group follows the same setting.
  - **Silent stages:** “on it” / “working” → **Working**; “confirmed” / “confirmado” → **Passed**; “order confirmed” → **Ordered**. “Approved” retains the configured status. Questions, negations, future promises and conflicting statuses become comments. Working/Passed replies do not move a closed lead backward.
  - **Order PDFs:** reply to the lead post with a text PDF containing a complete labeled account number and order/installation confirmation. The app reads it locally, saves the account number and installation date, fills empty customer/service/package fields, captures the order number in the comment, and marks the lead **Ordered** through the normal CRM workflow. PDFs without a quoted post require one unique permitted customer match among leads posted in the same group. In Selected numbers mode, unapproved external participants' PDFs are comments only and are not downloaded. Scans, encrypted/corrupt files, quotes/bills/cancellations, missing or conflicting details, and unmatched customers appear under **Order PDF activity → Needs review**; open the linked customer to review or reply to the correct post and resend. Limits: 5 MB, 20 pages, bounded download/reading time. PDF bytes are not retained or sent to Claude. Original customer values are preserved; account/customer conflicts require review.
  - Quiet groups never receive acknowledgments, emoji reactions, AI answers, follow-up questions, help, instructions, reminders or briefings. The send queue enforces the rule again at send time, including messages queued before quiet mode was enabled. Private chats and an interactive dispatch group continue working.
  - **Test quiet mode before launch:** select a **Test group** and click **Send test lead**. The selected group gets one clearly marked fictional sample, matching the preview and Notes switch. Reply to it from a different phone to see captured comments and test statuses in Settings. The sample and its replies never enter customer records, notifications or sales totals, and choosing a test group does not enable regular lead posts. **Simulate reply** previews external-participant behavior, a trusted participant configured for the test group, or your own CRM permissions without sending a message or saving changes. Replying with a sample PDF also exercises local extraction and displays the test account/installation fields without changing real leads. The group must include the alerts phone; an interactive dispatch group cannot double as the test group.
- **🤖 Assistant (optional, Claude Haiku 4.5, `claude-haiku-4-5-20251001`).** Turn it on in Admin → Settings → Assistant, with `ANTHROPIC_API_KEY` set. People can use it in three places: the **Assistant** page, the WhatsApp group (start a message with **bot**, then reply to its answer to keep talking), or a private chat with the alerts number.
  - **What it can do:** find and summarise leads, add notes, change a lead's status or assignment, set reminders, and report numbers (orders, commission, top reps and closers, speed to lead).
  - **Permissions:** it works through the app's own actions, as the person asking. It can only do what that person could do in the app, and every change it makes is audit-logged.
  - **What it knows:** the business brief admins write in Settings, plus the commission, working hours, roles and a live snapshot taken from the app. It never sees phone numbers, emails, addresses or birthdays.
  - **Lead replies:** it also reads replies to lead posts in the group to judge the status.
  - **Limits and fallback:** capped per hour (`AI_HOURLY_CAP`, default 200 calls). Without it, the keyword rules handle replies.
- **Reminders and daily briefings (no AI needed).**
  - **Reminders:** set them on the Assistant page or by asking the assistant. They can be for yourself, a teammate or the WhatsApp group, once or repeating (daily, weekdays, weekly). They arrive as app, phone, WhatsApp or email alerts.
  - **Briefings:** a morning briefing and an evening recap are posted to the group at times you set (default 9:00 and 19:00). Each covers yesterday's or today's leads and orders, who is winning, leads not called yet, unassigned and stuck leads, and today's call-backs.
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
| `ANTHROPIC_API_KEY` | — | Optional. Turns on the assistant (Claude Haiku 4.5) in the app and on WhatsApp. |
| `AI_MODEL` | `claude-haiku-4-5-20251001` | Optional. The Claude model the assistant uses. |
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

### Diagnosing WhatsApp replies

Under **Admin → Settings → WhatsApp alerts**, open **WhatsApp diagnostics** and refresh
after sending a test. It shows the last incoming-text time, why the bot handled or ignored
that message, queue length, outgoing send failures, and the last send/error. Counters and
the in-memory send queue reset when the server restarts. A successful send means WhatsApp
accepted it; it does not prove delivery or that someone read it.

Test from your personal phone, with its number saved on your active account, rather than
from the phone linked as the alerts bot. The linked phone's own messages are deliberately
ignored to prevent loops. In the configured dispatch group, start a question with **bot**,
reply to an assistant answer, or use **help**. Reply to a posted lead or include **#123**
to add a lead note. Private text goes to the assistant. The two-way switch must be on;
free-form assistant answers also require the AI switch and `ANTHROPIC_API_KEY`.

WhatsApp redelivery of the same message ID is ignored; manually sending the text again
with a new ID is a new request. Unknown senders get registration instructions at most once
per six hours, and help is limited to once per chat every five minutes. These limits can
explain why a repeat receives no additional reply. Other groups and messages older than
24 hours are ignored. Changing a user's WhatsApp number clears their learned privacy-id
association, so the new number must be recognized again.

Scheduled-report delivery history reports **failed** when email rejects the request or
is unconfigured, and counts only recipients whose request succeeded. CSV attachments are
included in report emails. Only the schedule owner or an admin can run a test or read its
delivery history.

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
## Seller coaching

In **Admin → Settings → Seller coach**, choose yourself as the reviewer, add approved product pricing and FAQs, and enable coaching. The assistant needs its API key enabled, a connected WhatsApp account, two-way replies, and sellers with WhatsApp alerts enabled.

Defaults are weekdays at 11 a.m. in the configured business time zone, with at least three days between check-ins. Automatic check-ins require each seller or manager to opt in under **My account → Notification preferences**, and target participants who have not entered a lead in three days, during business hours; the scheduler can catch up within two hours of the scheduled time. At the top of Seller coach, choose a seller or manager to automatically load their message, then click **Send check-in**. The button stays visible and any sending restriction appears beside it. **Refresh status** shows whether WhatsApp accepted the check-in or a send failed. Manual check-ins can contact recently active sellers, while preserving the cooldown and business-hours limits. Pending reviews pause check-ins. STOP / ALTO opts a seller out; START / REANUDAR resumes coaching.

Seller coaching extends the existing operations assistant. Lead lookup, notes, status updates, assignments, statistics, reminders and daily briefings retain their existing behavior. Private seller pricing/support questions use coaching; operations requests continue to use the existing assistant tools. Compensation is excluded from seller AI conversations, coaching drafts and approved coaching sends; admin operations retain their existing context and capabilities.

Difficult questions, undocumented prices and exceptions create persistent drafts and notify the configured reviewer in the app. Only that reviewer can edit, approve and send, or reject a draft. Unapproved drafts never go to sellers. Failed sends remain visible and retryable; interrupted sends after a restart need a WhatsApp check before retrying to avoid duplicates. “Sent” means WhatsApp accepted the message, not delivery or reading.

Managers participate in the same coaching cadence, manual check-in list, opt-out and owner-approval workflow. Manager check-ins encourage them to help their team enter leads and ask what support their sellers need. Existing manager operations tools and team permissions are preserved.

Completed coaching drafts (sent or rejected) can be hidden from the approval inbox. Use **View hidden drafts → Restore draft** to bring them back. Pending and failed drafts must be approved or rejected first, so cleanup cannot silently bypass review or pause outreach indefinitely.

## Notification preferences and opportunity profiles

Open **My account → Notification preferences** to choose email and phone push delivery for orders, owner mentions, other status changes, assignments, comments, new leads, reminders, waiting-lead alerts, coaching approvals and general alerts. All events remain in the in-app bell. Existing email, WhatsApp and device-registration switches still apply.

Personal WhatsApp alerts are limited to **Ordered** transitions and explicit mentions of the opportunity owner. Use **@owner** (also **@dueño**, **@rep**, **@vendedor** or **@vendedora**) or the owner’s username in a customer comment; the dispatch group also recognizes WhatsApp tags of the owner’s phone. An ordinary comment or an AI suggestion to notify the owner is not an urgent WhatsApp alert. The shared dispatch-group workflow operates independently: new leads post to the configured group, and replies add notes or update the lead’s CRM status. Personal notification preferences never disable these group posts. Admins can pause group posting with **Post every new lead to the dispatch group**. The v19 upgrade restores configured groups accidentally disabled by v18; other upgrades preserve explicit group settings. Direct assistant replies, manual coaching, approved answers, explicit group reminders and optional briefings retain their existing controls. Automatic coaching has its own personal opt-in, off by default.

Every customer record now names its **Opportunity owner**, using the existing credited seller (`created_by`). Entering on someone’s behalf preserves that seller as owner and records the actual entry author separately. Click owner, dispatcher or activity-author names to open their profile wall. Profiles show owned opportunities, open/order counts and activity only on records the viewer is already allowed to see. Another person’s wall does not expose account contact details, payment information or tracking IDs.

## Optional Texas energy options

On any customer record, including completed orders, choose **Energy options → Check energy service**. A **Check energy options** shortcut also appears after saving a new referral. Opening the tool makes no provider request. **Find meter** sends the entered service address and ZIP to ComparePower’s public ERCOT API; choose the correct meter before comparing. Switch holds and missing hold status block recommendations. If the meter’s twelve monthly usage estimates are unavailable, enter twelve customer-provided kWh values instead.

The server gets current plans for that meter’s TDSP and uses the pricing API’s authoritative **calculate/{usage}** bill totals for every distinct monthly usage value. It ranks estimated annual and average monthly bills, including bill credits and usage thresholds, rather than headline cents/kWh. Plans with incomplete calculations are excluded with a visible warning. Comparisons run in the background with progress, up to ten concurrent calculations, a two-minute deadline, and a fifteen-minute result/cache lifetime; at most 200 plans are calculated and the best 20 displayed. EFL/TOS/YRAAC snapshot links are shown when returned by the provider. These are estimates; current checkout terms and eligibility must be verified.

**Prepare checkout link** creates an attributed ComparePower handoff; it does not enroll a customer. Contact prefill is off by default and requires explicitly checking the name/email/phone option. **Save to customer record** adds an estimated quote as a note only when selected; it does not change the sale status.

**Admin → Settings → Energy options** controls the organization `cp_afid` and default `cp_afuid`. Defaults are the supplied public attribution values **eiwhj899** and **im3lwsos**. An owner’s personal **My account → Energy referral attribution** takes precedence for their `cp_afuid`, including when dispatch prepares the checkout. These public pricing and ERCOT endpoints use no API key or transaction credential.

Contract tests use a deterministic provider fixture to cover bill-credit ranking, switch holds, missing calculations, failures, record permissions, tracking attribution and explicit contact prefill. Live ComparePower requests and its developer reference returned HTTP 403 through this cloud workspace’s network proxy, so provider responses still need verification from the deployed service.
