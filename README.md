# WhatsApp Group Agent

A self-hosted bot that manages one WhatsApp group:

1. Rotates the group title on a schedule.
2. Posts a daily activity/prompt.
3. Tracks who's been quiet and posts an idle-member report.
4. Sends birthday wishes from a CSV list you maintain.

It logs into WhatsApp as a **regular linked device** on a phone number you
control (using the [Baileys](https://github.com/WhiskeySockets/Baileys)
library) — not Meta's official Business API. Read "Important caveats"
below before you rely on this.

## Important caveats — read first

- **This is unofficial.** It automates a real WhatsApp account by
  impersonating the WhatsApp Web protocol. It is not sanctioned by
  WhatsApp's Terms of Service, and accounts that behave like bots can be
  flagged or banned. Use the spare/secondary number you set aside for
  this, not your primary personal number.
- **Keep the message volume low and human-like.** The default config
  posts at most a few messages a day — resist the urge to add much more.
- **The bot number must be a group admin** to change the group subject.
- **Birthdays and idle detection are best-effort.** Idle tracking only
  sees messages sent *after* the bot is running and connected — it has
  no way to see history from before it joined. Birthdays come entirely
  from `data/birthdays.csv`; WhatsApp does not expose profile birthdates.

## 1. One-time setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- Leave `GROUP_JID` blank for now.
- Set `BOT_PHONE_NUMBER` to the dedicated number's full international
  number, digits only (e.g. `233241234567`).
- `TIMEZONE` defaults to `Africa/Accra` — change if needed.

Edit `data/birthdays.csv` with your real list — columns are
`phone,name,month,day` (phone = digits only, no `+`, month/day as
numbers, e.g. `7,29` for July 29).

Edit `config.json` to adjust the title list, activity prompts, idle
threshold, and cron schedules to taste. Cron format is
`minute hour day-of-month month day-of-week`, evaluated in the
`TIMEZONE` you set. A couple of examples:
- `0 6 * * 1` → every Monday at 6:00am
- `0 9 * * *` → every day at 9:00am

## 2. Link the bot to WhatsApp

Run it once locally/interactively:

```bash
npm start
```

You'll be given an 8-character **pairing code** in the terminal. On the
*bot's* phone: WhatsApp → Settings → Linked Devices → Link a Device →
"Link with phone number instead" → enter the code. Once linked, the
console prints "WhatsApp connection established." and the credentials
are saved to `auth_state/` — you won't need to re-link unless you log
the device out.

Then send any message in your target group. The console will print:

```
[startup] Discovered group JID: 12036301XXXXXXXXX@g.us
```

Copy that into `.env` as `GROUP_JID`, stop the process (Ctrl+C), and
restart it. From now on it'll pick up the group automatically.

## 3. Deploy it to run 24/7

The bot needs a long-lived process (it holds an open WebSocket to
WhatsApp), so it can't run as a serverless function — a small
always-on VPS works well. Any $5–6/month box (DigitalOcean, Hetzner,
a Fly.io VM, a Railway worker, etc.) is enough; it's barely using any
resources.

### Option A: Docker (works on any VPS with Docker installed)

Copy this whole project folder to the server, then:

```bash
# First run, interactively, to complete pairing:
docker compose run --rm whatsapp-group-agent
#   -> enter the pairing code shown, wait for "connection established",
#      send a test message in the group to discover its JID, fill in
#      GROUP_JID in .env, then Ctrl+C.

# Every run after that, run it in the background:
docker compose up -d --build

# Check logs any time:
docker compose logs -f
```

`auth_state/` and `data/` are mounted as volumes, so your WhatsApp
session and SQLite database survive container restarts and rebuilds.

### Option B: Plain Node on a fresh Ubuntu/Debian VPS

```bash
# On the server
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential

# Copy the project up (scp/rsync/git clone), then:
cd whatsapp-group-agent
npm install
cp .env.example .env   # fill it in
npm start               # do the pairing-code step interactively once

# Once linked, keep it running permanently with pm2:
sudo npm install -g pm2
pm2 start src/index.js --name whatsapp-group-agent
pm2 save
pm2 startup   # follow the printed instructions to survive reboots
```

## 4. Day-to-day operation

- Logs print to the console (or `docker compose logs -f` / `pm2 logs`).
- To change schedules, titles, prompts, or the idle threshold, edit
  `config.json` and restart the process — no re-linking needed.
- To update birthdays, edit `data/birthdays.csv` and restart.
- If the bot ever gets logged out (e.g. you unlink it from the phone),
  delete the `auth_state/` folder and repeat step 2.

## Project layout

```
src/
  config.js        loads config.json + .env
  db.js             SQLite: member last-seen tracking, small key/value store
  whatsapp.js       Baileys connection + pairing-code login
  features/
    titleRotator.js   scheduled group subject changes
    dailyActivity.js  scheduled activity/prompt posts
    idleReport.js     tracks last-seen timestamps, posts idle report
    birthday.js        reads data/birthdays.csv, posts wishes
  index.js          wires it all together
config.json         all schedules/content, safe to edit anytime
data/birthdays.csv  your birthday list
```
