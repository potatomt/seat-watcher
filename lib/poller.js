const fs = require('fs');
const path = require('path');
const { Scraper } = require('./scraper');
const { notifyOpen } = require('./notify');

const TARGETS_PATH = path.join(__dirname, '..', 'targets.json');
const HISTORY_PATH = path.join(__dirname, '..', 'history.log');

function loadConfig() {
  const raw = fs.readFileSync(TARGETS_PATH, 'utf8');
  return JSON.parse(raw);
}

function normalizeCourseCode(input) {
  return input
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/^([A-Z]+)\s*(\d+.*)$/, '$1 $2');
}

class Poller {
  constructor() {
    this.scraper = new Scraper();
    this.rows = new Map(); // seq -> { seq, status, instructor, activity, name, times, acknowledged }
    this.state = {
      lastCheckedAt: null,
      lastSuccessAt: null,
      nextCheckAt: null,
      lastCycleOk: null,
      lastError: null,
    };
    this.timer = null;
    this.cycleInFlight = false;
    this.pendingSeqs = new Set(); // seqs added mid-session awaiting their first successful cycle
  }

  appendHistory(line) {
    fs.appendFileSync(HISTORY_PATH, line + '\n');
  }

  acknowledgeAll() {
    for (const row of this.rows.values()) {
      if (row.status === 'Opened') row.acknowledged = true;
    }
  }

  saveConfig(config) {
    fs.writeFileSync(TARGETS_PATH, JSON.stringify(config, null, 2) + '\n');
  }

  // Adds seqs to an existing course group, or creates a new one.
  addTarget(course, department, seqs) {
    const config = loadConfig();
    const normCourse = normalizeCourseCode(course);
    let group = config.targets.find((t) => t.course === normCourse);
    if (!group) {
      group = { course: normCourse, department, seqs: [] };
      config.targets.push(group);
    }
    for (const seq of seqs) {
      if (!group.seqs.includes(seq)) {
        group.seqs.push(seq);
        this.pendingSeqs.add(seq);
      }
    }
    this.saveConfig(config);
    return config;
  }

  removeSeq(course, seq) {
    const config = loadConfig();
    const normCourse = normalizeCourseCode(course);
    const group = config.targets.find((t) => t.course === normCourse);
    if (group) {
      group.seqs = group.seqs.filter((s) => s !== seq);
      this.rows.delete(seq);
      if (!group.seqs.length) {
        config.targets = config.targets.filter((t) => t !== group);
      }
      this.saveConfig(config);
    }
    return config;
  }

  removeCourse(course) {
    const config = loadConfig();
    const normCourse = normalizeCourseCode(course);
    const group = config.targets.find((t) => t.course === normCourse);
    if (group) {
      for (const seq of group.seqs) this.rows.delete(seq);
      config.targets = config.targets.filter((t) => t !== group);
      this.saveConfig(config);
    }
    return config;
  }

  // Walks the live department tree looking for courseCode. Used by the
  // "add a course" UI flow so the user never has to know which department
  // page a course lives on.
  async searchCourse(courseCode) {
    const config = loadConfig();
    return this.scraper.searchCourse(config.campus, config.degree, courseCode);
  }

  getStatus() {
    const config = loadConfig();
    const neverSucceeded = !this.state.lastSuccessAt;

    const targets = config.targets.map((t) => {
      let anyChecking = false;
      let anyError = false;

      const rows = t.seqs.map((seq) => {
        const r = this.rows.get(seq);
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
          alarm: !!(r && r.status === 'Opened' && !r.acknowledged),
        };
      });

      let cardStatus;
      if (rows.some((r) => r.status === 'Opened')) cardStatus = 'OPEN';
      else if (anyChecking) cardStatus = 'CHECKING';
      else if (anyError) cardStatus = 'ERROR';
      else cardStatus = 'CLOSED';

      return { course: t.course, department: t.department, cardStatus, rows };
    });

    const anyAlarm = targets.some((t) => t.rows.some((r) => r.alarm));

    return {
      ...this.state,
      targets,
      anyAlarm,
      serverNow: new Date().toISOString(),
    };
  }

  logLine(config, ok) {
    const time = new Date().toLocaleTimeString();
    if (!ok) {
      console.log(`[${time}] ERROR  ${this.state.lastError}`);
      return;
    }
    const parts = [];
    for (const target of config.targets) {
      for (const seq of target.seqs) {
        const row = this.rows.get(seq);
        parts.push(`${target.course}#${seq}=${row ? row.status : '?'}`);
      }
    }
    console.log(`[${time}] OK  ${parts.join('  ')}`);
  }

  async runCycle() {
    const config = loadConfig();
    const startedAt = new Date();
    const departments = [...new Set(config.targets.map((t) => t.department))];

    let sectionsByDept = null;
    let lastErr = null;

    // Fresh navigation every cycle; on any parse failure, unexpected page, or
    // navigation timeout (the portal is noticeably slower over a proxy),
    // restart the flow once before giving up for this cycle. A timeout here
    // is just another caught error — it never escapes to crash the process.
    for (let attempt = 1; attempt <= 2 && !sectionsByDept; attempt++) {
      try {
        sectionsByDept = await this.scraper.fetchDepartments(
          config.campus,
          config.degree,
          departments
        );
      } catch (err) {
        lastErr = err;
        sectionsByDept = null;
      }
    }

    this.state.lastCheckedAt = startedAt.toISOString();

    if (!sectionsByDept) {
      this.state.lastCycleOk = false;
      this.state.lastError = lastErr ? lastErr.message : 'unknown error';
      this.logLine(config, false);
      return;
    }

    const changes = [];
    for (const target of config.targets) {
      const sections = sectionsByDept[target.department] || [];
      for (const seq of target.seqs) {
        const match = sections.find((s) => s.seq === seq);
        if (!match) continue; // keep last known state rather than blanking it

        const prev = this.rows.get(seq);
        const prevStatus = prev ? prev.status : null;
        const wasAcknowledged = prev ? prev.acknowledged : true;
        const changedToOpen = match.status === 'Opened' && prevStatus !== 'Opened';

        this.rows.set(seq, {
          seq,
          status: match.status,
          name: match.name,
          activity: match.activity,
          credits: match.credits,
          gender: match.gender,
          instructor: match.instructor,
          times: match.times,
          acknowledged: changedToOpen ? false : wasAcknowledged,
        });
        this.pendingSeqs.delete(seq);

        if (prevStatus === null) {
          changes.push(`${target.course} seq ${seq}: (initial) ${match.status}`);
        } else if (prevStatus !== match.status) {
          changes.push(`${target.course} seq ${seq}: ${prevStatus} -> ${match.status}`);
        }

        if (changedToOpen) {
          notifyOpen(`${target.course} seq ${seq}`);
        }
      }
    }

    this.state.lastCycleOk = true;
    this.state.lastError = null;
    this.state.lastSuccessAt = startedAt.toISOString();
    // Any seq still pending at this point wasn't found even with fresh data
    // from its department page — stop giving it CHECKING grace, show ERROR.
    this.pendingSeqs.clear();

    if (changes.length) {
      for (const c of changes) {
        this.appendHistory(`[${startedAt.toISOString()}] ${c}`);
      }
    }

    this.logLine(config, true);
  }

  scheduleNext() {
    const config = loadConfig();
    // POLL_MINUTES in .env overrides targets.json's pollIntervalSeconds when set.
    const envMinutes = Number(process.env.POLL_MINUTES);
    const baseSeconds =
      envMinutes > 0 ? envMinutes * 60 : config.pollIntervalSeconds || 180;
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

  // Fire-and-forget immediate cycle, e.g. right after adding a new target
  // via the UI, so its status doesn't sit on "CHECKING" for the full
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
