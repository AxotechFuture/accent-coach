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
    teardownAudioGraph();
    hideRecIndicators();
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
  }

  /** --- First-run modal --- */
  function initWelcomeModal() {
    const modal = $('#modal-welcome');
    const ok = $('#modal-accept');
    const done = store.get('firstRun', false);
    if (!done && modal) {
      modal.hidden = false;
    }
    ok?.addEventListener('click', () => {
      store.set('firstRun', true);
      if (modal) modal.hidden = true;
    });
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
      if (fb) fb.textContent = ok ? '✅ Nice match.' : `❌ Heard “${heard || '…'}”.`;
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
  }

  function paintPassageWord(i, cls) {
    state.passageWordEls.forEach((el, idx) => {
      el.classList.remove('w-curr', 'w-ok', 'w-bad', 'w-skip');
      if (idx === i) el.classList.add(cls);
      if (idx < i) el.classList.add('w-ok');
      if (state.passageProblemWords.has(idx)) el.classList.add('w-bad');
    });
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
    paintPassageWord(0, 'w-curr');
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
      advancePassageFromHeard(heard, !!interim);
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
      paintPassageWord(state.passageIndex, 'w-curr');
    } else if (!hasInterim) {
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

  function drawBufferOnCanvas(sel, channel) {
    const c = document.querySelector(sel);
    if (!c) return;
    const w = c.width;
    const h = c.height;
    const ctx2 = c.getContext('2d');
    if (!ctx2) return;
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
    const ctx2 = c.getContext('2d');
    if (!ctx2) return;
    ctx2.clearRect(0, 0, c.width, c.height);
    ctx2.fillStyle = '#0b1220';
    ctx2.fillRect(0, 0, c.width, c.height);
    ctx2.strokeStyle = '#334155';
    ctx2.beginPath();
    ctx2.moveTo(0, c.height / 2);
    ctx2.lineTo(c.width, c.height / 2);
    ctx2.stroke();
  }

  function animateNativeGuide(seconds) {
    const c = document.querySelector('#wave-native');
    if (!c) return;
    const ctx2 = c.getContext('2d');
    if (!ctx2) return;
    const w = c.width;
    const h = c.height;
    const t0 = performance.now();
    const dur = Math.max(1.2, seconds) * 1000;
    const frame = (t) => {
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
      const ctx2 = c?.getContext('2d');
      if (!c || !ctx2) return;
      const data = new Uint8Array(an.frequencyBinCount);
      const loop = () => {
        an.getByteTimeDomainData(data);
        ctx2.clearRect(0, 0, c.width, c.height);
        ctx2.fillStyle = '#0b1220';
        ctx2.fillRect(0, 0, c.width, c.height);
        ctx2.strokeStyle = '#5eead4';
        ctx2.beginPath();
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          const x = (i / data.length) * c.width;
          const y = c.height / 2 + v * (c.height / 2 - 4);
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
      $('#shadow-feedback').textContent = ok ? '✅ Line detected — nice.' : 'Keep going — try the line once more, then tap Next.';
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
    const ctx2 = c.getContext('2d');
    if (!ctx2) return;
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
    const w = c.width;
    const h = c.height;
    ctx2.clearRect(0, 0, w, h);
    ctx2.fillStyle = '#ffffff';
    ctx2.fillRect(0, 0, w, h);
    const barW = (w - 80) / data.length;
    data.forEach((d, i) => {
      const x = 40 + i * barW + 8;
      const bh = (h - 60) * (Math.min(100, d.value) / 100);
      const y = h - 40 - bh;
      ctx2.fillStyle = '#2d6a6a';
      ctx2.fillRect(x, y, barW - 16, bh);
      ctx2.fillStyle = '#1f2933';
      ctx2.font = '12px system-ui';
      ctx2.fillText(`${d.value}%`, x, y - 6);
      ctx2.save();
      ctx2.translate(x + 6, h - 28);
      ctx2.rotate(-0.2);
      ctx2.fillText(d.label, 0, 0);
      ctx2.restore();
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
    refreshHome();
    setView('home');
  });
})();
