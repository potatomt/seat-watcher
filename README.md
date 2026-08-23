# Seat Watcher

Watches JIC Edugate for specific course sections to open up, and alarms
loudly (in-browser + optional push notification) when they do.

## Per-browser watchlists — no accounts, no login

Each browser gets its own watchlist, identified by an anonymous cookie —
there's no sign-up, no password, no shared list. The first time you load the
page, the server sets an `sid` cookie (a random UUID, `httpOnly`, good for a
year) and everything you add in **⚙ Manage Targets** is tied to that cookie
alone. Open the page in a different browser, or in a private/incognito
window, and you get a completely separate, empty watchlist.

What this means in practice:

- **Clearing cookies loses your watchlist.** There's no recovery — the
  server only knows a session by its cookie, not by you. If you use private
  browsing or clear cookies regularly, this isn't the tool for that; add
  your courses again after, or keep a note of what you're watching.
- **One browser, one alarm.** Arming, acknowledging, and the alarm sound are
  all per-session. You arming your tab never triggers anyone else's, and
  someone else's watchlist never shows up in your dashboard.
- **This is intentional**, not a missing feature — the goal was "share one
  server with a few people, each watching their own courses" without
  standing up real auth for something this low-stakes. If you genuinely need
  accounts (e.g. recovering a watchlist across devices), that's a different,
  bigger project.
- The scraper is still smart about sharing work: if two people both watch
  something on the same Edugate department page, that page is scraped once
  per cycle and the result is filtered down to each person's own targets —
  see "How polling scales with visitors" below.

## Run it

```
npm start
```

First run installs dependencies and the Playwright Chromium browser
automatically (takes a minute or two). After that it starts instantly.
Your browser opens to `http://localhost:5173` automatically.

On that first load, since you have no targets yet, **Manage Targets** opens
automatically instead of an empty dashboard — add a course to get started.

Click **Arm alarm 🔔** once — browsers block audio until you interact with
the page, so nothing will make sound until you click it. Use **Test sound**
any time to hear the exact alarm for 2 seconds without needing to be armed.

Leave the tab open on a screen you can see/hear. The server keeps polling
even if you close the tab, but the in-browser alarm only plays in an open,
armed tab — for alerts without a tab open, set up an ntfy topic (see
Notifications below).

To stop: `Ctrl+C` in the terminal.

## Adding or removing courses/seqs

Click **⚙ Manage Targets** on the page. It opens a panel with:

- **Currently watching** — every course group with its seqs as chips (and a
  running count against the per-session cap — see below); click the `✕` on
  a chip to stop watching that section, or **Remove course** to drop the
  whole group.
- **Add a course** — type a course code (e.g. `MATH 202`) and click
  **Find sections**. This walks the live department tree looking for that
  course (can take up to ~20s — it's checking department pages one by one),
  then lists every section it found with instructor/time/status. Check the
  ones you want and click **Add selected**. You don't need to know which
  department page a course lives on; the search figures that out.
- **Notifications** — see below.

Adding a course triggers an immediate extra poll for it (instead of waiting
for the next scheduled cycle), so its card fills in within a few seconds
rather than sitting on "CHECKING…" for up to 3 minutes.

Everything in this panel operates on *your* watchlist only (identified by
your cookie) — see "Per-browser watchlists" above.

**Cap:** each session can watch at most 15 seqs total, so one person adding
courses can't accidentally make the poller scrape the whole catalog on
everyone's behalf. Trying to add past that returns an error explaining the
cap.

## What the page shows

- A card per target with a big status pill: **green OPEN**, **grey CLOSED**,
  **amber ERROR** (or amber CHECKING before the first successful poll).
- Each row: seq, instructor, days/time/room.
- Header: last-checked time, a relative "X ago", and a countdown to the next
  check. If the last *successful* check is more than 10 minutes old, the
  header turns amber and says so — that's your signal something's wrong
  with the scraper or the portal, independent of any one course's status.

## Sound & notifications

- **Arm alarm 🔔** unlocks WebAudio with a user gesture (required by
  browsers) and arms *this session* to actually sound the alarm on future
  opens.
- **Test sound** plays the real alarm tone for 2 seconds any time.
- When an armed target goes Opened, the page plays a loud repeating
  WebAudio beep and flashes the tab title (`🔴 OPEN — ENGL 213`) until you
  click **Acknowledge**. Acknowledging silences that section until it goes
  Closed → Opened again (e.g. someone drops it after you register, it can
  re-alarm). This is per-session — acknowledging in your tab doesn't affect
  anyone else watching the same seq.
- **Push notifications (optional):** in Manage Targets → Notifications, set
  your own [ntfy.sh](https://ntfy.sh) topic — pick a private, hard-to-guess
  name and subscribe to it in the ntfy app or at `ntfy.sh/<your-topic>`.
  When one of *your* targets flips to Opened, the server pushes to *your*
  topic only, whether or not your tab is open. This is per-session, stored
  with your cookie, same as your watchlist — there's no global notification
  topic anymore, so other visitors never see your alerts and you never see
  theirs.

If you don't set an ntfy topic, the only alert is the in-browser one, which
needs the tab open and armed. The Notifications panel says as much.

## Configuration via `.env`

Copy `.env.example` to `.env` to override these (all optional):

| Variable       | Default              | Meaning                                                |
|----------------|----------------------|---------------------------------------------------------|
| `PORT`         | `5173`               | Port the Express server binds on `127.0.0.1`.           |
| `POLL_MINUTES` | `3`                  | Poll interval in minutes.                                |
| `PROXY_URL`    | unset (direct connection) | Proxy for the scraper's browser, e.g. `socks5://127.0.0.1:1055`. See below. |

`.env` is gitignored (along with `node_modules/`, `data/`, and
`history.log`) — it's per-deployment, not something to commit.

### Proxy (`PROXY_URL`)

Edugate is geo-restricted to Saudi Arabia. If this server runs somewhere
else, set `PROXY_URL` to route the scraper's browser through something
inside the country — a Tailscale exit node is a natural fit if you already
have a machine on a Saudi network/VPN:

```
PROXY_URL=socks5://127.0.0.1:1055
```

Passed straight to Playwright as `proxy: { server: PROXY_URL }`. Leave unset
to connect directly, which is the normal case for local dev when you're
already on a Saudi network/VPN — startup logs `proxy: none` either way so
it's obvious which mode is active. The portal is noticeably slower through a
proxy, so navigation timeouts are set to 60s (up from Playwright's 30s
default); a timeout there is treated the same as any other failed cycle —
logged, retried once, and never crashes the process.

## How polling scales with visitors

Every cycle:

1. Compute the union of course codes across every session's targets.
2. Map each course to its department page (a small shared cache — see
   `data/department-cache.json` — populated the first time anyone's "Find
   sections" search resolves that course, so this is normally a cache hit,
   not a live lookup).
3. Scrape only the distinct department pages that union actually needs —
   **if nobody has any targets, the browser isn't launched at all that
   cycle.**
4. One page's scrape already contains every session's targets on that page
   — it's fetched once, not once per person.
5. The result is cached; each person's `/api/status` filters that shared
   cache down to their own seqs. No visitor's request ever triggers its own
   scrape.

The terminal log reflects this each cycle, e.g.:

```
[3:41:12 PM] OK  departments=[2-2-218-Instrumentation & Control Eng. | 2-2-217-Electrical Engineering]  sessionsServed=3  seqsTracked=314
```

## Storage

- `data/sessions.json` — one entry per browser: `targets`, `armed`,
  `acknowledgedSeqs`, `ntfyTopic`, `createdAt`, `lastSeenAt`. Plain JSON with
  an in-process write queue serializing saves — no database needed at this
  scale (a handful of anonymous sessions). Sessions untouched for 90+ days
  are dropped automatically (checked once a day, not per-request).
- `data/department-cache.json` — shared `course code -> department page`
  lookup, populated by course searches.
- `config.json` — small, effectively-static settings shared by everyone
  (which campus/degree this instance watches at all). Not per-session state,
  so it lives outside `data/`.
- `history.log` — append-only log of watched-seq status changes, with
  timestamps. Created automatically on the first change.

`data/` is gitignored — it's runtime state, not something to commit.

## Files

- `data/`, `config.json` — storage, see above.
- `.env` — local overrides (see above); `.env.example` is the template.
- `server.js` — Express app: cookie/session middleware, the `/api/*` routes.
- `lib/sessionStore.js` — per-browser watchlist storage + validation.
- `lib/departmentCache.js` — the shared course→department lookup.
- `lib/config.js` — loads `config.json`.
- `lib/poller.js` — the polling loop (see "How polling scales" above).
- `lib/scraper.js` — Playwright: navigation, parsing, course search.
- `lib/notify.js` — ntfy.sh push, now per-session (takes a topic argument).
- `lib/migrate.js` — one-time `targets.json` → `data/sessions.json` migration.
- `public/` — the plain HTML/CSS/JS frontend, polls `/api/status` every 5s.
- `ecosystem.config.js` — pm2 process definition for production (see
  Deployment below).

## API

All `/api/*` routes require the `sid` cookie (set automatically on your
first page load) and respond `400` without one — a bare `curl` with no
cookie jar gets a clear error rather than silently starting an orphaned
session nobody can ever reach again.

| Route | Method | Does |
|---|---|---|
| `/api/targets` | GET | This session's watchlist. |
| `/api/targets` | POST | Replace this session's watchlist (`{ targets: [{course, seqs}] }`). Validates course format and seq format, enforces the 15-seq cap. |
| `/api/search-course` | GET | `?course=` — live department-tree search (see Manage Targets above). |
| `/api/status` | GET | This session's targets merged with the last completed cycle's cached status — never triggers a scrape itself. |
| `/api/acknowledge` | POST | `{ seq }` — dismiss the alarm for one seq, this session only. |
| `/api/armed` | POST | `{ armed }` — per-session arm state. |
| `/api/settings` | POST | `{ ntfyTopic }` — set or clear this session's push topic. |

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

## Migrating from the old shared `targets.json`

Older versions of this app had one shared `targets.json` for everyone. On
first boot after upgrading, if `targets.json` still exists and
`data/sessions.json` doesn't, it's migrated automatically:

- The old watchlist becomes a session keyed `"default"` in
  `data/sessions.json` (campus/degree settings move to `config.json`, and
  each target's `department` seeds `data/department-cache.json`).
- If `NTFY_TOPIC` was set in `.env` under the old global-notification model,
  it's carried over as that session's `ntfyTopic` so push notifications keep
  working for whoever had it configured, instead of silently going dark.
- `targets.json` is renamed to `targets.json.bak` (kept, not deleted).
- The **first browser to load the page** after this migration automatically
  adopts the `"default"` session onto its own real cookie — in practice,
  that's whoever was already using the app, so their watchlist just keeps
  working with no manual steps. After that one adoption, `"default"` no
  longer exists, and every subsequent new visitor gets a normal empty
  session as usual.

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
$EDITOR .env                # PORT/POLL_MINUTES/PROXY_URL are all optional
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
