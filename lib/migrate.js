const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OLD_TARGETS_PATH = path.join(ROOT, 'targets.json');
const DATA_DIR = path.join(ROOT, 'data');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const DEPT_CACHE_PATH = path.join(DATA_DIR, 'department-cache.json');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// One-time move from the old shared targets.json to per-session storage.
// Runs at startup, before the session store is constructed. Everyone's old
// shared watchlist becomes a single session keyed "default" — the session
// store's rename() then hands it to whoever's browser visits first (see
// server.js), so it isn't just sitting there orphaned under a key no real
// cookie will ever have.
function migrateIfNeeded() {
  if (!fs.existsSync(OLD_TARGETS_PATH) || fs.existsSync(SESSIONS_PATH)) return;

  console.log('Migrating targets.json -> data/sessions.json (one-time)...');
  let old;
  try {
    old = JSON.parse(fs.readFileSync(OLD_TARGETS_PATH, 'utf8'));
  } catch (e) {
    console.error('Could not parse targets.json, skipping migration:', e.message);
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(CONFIG_PATH)) {
    const config = {
      campus: old.campus || '1',
      campusLabel: old.campusLabel || 'Jubail Industrial College',
      degree: old.degree || '2',
      degreeLabel: old.degreeLabel || 'Bachelor',
      jitterSeconds: old.jitterSeconds || 30,
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  }

  const deptCache = {};
  for (const t of old.targets || []) {
    if (t.course && t.department) deptCache[t.course] = t.department;
  }
  fs.writeFileSync(DEPT_CACHE_PATH, JSON.stringify(deptCache, null, 2) + '\n');

  const now = new Date().toISOString();
  const sessions = {
    default: {
      targets: (old.targets || []).map((t) => ({ course: t.course, seqs: t.seqs })),
      armed: false,
      acknowledgedSeqs: [],
      // Preserve an already-configured global ntfy topic so notifications
      // keep working for the person who had it set up, instead of silently
      // going dark under the new per-session model.
      ntfyTopic: process.env.NTFY_TOPIC || null,
      createdAt: now,
      lastSeenAt: now,
    },
  };
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify({ sessions }, null, 2) + '\n');

  fs.renameSync(OLD_TARGETS_PATH, OLD_TARGETS_PATH + '.bak');
  console.log(
    'Migration complete: targets.json -> targets.json.bak. ' +
      'Watchlist preserved as session "default" — it will be claimed by ' +
      'whichever browser visits first (see data/sessions.json).'
  );
}

module.exports = { migrateIfNeeded };
