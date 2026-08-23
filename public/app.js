(() => {
  const ORIGINAL_TITLE = document.title;
  const STALE_MS = 10 * 60 * 1000;
  const POLL_MS = 5000;

  const cardsEl = document.getElementById('cards');
  const headerEl = document.getElementById('header');
  const lastCheckedEl = document.getElementById('last-checked');
  const relativeTimeEl = document.getElementById('relative-time');
  const countdownEl = document.getElementById('countdown');
  const staleWarningEl = document.getElementById('stale-warning');
  const armBtn = document.getElementById('arm-btn');
  const testBtn = document.getElementById('test-btn');
  const ackBtn = document.getElementById('ack-btn');

  const manageBtn = document.getElementById('manage-btn');
  const manageOverlay = document.getElementById('manage-overlay');
  const manageCloseBtn = document.getElementById('manage-close-btn');
  const manageCurrentEl = document.getElementById('manage-current');
  const addCourseInput = document.getElementById('add-course-input');
  const findSectionsBtn = document.getElementById('find-sections-btn');
  const searchStatusEl = document.getElementById('search-status');
  const searchResultsEl = document.getElementById('search-results');
  const addSelectedBtn = document.getElementById('add-selected-btn');

  let armed = false;
  let audioCtx = null;
  let beepTimer = null;
  let titleFlashTimer = null;
  let alarmActive = false;
  let lastStatus = null;
  let nextCheckAtMs = null;
  let lastSearch = null; // { course, department, sections }

  // ---- WebAudio alarm ----

  function getAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function beepOnce(freq) {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.6, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  }

  function startBeepLoop() {
    if (beepTimer) return;
    let toggle = false;
    beepOnce(toggle ? 880 : 1046);
    beepTimer = setInterval(() => {
      toggle = !toggle;
      beepOnce(toggle ? 880 : 1046);
    }, 450);
  }

  function stopBeepLoop() {
    if (beepTimer) {
      clearInterval(beepTimer);
      beepTimer = null;
    }
  }

  function startTitleFlash(label) {
    if (titleFlashTimer) return;
    let flip = false;
    titleFlashTimer = setInterval(() => {
      document.title = flip ? ORIGINAL_TITLE : `🔴 OPEN — ${label}`;
      flip = !flip;
    }, 900);
  }

  function stopTitleFlash() {
    if (titleFlashTimer) {
      clearInterval(titleFlashTimer);
      titleFlashTimer = null;
    }
    document.title = ORIGINAL_TITLE;
  }

  function startAlarm(label) {
    alarmActive = true;
    startBeepLoop();
    startTitleFlash(label);
    ackBtn.classList.remove('hidden');
  }

  function stopAlarm() {
    alarmActive = false;
    stopBeepLoop();
    stopTitleFlash();
    ackBtn.classList.add('hidden');
  }

  // ---- Buttons ----

  armBtn.addEventListener('click', () => {
    getAudioCtx();
    // tiny silent blip to fully unlock audio on this gesture
    beepOnce(0.0001);
    armed = true;
    armBtn.textContent = 'Armed ✅';
    armBtn.classList.add('armed');
  });

  testBtn.addEventListener('click', () => {
    getAudioCtx();
    startBeepLoop();
    setTimeout(stopBeepLoop, 2000);
  });

  ackBtn.addEventListener('click', async () => {
    stopAlarm();
    try {
      await fetch('/acknowledge', { method: 'POST' });
    } catch (e) {
      // will retry naturally on next poll if this fails
    }
  });

  // ---- Rendering ----

  function fmtTimes(times) {
    if (!times || !times.length) return 'TBA';
    return times
      .map((t) => `${t.days.join('+')} ${t.time}${t.room ? ' · ' + t.room : ''}`)
      .join(' | ');
  }

  function statusClass(status) {
    if (status === 'Opened') return 'opened';
    if (status === 'Closed') return 'closed';
    return 'unknown';
  }

  function pillClass(cardStatus) {
    if (cardStatus === 'OPEN') return 'pill-open';
    if (cardStatus === 'CLOSED') return 'pill-closed';
    if (cardStatus === 'CHECKING') return 'pill-checking';
    return 'pill-error';
  }

  function pillLabel(cardStatus) {
    if (cardStatus === 'OPEN') return 'OPEN';
    if (cardStatus === 'CLOSED') return 'CLOSED';
    if (cardStatus === 'CHECKING') return 'CHECKING…';
    return 'ERROR';
  }

  function renderCards(targets) {
    cardsEl.innerHTML = '';
    for (const target of targets) {
      const card = document.createElement('div');
      card.className = 'card';

      const head = document.createElement('div');
      head.className = 'card-head';

      const code = document.createElement('div');
      code.className = 'course-code';
      code.textContent = target.course;

      const pill = document.createElement('div');
      const anyAlarmHere = target.rows.some((r) => r.alarm);
      pill.className = `pill ${pillClass(target.cardStatus)}${anyAlarmHere ? ' pulsing' : ''}`;
      pill.textContent = pillLabel(target.cardStatus);

      head.appendChild(code);
      head.appendChild(pill);
      card.appendChild(head);

      for (const row of target.rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'row';

        const info = document.createElement('div');
        info.className = 'row-info';

        const seqEl = document.createElement('div');
        seqEl.className = 'row-seq';
        seqEl.textContent = `Seq ${row.seq}${row.instructor ? ' — ' + row.instructor : ''}`;

        const detailEl = document.createElement('div');
        detailEl.className = 'row-detail';
        detailEl.textContent = fmtTimes(row.times);

        info.appendChild(seqEl);
        info.appendChild(detailEl);

        const statusEl = document.createElement('div');
        statusEl.className = `row-status ${statusClass(row.status)}`;
        statusEl.textContent = row.status || 'unknown';

        rowEl.appendChild(info);
        rowEl.appendChild(statusEl);
        card.appendChild(rowEl);
      }

      cardsEl.appendChild(card);
    }
  }

  function relativeTime(iso) {
    if (!iso) return '';
    const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 5) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs}h ago`;
  }

  function updateHeaderClock() {
    if (!lastStatus) return;
    relativeTimeEl.textContent = lastStatus.lastCheckedAt
      ? `(${relativeTime(lastStatus.lastCheckedAt)})`
      : '';

    const staleSuccess =
      !lastStatus.lastSuccessAt ||
      Date.now() - new Date(lastStatus.lastSuccessAt).getTime() > STALE_MS;

    if (staleSuccess) {
      headerEl.classList.add('stale');
      staleWarningEl.classList.remove('hidden');
      staleWarningEl.textContent = lastStatus.lastSuccessAt
        ? `⚠ Data is stale — last successful check was ${relativeTime(lastStatus.lastSuccessAt)}`
        : '⚠ No successful check yet';
    } else {
      headerEl.classList.remove('stale');
      staleWarningEl.classList.add('hidden');
    }

    if (nextCheckAtMs) {
      const remaining = Math.max(0, Math.round((nextCheckAtMs - Date.now()) / 1000));
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      countdownEl.textContent = `Next check in ${m}:${String(s).padStart(2, '0')}`;
    }
  }

  function alarmLabel(targets) {
    const names = targets
      .filter((t) => t.rows.some((r) => r.alarm))
      .map((t) => t.course);
    return names.join(', ') || 'a section';
  }

  // ---- Manage targets panel ----

  function openManage() {
    manageOverlay.classList.remove('hidden');
    if (lastStatus) renderManageCurrent(lastStatus.targets);
  }

  function closeManage() {
    manageOverlay.classList.add('hidden');
    addCourseInput.value = '';
    searchStatusEl.textContent = '';
    searchResultsEl.innerHTML = '';
    addSelectedBtn.classList.add('hidden');
    lastSearch = null;
  }

  manageBtn.addEventListener('click', openManage);
  manageCloseBtn.addEventListener('click', closeManage);
  manageOverlay.addEventListener('click', (e) => {
    if (e.target === manageOverlay) closeManage();
  });

  function renderManageCurrent(targets) {
    manageCurrentEl.innerHTML = '';
    if (!targets.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Nothing being watched yet.';
      manageCurrentEl.appendChild(p);
      return;
    }
    for (const target of targets) {
      const block = document.createElement('div');
      block.className = 'manage-course';

      const head = document.createElement('div');
      head.className = 'manage-course-head';

      const title = document.createElement('strong');
      title.textContent = target.course;

      const removeCourseBtn = document.createElement('button');
      removeCourseBtn.className = 'text-btn';
      removeCourseBtn.textContent = 'Remove course';
      removeCourseBtn.addEventListener('click', () => doRemoveCourse(target.course));

      head.appendChild(title);
      head.appendChild(removeCourseBtn);
      block.appendChild(head);

      const seqList = document.createElement('div');
      seqList.className = 'manage-seq-list';

      for (const row of target.rows) {
        const chip = document.createElement('span');
        chip.className = 'seq-chip';

        const label = document.createElement('span');
        label.textContent = `${row.seq}${row.status ? ' · ' + row.status : ''}`;

        const removeBtn = document.createElement('button');
        removeBtn.textContent = '✕';
        removeBtn.title = `Remove seq ${row.seq}`;
        removeBtn.addEventListener('click', () => doRemoveSeq(target.course, row.seq));

        chip.appendChild(label);
        chip.appendChild(removeBtn);
        seqList.appendChild(chip);
      }

      block.appendChild(seqList);
      manageCurrentEl.appendChild(block);
    }
  }

  async function doRemoveSeq(course, seq) {
    try {
      const res = await fetch('/targets/remove-seq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ course, seq }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to remove');
      await poll();
    } catch (e) {
      searchStatusEl.textContent = 'Could not remove: ' + e.message;
    }
  }

  async function doRemoveCourse(course) {
    try {
      const res = await fetch('/targets/remove-course', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ course }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to remove');
      await poll();
    } catch (e) {
      searchStatusEl.textContent = 'Could not remove: ' + e.message;
    }
  }

  function alreadyWatchedSeqs(course) {
    if (!lastStatus) return new Set();
    const target = lastStatus.targets.find((t) => t.course === course);
    return new Set(target ? target.rows.map((r) => r.seq) : []);
  }

  function renderSearchResults(course, department, sections) {
    lastSearch = { course, department, sections };
    searchResultsEl.innerHTML = '';
    const watched = alreadyWatchedSeqs(course);
    let anyAddable = false;

    for (const s of sections) {
      const already = watched.has(s.seq);
      if (!already) anyAddable = true;

      const row = document.createElement('div');
      row.className = 'section-choice' + (already ? ' already' : '');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.seq;
      cb.id = `sc-${s.seq}`;
      cb.disabled = already;
      cb.checked = already;

      const label = document.createElement('label');
      label.setAttribute('for', cb.id);

      const t = document.createElement('div');
      t.className = 'sc-title';
      t.textContent = `Seq ${s.seq} — ${s.activity || ''} — ${s.instructor || 'TBA'}${already ? ' (already watching)' : ''}`;

      const d = document.createElement('div');
      d.className = 'sc-detail';
      const times = (s.times || [])
        .map((t2) => `${t2.days.join('+')} ${t2.time}${t2.room ? ' · ' + t2.room : ''}`)
        .join(' | ') || 'TBA';
      d.textContent = `${times} — ${s.status}`;

      label.appendChild(t);
      label.appendChild(d);
      row.appendChild(cb);
      row.appendChild(label);
      searchResultsEl.appendChild(row);
    }

    addSelectedBtn.classList.toggle('hidden', !anyAddable);
  }

  async function doFindSections() {
    const course = addCourseInput.value.trim();
    if (!course) return;
    findSectionsBtn.disabled = true;
    searchStatusEl.textContent = 'Searching department pages… this can take up to ~20s.';
    searchResultsEl.innerHTML = '';
    addSelectedBtn.classList.add('hidden');
    lastSearch = null;

    try {
      const res = await fetch(`/search-course?course=${encodeURIComponent(course)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');

      if (!data.found) {
        searchStatusEl.textContent = `"${course}" wasn't found on any JIC Bachelor department page. Check the code and try again.`;
        return;
      }

      searchStatusEl.textContent = `Found on ${data.department}:`;
      renderSearchResults(data.sections[0].code, data.department, data.sections);
    } catch (e) {
      searchStatusEl.textContent = 'Error: ' + e.message;
    } finally {
      findSectionsBtn.disabled = false;
    }
  }

  findSectionsBtn.addEventListener('click', doFindSections);
  addCourseInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doFindSections();
  });

  addSelectedBtn.addEventListener('click', async () => {
    if (!lastSearch) return;
    const checked = [...searchResultsEl.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)')].map(
      (cb) => cb.value
    );
    if (!checked.length) return;

    addSelectedBtn.disabled = true;
    try {
      const res = await fetch('/targets/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ course: lastSearch.course, department: lastSearch.department, seqs: checked }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to add');
      searchStatusEl.textContent = `Added ${checked.length} section(s) to ${lastSearch.course}. Checking status…`;
      await poll(); // refresh lastStatus first so the checklist can mark these as already-watching
      renderSearchResults(lastSearch.course, lastSearch.department, lastSearch.sections);
    } catch (e) {
      searchStatusEl.textContent = 'Error: ' + e.message;
    } finally {
      addSelectedBtn.disabled = false;
    }
  });

  async function poll() {
    let data;
    try {
      const res = await fetch('/status');
      data = await res.json();
    } catch (e) {
      return; // try again next tick
    }

    lastStatus = data;
    nextCheckAtMs = data.nextCheckAt ? new Date(data.nextCheckAt).getTime() : null;

    lastCheckedEl.textContent = data.lastCheckedAt
      ? `Last checked: ${new Date(data.lastCheckedAt).toLocaleTimeString()}`
      : 'Last checked: —';

    renderCards(data.targets);
    updateHeaderClock();
    if (!manageOverlay.classList.contains('hidden')) {
      renderManageCurrent(data.targets);
    }

    if (data.anyAlarm && armed && !alarmActive) {
      startAlarm(alarmLabel(data.targets));
    } else if (!data.anyAlarm && alarmActive) {
      stopAlarm();
    } else if (data.anyAlarm && alarmActive) {
      // keep title flash label current
    }
  }

  poll();
  setInterval(poll, POLL_MS);
  setInterval(updateHeaderClock, 1000);
})();
