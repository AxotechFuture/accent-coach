/**
 * AccentCoach — vanilla browser accent practice.
 * Decisions documented inline: Web Speech synthesis cannot be piped to AnalyserNode;
 * native waveform uses a soft animated guide; user waveform uses decoded audio.
 */
(function () {
  'use strict';

  const LS_PREFIX = 'accentCoach:v1:';
  const content = window.AccentCoachContent || {};

  /** Safe JSON localStorage (private mode / blocked storage). */
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(LS_PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
        return true;
      } catch {
        showToast('Could not save progress in this browser profile.');
        return false;
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(LS_PREFIX + key);
      } catch { /* ignore */ }
    },
  };

  const state = {
    view: 'home',
    recognition: null,
    recognitionSupported: false,
    mediaStream: null,
    mediaRecorder: null,
    recordedChunks: [],
    passageRecActive: false,
    compareRecActive: false,
    promptRecActive: false,
    shadowRecActive: false,
    activeUtterance: null,
    audioCtx: null,
    userAnalyser: null,
    userSourceNode: null,
    rafId: 0,
    compareBlob: null,
    compareObjectUrl: null,
    compareSentenceOrder: [],
    compareIdx: 0,
    pairsQueue: [],
    pairsPtr: 0,
    pairTargetIsLeft: true,
    pairCurrentCategory: 'all',
    shadowDialogueIdx: 0,
    shadowLineIdx: 0,
    shadowListening: false,
    promptStream: null,
    passageTokens: [],
    passageWordEls: [],
    passageIndex: 0,
    passageStartTs: 0,
    passageTranscriptWords: [],
    passageProblemWords: new Set(),
    micPermission: 'unknown',
    passageFinalized: false,
    passageCurrEl: null,
    passageHeardRaf: 0,
    passageScrollIdx: -1,
    canvasResizeObs: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function updateSpeechDependentControls() {
    const on = state.recognitionSupported;
    const pairBtn = $('#pair-speak');
    if (pairBtn) {
      if (on) pairBtn.removeAttribute('disabled');
      else pairBtn.setAttribute('disabled', 'true');
    }
    const passBtn = $('#passage-start');
    if (passBtn) {
      if (on) passBtn.removeAttribute('disabled');
      else passBtn.setAttribute('disabled', 'true');
    }
  }

  function showToast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      t.hidden = true;
    }, 3200);
  }

  function todayISO() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function bumpPracticeDay() {
    const stats = store.get('stats', { lastDay: '', streak: 0, weekWords: [], sessions: 0 });
    const day = todayISO();
    if (stats.lastDay === day) {
      stats.sessions = (stats.sessions || 0) + 1;
      store.set('stats', stats);
      return;
    }
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().slice(0, 10);
    if (stats.lastDay === yStr) {
      stats.streak = (stats.streak || 0) + 1;
    } else if (stats.lastDay === '') {
      stats.streak = 1;
    } else {
      stats.streak = 1;
    }
    stats.lastDay = day;
    stats.sessions = (stats.sessions || 0) + 1;
    store.set('stats', stats);
  }

  function addWeekWordCount(n) {
    const stats = store.get('stats', { lastDay: '', streak: 0, weekWords: [], sessions: 0 });
    const day = todayISO();
    stats.weekWords = Array.isArray(stats.weekWords) ? stats.weekWords : [];
    const idx = stats.weekWords.findIndex((w) => w.day === day);
    if (idx === -1) stats.weekWords.push({ day, count: n });
    else stats.weekWords[idx].count = (stats.weekWords[idx].count || 0) + n;
    stats.weekWords = stats.weekWords.filter((w) => {
      const d0 = new Date(w.day + 'T12:00:00');
      return (Date.now() - d0.getTime()) / 86400000 <= 7;
    });
    store.set('stats', stats);
  }

  function weekWordTotal() {
    const stats = store.get('stats', { weekWords: [] });
    const arr = Array.isArray(stats.weekWords) ? stats.weekWords : [];
    return arr.reduce((s, w) => s + (w.count || 0), 0);
  }

  function pickUSVoice() {
    const voices = speechSynthesis.getVoices() || [];
    const prefer = voices.filter((v) => /en-US/i.test(v.lang));
    const pick =
      prefer.find((v) => /Google US English/i.test(v.name)) ||
      prefer.find((v) => /Samantha|Alex|Victoria|Zira/i.test(v.name)) ||
      prefer[0] ||
      voices.find((v) => /^en(-|$)/i.test(v.lang)) ||
      voices[0] ||
      null;
    return pick;
  }

  function speak(text, rate) {
    cancelSpeech();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickUSVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang || 'en-US';
    } else {
      u.lang = 'en-US';
    }
    u.rate = typeof rate === 'number' ? rate : 0.9;
    state.activeUtterance = u;
    try {
      speechSynthesis.speak(u);
    } catch {
      showToast('Speech playback failed in this browser.');
    }
    return u;
  }

  function cancelSpeech() {
    try {
      speechSynthesis.cancel();
    } catch { /* ignore */ }
    state.activeUtterance = null;
  }

  function getRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function buildRecognition() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    return rec;
  }

  async function ensureMicStream() {
    if (state.mediaStream) return state.mediaStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone APIs are not available in this context.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.mediaStream = stream;
    return stream;
  }

  function stopMediaStream() {
    if (state.mediaStream) {
      try {
        state.mediaStream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
    }
    state.mediaStream = null;
  }

  function stopRecorderIfAny() {
    try {
      if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
      }
    } catch { /* ignore */ }
    state.mediaRecorder = null;
  }

  function stopAllPractice() {
    try {
      if (state.recognition) {
        state.recognition.onresult = null;
        state.recognition.onerror = null;
        state.recognition.onend = null;
        state.recognition.stop();
      }
    } catch { /* ignore */ }
    state.recognition = null;
    state.passageRecActive = false;
    state.compareRecActive = false;
    state.promptRecActive = false;
    state.shadowRecActive = false;
    state.shadowListening = false;
    stopRecorderIfAny();
    stopMediaStream();
    cancelSpeech();
    cancelAnimationFrame(state.rafId);
    state.rafId = 0;
    if (state.passageHeardRaf) {
      cancelAnimationFrame(state.passageHeardRaf);
      state.passageHeardRaf = 0;
    }
    teardownAudioGraph();
    hideRecIndicators();
    stopBreath();
    stopPacing();
  }

  function teardownAudioGraph() {
    try {
      if (state.userSourceNode) state.userSourceNode.disconnect();
    } catch { /* ignore */ }
    state.userSourceNode = null;
    state.userAnalyser = null;
    try {
      if (state.audioCtx && state.audioCtx.state !== 'closed') {
        state.audioCtx.close();
      }
    } catch { /* ignore */ }
    state.audioCtx = null;
  }

  function hideRecIndicators() {
    ['passage-rec-indicator', 'compare-rec-indicator', 'prompt-rec-indicator', 'shadow-rec-indicator'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
  }

  function normalizeWord(w) {
    return String(w || '')
      .toLowerCase()
      .replace(/[^a-z']/g, '');
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
        prev = tmp;
      }
    }
    return dp[n];
  }

  function wordMatch(expected, heard) {
    const e = normalizeWord(expected);
    const h = normalizeWord(heard);
    if (!e || !h) return false;
    if (e === h) return true;
    if (e.length <= 3 || h.length <= 3) return e === h;
    return levenshtein(e, h) <= 1;
  }

  /** --- Navigation --- */
  function focusViewHeading(name) {
    const panel = document.getElementById(`view-${name}`);
    if (!panel) return;
    const h = panel.querySelector('h2');
    if (!h) return;
    try {
      h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }

  function setView(name) {
    stopAllPractice();
    state.view = name;
    $$('.view').forEach((v) => {
      const show = v.id === `view-${name}`;
      v.hidden = !show;
      v.classList.toggle('view--active', show);
    });
    $$('.tab').forEach((btn) => {
      const on = btn.dataset.view === name;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    requestAnimationFrame(() => focusViewHeading(name));
    if (name === 'home') refreshHome();
    if (name === 'progress') refreshProgress();
    if (name === 'pairs') {
      initPairsView();
      const pSel = $('#pairs-category');
      if (pSel?.dataset.ready === '1') {
        state.pairCurrentCategory = pSel.value || 'all';
        buildPairsQueue(true);
        showPair();
      }
    }
    if (name === 'passage') initPassageView();
    if (name === 'compare') initCompareView();
    if (name === 'convo') initConvoView();
    if (name === 'fluency') initFluencyView();
    if (name === 'accent') initAccentView();
  }

  function wireNav() {
    $$('.tab').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });
    $$('.mode-card').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        setView(a.dataset.jump);
      });
    });
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-jump-view]');
      if (!t) return;
      e.preventDefault();
      const v = t.dataset.jumpView;
      const sub = t.dataset.jumpSub || '';
      setView(v);
      if (sub) {
        requestAnimationFrame(() => {
          if (v === 'fluency') showFluencySub(sub);
          else if (v === 'accent') showAccentSub(sub);
          else if (v === 'convo') setConvoSub(sub);
        });
      }
    });
  }

  /** --- First-run modal --- */
  function initWelcomeModal() {
    const modal = $('#modal-welcome');
    const ok = $('#modal-accept');
    const done = store.get('firstRun', false);

    function onModalKey(e) {
      if (!modal || modal.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      }
    }

    function closeModal() {
      store.set('firstRun', true);
      if (modal) modal.hidden = true;
      document.removeEventListener('keydown', onModalKey);
    }

    if (!done && modal) {
      modal.hidden = false;
      requestAnimationFrame(() => {
        ok?.focus();
        document.addEventListener('keydown', onModalKey);
      });
    }
    ok?.addEventListener('click', () => closeModal());
  }

  /** --- Mic check --- */
  async function micCheck() {
    const status = $('#mic-status');
    if (status) status.textContent = 'Checking…';
    try {
      const stream = await ensureMicStream();
      state.micPermission = 'granted';
      if (status) status.textContent = 'Microphone is working. You are all set.';
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch { /* ignore */ }
      });
      state.mediaStream = null;
    } catch (err) {
      state.micPermission = 'denied';
      if (status) {
        status.textContent =
          'Microphone access was blocked. You can still read passages silently; recording modes need permission.';
      }
      showToast('Microphone permission is required for recording modes.');
    }
  }

  /** --- Home --- */
  function refreshHome() {
    const stats = store.get('stats', { streak: 0 });
    const hs = $('#home-streak');
    const hw = $('#home-week-words');
    if (hs) hs.textContent = String(stats.streak || 0);
    if (hw) hw.textContent = String(weekWordTotal());
    const warm = $('#daily-warmup');
    const tips = content.dailyWarmups || ['Take five slow breaths before you speak.'];
    const day = new Date().getDay();
    if (warm) {
      warm.innerHTML = `<strong>Daily warm-up</strong><p>${tips[day % tips.length]}</p>`;
    }
    renderDailyPlan();
  }

  function renderDailyPlan() {
    const list = $('#plan-steps');
    if (!list) return;
    const plan = content.dailyPlan || [];
    list.innerHTML = '';
    plan.forEach((step, i) => {
      const li = document.createElement('li');
      li.className = 'plan-step';
      li.innerHTML = `
        <div class="plan-step__index" aria-hidden="true">${i + 1}</div>
        <div class="plan-step__body">
          <div class="plan-step__head">
            <span class="plan-step__label">${escapeHtml(step.label)}</span>
            <span class="plan-step__min">${step.minutes} min</span>
          </div>
          <p class="plan-step__desc">${escapeHtml(step.desc || '')}</p>
        </div>
        <button type="button" class="btn btn-primary plan-step__go" data-jump-view="${step.view}" data-jump-sub="${step.sub || ''}">Start</button>
      `;
      list.appendChild(li);
    });
  }

  /** --- Minimal pairs --- */
  function initPairsView() {
    const sel = $('#pairs-category');
    if (!sel || sel.dataset.ready === '1') return;
    sel.dataset.ready = '1';
    const cats = content.minimalPairCategories || [];
    sel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = 'All categories (shuffled)';
    sel.appendChild(optAll);
    cats.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.title;
      sel.appendChild(o);
    });
    state.pairCurrentCategory = sel.value || 'all';
    sel.addEventListener('change', () => {
      state.pairCurrentCategory = sel.value;
      buildPairsQueue(true);
      showPair();
    });
    $('#pair-left')?.addEventListener('click', () => playPairSide('left'));
    $('#pair-right')?.addEventListener('click', () => playPairSide('right'));
    $('#pair-speak')?.addEventListener('click', () => startPairListen());
    $('#pair-next')?.addEventListener('click', () => nextPair(true));
    $('#pair-hear-again')?.addEventListener('click', () => replayPairTarget(0.9));
    $('#pair-slow')?.addEventListener('click', () => replayPairTarget(0.6));
  }

  function buildPairsQueue(resetPtr) {
    const cats = content.minimalPairCategories || [];
    let pool = [];
    if (state.pairCurrentCategory === 'all') {
      cats.forEach((c) => {
        (c.pairs || []).forEach((p) => {
          pool.push({ cat: c, a: p[0], b: p[1] });
        });
      });
    } else {
      const c = cats.find((x) => x.id === state.pairCurrentCategory);
      (c?.pairs || []).forEach((p) => pool.push({ cat: c, a: p[0], b: p[1] }));
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    state.pairsQueue = pool;
    if (resetPtr) state.pairsPtr = 0;
  }

  function currentPair() {
    return state.pairsQueue[state.pairsPtr] || null;
  }

  function showPair() {
    const p = currentPair();
    const left = $('#pair-left');
    const right = $('#pair-right');
    const tip = $('#pair-tip');
    const fb = $('#pair-feedback');
    const miss = $('#pair-miss-tools');
    const line = $('#pair-target-line');
    if (!p || !left || !right) return;
    state.pairTargetIsLeft = Math.random() < 0.5;
    left.textContent = p.a;
    right.textContent = p.b;
    left.setAttribute('aria-label', `Play word ${p.a}`);
    right.setAttribute('aria-label', `Play word ${p.b}`);
    left.classList.toggle('hl', state.pairTargetIsLeft);
    right.classList.toggle('hl', !state.pairTargetIsLeft);
    if (tip) tip.textContent = p.cat.tip || '';
    if (fb) fb.textContent = '';
    if (miss) miss.hidden = true;
    if (line) {
      const tgt = state.pairTargetIsLeft ? p.a : p.b;
      line.textContent = `Say the highlighted word: “${tgt}”.`;
    }
  }

  function playPairSide(side) {
    const p = currentPair();
    if (!p) return;
    const w = side === 'left' ? p.a : p.b;
    speak(w, 0.9);
  }

  function replayPairTarget(rate) {
    const p = currentPair();
    if (!p) return;
    const w = state.pairTargetIsLeft ? p.a : p.b;
    speak(w, rate);
  }

  function startPairListen() {
    const p = currentPair();
    if (!p) return;
    if (!state.recognitionSupported) {
      showToast('Speech recognition is not available in this browser.');
      return;
    }
    try {
      state.recognition && state.recognition.stop();
    } catch { /* ignore */ }
    state.recognition = null;
    const fb = $('#pair-feedback');
    if (fb) fb.textContent = 'Listening…';
    const rec = buildRecognition();
    if (!rec) return;
    rec.continuous = false;
    rec.interimResults = true;
    let resolved = false;
    const finish = (ok, heard) => {
      if (resolved) return;
      resolved = true;
      try {
        rec.stop();
      } catch { /* ignore */ }
      const tgt = state.pairTargetIsLeft ? p.a : p.b;
      const catId = p.cat.id;
      const stats = store.get('pairStats', {});
      stats[catId] = stats[catId] || { correct: 0, total: 0 };
      stats[catId].total += 1;
      if (ok) stats[catId].correct += 1;
      store.set('pairStats', stats);
      addWeekWordCount(1);
      bumpPracticeDay();
      if (fb) {
        fb.textContent = ok
          ? 'Match — nice work.'
          : `Heard “${heard || '…'}”. Try again, or use Hear again / Slow.`;
      }
      const miss = $('#pair-miss-tools');
      if (miss) miss.hidden = ok;
      const tipEl = $('#pair-tip');
      if (tipEl) tipEl.textContent = ok ? p.cat.tip || '' : `${p.cat.tip}`;
    };
    rec.onerror = (e) => {
      if (fb) fb.textContent = `Listening error: ${e.error || 'unknown'}`;
    };
    rec.onend = () => {
      if (!resolved && fb) fb.textContent = 'No speech detected. Try again.';
    };
    rec.onresult = (ev) => {
      let text = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        text += ev.results[i][0].transcript;
      }
      const words = text.trim().split(/\s+/).filter(Boolean);
      const heard = words[words.length - 1] || text.trim();
      const tgt = state.pairTargetIsLeft ? p.a : p.b;
      if (ev.results[ev.results.length - 1].isFinal) {
        const ok = wordMatch(tgt, heard) || wordMatch(tgt, text);
        finish(ok, heard || text);
      }
    };
    state.recognition = rec;
    try {
      rec.start();
    } catch (e) {
      if (fb) fb.textContent = 'Could not start listening.';
    }
  }

  function nextPair(advance) {
    if (advance) {
      state.pairsPtr += 1;
      if (state.pairsPtr >= state.pairsQueue.length) {
        buildPairsQueue(true);
      }
    }
    showPair();
  }

  /** --- Passages --- */
  function initPassageView() {
    const sel = $('#passage-select');
    if (!sel || sel.dataset.ready === '1') return;
    sel.dataset.ready = '1';
    (content.passages || []).forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.title;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => renderPassage(sel.value));
    $('#passage-start')?.addEventListener('click', () => startPassageRead());
    $('#passage-stop')?.addEventListener('click', () => stopPassageRead(false));
    renderPassage(sel.value || (content.passages && content.passages[0]?.id));
  }

  function renderPassage(id) {
    const p = (content.passages || []).find((x) => x.id === id) || content.passages?.[0];
    const box = $('#passage-text');
    if (!p || !box) return;
    const parts = p.text.split(/(\s+)/);
    const frag = document.createDocumentFragment();
    state.passageTokens = [];
    state.passageWordEls = [];
    let wi = 0;
    parts.forEach((chunk) => {
      if (!chunk) return;
      if (/^\s+$/.test(chunk)) {
        frag.appendChild(document.createTextNode(chunk.includes('\n') ? chunk : ' '));
        return;
      }
      const key = normalizeWord(chunk);
      if (!key) {
        frag.appendChild(document.createTextNode(chunk));
        return;
      }
      const span = document.createElement('span');
      span.className = 'w';
      span.dataset.index = String(wi);
      span.textContent = chunk;
      state.passageTokens.push({ el: span, raw: chunk, key });
      state.passageWordEls.push(span);
      frag.appendChild(span);
      wi += 1;
    });
    box.innerHTML = '';
    box.appendChild(frag);
    $('#passage-summary') && ($('#passage-summary').hidden = true);
    $('#passage-stop')?.setAttribute('disabled', 'true');
    if (state.recognitionSupported) $('#passage-start')?.removeAttribute('disabled');
    else $('#passage-start')?.setAttribute('disabled', 'true');
    state.passageFinalized = false;
    state.passageCurrEl = null;
    state.passageScrollIdx = -1;
  }

  function setPassageCurrentIndex(i) {
    const els = state.passageWordEls;
    if (i >= 0 && i < els.length && state.passageCurrEl === els[i]) return;
    if (state.passageCurrEl) {
      state.passageCurrEl.classList.remove('w-curr');
      state.passageCurrEl = null;
    }
    if (i < 0 || i >= els.length) {
      state.passageScrollIdx = -1;
      return;
    }
    const el = els[i];
    el.classList.add('w-curr');
    state.passageCurrEl = el;
    if (i !== state.passageScrollIdx) {
      state.passageScrollIdx = i;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      try {
        el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      } catch {
        /* ignore */
      }
    }
  }

  function startPassageRead() {
    if (!state.recognitionSupported) {
      showToast('Speech recognition is unavailable; try Chrome or Edge.');
      return;
    }
    stopAllPractice();
    state.passageIndex = 0;
    state.passageProblemWords = new Set();
    state.passageTranscriptWords = [];
    state.passageStartTs = Date.now();
    state.passageFinalized = false;
    state.passageRecActive = true;
    $('#passage-rec-indicator') && ($('#passage-rec-indicator').hidden = false);
    $('#passage-stop')?.removeAttribute('disabled');
    $('#passage-start')?.setAttribute('disabled', 'true');
    state.passageScrollIdx = -1;
    setPassageCurrentIndex(0);
    const rec = buildRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    let buffer = '';
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const piece = r[0].transcript;
        if (r.isFinal) buffer += ` ${piece}`;
        else interim += piece;
      }
      const slice = `${buffer} ${interim}`.trim();
      const heard = slice.split(/\s+/).map(normalizeWord).filter(Boolean);
      const hasInterim = !!interim;
      state._passagePendingHeard = heard;
      state._passagePendingInterim = hasInterim;
      if (state.passageHeardRaf) return;
      state.passageHeardRaf = requestAnimationFrame(() => {
        state.passageHeardRaf = 0;
        advancePassageFromHeard(state._passagePendingHeard || [], !!state._passagePendingInterim);
      });
    };
    rec.onerror = (e) => {
      showToast(`Passage listening error: ${e.error || 'unknown'}`);
    };
    rec.onend = () => {
      if (state.passageRecActive) {
        try {
          rec.start();
        } catch {
          /* ignore */
        }
      }
    };
    state.recognition = rec;
    try {
      rec.start();
    } catch {
      showToast('Could not start passage listening.');
    }
    bumpPracticeDay();
  }

  function advancePassageFromHeard(heardWords, hasInterim) {
    let i = state.passageIndex;
    while (i < state.passageTokens.length) {
      const expected = state.passageTokens[i].key;
      const lastFew = heardWords.slice(-6);
      const hit = lastFew.some((h) => wordMatch(expected, h));
      if (!hit) break;
      i += 1;
    }
    if (i !== state.passageIndex) {
      for (let k = state.passageIndex; k < i; k++) {
        if (state.passageTokens[k]) state.passageTokens[k].el.classList.add('w-ok');
      }
      state.passageIndex = i;
    }
    if (state.passageIndex < state.passageTokens.length) {
      setPassageCurrentIndex(state.passageIndex);
    } else if (!hasInterim) {
      setPassageCurrentIndex(-1);
      stopPassageListening();
      finalizePassage();
    }
  }

  function stopPassageListening() {
    state.passageRecActive = false;
    try {
      state.recognition && state.recognition.stop();
    } catch { /* ignore */ }
    state.recognition = null;
    $('#passage-rec-indicator') && ($('#passage-rec-indicator').hidden = true);
    $('#passage-stop')?.setAttribute('disabled', 'true');
    if (state.recognitionSupported) $('#passage-start')?.removeAttribute('disabled');
    else $('#passage-start')?.setAttribute('disabled', 'true');
  }

  function finalizePassage() {
    if (state.passageFinalized) return;
    state.passageFinalized = true;
    stopPassageListening();
    const total = state.passageTokens.length || 1;
    const matched = Math.min(state.passageIndex, total);
    const elapsedMin = Math.max((Date.now() - state.passageStartTs) / 60000, 1 / 60);
    const wpm = Math.round(matched / elapsedMin);
    const acc = Math.round((matched / total) * 100);
    for (let k = matched; k < total; k++) {
      state.passageProblemWords.add(k);
      const el = state.passageTokens[k]?.el;
      if (el) el.classList.add('w-bad');
    }
    const sum = $('#passage-summary');
    const pSel = $('#passage-select');
    const pid = pSel?.value || '';
    const passage = (content.passages || []).find((x) => x.id === pid);
    if (sum) {
      sum.hidden = false;
      const problems = Array.from(state.passageProblemWords)
        .slice(0, 24)
        .map((idx) => state.passageTokens[idx]?.raw)
        .filter(Boolean);
      sum.innerHTML = '';
      const h3 = document.createElement('h3');
      h3.textContent = 'Session summary';
      sum.appendChild(h3);
      const pEl = document.createElement('p');
      pEl.innerHTML = `<strong>Accuracy:</strong> ${acc}% · <strong>Pace:</strong> ~${wpm} words per minute`;
      sum.appendChild(pEl);
      const lbl = document.createElement('div');
      lbl.textContent = 'Practice focus words';
      sum.appendChild(lbl);
      const ul = document.createElement('ul');
      if (!problems.length) {
        const li = document.createElement('li');
        li.textContent = 'Great — no missed words detected.';
        ul.appendChild(li);
      } else {
        problems.forEach((w) => {
          const li = document.createElement('li');
          li.appendChild(document.createTextNode(`${w} `));
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn';
          b.textContent = 'Hear';
          b.addEventListener('click', () => speak(w, 0.85));
          li.appendChild(b);
          ul.appendChild(li);
        });
      }
      sum.appendChild(ul);
    }
    const hist = store.get('passageHistory', []);
    hist.unshift({
      id: pid,
      title: passage?.title || 'Passage',
      at: Date.now(),
      acc,
      wpm,
    });
    store.set('passageHistory', hist.slice(0, 40));
    const modeAcc = store.get('modeAccuracy', { passage: [], pairs: [], compare: [], convo: [] });
    modeAcc.passage = modeAcc.passage || [];
    modeAcc.passage.push(acc);
    if (modeAcc.passage.length > 60) modeAcc.passage.length = 60;
    store.set('modeAccuracy', modeAcc);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function stopPassageRead(clearUi = true) {
    stopPassageListening();
    if (clearUi) {
      state.passageCurrEl = null;
      state.passageScrollIdx = -1;
      state.passageWordEls.forEach((el) => el.classList.remove('w-curr', 'w-ok', 'w-bad'));
    } else {
      finalizePassage();
    }
  }

  /** --- Compare --- */
  function initCompareView() {
    const root = $('#view-compare');
    if (!root || root.dataset.ready === '1') return;
    root.dataset.ready = '1';
    $('#compare-native')?.addEventListener('click', () => playCompareNative());
    $('#compare-record')?.addEventListener('click', () => startCompareRecord());
    $('#compare-stop')?.addEventListener('click', () => stopCompareRecord());
    $('#compare-play-user')?.addEventListener('click', () => playUserBlob());
    $('#compare-next')?.addEventListener('click', () => advanceCompareSentence(true));
    $$('#star-rating .star').forEach((s) => {
      s.addEventListener('click', () => setStarRating(Number(s.dataset.value)));
    });
    advanceCompareSentence(false);
  }

  function shuffleCompare() {
    const arr = (content.compareSentences || []).map((_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    state.compareSentenceOrder = arr;
    state.compareIdx = 0;
  }

  function advanceCompareSentence(fromUser) {
    if (!state.compareSentenceOrder.length) shuffleCompare();
    if (fromUser) {
      state.compareIdx += 1;
      if (state.compareIdx >= state.compareSentenceOrder.length) shuffleCompare();
    }
    const item = content.compareSentences[state.compareSentenceOrder[state.compareIdx]];
    const box = $('#compare-sentence');
    if (box && item) {
      box.innerHTML = `<p>${escapeHtml(item.text)}</p><p class="note">${escapeHtml(item.note || '')}</p>`;
    }
    disposeCompareBlob();
    drawFlat('#wave-user');
    drawFlat('#wave-native');
    resetStars();
    $('#compare-play-user')?.setAttribute('disabled', 'true');
  }

  function disposeCompareBlob() {
    if (state.compareObjectUrl) {
      try {
        URL.revokeObjectURL(state.compareObjectUrl);
      } catch { /* ignore */ }
    }
    state.compareObjectUrl = null;
    state.compareBlob = null;
  }

  function playCompareNative() {
    const item = content.compareSentences[state.compareSentenceOrder[state.compareIdx]];
    if (!item) return;
    const u = speak(item.text, 0.9);
    animateNativeGuide(item.text.length * 0.06);
    u.onend = () => cancelAnimationFrame(state.rafId);
  }

  async function startCompareRecord() {
    if (state.compareRecActive) return;
    try {
      const stream = await ensureMicStream();
      state.compareRecActive = true;
      state.recordedChunks = [];
      $('#compare-rec-indicator') && ($('#compare-rec-indicator').hidden = false);
      $('#compare-stop')?.removeAttribute('disabled');
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      state.mediaRecorder = rec;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) state.recordedChunks.push(e.data);
      };
      rec.onstop = () => {
        state.compareRecActive = false;
        $('#compare-rec-indicator') && ($('#compare-rec-indicator').hidden = true);
        $('#compare-stop')?.setAttribute('disabled', 'true');
        const blob = new Blob(state.recordedChunks, { type: rec.mimeType || 'audio/webm' });
        state.compareBlob = blob;
        disposeCompareBlob();
        state.compareObjectUrl = URL.createObjectURL(blob);
        $('#compare-play-user')?.removeAttribute('disabled');
        drawUserWaveformFromBlob(blob);
        bumpPracticeDay();
      };
      rec.start();
    } catch (e) {
      showToast('Recording failed. Check microphone permissions.');
      state.compareRecActive = false;
      $('#compare-rec-indicator') && ($('#compare-rec-indicator').hidden = true);
    }
  }

  function stopCompareRecord() {
    stopRecorderIfAny();
  }

  function playUserBlob() {
    if (!state.compareObjectUrl) return;
    const audio = new Audio(state.compareObjectUrl);
    audio.addEventListener('play', () => visualizeUserFromElement(audio));
    audio.play().catch(() => showToast('Playback blocked. Click again.'));
  }

  async function drawUserWaveformFromBlob(blob) {
    try {
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      drawBufferOnCanvas('#wave-user', buf.getChannelData(0));
      await ctx.close();
    } catch {
      drawFlat('#wave-user');
    }
  }

  /** Prepare canvas backing store for devicePixelRatio; context draws in CSS pixels. */
  function prepareCanvas2d(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx2 = canvas.getContext('2d');
    if (!ctx2) return null;
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx2, cssW, cssH };
  }

  function drawBufferOnCanvas(sel, channel) {
    const c = document.querySelector(sel);
    if (!c) return;
    const pre = prepareCanvas2d(c);
    if (!pre) return;
    const { ctx: ctx2, cssW: w, cssH: h } = pre;
    ctx2.clearRect(0, 0, w, h);
    ctx2.fillStyle = '#0b1220';
    ctx2.fillRect(0, 0, w, h);
    ctx2.strokeStyle = '#5eead4';
    ctx2.lineWidth = 1.2;
    ctx2.beginPath();
    const step = Math.max(1, Math.floor(channel.length / w));
    const amp = h / 2;
    for (let x = 0; x < w; x++) {
      const s = channel[x * step] || 0;
      const y = amp + s * (amp - 6);
      if (x === 0) ctx2.moveTo(x, y);
      else ctx2.lineTo(x, y);
    }
    ctx2.stroke();
  }

  function drawFlat(sel) {
    const c = document.querySelector(sel);
    if (!c) return;
    const pre = prepareCanvas2d(c);
    if (!pre) return;
    const { ctx: ctx2, cssW, cssH } = pre;
    ctx2.clearRect(0, 0, cssW, cssH);
    ctx2.fillStyle = '#0b1220';
    ctx2.fillRect(0, 0, cssW, cssH);
    ctx2.strokeStyle = '#334155';
    ctx2.beginPath();
    ctx2.moveTo(0, cssH / 2);
    ctx2.lineTo(cssW, cssH / 2);
    ctx2.stroke();
  }

  function animateNativeGuide(seconds) {
    const c = document.querySelector('#wave-native');
    if (!c) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      drawFlat('#wave-native');
      return;
    }
    const t0 = performance.now();
    const dur = Math.max(1.2, seconds) * 1000;
    const frame = (t) => {
      const pre = prepareCanvas2d(c);
      if (!pre) return;
      const { ctx: ctx2, cssW: w, cssH: h } = pre;
      const p = Math.min(1, (t - t0) / dur);
      ctx2.clearRect(0, 0, w, h);
      ctx2.fillStyle = '#0b1220';
      ctx2.fillRect(0, 0, w, h);
      ctx2.strokeStyle = '#93c5fd';
      ctx2.beginPath();
      for (let x = 0; x < w; x++) {
        const phase = (x / w) * Math.PI * 6 + p * 10;
        const y = h / 2 + Math.sin(phase) * (h * 0.25) * (0.4 + 0.6 * p);
        if (x === 0) ctx2.moveTo(x, y);
        else ctx2.lineTo(x, y);
      }
      ctx2.stroke();
      if (p < 1) state.rafId = requestAnimationFrame(frame);
    };
    cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(frame);
  }

  function visualizeUserFromElement(audio) {
    teardownAudioGraph();
    try {
      const ctx = new AudioContext();
      state.audioCtx = ctx;
      const src = ctx.createMediaElementSource(audio);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      an.connect(ctx.destination);
      state.userAnalyser = an;
      state.userSourceNode = src;
      const c = document.querySelector('#wave-user');
      if (!c) return;
      const data = new Uint8Array(an.frequencyBinCount);
      const loop = () => {
        const pre = prepareCanvas2d(c);
        if (!pre) return;
        const { ctx: ctx2, cssW: cw, cssH: ch } = pre;
        an.getByteTimeDomainData(data);
        ctx2.clearRect(0, 0, cw, ch);
        ctx2.fillStyle = '#0b1220';
        ctx2.fillRect(0, 0, cw, ch);
        ctx2.strokeStyle = '#5eead4';
        ctx2.beginPath();
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          const x = (i / data.length) * cw;
          const y = ch / 2 + v * (ch / 2 - 4);
          if (i === 0) ctx2.moveTo(x, y);
          else ctx2.lineTo(x, y);
        }
        ctx2.stroke();
        if (!audio.paused) state.rafId = requestAnimationFrame(loop);
      };
      state.rafId = requestAnimationFrame(loop);
    } catch {
      /* ignore */
    }
  }

  function resetStars() {
    $$('#star-rating .star').forEach((s) => s.classList.remove('on'));
  }

  function setStarRating(n) {
    $$('#star-rating .star').forEach((s) => {
      s.classList.toggle('on', Number(s.dataset.value) <= n);
    });
    const item = content.compareSentences[state.compareSentenceOrder[state.compareIdx]];
    const arr = store.get('compareStars', []);
    arr.push({ at: Date.now(), stars: n, text: item?.text || '' });
    store.set('compareStars', arr.slice(-120));
    const modeAcc = store.get('modeAccuracy', { compare: [] });
    modeAcc.compare = modeAcc.compare || [];
    modeAcc.compare.push(n * 20);
    if (modeAcc.compare.length > 60) modeAcc.compare.length = 60;
    store.set('modeAccuracy', modeAcc);
    showToast('Saved your self-rating.');
  }

  /** --- Shadowing & prompts --- */
  function initConvoView() {
    const root = $('#view-convo');
    if (!root || root.dataset.ready === '1') return;
    root.dataset.ready = '1';
    $('#subtab-shadow')?.addEventListener('click', () => setConvoSub('shadow'));
    $('#subtab-prompt')?.addEventListener('click', () => setConvoSub('prompt'));
    $('#shadow-begin')?.addEventListener('click', () => startShadowFlow());
    $('#shadow-repeat-line')?.addEventListener('click', () => shadowPlayLine());
    $('#shadow-next-line')?.addEventListener('click', () => shadowForceNext());
    $('#prompt-record')?.addEventListener('click', () => startPromptFlow());
    $('#prompt-stop')?.addEventListener('click', () => stopPromptFlow());
    $('#prompt-save-self')?.addEventListener('click', () => savePromptSelf());
    renderShadowDialogue();
    renderPrompt();
  }

  function setConvoSub(name) {
    const a = name === 'shadow';
    $('#convo-shadow').hidden = !a;
    $('#convo-prompt').hidden = a;
    $('#subtab-shadow')?.setAttribute('aria-selected', a ? 'true' : 'false');
    $('#subtab-prompt')?.setAttribute('aria-selected', a ? 'false' : 'true');
    stopAllPractice();
    if (a) renderShadowDialogue();
    else renderPrompt();
  }

  function renderShadowDialogue() {
    const list = content.shadowDialogues || [];
    if (!list.length) return;
    state.shadowDialogueIdx = Math.floor(Math.random() * list.length);
    const d = list[state.shadowDialogueIdx];
    const meta = $('#shadow-meta');
    if (meta) meta.textContent = `${d.setting}`;
    const box = $('#shadow-dialogue');
    if (box) {
      box.innerHTML = (d.lines || [])
        .map((ln, i) => `<div class="line" data-i="${i}">${escapeHtml(ln)}</div>`)
        .join('');
    }
    state.shadowLineIdx = 0;
    $('#shadow-repeat-line')?.setAttribute('disabled', 'true');
    $('#shadow-next-line')?.setAttribute('disabled', 'true');
  }

  function startShadowFlow() {
    stopAllPractice();
    state.shadowLineIdx = 0;
    $('#shadow-repeat-line')?.removeAttribute('disabled');
    $('#shadow-next-line')?.removeAttribute('disabled');
    shadowPlayLine();
  }

  function shadowPlayLine() {
    const d = content.shadowDialogues[state.shadowDialogueIdx];
    const line = d?.lines[state.shadowLineIdx];
    if (!line) return;
    const u = speak(line, 0.88);
    u.onend = () => beginShadowListen(line);
  }

  function beginShadowListen(expected) {
    if (!state.recognitionSupported) {
      $('#shadow-feedback').textContent =
        'Recognition unavailable — repeat the line aloud for your own practice, then press Next.';
      return;
    }
    state.shadowListening = true;
    $('#shadow-rec-indicator') && ($('#shadow-rec-indicator').hidden = false);
    const rec = buildRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    let done = false;
    const stopSafe = () => {
      if (done) return;
      done = true;
      try {
        rec.stop();
      } catch { /* ignore */ }
      state.shadowListening = false;
      $('#shadow-rec-indicator') && ($('#shadow-rec-indicator').hidden = true);
    };
    rec.onresult = (ev) => {
      let text = '';
      for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
      const ok = roughLineMatch(expected, text);
      $('#shadow-feedback').textContent = ok
        ? 'Line detected — nice.'
        : 'Keep going — try the line once more, then tap Next.';
    };
    rec.onerror = () => {
      $('#shadow-feedback').textContent = 'Listening hiccup — tap Hear line again.';
      stopSafe();
    };
    rec.onend = () => {
      stopSafe();
    };
    state.recognition = rec;
    try {
      rec.start();
    } catch {
      $('#shadow-feedback').textContent = 'Could not start listening.';
    }
    bumpPracticeDay();
  }

  function roughLineMatch(expected, heard) {
    const a = normalizeWord(expected.replace(/[^a-z ]/gi, ''));
    const tokens = heard.toLowerCase().split(/\s+/).map(normalizeWord).filter(Boolean);
    const needed = expected
      .toLowerCase()
      .split(/\s+/)
      .map(normalizeWord)
      .filter(Boolean);
    let hits = 0;
    needed.forEach((w) => {
      if (tokens.some((t) => wordMatch(w, t))) hits += 1;
    });
    return hits >= Math.max(1, Math.floor(needed.length * 0.55));
  }

  function shadowForceNext() {
    try {
      state.recognition && state.recognition.stop();
    } catch { /* ignore */ }
    state.recognition = null;
    const d = content.shadowDialogues[state.shadowDialogueIdx];
    if (!d) return;
    if (state.shadowLineIdx + 1 < d.lines.length) {
      state.shadowLineIdx += 1;
      shadowPlayLine();
    } else {
      $('#shadow-feedback').textContent = 'You finished the dialogue. Tap Begin for a fresh shuffle.';
      state.shadowLineIdx = 0;
    }
  }

  function renderPrompt() {
    const prompts = content.conversationPrompts || ['Tell a one-minute story about your day.'];
    const p = prompts[Math.floor(Math.random() * prompts.length)];
    const box = $('#prompt-text');
    if (box) box.innerHTML = `<p>${escapeHtml(p)}</p>`;
    $('#prompt-transcript').textContent = '';
    $('#prompt-audio').hidden = true;
    const card = $('#prompt-fillers');
    if (card) card.hidden = true;
    disposePromptUrl();
  }

  let promptObjectUrl = null;
  function disposePromptUrl() {
    if (promptObjectUrl) {
      try {
        URL.revokeObjectURL(promptObjectUrl);
      } catch { /* ignore */ }
    }
    promptObjectUrl = null;
  }

  async function startPromptFlow() {
    if (state.promptRecActive) return;
    try {
      const stream = await ensureMicStream();
      state.promptStream = stream;
      state.promptRecActive = true;
      state.recordedChunks = [];
      $('#prompt-rec-indicator') && ($('#prompt-rec-indicator').hidden = false);
      $('#prompt-stop')?.removeAttribute('disabled');
      $('#prompt-record')?.setAttribute('disabled', 'true');
      let textBuf = '';
      if (state.recognitionSupported) {
        const rec = buildRecognition();
        rec.continuous = true;
        rec.interimResults = true;
        rec.onresult = (ev) => {
          textBuf = '';
          for (let i = 0; i < ev.results.length; i++) {
            textBuf += ev.results[i][0].transcript;
          }
          $('#prompt-transcript').textContent = textBuf;
          renderFillerReport(textBuf);
        };
        rec.onerror = () => {};
        state.recognition = rec;
        try {
          rec.start();
        } catch { /* ignore */ }
      }
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recm = new MediaRecorder(stream, { mimeType: mime });
      state.mediaRecorder = recm;
      recm.ondataavailable = (e) => {
        if (e.data && e.data.size) state.recordedChunks.push(e.data);
      };
      recm.onstop = () => {
        state.promptRecActive = false;
        $('#prompt-rec-indicator') && ($('#prompt-rec-indicator').hidden = true);
        $('#prompt-stop')?.setAttribute('disabled', 'true');
        $('#prompt-record')?.removeAttribute('disabled');
        try {
          state.recognition && state.recognition.stop();
        } catch { /* ignore */ }
        state.recognition = null;
        const blob = new Blob(state.recordedChunks, { type: mime });
        disposePromptUrl();
        promptObjectUrl = URL.createObjectURL(blob);
        const a = $('#prompt-audio');
        if (a) {
          a.src = promptObjectUrl;
          a.hidden = false;
        }
        renderFillerReport($('#prompt-transcript')?.textContent || '');
        bumpPracticeDay();
      };
      recm.start();
      setTimeout(() => {
        if (state.promptRecActive) showToast('Tip: aim for 30–60 seconds, then stop.');
      }, 15000);
    } catch {
      showToast('Could not access the microphone.');
      state.promptRecActive = false;
      $('#prompt-rec-indicator') && ($('#prompt-rec-indicator').hidden = true);
    }
  }

  function stopPromptFlow() {
    stopRecorderIfAny();
  }

  function savePromptSelf() {
    const payload = {
      at: Date.now(),
      clarity: Number($('#slider-clarity')?.value || 3),
      rhythm: Number($('#slider-rhythm')?.value || 3),
      confidence: Number($('#slider-confidence')?.value || 3),
      transcript: $('#prompt-transcript')?.textContent || '',
    };
    const arr = store.get('promptAssess', []);
    arr.push(payload);
    store.set('promptAssess', arr.slice(-80));
    const modeAcc = store.get('modeAccuracy', { convo: [] });
    modeAcc.convo = modeAcc.convo || [];
    const avg = ((payload.clarity + payload.rhythm + payload.confidence) / 3) * 20;
    modeAcc.convo.push(avg);
    if (modeAcc.convo.length > 60) modeAcc.convo.length = 60;
    store.set('modeAccuracy', modeAcc);
    showToast('Saved your self-check.');
  }

  /** --- Progress --- */
  function average(arr) {
    if (!arr || !arr.length) return 0;
    return arr.reduce((s, n) => s + n, 0) / arr.length;
  }

  function refreshProgress() {
    const stats = store.get('stats', { streak: 0, sessions: 0 });
    $('#prog-streak').textContent = String(stats.streak || 0);
    $('#prog-sessions').textContent = String(stats.sessions || 0);
    drawAccuracyChart();
    const ps = store.get('pairStats', {});
    const rows = Object.entries(ps)
      .map(([id, v]) => {
        const cat = (content.minimalPairCategories || []).find((c) => c.id === id);
        const acc = v.total ? Math.round((v.correct / v.total) * 100) : 999;
        return { id, title: cat?.title || id, acc, total: v.total || 0 };
      })
      .filter((r) => r.total >= 3)
      .sort((a, b) => a.acc - b.acc)
      .slice(0, 3);
    const ul = $('#weak-cats');
    if (ul) {
      ul.innerHTML = rows.length
        ? rows.map((r) => `<li>${escapeHtml(r.title)} — about ${r.acc}% over ${r.total} tries</li>`).join('')
        : '<li>Practice more minimal pairs to see categories here.</li>';
    }
    const hist = store.get('passageHistory', []);
    const ul2 = $('#passage-history');
    if (ul2) {
      ul2.innerHTML = hist
        .slice(0, 10)
        .map(
          (h) =>
            `<li>${escapeHtml(h.title)} — ${h.acc}% · ${h.wpm} wpm · ${new Date(h.at).toLocaleString()}</li>`,
        )
        .join('') || '<li>No passage sessions yet.</li>';
    }
  }

  function drawAccuracyChart() {
    const c = document.querySelector('#chart-accuracy');
    if (!c) return;
    const pre = prepareCanvas2d(c);
    if (!pre) return;
    const { ctx: ctx2, cssW: w, cssH: h } = pre;
    const root = getComputedStyle(document.documentElement);
    const surface = (root.getPropertyValue('--chart-surface') || '#ffffff').trim();
    const text = (root.getPropertyValue('--chart-text') || '#1f2933').trim();
    const bar = (root.getPropertyValue('--chart-bar') || '#2d6a6a').trim();
    const modeAcc = store.get('modeAccuracy', {});
    const pairsArr = store.get('pairStats', {});
    let pairAvg = 0;
    const totals = Object.values(pairsArr);
    if (totals.length) {
      const csum = totals.reduce((s, v) => s + (v.correct || 0), 0);
      const tsum = totals.reduce((s, v) => s + (v.total || 0), 0);
      pairAvg = tsum ? Math.round((csum / tsum) * 100) : 0;
    }
    const data = [
      { label: 'Minimal pairs', value: pairAvg },
      { label: 'Passages', value: Math.round(average(modeAcc.passage || [])) },
      { label: 'Compare stars', value: Math.round(average(modeAcc.compare || [])) },
      { label: 'Conversation', value: Math.round(average(modeAcc.convo || [])) },
    ];
    ctx2.clearRect(0, 0, w, h);
    ctx2.fillStyle = surface;
    ctx2.fillRect(0, 0, w, h);
    const barW = (w - 80) / data.length;
    data.forEach((d, i) => {
      const x = 40 + i * barW + 8;
      const bh = (h - 60) * (Math.min(100, d.value) / 100);
      const y = h - 40 - bh;
      ctx2.fillStyle = bar;
      ctx2.fillRect(x, y, barW - 16, bh);
      ctx2.fillStyle = text;
      ctx2.font = '12px system-ui';
      ctx2.fillText(`${d.value}%`, x, y - 6);
      ctx2.save();
      ctx2.translate(x + 6, h - 28);
      ctx2.rotate(-0.2);
      ctx2.fillText(d.label, 0, 0);
      ctx2.restore();
    });
  }

  function bindCanvasResizeRedraw() {
    if (state.canvasResizeObs || typeof ResizeObserver === 'undefined') return;
    let t = 0;
    const run = () => {
      if (state.view === 'progress') drawAccuracyChart();
      drawFlat('#wave-native');
      if (state.compareBlob) drawUserWaveformFromBlob(state.compareBlob);
      else drawFlat('#wave-user');
    };
    state.canvasResizeObs = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(run, 80);
    });
    ['#chart-accuracy', '#wave-native', '#wave-user'].forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) state.canvasResizeObs.observe(el);
    });
  }

  /** --- Filler-word counter (prompt mode) --- */
  function countFillers(text) {
    const fillers = (content.fillerWords && content.fillerWords.length)
      ? content.fillerWords
      : ['um', 'uh', 'like', 'you know', 'so', 'actually', 'basically', 'literally'];
    const lower = String(text || '').toLowerCase();
    const counts = {};
    let total = 0;
    fillers.forEach((f) => {
      const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'gi');
      const matches = lower.match(re);
      const n = matches ? matches.length : 0;
      if (n > 0) {
        counts[f] = n;
        total += n;
      }
    });
    return { counts, total };
  }

  function renderFillerReport(text) {
    const card = $('#prompt-fillers');
    const summary = $('#prompt-filler-summary');
    const list = $('#prompt-filler-list');
    if (!card || !summary || !list) return;
    const trimmed = String(text || '').trim();
    if (!trimmed) {
      card.hidden = true;
      return;
    }
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const { counts, total } = countFillers(trimmed);
    card.hidden = false;
    list.innerHTML = '';
    if (total === 0) {
      summary.textContent = `No filler words detected in ${wordCount} words. Clean delivery.`;
      return;
    }
    const pct = wordCount ? Math.round((total / wordCount) * 1000) / 10 : 0;
    summary.textContent = `${total} filler${total === 1 ? '' : 's'} in ${wordCount} words (${pct}%). Aim for under 3%.`;
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([w, n]) => {
        const li = document.createElement('li');
        li.className = 'chip';
        li.textContent = `${w} × ${n}`;
        list.appendChild(li);
      });
  }

  /** --- Fluency lab --- */
  function initFluencyView() {
    const root = $('#view-fluency');
    if (!root || root.dataset.ready === '1') return;
    root.dataset.ready = '1';
    Array.from(root.querySelectorAll('[data-fsub]')).forEach((btn) => {
      btn.addEventListener('click', () => showFluencySub(btn.dataset.fsub));
    });
    $('#breath-start')?.addEventListener('click', () => startBreath());
    $('#breath-stop')?.addEventListener('click', () => stopBreath(true));
    initPacingControls();
    renderEasyOnsetWords();
  }

  function showFluencySub(name) {
    stopBreath();
    stopPacing();
    const subs = { breath: '#fluency-breath', pacing: '#fluency-pacing', onset: '#fluency-onset' };
    Object.entries(subs).forEach(([k, sel]) => {
      const el = document.querySelector(sel);
      if (el) el.hidden = k !== name;
    });
    $$('[data-fsub]').forEach((b) => {
      b.setAttribute('aria-selected', b.dataset.fsub === name ? 'true' : 'false');
    });
  }

  /* Breath: 4-1-6-1 cycle, JS-driven so we can respect reduced-motion. */
  function startBreath() {
    if (state.breath?.active) return;
    const plan = content.breathPlan || { inhaleSec: 4, holdInSec: 1, exhaleSec: 6, holdOutSec: 1 };
    const phases = [
      { name: 'Inhale', dur: plan.inhaleSec, scale: 1 },
      { name: 'Hold', dur: plan.holdInSec, scale: 1 },
      { name: 'Exhale', dur: plan.exhaleSec, scale: 0 },
      { name: 'Hold', dur: plan.holdOutSec, scale: 0 },
    ];
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const circle = $('#breath-circle');
    const label = $('#breath-label');
    const cyclesEl = $('#breath-cycles');
    const timeEl = $('#breath-time');
    const startBtn = $('#breath-start');
    const stopBtn = $('#breath-stop');
    state.breath = { active: true, idx: 0, cycles: 0, t0: performance.now(), raf: 0, timer: 0 };
    startBtn?.setAttribute('disabled', 'true');
    stopBtn?.removeAttribute('disabled');

    function setVisual(phase) {
      if (!circle) return;
      if (reduced) {
        circle.style.transform = phase.scale === 1 ? 'scale(1.25)' : 'scale(1)';
      } else {
        circle.style.transition = `transform ${phase.dur}s ease-in-out`;
        circle.style.transform = phase.scale === 1 ? 'scale(1.45)' : 'scale(0.85)';
      }
      circle.dataset.phase = phase.name.toLowerCase();
      if (label) label.textContent = phase.name;
    }

    function tickClock() {
      if (!state.breath?.active) return;
      const sec = Math.floor((performance.now() - state.breath.t0) / 1000);
      if (timeEl) timeEl.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      state.breath.raf = requestAnimationFrame(tickClock);
    }

    function next() {
      if (!state.breath?.active) return;
      const phase = phases[state.breath.idx % phases.length];
      setVisual(phase);
      state.breath.timer = setTimeout(() => {
        state.breath.idx += 1;
        if (state.breath.idx % phases.length === 0) {
          state.breath.cycles += 1;
          if (cyclesEl) cyclesEl.textContent = String(state.breath.cycles);
        }
        next();
      }, Math.max(200, phase.dur * 1000));
    }

    if (label) label.textContent = phases[0].name;
    if (cyclesEl) cyclesEl.textContent = '0';
    if (timeEl) timeEl.textContent = '0:00';
    next();
    state.breath.raf = requestAnimationFrame(tickClock);
  }

  function stopBreath(announce) {
    if (!state.breath) return;
    if (state.breath.timer) clearTimeout(state.breath.timer);
    if (state.breath.raf) cancelAnimationFrame(state.breath.raf);
    const wasActive = state.breath.active;
    const cycles = state.breath.cycles || 0;
    state.breath = { active: false, idx: 0, cycles: 0, t0: 0, raf: 0, timer: 0 };
    const circle = $('#breath-circle');
    if (circle) {
      circle.style.transition = 'transform 240ms ease-out';
      circle.style.transform = 'scale(1)';
      circle.dataset.phase = '';
    }
    const label = $('#breath-label');
    if (label) label.textContent = wasActive ? 'Done' : 'Ready';
    $('#breath-start')?.removeAttribute('disabled');
    $('#breath-stop')?.setAttribute('disabled', 'true');
    if (announce && wasActive) {
      showToast(`Breath warm-up: ${cycles} cycle${cycles === 1 ? '' : 's'}.`);
      if (cycles >= 1) bumpPracticeDay();
    }
  }

  /* Pacing metronome — Web Audio scheduling for steady beats. */
  function initPacingControls() {
    const sel = $('#pace-passage');
    if (sel && sel.dataset.ready !== '1') {
      sel.dataset.ready = '1';
      sel.innerHTML = '';
      (content.pacingPassages || []).forEach((p) => {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.title;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => renderPacingPassage());
    }
    const bpm = $('#pace-bpm');
    const bpmVal = $('#pace-bpm-val');
    if (bpm && bpm.dataset.ready !== '1') {
      bpm.dataset.ready = '1';
      bpm.addEventListener('input', () => {
        if (bpmVal) bpmVal.textContent = bpm.value;
      });
    }
    $('#pace-start')?.addEventListener('click', () => startPacing());
    $('#pace-stop')?.addEventListener('click', () => stopPacing(true));
    renderPacingPassage();
  }

  function renderPacingPassage() {
    const sel = $('#pace-passage');
    const box = $('#pace-text');
    if (!box) return;
    const id = sel?.value;
    const p = (content.pacingPassages || []).find((x) => x.id === id) || (content.pacingPassages || [])[0];
    if (!p) {
      box.textContent = 'No passage available.';
      return;
    }
    const words = p.text.split(/\s+/).filter(Boolean);
    box.innerHTML = words
      .map((w, i) => `<span class="word" data-i="${i}">${escapeHtml(w)}</span>`)
      .join(' ');
  }

  function startPacing() {
    if (state.pace?.active) return;
    const bpm = Number($('#pace-bpm')?.value || 72);
    const muted = !!$('#pace-mute')?.checked;
    const wordEls = $$('#pace-text .word');
    if (!wordEls.length) return;
    let ctx = null;
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      if (C) ctx = new C();
    } catch { /* ignore */ }
    state.pace = {
      active: true,
      ctx,
      bpm,
      muted,
      next: ctx ? ctx.currentTime + 0.1 : 0,
      beatIdx: 0,
      total: wordEls.length,
      timer: 0,
    };
    wordEls.forEach((el) => el.classList.remove('w-curr', 'w-ok'));
    $('#pace-start')?.setAttribute('disabled', 'true');
    $('#pace-stop')?.removeAttribute('disabled');
    pacingTick();
  }

  function pacingTick() {
    const p = state.pace;
    if (!p?.active) return;
    const period = 60 / p.bpm;
    if (p.ctx) {
      while (p.next < p.ctx.currentTime + 0.12) {
        scheduleClick(p.ctx, p.next, p.muted);
        const idx = p.beatIdx;
        const delayMs = Math.max(0, (p.next - p.ctx.currentTime) * 1000);
        setTimeout(() => highlightPaceWord(idx), delayMs);
        p.beatIdx += 1;
        p.next += period;
        if (p.beatIdx >= p.total) {
          p.timer = setTimeout(() => stopPacing(true), Math.max(100, delayMs + 200));
          return;
        }
      }
      p.timer = setTimeout(pacingTick, 30);
    } else {
      const idx = p.beatIdx;
      highlightPaceWord(idx);
      p.beatIdx += 1;
      if (p.beatIdx >= p.total) {
        p.timer = setTimeout(() => stopPacing(true), period * 1000);
        return;
      }
      p.timer = setTimeout(pacingTick, period * 1000);
    }
  }

  function scheduleClick(ctx, when, muted) {
    if (muted) return;
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.18, when + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
      o.connect(g).connect(ctx.destination);
      o.start(when);
      o.stop(when + 0.08);
    } catch { /* ignore */ }
  }

  function highlightPaceWord(i) {
    const wordEls = $$('#pace-text .word');
    if (!wordEls.length) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    wordEls.forEach((el, j) => {
      el.classList.toggle('w-curr', j === i);
      if (j < i) el.classList.add('w-ok');
    });
    const cur = wordEls[i];
    if (cur && !reduced) {
      try {
        cur.scrollIntoView({ block: 'nearest', behavior: 'smooth', inline: 'nearest' });
      } catch { /* ignore */ }
    }
  }

  function stopPacing(announce) {
    if (!state.pace) return;
    if (state.pace.timer) clearTimeout(state.pace.timer);
    const wasActive = state.pace.active;
    const total = state.pace.total || 0;
    const done = state.pace.beatIdx || 0;
    try {
      if (state.pace.ctx && state.pace.ctx.state !== 'closed') state.pace.ctx.close();
    } catch { /* ignore */ }
    state.pace = { active: false };
    $('#pace-start')?.removeAttribute('disabled');
    $('#pace-stop')?.setAttribute('disabled', 'true');
    if (announce && wasActive) {
      const finished = Math.min(done, total);
      showToast(`Pacing read: ${finished}/${total} words.`);
      if (finished >= Math.max(1, Math.floor(total * 0.6))) bumpPracticeDay();
    }
  }

  function renderEasyOnsetWords() {
    const list = $('#onset-list');
    if (!list || list.dataset.ready === '1') return;
    list.dataset.ready = '1';
    const words = content.easyOnsetWords || [];
    list.innerHTML = '';
    words.forEach((w) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip chip-btn';
      btn.textContent = w;
      btn.addEventListener('click', () => speak(w, 0.75));
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  /** --- Accent shaping --- */
  function initAccentView() {
    const root = $('#view-accent');
    if (!root || root.dataset.ready === '1') return;
    root.dataset.ready = '1';
    Array.from(root.querySelectorAll('[data-asub]')).forEach((btn) => {
      btn.addEventListener('click', () => showAccentSub(btn.dataset.asub));
    });
    renderStressList();
    renderSchwaList();
    renderLinkingList();
    renderFlapList();
    renderEloquenceList();
  }

  function showAccentSub(name) {
    cancelSpeech();
    const subs = {
      stress: '#accent-stress',
      schwa: '#accent-schwa',
      linking: '#accent-linking',
      flap: '#accent-flap',
      eloquence: '#accent-eloquence',
    };
    Object.entries(subs).forEach(([k, sel]) => {
      const el = document.querySelector(sel);
      if (el) el.hidden = k !== name;
    });
    $$('[data-asub]').forEach((b) => {
      b.setAttribute('aria-selected', b.dataset.asub === name ? 'true' : 'false');
    });
  }

  function renderStressList() {
    const list = $('#stress-list');
    if (!list) return;
    const items = content.stressSentences || [];
    list.innerHTML = '';
    items.forEach((s) => {
      const stressed = new Set((s.stressed || []).map((w) => w.toLowerCase()));
      const tokens = s.text.split(/(\s+)/).map((tok) => {
        if (/^\s+$/.test(tok)) return tok;
        const bare = tok.toLowerCase().replace(/[^a-z']/g, '');
        const isStress = stressed.has(bare) || /[A-Z]{2,}/.test(tok);
        return isStress ? `<strong class="stress-w">${escapeHtml(tok)}</strong>` : escapeHtml(tok);
      }).join('');
      const li = document.createElement('li');
      li.className = 'drill';
      li.innerHTML = `
        <p class="drill-text">${tokens}</p>
        <p class="drill-note">${escapeHtml(s.note || '')}</p>
        <div class="btn-row">
          <button type="button" class="btn" data-act="play">Hear it</button>
          <button type="button" class="btn" data-act="slow">Slow</button>
        </div>
      `;
      const plain = s.text.replace(/[A-Z]{2,}/g, (m) => m.toLowerCase());
      li.querySelector('[data-act="play"]').addEventListener('click', () => speak(plain, 0.95));
      li.querySelector('[data-act="slow"]').addEventListener('click', () => speak(plain, 0.7));
      list.appendChild(li);
    });
  }

  function renderSchwaList() {
    const list = $('#schwa-list');
    if (!list) return;
    const items = content.schwaPhrases || [];
    list.innerHTML = '';
    items.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'drill';
      li.innerHTML = `
        <p class="drill-text"><span class="muted">Written:</span> ${escapeHtml(s.written)}</p>
        <p class="drill-text drill-text--alt"><span class="muted">Spoken:</span> ${escapeHtml(s.schwa)}</p>
        <p class="drill-note">${escapeHtml(s.note || '')}</p>
        <div class="btn-row">
          <button type="button" class="btn" data-act="careful">Careful</button>
          <button type="button" class="btn btn-primary" data-act="natural">Natural</button>
        </div>
      `;
      li.querySelector('[data-act="careful"]').addEventListener('click', () => speak(s.written, 0.7));
      li.querySelector('[data-act="natural"]').addEventListener('click', () => speak(s.written, 1.0));
      list.appendChild(li);
    });
  }

  function renderLinkingList() {
    const list = $('#linking-list');
    if (!list) return;
    const items = content.linkingPhrases || [];
    list.innerHTML = '';
    items.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'drill';
      li.innerHTML = `
        <p class="drill-text">${escapeHtml(s.written)}</p>
        <p class="drill-text drill-text--alt">${escapeHtml(s.linked)}</p>
        <p class="drill-note">${escapeHtml(s.note || '')}</p>
        <div class="btn-row">
          <button type="button" class="btn btn-primary" data-act="play">Hear linked</button>
        </div>
      `;
      li.querySelector('[data-act="play"]').addEventListener('click', () => speak(s.written, 1.05));
      list.appendChild(li);
    });
  }

  function renderFlapList() {
    const list = $('#flap-list');
    if (!list) return;
    const items = content.flapTWords || [];
    list.innerHTML = '';
    items.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'drill drill--row';
      li.innerHTML = `
        <span class="drill-text drill-text--big">${escapeHtml(s.word)} <span class="muted">→ ${escapeHtml(s.flap)}</span></span>
        <div class="btn-row">
          <button type="button" class="btn" data-act="careful">Careful T</button>
          <button type="button" class="btn btn-primary" data-act="flap">Flap</button>
        </div>
      `;
      li.querySelector('[data-act="careful"]').addEventListener('click', () => speak(s.word, 0.75));
      li.querySelector('[data-act="flap"]').addEventListener('click', () => speak(s.word, 1.1));
      list.appendChild(li);
    });
  }

  function renderEloquenceList() {
    const list = $('#eloquence-list');
    if (!list) return;
    const items = content.eloquencePhrases || [];
    list.innerHTML = '';
    items.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'drill';
      li.innerHTML = `
        <p class="drill-text">${escapeHtml(p)}</p>
        <div class="btn-row">
          <button type="button" class="btn" data-act="play">Hear it</button>
          <button type="button" class="btn" data-act="slow">Slow</button>
        </div>
      `;
      li.querySelector('[data-act="play"]').addEventListener('click', () => speak(p, 0.95));
      li.querySelector('[data-act="slow"]').addEventListener('click', () => speak(p, 0.75));
      list.appendChild(li);
    });
  }

  function resetAll() {
    if (!window.confirm('Reset all AccentCoach data in this browser?')) return;
    const keys = [
      'stats',
      'pairStats',
      'passageHistory',
      'compareStars',
      'promptAssess',
      'modeAccuracy',
      'firstRun',
    ];
    keys.forEach((k) => store.remove(k));
    showToast('All local data cleared.');
    refreshHome();
    refreshProgress();
  }

  /** --- Keyboard --- */
  function onKey(e) {
    if (e.code === 'Space') {
      const tag = document.activeElement?.tagName;
      if (tag === 'BUTTON' || tag === 'A') return;
      if (state.view === 'compare' && !e.repeat) {
        e.preventDefault();
        if (state.compareRecActive) stopCompareRecord();
        else if (!$('#compare-record')?.disabled) startCompareRecord();
      }
      if (state.view === 'convo' && $('#convo-prompt') && !$('#convo-prompt').hidden) {
        e.preventDefault();
        if (state.promptRecActive) stopPromptFlow();
        else startPromptFlow();
      }
    }
    if (e.key === 'r' || e.key === 'R') {
      if (state.view === 'compare') playCompareNative();
    }
    if (e.key === 'ArrowRight') {
      if (state.view === 'pairs') nextPair(true);
      if (state.view === 'compare') advanceCompareSentence(true);
    }
    if (e.key === 'ArrowLeft') {
      if (state.view === 'pairs') {
        state.pairsPtr = Math.max(0, state.pairsPtr - 1);
        showPair();
      }
    }
  }

  /** --- Init --- */
  function initPairCategorySelect() {
    const sel = $('#pairs-category');
    if (sel) state.pairCurrentCategory = sel.value || 'all';
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (state.compareRecActive || state.promptRecActive) {
        /* keep recording — user may switch apps intentionally */
      }
    }
  });

  window.addEventListener('beforeunload', () => {
    stopAllPractice();
  });

  document.addEventListener('DOMContentLoaded', () => {
    state.recognitionSupported = !!getRecognitionCtor();
    const fb = $('#speech-fallback');
    if (fb) fb.hidden = state.recognitionSupported;
    if (!state.recognitionSupported) {
      showToast('Tip: Chrome or Edge unlocks live speech feedback.');
    }
    if (location.protocol === 'file:') {
      showToast('Browsers often block microphone access on file://. Upload to GitHub Pages (see DEPLOY.md) for the smoothest setup.');
    }
    updateSpeechDependentControls();
    speechSynthesis.addEventListener('voiceschanged', () => {
      /* voices may load later; pickUSVoice resolves on demand */
    });
    wireNav();
    initWelcomeModal();
    $('#btn-mic-check')?.addEventListener('click', () => micCheck());
    $('#btn-reset')?.addEventListener('click', () => resetAll());
    document.addEventListener('keydown', onKey);
    initPairCategorySelect();
    bindCanvasResizeRedraw();
    refreshHome();
    setView('home');
  });
})();
