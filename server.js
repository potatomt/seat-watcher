require('dotenv').config();

const express = require('express');
const path = require('path');
const { Poller } = require('./lib/poller');

const PORT = process.env.PORT || 5173;
const HOST = '127.0.0.1'; // nginx is the only thing that should reach this

const app = express();
const poller = new Poller();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/status', (req, res) => {
  res.json(poller.getStatus());
});

app.post('/acknowledge', (req, res) => {
  poller.acknowledgeAll();
  res.json({ ok: true });
});

// Walks the live department tree looking for a course code. Can take up to
// ~20-30s (one navigation per department), so the client shows a spinner.
app.get('/search-course', async (req, res) => {
  const course = String(req.query.course || '').trim();
  if (!course) {
    return res.status(400).json({ error: 'course is required' });
  }
  try {
    const result = await poller.searchCourse(course);
    if (!result) {
      return res.json({ found: false });
    }
    res.json({ found: true, department: result.department, sections: result.sections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/targets/add', (req, res) => {
  try {
    const { course, department, seqs } = req.body || {};
    if (!course || !department || !Array.isArray(seqs) || !seqs.length) {
      return res.status(400).json({ error: 'course, department, and seqs[] are required' });
    }
    const config = poller.addTarget(course, department, seqs);
    poller.pokeSoon();
    res.json({ ok: true, targets: config.targets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/targets/remove-seq', (req, res) => {
  try {
    const { course, seq } = req.body || {};
    if (!course || !seq) {
      return res.status(400).json({ error: 'course and seq are required' });
    }
    const config = poller.removeSeq(course, seq);
    res.json({ ok: true, targets: config.targets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/targets/remove-course', (req, res) => {
  try {
    const { course } = req.body || {};
    if (!course) {
      return res.status(400).json({ error: 'course is required' });
    }
    const config = poller.removeCourse(course);
    res.json({ ok: true, targets: config.targets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Seat watcher running at http://${HOST}:${PORT}`);
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
