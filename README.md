# Seat Watcher

Watches JIC Edugate for specific course sections to open up, and alarms
loudly (in-browser + macOS sound) when they do.

## Run it

```
npm start
```

First run installs dependencies and the Playwright Chromium browser
automatically (takes a minute or two). After that it starts instantly.
Your browser opens to `http://localhost:5173` automatically.

Click **Arm alarm 🔔** once — browsers block audio until you interact with
the page, so nothing will make sound until you click it. Use **Test sound**
any time to hear the exact alarm for 2 seconds without needing to be armed.

Leave the tab open on a screen you can see/hear. The server keeps polling
even if you close the tab, but sound only plays in an open, armed tab.

To stop: `Ctrl+C` in the terminal.

## Adding or removing courses/seqs

Click **⚙ Manage targets** on the page. It opens a panel with:

- **Currently watching** — every course group with its seqs as chips; click
  the `✕` on a chip to stop watching that section, or **Remove course** to
  drop the whole group.
- **Add a course** — type a course code (e.g. `MATH 202`) and click
  **Find sections**. This walks the live department tree looking for that
  course (can take up to ~20s — it's checking department pages one by one),
  then lists every section it found with instructor/time/status. Check the
  ones you want and click **Add selected**. You don't need to know which
  department page a course lives on; the search figures that out and saves
  it to `targets.json` for you.

Adding a course triggers an immediate extra poll for it (instead of waiting
for the next scheduled cycle), so its card fills in within a few seconds
rather than sitting on "CHECKING…" for up to 3 minutes.

This is the same `targets.json` described below — the panel just edits it
for you. You can still hand-edit the file directly if you prefer (see next
section); either way takes effect on the next poll cycle, no restart needed.

## Editing `targets.json`

```json
{
  "campus": "1",
  "campusLabel": "Jubail Industrial College",
  "degree": "2",
  "degreeLabel": "Bachelor",
  "pollIntervalSeconds": 180,
  "jitterSeconds": 30,
  "targets": [
    {
      "course": "ENGL 213",
      "department": "2-2-218-Instrumentation & Control Eng.",
      "seqs": ["1335", "1336"]
    },
    {
      "course": "ICE 224",
      "department": "2-2-218-Instrumentation & Control Eng.",
      "seqs": ["761"]
    },
    {
      "course": "BUS 481",
      "department": "2-2-218-Instrumentation & Control Eng.",
      "seqs": ["1268"]
    }
  ]
}
```

- **One card per target.** All `seqs` under one target are shown as rows on
  the same card, and the alarm fires if *any* of them goes Opened — this is
  how ENGL 213's two sections (1335, 1336) are set up.
- **`department`** is the exact link text of the department page on Edugate
  that lists this course (e.g. `"2-2-218-Instrumentation & Control Eng."`).
  A department's listing includes every course its own students take
  (electives, gen-ed, math/English requirements, etc.), so one department
  page usually covers several unrelated-looking courses — all three targets
  here happen to live on the same ICE department page. If you add a course
  that isn't on a department page you already use, you need to find which
  department lists it:
  1. Open the entry URL below, set campus/degree, click through department
     links in the tree.
  2. Once a department's course table loads, check whether your course code
     appears in it.
  3. Copy that department's exact link text into `department` in
     `targets.json`.
  The poller only loads the distinct set of department pages your targets
  reference, so adding a `seq` from a department you already watch is free.
- **`seqs`** are the "Seq." numbers from the portal — unique per section.
- **`pollIntervalSeconds`** / **`jitterSeconds`** control the polling cadence
  (default: every 3 minutes, plus 0–30s random jitter, to avoid hammering
  the portal).
- **`campus`** / **`degree`** are the raw `<select>` values Edugate expects
  (`campus=1` is Jubail Industrial College male campus; `degree=2` is
  Bachelor — see the dropdowns on the portal if you need other values).

Edits to `targets.json` take effect on the *next* poll cycle — no restart
needed.

## What the page shows

- A card per target with a big status pill: **green OPEN**, **grey CLOSED**,
  **amber ERROR** (or amber CHECKING before the first successful poll).
- Each row: seq, instructor, days/time/room.
- Header: last-checked time, a relative "X ago", and a countdown to the next
  check. If the last *successful* check is more than 10 minutes old, the
  header turns amber and says so — that's your signal something's wrong
  with the scraper or the portal, independent of any one course's status.

## Sound

- **Arm alarm 🔔** unlocks WebAudio with a user gesture (required by
  browsers) and arms the page to actually sound the alarm on future opens.
- **Test sound** plays the real alarm tone for 2 seconds any time.
- When an armed target goes Opened, the page plays a loud repeating
  WebAudio beep and flashes the tab title (`🔴 OPEN — ENGL 213`) until you
  click **Acknowledge**. Acknowledging silences that section until it goes
  Closed → Opened again (e.g. someone drops it after you register, it can
  re-alarm).
- As a backup in case the tab is buried or muted, the *server* also sends a
  push notification via [ntfy.sh](https://ntfy.sh) whenever a section flips
  to Opened — set `NTFY_TOPIC` in `.env` to enable it (see below). No-op if
  unset.

## Configuration via `.env`

Copy `.env.example` to `.env` to override these (all optional):

| Variable       | Default              | Meaning                                                |
|----------------|----------------------|---------------------------------------------------------|
| `PORT`         | `5173`               | Port the Express server binds on `127.0.0.1`.           |
| `NTFY_TOPIC`   | unset (disabled)     | ntfy.sh topic for push notifications on section opens.  |
| `POLL_MINUTES` | unset (uses `targets.json`'s `pollIntervalSeconds`) | Poll interval in minutes; overrides `targets.json` when set. |

`.env` is gitignored (along with `node_modules/` and `history.log`) — it's
per-deployment, not something to commit.

## Files

- `targets.json` — what to watch (edit this, or use ⚙ Manage targets).
- `.env` — local overrides (see above); `.env.example` is the template.
- `history.log` — append-only log of every status change, with timestamps.
  Created automatically on the first change.
- `server.js` / `lib/poller.js` / `lib/scraper.js` / `lib/notify.js` — the
  Express server, polling loop, Playwright scraper, and ntfy.sh push backup.
- `public/` — the plain HTML/CSS/JS frontend, polls `/status` every 5s.
- `ecosystem.config.js` — pm2 process definition for production (see
  Deployment below).

## How the scraper works

Fresh navigation from the Edugate guest timetable every cycle (the JSF
session expires, so re-navigating each time is more reliable than trying to
keep a session alive): set campus/degree via the two `<select>` elements and
a form submit, click the department link, then read every section row
straight out of the DOM — including meeting times, which live in a hidden
input per row rather than needing the "Details" popup. If parsing ever comes
back empty (portal changed, session hiccup), the poller restarts the whole
flow once before giving up and marking that cycle as an error in the
terminal log and the header. One failed cycle never stops the loop; the
browser process itself stays warm between cycles and only relaunches if it
actually dies.

## Deployment (Ubuntu droplet + nginx + pm2)

The server binds to `127.0.0.1` only — nginx is expected to be the only
thing that can reach it, and everything runs under pm2 so it survives
unattended for weeks.

**1. On the droplet**, as the user that will run the app (root is fine, but
this also works under a dedicated non-root user — just make sure it's the
same user pm2 runs as):

```bash
git clone <this repo> /opt/jic-watcher   # or scp/rsync it over
cd /opt/jic-watcher
npm install                 # also downloads Playwright's Chromium via postinstall
npx playwright install-deps # installs the OS shared libs Chromium needs (needs sudo/root) —
                             # skip this on a fresh droplet and Chromium fails to launch at all
cp .env.example .env
$EDITOR .env                # set NTFY_TOPIC at least; PORT/POLL_MINUTES are optional
```

**2. Install and start pm2:**

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save                    # persist the process list
pm2 startup                 # prints a systemd command to run once, so pm2
                             # (and this app) comes back up after a droplet reboot
```

Useful pm2 commands: `pm2 logs jic-watcher`, `pm2 restart jic-watcher`,
`pm2 monit`.

**3. nginx** — reverse proxy to the app on `127.0.0.1:5173` (or whatever
`PORT` you set):

```nginx
server {
    listen 80;
    server_name your-domain-or-ip;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Reload with `sudo nginx -t && sudo systemctl reload nginx`. Add TLS with
`certbot --nginx` if this is reachable on a public domain.

**Updating after a code change:**

```bash
cd /opt/jic-watcher
git pull
npm install       # only needed if dependencies changed
pm2 restart jic-watcher
```

**Why `--no-sandbox`:** Chromium's sandbox needs a setuid helper that
doesn't work when the browser is launched as root (the common case on a
freshly provisioned droplet with no dedicated app user), so it refuses to
start without `--no-sandbox`. `--disable-dev-shm-usage` avoids a separate
crash from Chromium filling the tiny default `/dev/shm` on most cloud VM
images. Both are already set in `lib/scraper.js` — no droplet-specific code
needed, they're harmless on macOS too.
