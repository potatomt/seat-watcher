const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  campus: '1',
  campusLabel: 'Jubail Industrial College',
  degree: '2',
  degreeLabel: 'Bachelor',
  jitterSeconds: 30,
};

// Small, effectively-static settings (which campus/degree this instance
// watches at all) that apply to every session — not per-visitor state, so
// they don't belong in sessions.json. Poll cadence itself is governed by
// POLL_MINUTES in .env (see lib/poller.js), not this file.
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (e) {
    console.error('Failed to parse config.json, using defaults:', e.message);
    return { ...DEFAULTS };
  }
}

module.exports = { loadConfig, CONFIG_PATH, DEFAULTS };
