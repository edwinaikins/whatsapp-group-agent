# WhatsApp Group Agent

A self-hosted bot that manages one WhatsApp group:

1. Rotates the group title on a schedule.
2. Posts a daily activity/prompt (optionally with an image).
3. Tracks who's been quiet and posts an idle-member report.
4. Sends birthday wishes (optionally with a photo) from a list you maintain.

The content for #1, #2, and #4 (titles, activity prompts, birthday list)
lives in an **Airtable base** rather than in files on the server, so you
can edit it from a normal spreadsheet-style UI — including uploading
photos — without touching the VPS. See "Set up the Airtable base" below.

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
  from the Airtable Birthdays table; WhatsApp does not expose profile
  birthdates.
- **If Airtable is unreachable** (bad token, network hiccup, Airtable
  outage) when a scheduled job fires, the bot falls back to the last
  successfully fetched copy of that table, cached on disk under
  `data/airtable-cache/`. Only if there's no cache yet does it skip
  that run.

## 1. Set up the Airtable base

Create a free account at [airtable.com](https://airtable.com) and make a
new base (e.g. named "WhatsApp Group Agent") with these three tables:

**Titles** — used for the group-title rotation
| Field  | Type          |
|--------|---------------|
| Title  | Single line text |
| Order  | Number (sets rotation order) |

**ActivityPrompts** — used for the daily activity post
| Field  | Type          |
|--------|---------------|
| Prompt | Long text     |
| Image  | Attachment (optional — attach a photo to include it in that day's post) |
| Order  | Number (sets rotation order) |

**Birthdays** — used for birthday wishes
| Field  | Type          |
|--------|---------------|
| Name   | Single line text |
| Phone  | Single line text (digits only, country code, no `+`, e.g. `233241234567`) |
| Month  | Number (1-12) |
| Day    | Number (1-31) |
| Photo  | Attachment (optional — attach a photo to include it in that day's wish) |

Fill in a few rows in each table now. For photos, keep them reasonably
sized (resize to ~800px wide before uploading) — Airtable's free tier
caps attachment storage at 1GB per base, and WhatsApp recompresses
images on send anyway, so a smaller source file loses nothing visible.

Then get your credentials:
- **Personal access token**: click your account icon → **Developer Hub**
  → **Personal access tokens** → **Create token**. Give it the
  `data.records:read` scope, and under "Access" add just this one base.
  Copy the token (starts with `pat...`).
- **Base ID**: open the base → **Help** → **API documentation** (or just
  look at the base's URL) — it looks like `appXXXXXXXXXXXXXX`.

## 2. One-time setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- Leave `GROUP_JID` blank for now.
- Set `BOT_PHONE_NUMBER` to the dedicated number's full international
  number, digits only (e.g. `233241234567`).
- Set `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID` from the step above.
- `TIMEZONE` defaults to `Africa/Accra` — change if needed.

Edit `config.json` to adjust cron schedules and the idle threshold to
taste (the actual titles/prompts/birthdays now live in Airtable, not
here). Cron format is `minute hour day-of-month month day-of-week`,
evaluated in the `TIMEZONE` you set. A couple of examples:
- `0 6 * * 1` → every Monday at 6:00am
- `0 9 * * *` → every day at 9:00am

## 3. Link the bot to WhatsApp

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

## 4. Deploy it to run 24/7

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

## 5. Day-to-day operation

- Logs print to the console (or `docker compose logs -f` / `pm2 logs`).
- To change titles, activity prompts, or birthdays: just edit the rows
  in the Airtable base — no server access, redeploy, or restart needed.
  The bot fetches fresh data right before each scheduled action.
- To change schedules or the idle threshold, edit `config.json` and
  restart the process.
- If the bot ever gets logged out (e.g. you unlink it from the phone),
  delete the `auth_state/` folder and repeat step 3.

## Project layout

```
src/
  config.js        loads config.json + .env
  db.js             SQLite: member last-seen tracking, small key/value store
  airtable.js       fetches Titles/ActivityPrompts/Birthdays from Airtable,
                     with an on-disk cache fallback
  whatsapp.js       Baileys connection + pairing-code login
  features/
    titleRotator.js   scheduled group subject changes (from Airtable Titles)
    dailyActivity.js  scheduled activity/prompt posts (from ActivityPrompts)
    idleReport.js     tracks last-seen timestamps, posts idle report
    birthday.js        birthday wishes (from Airtable Birthdays)
  index.js          wires it all together
config.json               schedules + idle threshold, safe to edit anytime
data/airtable-cache/       auto-generated fallback cache, not for editing
```
