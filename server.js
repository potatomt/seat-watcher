require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { migrateIfNeeded } = require('./lib/migrate');
const { SessionStore, ValidationError, normalizeCourseCode, MAX_TARGETS_PER_SESSION } = require('./lib/sessionStore');
const { DepartmentCache } = require('./lib/departmentCache');
const { Poller } = require('./lib/poller');
const { loadConfig } = require('./lib/config');

migrateIfNeeded();

const PORT = process.env.PORT || 5173;
const HOST = '127.0.0.1'; // nginx is the only thing that should reach this
const SID_COOKIE = 'sid';
const SID_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const sessionStore = new SessionStore();
const departmentCache = new DepartmentCache();
const poller = new Poller(sessionStore, departmentCache);

const app = express();
app.use(cookieParser());
app.use(express.json());

// Mints a sid cookie for any page load that doesn't have one yet. API calls
// never mint one themselves (see requireSession below) — a bare curl with no
// cookie jar should get a clear 400, not a silently orphaned new session.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && !req.cookies[SID_COOKIE]) {
    let sid;
    if (sessionStore.has('default')) {
      // One-time adoption of the pre-migration watchlist by whoever's
      // browser visits first. After this, "default" no longer exists.
      sid = crypto.randomUUID();
      sessionStore.rename('default', sid);
      console.log(`Migrated "default" session adopted by new sid ${sid}.`);
    } else {
      sid = crypto.randomUUID();
    }
    res.cookie(SID_COOKIE, sid, {
      httpOnly: true,
      maxAge: SID_MAX_AGE_MS,
      sameSite: 'lax',
    });
    req.cookies[SID_COOKIE] = sid;
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function requireSession(req, res, next) {
  const sid = req.cookies[SID_COOKIE];
  if (!sid) {
    return res.status(400).json({ error: 'missing sid cookie — load the page first' });
  }
  req.sid = sid;
  sessionStore.touch(sid);
  next();
}

app.use('/api', requireSession);

app.get('/api/targets', (req, res) => {
  const session = sessionStore.getOrCreate(req.sid);
  res.json({
    targets: session.targets,
    armed: session.armed,
    ntfyTopic: session.ntfyTopic,
    maxTargets: MAX_TARGETS_PER_SESSION,
  });
});

app.post('/api/targets', (req, res) => {
  try {
    const { targets } = req.body || {};
    const { session, resolvedDepartments } = sessionStore.setTargets(req.sid, targets);

    // Seed the shared department cache from any hints the client already
    // has (it just ran a search to find these), and give brand-new seqs a
    // CHECKING grace period instead of a false ERROR.
    const withDept = resolvedDepartments.filter((d) => d.department);
    if (withDept.length) {
      departmentCache.setAll(withDept.map((d) => [d.course, d.department]));
    }
    poller.markNewSeqsPending(session.targets.flatMap((t) => t.seqs));
    poller.pokeSoon();

    res.json({ targets: session.targets });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// Walks the live department tree looking for a course code. Can take up to
// ~20-30s (one navigation per department), so the client shows a spinner.
app.get('/api/search-course', async (req, res) => {
  const course = String(req.query.course || '').trim();
  if (!course) {
    return res.status(400).json({ error: 'course is required' });
  }
  try {
    const config = loadConfig();
    const result = await poller.scraper.searchCourse(config.campus, config.degree, course);
    if (!result) {
      return res.json({ found: false });
    }
    departmentCache.set(normalizeCourseCode(course), result.department);
    res.json({ found: true, department: result.department, sections: result.sections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json(poller.getStatusForSession(req.sid));
});

app.post('/api/acknowledge', (req, res) => {
  const { seq } = req.body || {};
  if (!seq) {
    return res.status(400).json({ error: 'seq is required' });
  }
  sessionStore.setAcknowledged(req.sid, seq, true);
  res.json({ ok: true });
});

app.post('/api/armed', (req, res) => {
  const { armed } = req.body || {};
  sessionStore.setArmed(req.sid, !!armed);
  res.json({ ok: true });
});

app.post('/api/settings', (req, res) => {
  const { ntfyTopic } = req.body || {};
  const session = sessionStore.setNtfyTopic(req.sid, ntfyTopic);
  res.json({ ntfyTopic: session.ntfyTopic });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Seat watcher running at http://${HOST}:${PORT}`);
  sessionStore.startCleanupSchedule();
  poller.start();
});

async function shutdown() {
  console.log('\nShutting down...');
  await poller.stop();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Last-resort safety net for a multi-week unattended deployment: anything
// that slips past the per-cycle and per-route try/catches leaves the process
// in an unknown state, so log it clearly (visible in `pm2 logs`) and exit —
// pm2's autorestart brings it back up clean rather than it limping along.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception, exiting so pm2 can restart cleanly:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection, exiting so pm2 can restart cleanly:', reason);
  process.exit(1);
});

module.exports = app;
