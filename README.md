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
  served over HTTPS (via the reverse-proxy setup below) specifically so
  that password never travels in the clear.

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
- `TIMEZONE` defaults to `Africa/Accra` — change if needed.
- `HOST_PORT` defaults to `3000` — only change it if something else on
  the server already uses port 3000 (see step 4).

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

Create a DNS **A record** for the subdomain you want the dashboard on
(e.g. `agent.yourdomain.com`), pointing at the VPS's IP address, and
give it a little time to propagate before the next step (Let's Encrypt
needs to actually reach that hostname to issue a certificate).

## 4. Deploy it to run 24/7

The bot needs a long-lived process (it holds an open WebSocket to
WhatsApp), so it can't run as a serverless function — a small
always-on VPS works well.

Copy this whole project folder to the server, then:

```bash
# First run, interactively, to complete pairing:
docker compose run --rm whatsapp-group-agent
#   -> enter the pairing code shown, wait for "connection established",
#      send a test message in the group to discover its JID, fill in
#      GROUP_JID in .env, then Ctrl+C.

# Bring it up in the background:
docker compose up -d --build
docker compose logs -f
```

This publishes the dashboard on `127.0.0.1:3000` only (or whatever
`HOST_PORT` you set in `.env` — see below) — it's not reachable from
the internet until a reverse proxy in front of it terminates HTTPS on
your public hostname. `auth_state/` and `data/` (SQLite DB + uploaded
images) persist across container restarts and rebuilds.

If `docker compose up -d --build` fails with something like `failed to
bind host port 127.0.0.1:3000/tcp: address already in use`, something
else on the VPS already owns port 3000 (run `sudo ss -tlnp | grep 3000`
to see what). Rather than fighting over it, set a different one in
`.env`:

```
HOST_PORT=3001
```

then `docker compose up -d --build` again — just remember to point
`proxy_pass` at that same port in the nginx block below.

### If nginx is already running other sites on this VPS

Don't run a second thing on ports 80/443 — add the dashboard as another
site in your existing nginx instead. Create
`/etc/nginx/sites-available/agent.yourdomain.com` (swap in your real
subdomain) with:

```nginx
server {
    listen 80;
    server_name agent.yourdomain.com;

    # Birthday/prompt photos and group icons can be a few MB — nginx's
    # 1MB default would reject those uploads with a 413 otherwise.
    client_max_body_size 20M;

    location / {
        # Match this to HOST_PORT in .env (3000 unless you changed it).
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then enable it and get a certificate:

```bash
sudo ln -s /etc/nginx/sites-available/agent.yourdomain.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d agent.yourdomain.com
```

`certbot` rewrites that server block to add the certificate, `listen
443 ssl`, and an HTTP→HTTPS redirect automatically. This doesn't touch
whatever's already configured for your other site(s) on the same nginx.

### If this VPS has no reverse proxy at all yet

Simplest option: install nginx and certbot fresh, then follow the same
steps above.

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

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

Still needs the nginx (or other reverse proxy) setup above for the
dashboard's public HTTPS access.

## 5. The dashboard

Visit `https://agent.yourdomain.com` (your actual subdomain) and log in.
From there you can:

- **Group settings** — rename the group or upload a new icon immediately.
- **Schedule a group action** — pick a date/time (in your browser's
  local timezone) and choose to post a message (optionally with an
  image), rename the group, or change its icon at that moment; a
  background check runs every minute. Pending actions can be cancelled
  before they fire.
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
data/uploads/        images uploaded via the dashboard
```
