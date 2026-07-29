# WhatsApp Group Agent

A self-hosted bot + web dashboard that manages one WhatsApp group:

1. Rotates the group title on a schedule.
2. Posts a daily activity/prompt (optionally with an image).
3. Tracks who's been quiet and posts an idle-member report.
4. Sends birthday wishes (optionally with a photo) from a list you maintain.
5. Lets you schedule one-off posts, and rename/re-icon the group on demand,
   from a small web dashboard.

Titles, activity prompts, birthdays, and scheduled posts are all managed
from the dashboard — no server access or redeploys needed for day-to-day
content changes. See "The dashboard" below.

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
- **The bot number must be a group admin** to change the group subject
  and icon.
- **Idle detection is best-effort.** It only sees messages sent *after*
  the bot is running and connected — it has no way to see history from
  before it joined.
- **The dashboard can post to the group, rename it, and change its
  icon** — anyone with the login can do all of that, so treat the
  password like you would any account with real-world consequences. It's
  served over HTTPS (via the Caddy setup below) specifically so that
  password never travels in the clear.

## 1. One-time setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- Leave `GROUP_JID` blank for now.
- Set `BOT_PHONE_NUMBER` to the dedicated number's full international
  number, digits only (e.g. `233241234567`).
- Set `ADMIN_USER` / `ADMIN_PASSWORD` for the dashboard login — pick a
  strong password.
- Set `DOMAIN` to the subdomain you'll point at the VPS (e.g.
  `agent.yourdomain.com`) — see step 4.
- `TIMEZONE` defaults to `Africa/Accra` — change if needed.

Edit `config.json` to adjust cron schedules and the idle threshold to
taste. Cron format is `minute hour day-of-month month day-of-week`,
evaluated in the `TIMEZONE` you set. A couple of examples:
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

## 3. Point a subdomain at the VPS

Before starting the dashboard, create a DNS **A record** for the
subdomain you put in `.env` as `DOMAIN`, pointing at the VPS's IP
address. This has to be in place (and to have propagated — usually
minutes, occasionally longer) before Caddy can request its certificate,
since Let's Encrypt validates ownership by reaching that hostname.

Also make sure ports **80** and **443** are open on the VPS (cloud
firewall / security group, and any host firewall like `ufw`) — Caddy
needs 80 for the ACME HTTP challenge and 443 to serve the dashboard.

## 4. Deploy it to run 24/7

The bot needs a long-lived process (it holds an open WebSocket to
WhatsApp), so it can't run as a serverless function — a small
always-on VPS works well. Any $5–6/month box (DigitalOcean, Hetzner,
a Fly.io VM, a Railway worker, etc.) is enough; it's barely using any
resources.

Copy this whole project folder to the server, then:

```bash
# First run, interactively, to complete pairing:
docker compose run --rm whatsapp-group-agent
#   -> enter the pairing code shown, wait for "connection established",
#      send a test message in the group to discover its JID, fill in
#      GROUP_JID in .env, then Ctrl+C.

# Bring everything up, including Caddy (which will request the
# certificate for DOMAIN on first start — check its logs if it hangs):
docker compose up -d --build
docker compose logs -f caddy
docker compose logs -f whatsapp-group-agent
```

Once Caddy reports it obtained a certificate, the dashboard is live at
`https://<DOMAIN>` — log in with `ADMIN_USER` / `ADMIN_PASSWORD`.

`auth_state/`, `data/` (SQLite DB + uploaded images), and Caddy's
certificate volumes all persist across container restarts and rebuilds.

### Alternative: plain Node instead of Docker

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential

cd whatsapp-group-agent
npm install
cp .env.example .env   # fill it in
npm start               # do the pairing-code step interactively once

sudo npm install -g pm2
pm2 start src/index.js --name whatsapp-group-agent
pm2 save
pm2 startup   # follow the printed instructions to survive reboots
```

Note this skips Caddy — you'd need to set up your own reverse proxy /
TLS termination (e.g. nginx + certbot) for the dashboard in this case.

## 5. The dashboard

Visit `https://<DOMAIN>` and log in. From there you can:

- **Group settings** — rename the group or upload a new icon immediately.
- **Schedule a one-off post** — pick a date/time (in your browser's
  local timezone), optionally attach an image, and it'll post
  automatically at that moment; a background check runs every minute.
  Pending posts can be cancelled before they fire.
- **Title rotation** — add/remove/reorder the titles the bot cycles
  through on its schedule.
- **Daily activity prompts** — add/remove/reorder prompts, optionally
  with an image attached to each.
- **Birthdays** — add/remove entries (name, phone, month, day, optional
  photo) for the daily birthday check.

Uploaded images are stored under `data/uploads/` on the VPS (persisted
across rebuilds) and are deleted automatically once the row/action that
used them is gone.

## 6. Day-to-day operation

- Logs print to the console (or `docker compose logs -f`).
- Everything content-related (titles, prompts, birthdays, one-off
  posts, group name/icon) is managed from the dashboard — no restart
  needed.
- To change cron schedules or the idle threshold, edit `config.json`
  and restart the `whatsapp-group-agent` container/process.
- If the bot ever gets logged out (e.g. you unlink it from the phone),
  delete the `auth_state/` folder and repeat step 2.

## Project layout

```
src/
  config.js         loads config.json + .env
  db.js              SQLite: members, titles, prompts, birthdays,
                      scheduled posts, small key/value store
  server.js          Express dashboard: auth, CRUD APIs, uploads,
                      group name/icon endpoints
  whatsapp.js        Baileys connection + pairing-code login
  features/
    titleRotator.js    scheduled group subject changes
    dailyActivity.js   scheduled activity/prompt posts
    idleReport.js      tracks last-seen timestamps, posts idle report
    birthday.js         daily birthday check + wishes
    scheduledPosts.js   sends due one-off posts (checked every minute)
  index.js           wires it all together, starts the dashboard server
public/
  index.html         the dashboard's single-page frontend
config.json          schedules + idle threshold, safe to edit anytime
Caddyfile            reverse proxy config; DOMAIN is templated in from .env
data/uploads/        images uploaded via the dashboard
```
