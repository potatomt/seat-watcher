(() => {
  const ORIGINAL_TITLE = document.title;
  const STALE_MS = 10 * 60 * 1000;
  const POLL_MS = 5000;

  const cardsEl = document.getElementById('cards');
  const emptyStateEl = document.getElementById('empty-state');
  const emptyStateManageBtn = document.getElementById('empty-state-manage-btn');
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
  const targetsCapEl = document.getElementById('targets-cap');

  const ntfyTopicInput = document.getElementById('ntfy-topic-input');
  const saveNtfyBtn = document.getElementById('save-ntfy-btn');
  const ntfyStatusEl = document.getElementById('ntfy-status');

  let armed = false;
  let audioCtx = null;
  let beepTimer = null;
  let titleFlashTimer = null;
  let alarmActive = false;
  let lastStatus = null;
  let nextCheckAtMs = null;
  let lastSearch = null; // { course, department, sections }
  let myTargets = []; // clean {course, seqs} list — the source of truth for edits
  let maxTargets = 15;

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

  armBtn.addEventListener('click', async () => {
    getAudioCtx();
    // tiny silent blip to fully unlock audio on this gesture
    beepOnce(0.0001);
    armed = true;
    armBtn.textContent = 'Armed ✅';
    armBtn.classList.add('armed');
    try {
      await fetch('/api/armed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed: true }),
      });
    } catch (e) {
      // local arming already took effect; server sync can lag without harm
    }
  });

  testBtn.addEventListener('click', () => {
    getAudioCtx();
    startBeepLoop();
    setTimeout(stopBeepLoop, 2000);
  });

  ackBtn.addEventListener('click', async () => {
    stopAlarm();
    if (!lastStatus) return;
    const alarmingSeqs = lastStatus.targets.flatMap((t) => t.rows.filter((r) => r.alarm).map((r) => r.seq));
    try {
      await Promise.all(
        alarmingSeqs.map((seq) =>
          fetch('/api/acknowledge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seq }),
          })
        )
      );
    } catch (e) {
      // next poll will just show the alarm again if this failed — safe default
    }
    await poll();
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
    const isEmpty = targets.length === 0;
    emptyStateEl.classList.toggle('hidden', !isEmpty);
    cardsEl.classList.toggle('hidden', isEmpty);
    if (isEmpty) {
      cardsEl.innerHTML = '';
      return;
    }

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
    renderManageCurrent();
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
  emptyStateManageBtn.addEventListener('click', openManage);
  manageCloseBtn.addEventListener('click', closeManage);
  manageOverlay.addEventListener('click', (e) => {
    if (e.target === manageOverlay) closeManage();
  });

  function renderManageCurrent() {
    manageCurrentEl.innerHTML = '';
    const totalSeqs = myTargets.reduce((n, t) => n + t.seqs.length, 0);
    targetsCapEl.textContent = `${totalSeqs} / ${maxTargets} seqs watched`;

    if (!myTargets.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Nothing being watched yet — add a course below.';
      manageCurrentEl.appendChild(p);
      return;
    }
    for (const target of myTargets) {
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

      // pull live status for display if we have it, purely cosmetic
      const statusTarget = lastStatus && lastStatus.targets.find((t) => t.course === target.course);

      for (const seq of target.seqs) {
        const liveRow = statusTarget && statusTarget.rows.find((r) => r.seq === seq);
        const chip = document.createElement('span');
        chip.className = 'seq-chip';

        const label = document.createElement('span');
        label.textContent = `${seq}${liveRow && liveRow.status ? ' · ' + liveRow.status : ''}`;

        const removeBtn = document.createElement('button');
        removeBtn.textContent = '✕';
        removeBtn.title = `Remove seq ${seq}`;
        removeBtn.addEventListener('click', () => doRemoveSeq(target.course, seq));

        chip.appendChild(label);
        chip.appendChild(removeBtn);
        seqList.appendChild(chip);
      }

      block.appendChild(seqList);
      manageCurrentEl.appendChild(block);
    }
  }

  async function replaceTargets(newTargets) {
    const res = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: newTargets }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save targets');
    myTargets = data.targets;
    return data.targets;
  }

  async function doRemoveSeq(course, seq) {
    try {
      const newTargets = myTargets
        .map((t) => (t.course === course ? { course: t.course, seqs: t.seqs.filter((s) => s !== seq) } : t))
        .filter((t) => t.seqs.length > 0);
      await replaceTargets(newTargets);
      renderManageCurrent();
      await poll();
    } catch (e) {
      searchStatusEl.textContent = 'Could not remove: ' + e.message;
    }
  }

  async function doRemoveCourse(course) {
    try {
      const newTargets = myTargets.filter((t) => t.course !== course);
      await replaceTargets(newTargets);
      renderManageCurrent();
      await poll();
    } catch (e) {
      searchStatusEl.textContent = 'Could not remove: ' + e.message;
    }
  }

  function alreadyWatchedSeqs(course) {
    const target = myTargets.find((t) => t.course === course);
    return new Set(target ? target.seqs : []);
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
      const res = await fetch(`/api/search-course?course=${encodeURIComponent(course)}`);
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
      const existing = myTargets.find((t) => t.course === lastSearch.course);
      const newTargets = existing
        ? myTargets.map((t) =>
            t.course === lastSearch.course
              ? { course: t.course, seqs: [...new Set([...t.seqs, ...checked])], department: lastSearch.department }
              : t
          )
        : [...myTargets, { course: lastSearch.course, seqs: checked, department: lastSearch.department }];

      await replaceTargets(newTargets);
      searchStatusEl.textContent = `Added ${checked.length} section(s) to ${lastSearch.course}. Checking status…`;
      await poll(); // refresh lastStatus first so the checklist can mark these as already-watching
      renderSearchResults(lastSearch.course, lastSearch.department, lastSearch.sections);
      renderManageCurrent();
    } catch (e) {
      searchStatusEl.textContent = 'Error: ' + e.message;
    } finally {
      addSelectedBtn.disabled = false;
    }
  });

  // ---- Notification settings ----

  saveNtfyBtn.addEventListener('click', async () => {
    const val = ntfyTopicInput.value.trim();
    saveNtfyBtn.disabled = true;
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ntfyTopic: val }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      ntfyStatusEl.textContent = data.ntfyTopic
        ? `Saved — you'll get a push at ntfy.sh/${data.ntfyTopic} when a target opens.`
        : 'Saved — push notifications off (add a topic to enable).';
    } catch (e) {
      ntfyStatusEl.textContent = 'Error: ' + e.message;
    } finally {
      saveNtfyBtn.disabled = false;
    }
  });

  // ---- Bootstrapping + polling ----

  async function loadTargets() {
    try {
      const res = await fetch('/api/targets');
      const data = await res.json();
      myTargets = data.targets || [];
      maxTargets = data.maxTargets || 15;
      ntfyTopicInput.value = data.ntfyTopic || '';
      if (!myTargets.length) {
        openManage();
      }
    } catch (e) {
      // /api/status polling below will surface connectivity problems
    }
  }

  async function poll() {
    let data;
    try {
      const res = await fetch('/api/status');
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
      renderManageCurrent();
    }

    if (data.anyAlarm && armed && !alarmActive) {
      startAlarm(alarmLabel(data.targets));
    } else if (!data.anyAlarm && alarmActive) {
      stopAlarm();
    }
  }

  (async () => {
    await loadTargets();
    await poll();
    setInterval(poll, POLL_MS);
    setInterval(updateHeaderClock, 1000);
  })();
})();
