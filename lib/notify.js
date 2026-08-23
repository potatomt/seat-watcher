// Optional push notification via ntfy.sh (https://ntfy.sh) — no signup, no
// app install. Per-session now: each visitor can set their own topic in
// Manage Targets, and only sessions that configured one get pushed to.
async function notifyOpen(topic, label) {
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
