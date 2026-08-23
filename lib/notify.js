// Optional push notification via ntfy.sh (https://ntfy.sh) — no signup, no
// app install: set NTFY_TOPIC in .env to a private, hard-to-guess topic name
// and subscribe to it in the ntfy app/browser. No-op if NTFY_TOPIC is unset.
async function notifyOpen(label) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      body: `${label} is open`,
      headers: { Title: 'Seat Watcher', Priority: 'urgent', Tags: 'rotating_light' },
    });
  } catch (e) {
    // best-effort — a failed push should never affect the poll cycle
  }
}

module.exports = { notifyOpen };
