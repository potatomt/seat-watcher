const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_PATH = path.join(DATA_DIR, 'department-cache.json');

// course code -> department link text, e.g. "ENGL 213" -> "2-2-218-...".
// Shared across every session — once one visitor's search resolves a
// course, no one else ever has to pay for that lookup again.
class DepartmentCache {
  constructor() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    this.map = this._load();
  }

  _load() {
    if (!fs.existsSync(CACHE_PATH)) return {};
    try {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch (e) {
      console.error('Failed to parse data/department-cache.json, starting fresh:', e.message);
      return {};
    }
  }

  _save() {
    fs.writeFile(CACHE_PATH, JSON.stringify(this.map, null, 2) + '\n', (err) => {
      if (err) console.error('Failed to save data/department-cache.json:', err.message);
    });
  }

  get(course) {
    return this.map[course] || null;
  }

  set(course, department) {
    if (this.map[course] === department) return;
    this.map[course] = department;
    this._save();
  }

  setAll(entries) {
    let changed = false;
    for (const [course, department] of entries) {
      if (this.map[course] !== department) {
        this.map[course] = department;
        changed = true;
      }
    }
    if (changed) this._save();
  }
}

module.exports = { DepartmentCache };
