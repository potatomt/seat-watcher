const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');

const MAX_TARGETS_PER_SESSION = 15;
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const COURSE_RE = /^[A-Z]{2,5} \d{3}$/;
const SEQ_RE = /^\d+$/;

class ValidationError extends Error {}

function normalizeCourseCode(input) {
  return String(input)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/^([A-Z]+)\s*(\d+.*)$/, '$1 $2');
}

// Plain JSON + an in-process write queue is enough at this scale (a handful
// of anonymous sessions) — see README for why this wasn't sqlite.
class SessionStore {
  constructor() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    this.data = this._load();
    this._writeQueue = Promise.resolve();
  }

  _load() {
    if (!fs.existsSync(SESSIONS_PATH)) return { sessions: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
      if (!parsed.sessions) parsed.sessions = {};
      return parsed;
    } catch (e) {
      console.error('Failed to parse data/sessions.json, starting fresh:', e.message);
      return { sessions: {} };
    }
  }

  // Serializes writes so concurrent requests never interleave and corrupt
  // the file — each save waits for the previous one to finish.
  _save() {
    this._writeQueue = this._writeQueue
      .then(() => fs.promises.writeFile(SESSIONS_PATH, JSON.stringify(this.data, null, 2) + '\n'))
      .catch((err) => console.error('Failed to save data/sessions.json:', err.message));
    return this._writeQueue;
  }

  has(sid) {
    return Object.prototype.hasOwnProperty.call(this.data.sessions, sid);
  }

  all() {
    return this.data.sessions;
  }

  getOrCreate(sid) {
    if (!this.data.sessions[sid]) {
      const now = new Date().toISOString();
      this.data.sessions[sid] = {
        targets: [],
        armed: false,
        acknowledgedSeqs: [],
        ntfyTopic: null,
        createdAt: now,
        lastSeenAt: now,
      };
      this._save();
    }
    return this.data.sessions[sid];
  }

  touch(sid) {
    const session = this.getOrCreate(sid);
    session.lastSeenAt = new Date().toISOString();
    this._save();
    return session;
  }

  // One-time adoption of a migrated watchlist: whoever's browser hits the
  // server first after migration (in practice, Ali) gets the pre-existing
  // "default" session renamed onto their freshly-minted real sid, so nothing
  // is lost. After this runs once, "default" no longer exists.
  rename(oldSid, newSid) {
    if (!this.data.sessions[oldSid]) return null;
    this.data.sessions[newSid] = this.data.sessions[oldSid];
    delete this.data.sessions[oldSid];
    this._save();
    return this.data.sessions[newSid];
  }

  setTargets(sid, rawTargets) {
    const clean = this._validateTargets(rawTargets);
    const session = this.getOrCreate(sid);
    session.targets = clean.map(({ course, seqs }) => ({ course, seqs }));
    // dropping acknowledgedSeqs for seqs no longer watched keeps the list tidy
    const stillWatched = new Set(clean.flatMap((t) => t.seqs));
    session.acknowledgedSeqs = session.acknowledgedSeqs.filter((s) => stillWatched.has(s));
    this._save();
    return { session, resolvedDepartments: clean.map(({ course, department }) => ({ course, department })) };
  }

  _validateTargets(rawTargets) {
    if (!Array.isArray(rawTargets)) {
      throw new ValidationError('targets must be an array');
    }
    let totalSeqs = 0;
    const seenCourses = new Set();
    const clean = [];

    for (const t of rawTargets) {
      if (!t || typeof t.course !== 'string') {
        throw new ValidationError('each target needs a "course" string');
      }
      const course = normalizeCourseCode(t.course);
      if (!COURSE_RE.test(course)) {
        throw new ValidationError(`invalid course code "${t.course}" — expected a format like "ENGL 213"`);
      }
      if (seenCourses.has(course)) {
        throw new ValidationError(`duplicate course "${course}" in targets`);
      }
      seenCourses.add(course);

      if (!Array.isArray(t.seqs) || !t.seqs.length) {
        throw new ValidationError(`"${course}" needs at least one seq`);
      }
      const seqs = [];
      for (const seq of t.seqs) {
        if (typeof seq !== 'string' || !SEQ_RE.test(seq)) {
          throw new ValidationError(`invalid seq "${seq}" for "${course}" — must be a numeric string`);
        }
        seqs.push(seq);
        totalSeqs++;
      }

      if (totalSeqs > MAX_TARGETS_PER_SESSION) {
        throw new ValidationError(`too many targets (max ${MAX_TARGETS_PER_SESSION} seqs per session)`);
      }

      clean.push({
        course,
        seqs,
        department: typeof t.department === 'string' && t.department ? t.department : null,
      });
    }

    return clean;
  }

  setAcknowledged(sid, seq, acknowledged) {
    const session = this.getOrCreate(sid);
    const has = session.acknowledgedSeqs.includes(seq);
    if (acknowledged && !has) session.acknowledgedSeqs.push(seq);
    if (!acknowledged && has) {
      session.acknowledgedSeqs = session.acknowledgedSeqs.filter((s) => s !== seq);
    }
    this._save();
    return session;
  }

  // Called by the poller when a watched seq flips Closed -> Opened: whoever
  // already dismissed it gets un-dismissed so they see the new alarm.
  resetAcknowledgment(seq) {
    let changed = false;
    for (const session of Object.values(this.data.sessions)) {
      if (session.acknowledgedSeqs.includes(seq)) {
        session.acknowledgedSeqs = session.acknowledgedSeqs.filter((s) => s !== seq);
        changed = true;
      }
    }
    if (changed) this._save();
  }

  setArmed(sid, armed) {
    const session = this.getOrCreate(sid);
    session.armed = !!armed;
    this._save();
    return session;
  }

  setNtfyTopic(sid, ntfyTopic) {
    const session = this.getOrCreate(sid);
    session.ntfyTopic = ntfyTopic ? String(ntfyTopic).trim().slice(0, 100) : null;
    this._save();
    return session;
  }

  // Sessions with lastSeenAt older than 90 days get dropped. Cheap check,
  // run once a day rather than per-request.
  cleanupOldSessions() {
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    let removed = 0;
    for (const [sid, session] of Object.entries(this.data.sessions)) {
      if (new Date(session.lastSeenAt).getTime() < cutoff) {
        delete this.data.sessions[sid];
        removed++;
      }
    }
    if (removed) {
      console.log(`Session cleanup: removed ${removed} session(s) inactive for 90+ days.`);
      this._save();
    }
    return removed;
  }

  startCleanupSchedule() {
    this.cleanupOldSessions();
    setInterval(() => this.cleanupOldSessions(), CLEANUP_INTERVAL_MS).unref();
  }
}

module.exports = { SessionStore, ValidationError, normalizeCourseCode, MAX_TARGETS_PER_SESSION };
