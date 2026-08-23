const { chromium } = require('playwright');

const ENTRY_URL =
  'https://edugate.rcjy.edu.sa/jyup/ui/guest/timetable/index/scheduleTreeCoursesIndex.faces';

// Sets a <select> by id and submits the JSF form, waiting for the reload.
async function setSelect(page, id, value) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.evaluate(
      ({ id, value }) => {
        document.getElementById(id).value = value;
        document.forms.myForm.submit();
      },
      { id, value }
    ),
  ]);
}

// Clicks a department link in the tree by its visible text.
async function openDepartment(page, deptText) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.evaluate((text) => {
      const link = [...document.querySelectorAll('a')].find(
        (a) => a.textContent.trim() === text
      );
      if (!link) throw new Error('Department link not found: ' + text);
      link.click();
    }, deptText),
  ]);
}

// Reuses the parsing logic from the jic-course-schedule skill's
// scripts/extract_sections.js: every section row is already in the DOM,
// meeting times live in a hidden input decoded as "days @t time @r room".
async function extractSections(page) {
  return page.evaluate(() => {
    const DAYS = { 1: 'Sun', 2: 'Mon', 3: 'Tue', 4: 'Wed', 5: 'Thu' };

    const parseTimes = (raw) =>
      raw
        .split('@n')
        .map((block) => {
          const m = block.match(/^\s*([\d\s]+?)\s*@t\s*(.+?)\s*@r\s*(.*)$/);
          if (!m) return null;
          return {
            days: m[1].trim().split(/\s+/).map((d) => DAYS[d] || d),
            time: m[2].trim(),
            room: m[3].trim(),
          };
        })
        .filter(Boolean);

    const rows = [...document.querySelectorAll('tr')].filter(
      (r) => r.querySelector('input[name$=":section"]') && r.children.length === 8
    );

    return rows.map((r) => {
      const c = [...r.children].map((x) => x.textContent.trim());
      return {
        code: c[0].replace(/\s+/g, ' '),
        name: c[1],
        seq: c[2],
        activity: c[3],
        credits: c[4],
        gender: c[5],
        status: c[6], // "Opened" or "Closed"
        instructor: r.querySelector('input[name$=":instructor"]').value.trim(),
        times: parseTimes(r.querySelector('input[name$=":section"]').value),
      };
    });
  });
}

class Scraper {
  constructor() {
    this.browser = null;
  }

  async ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return;
    if (this.browser) {
      await this.browser.close().catch(() => {});
    }
    // --no-sandbox / --disable-dev-shm-usage: required when running headless
    // Chromium as root (e.g. a droplet with no dedicated app user) — without
    // them Chromium refuses to start or crashes on the tiny default /dev/shm.
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
    }
    this.browser = null;
  }

  // Walks the department tree (in the order Edugate lists it) looking for
  // courseCode, stopping at the first department page that lists it. Returns
  // { department, sections } (sections = every section row for that course
  // on that page) or null if no department page lists the course.
  async searchCourse(campus, degree, courseCode) {
    await this.ensureBrowser();
    const page = await this.browser.newPage();
    page.setDefaultTimeout(30000);
    const wanted = courseCode.trim().toUpperCase().replace(/\s+/g, ' ');
    try {
      await page.goto(ENTRY_URL, { waitUntil: 'networkidle' });
      await setSelect(page, 'myForm:select2', campus);
      await setSelect(page, 'myForm:select1', degree);

      const departments = await page.evaluate(() =>
        [...document.querySelectorAll('a')]
          .map((a) => a.textContent.trim())
          .filter((t) => /^\d\s*-\d-\d+-/.test(t))
      );

      for (const deptText of departments) {
        await openDepartment(page, deptText);
        const sections = await extractSections(page);
        const matches = sections.filter((s) => s.code.toUpperCase() === wanted);
        if (matches.length) {
          return { department: deptText, sections: matches };
        }
        await page.goto(ENTRY_URL, { waitUntil: 'networkidle' });
        await setSelect(page, 'myForm:select2', campus);
        await setSelect(page, 'myForm:select1', degree);
      }
      return null;
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Fetches every listed department fresh from the entry URL and returns
  // { [departmentText]: sections[] }. Throws on any parse failure so the
  // caller can restart the flow.
  async fetchDepartments(campus, degree, departmentNames) {
    await this.ensureBrowser();
    const page = await this.browser.newPage();
    page.setDefaultTimeout(30000);
    try {
      const results = {};
      for (const deptText of departmentNames) {
        await page.goto(ENTRY_URL, { waitUntil: 'networkidle' });
        await setSelect(page, 'myForm:select2', campus);
        await setSelect(page, 'myForm:select1', degree);
        await openDepartment(page, deptText);

        const sections = await extractSections(page);
        if (!sections.length) {
          throw new Error(
            `Parse failure: no section rows found for department "${deptText}" (page structure may have changed or session expired)`
          );
        }
        results[deptText] = sections;
      }
      return results;
    } finally {
      await page.close().catch(() => {});
    }
  }
}

module.exports = { Scraper, ENTRY_URL };
