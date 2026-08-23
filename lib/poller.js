const fs = require('fs');
const path = require('path');
const { Scraper } = require('./scraper');
const { notifyOpen } = require('./notify');
const { loadConfig } = require('./config');

const HISTORY_PATH = path.join(__dirname, '..', 'history.log');
const DEFAULT_POLL_SECONDS = 180;

class Poller {
  constructor(sessionStore, departmentCache) {
    this.sessionStore = sessionStore;
    this.departmentCache = departmentCache;
    this.scraper = new Scraper();

    // Global cache of the last completed cycle's scrape, keyed by seq. Every
    // session's /api/status filters this down to their own seqs rather than
    // triggering a scrape of their own.
    this.scrapeCache = new Map();
    this.pendingSeqs = new Set(); // seqs awaiting their first successful resolution

    this.state = {
      lastCheckedAt: null,
      lastSuccessAt: null,
      nextCheckAt: null,
      lastCycleOk: null,
      lastError: null,
      lastDepartmentsScraped: [],
      lastSessionsServed: 0,
    };
    this.timer = null;
    this.cycleInFlight = false;
  }

  appendHistory(line) {
    fs.appendFileSync(HISTORY_PATH, line + '\n');
  }

  // Seqs that just entered a watchlist and aren't in the scrape cache yet —
  // give them a "CHECKING" grace period instead of an immediate false ERROR.
  markNewSeqsPending(seqs) {
    for (const seq of seqs) {
      if (!this.scrapeCache.has(seq)) this.pendingSeqs.add(seq);
    }
  }

  computeUnionCourses() {
    const set = new Set();
    for (const session of Object.values(this.sessionStore.all())) {
      for (const t of session.targets) set.add(t.course);
    }
    return set;
  }

  // Course -> department, using the shared cache first (populated by the
  // "Find sections" search that necessarily preceded any add) and falling
  // back to a live department-tree search for anything uncached. One
  // course's resolution failure doesn't block the others.
  async resolveDepartments(courses) {
    const config = loadConfig();
    const resolved = new Map();
    const failures = [];
    for (const course of courses) {
      let dept = this.departmentCache.get(course);
      if (!dept) {
        try {
          const found = await this.scraper.searchCourse(config.campus, config.degree, course);
          if (found) {
            dept = found.department;
            this.departmentCache.set(course, dept);
          }
        } catch (err) {
          failures.push(`${course}: ${err.message}`);
        }
      }
      if (dept) resolved.set(course, dept);
    }
    return { resolved, failures };
  }

  async runCycle() {
    const startedAt = new Date();
    const courses = this.computeUnionCourses();
    const sessionsServed = Object.values(this.sessionStore.all()).filter(
      (s) => s.targets.length > 0
    ).length;

    if (!courses.size) {
      // No one is watching anything — don't launch Chromium for nothing.
      this.state.lastCheckedAt = startedAt.toISOString();
      this.state.lastCycleOk = true;
      this.state.lastError = null;
      this.state.lastSuccessAt = startedAt.toISOString();
      this.state.lastDepartmentsScraped = [];
      this.state.lastSessionsServed = 0;
      this.logLine(true, [], 0);
      return;
    }

    const { resolved, failures } = await this.resolveDepartments(courses);
    const departments = [...new Set(resolved.values())];

    this.state.lastCheckedAt = startedAt.toISOString();

    if (!departments.length) {
      this.state.lastCycleOk = false;
      this.state.lastError = `Could not resolve any department for: ${failures.join('; ') || [...courses].join(', ')}`;
      this.logLine(false, [], sessionsServed);
      return;
    }

    const { campus, degree } = loadConfig();
    let sectionsByDept = null;
    let lastErr = null;

    // Fresh navigation every cycle; on any parse failure, unexpected page, or
    // navigation timeout (the portal is noticeably slower over a proxy),
    // restart the flow once before giving up for this cycle. A timeout here
    // is just another caught error — it never escapes to crash the process.
    for (let attempt = 1; attempt <= 2 && !sectionsByDept; attempt++) {
      try {
        sectionsByDept = await this.scraper.fetchDepartments(campus, degree, departments);
      } catch (err) {
        lastErr = err;
        sectionsByDept = null;
      }
    }

    if (!sectionsByDept) {
      this.state.lastCycleOk = false;
      this.state.lastError = lastErr ? lastErr.message : 'unknown error';
      this.logLine(false, departments, sessionsServed);
      return;
    }

    // Flatten every scraped section (across all needed departments this
    // cycle) into one seq -> section map. Section seqs are unique across the
    // whole portal, and one department page's scrape already answers every
    // session that has a target there — no per-session re-scraping.
    const flatSections = new Map();
    for (const sections of Object.values(sectionsByDept)) {
      for (const s of sections) flatSections.set(s.seq, s);
    }

    // A scraped department page carries hundreds of sections nobody asked
    // about (that's the whole point of sharing one scrape). Cache every one
    // of them — cheap, and lets a freshly-added target on an
    // already-scraped page resolve instantly — but only log/notify/reset
    // acknowledgment for seqs someone is actually watching.
    const watchedSeqs = new Set();
    for (const session of Object.values(this.sessionStore.all())) {
      for (const t of session.targets) for (const seq of t.seqs) watchedSeqs.add(seq);
    }

    const changes = [];
    for (const [seq, section] of flatSections) {
      const prev = this.scrapeCache.get(seq);
      const prevStatus = prev ? prev.status : null;
      const changedToOpen = section.status === 'Opened' && prevStatus !== 'Opened';

      this.scrapeCache.set(seq, section);
      this.pendingSeqs.delete(seq);

      if (!watchedSeqs.has(seq)) continue;

      if (prevStatus === null) {
        changes.push(`${section.code} seq ${seq}: (initial) ${section.status}`);
      } else if (prevStatus !== section.status) {
        changes.push(`${section.code} seq ${seq}: ${prevStatus} -> ${section.status}`);
      }

      if (changedToOpen) {
        // Whoever already dismissed this seq gets un-dismissed so it alarms again.
        this.sessionStore.resetAcknowledgment(seq);
        this.notifyWatchingSessions(seq, `${section.code} seq ${seq}`);
      }
    }

    this.state.lastCycleOk = true;
    this.state.lastError = null;
    this.state.lastSuccessAt = startedAt.toISOString();
    this.state.lastDepartmentsScraped = departments;
    this.state.lastSessionsServed = sessionsServed;
    // Any seq still pending at this point wasn't found even with fresh data
    // from its department page — stop giving it CHECKING grace, show ERROR.
    this.pendingSeqs.clear();

    if (changes.length) {
      for (const c of changes) this.appendHistory(`[${startedAt.toISOString()}] ${c}`);
    }

    this.logLine(true, departments, sessionsServed);
  }

  notifyWatchingSessions(seq, label) {
    for (const session of Object.values(this.sessionStore.all())) {
      if (!session.ntfyTopic) continue;
      const watches = session.targets.some((t) => t.seqs.includes(seq));
      if (watches) notifyOpen(session.ntfyTopic, label);
    }
  }

  logLine(ok, departments, sessionsServed) {
    const time = new Date().toLocaleTimeString();
    if (!ok) {
      console.log(`[${time}] ERROR  ${this.state.lastError}`);
      return;
    }
    const deptSummary = departments.length ? departments.join(' | ') : '(no scrape needed)';
    console.log(
      `[${time}] OK  departments=[${deptSummary}]  sessionsServed=${sessionsServed}  seqsTracked=${this.scrapeCache.size}`
    );
  }

  // Builds the same {targets, anyAlarm, ...} shape the frontend has always
  // used, but filtered to one session's own targets and acknowledgment
  // state, read from the shared cache rather than triggering a scrape.
  getStatusForSession(sid) {
    const session = this.sessionStore.getOrCreate(sid);
    const neverSucceeded = !this.state.lastSuccessAt;

    const targets = session.targets.map((t) => {
      let anyChecking = false;
      let anyError = false;

      const rows = t.seqs.map((seq) => {
        const r = this.scrapeCache.get(seq);
        const status = r ? r.status : null;
        if (status === null) {
          if (neverSucceeded || this.pendingSeqs.has(seq)) anyChecking = true;
          else anyError = true;
        }
        return {
          seq,
          name: r ? r.name : null,
          activity: r ? r.activity : null,
          credits: r ? r.credits : null,
          gender: r ? r.gender : null,
          instructor: r ? r.instructor : null,
          times: r ? r.times : [],
          status,
          alarm: !!(r && r.status === 'Opened' && !session.acknowledgedSeqs.includes(seq)),
        };
      });

      let cardStatus;
      if (rows.some((r) => r.status === 'Opened')) cardStatus = 'OPEN';
      else if (anyChecking) cardStatus = 'CHECKING';
      else if (anyError) cardStatus = 'ERROR';
      else cardStatus = 'CLOSED';

      return { course: t.course, cardStatus, rows };
    });

    const anyAlarm = targets.some((t) => t.rows.some((r) => r.alarm));

    return {
      lastCheckedAt: this.state.lastCheckedAt,
      lastSuccessAt: this.state.lastSuccessAt,
      nextCheckAt: this.state.nextCheckAt,
      lastCycleOk: this.state.lastCycleOk,
      lastError: this.state.lastError,
      targets,
      anyAlarm,
      armed: session.armed,
      ntfyTopic: session.ntfyTopic,
      serverNow: new Date().toISOString(),
    };
  }

  scheduleNext() {
    const config = loadConfig();
    const envMinutes = Number(process.env.POLL_MINUTES);
    const baseSeconds = envMinutes > 0 ? envMinutes * 60 : DEFAULT_POLL_SECONDS;
    const baseMs = baseSeconds * 1000;
    const jitterMs = Math.random() * (config.jitterSeconds || 30) * 1000;
    const delay = baseMs + jitterMs;
    this.state.nextCheckAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => this.tick(), delay);
  }

  // Runs a cycle now, guarded so a manual poke (from adding a target) never
  // overlaps with the regularly scheduled tick.
  async triggerCycle() {
    if (this.cycleInFlight) return;
    this.cycleInFlight = true;
    try {
      await this.runCycle();
    } catch (err) {
      // Never let a failed cycle stop the loop.
      this.state.lastCycleOk = false;
      this.state.lastError = err.message;
      console.log(`[${new Date().toLocaleTimeString()}] ERROR  ${err.message}`);
    } finally {
      this.cycleInFlight = false;
    }
  }

  async tick() {
    await this.triggerCycle();
    this.scheduleNext();
  }

  // Fire-and-forget immediate cycle, e.g. right after a session adds a new
  // target via the UI, so its status doesn't sit on "CHECKING" for the full
  // interval. Doesn't touch the regular schedule.
  pokeSoon() {
    this.triggerCycle();
  }

  start() {
    this.tick();
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    await this.scraper.close();
  }
}

module.exports = { Poller };
