# AccentCoach — self-review and bug-hunt notes

Internal log of issues found during Phase 2 (code review) and Phase 3 (bug hunt), and what was changed.

## Phase 2 — Code review findings

1. **Passage summary referenced undefined variables** (`pid`, `passage`) after refactor. **Fix:** Build summary from the passage select value inside `finalizePassage` and create DOM nodes safely instead of fragile `innerHTML` for buttons.
2. **`stopPassageRead` could recurse into summary logic** when tied to auto-complete. **Fix:** Split `stopPassageListening` and `finalizePassage` with a `passageFinalized` guard.
3. **Passage “Stop” defaulted to clearing UI without saving partial results.** **Fix:** Stop button calls `stopPassageRead(false)` so partial sessions still finalize.
4. **`completePassageSession` vs interim results** could stall completion. **Fix:** Only auto-finalize when the last chunk is not interim-only; manual stop always finalizes.
5. **WPM blow-ups** on very short sessions. **Fix:** Minimum elapsed window of one second for WPM math.
6. **Minimal pair listen race** if the user double-taps Speak. **Fix:** Stop any active recognition before starting a new session.
7. **Miss tip overwrote category text awkwardly.** **Fix:** Always restore the category tip string after each attempt.
8. **Some minimal-pair rows were low-quality** (nonsense spellings, duplicates). **Fix:** Curated `content.js` lists (v/w, wh pairs, flap set, vowel sets).
9. **No release of `MediaStream` when switching modes.** **Fix:** Call `stopMediaStream()` inside `stopAllPractice()` to avoid leaked mic captures.
10. **Speech synthesis could throw** in edge builds. **Fix:** Wrapped `speechSynthesis.speak` in try/catch with a toast.
11. **Recognition-dependent buttons** stayed clickable in unsupported browsers. **Fix:** `updateSpeechDependentControls()` plus render-time checks for passage start.
12. **First-run pairs shuffle** could desync category select. **Fix:** Re-read select value whenever the Pairs tab activates; removed duplicate queue init from `initPairsView`.
13. **Graceful degradation UX.** **Fix:** Banner (`#speech-fallback`) + toast for `file://` microphone limits.
14. **Native waveform vs TTS** cannot use a real `AnalyserNode` on synthesized speech in the browser. **Fix:** Documented in UI copy and this file; native pane uses an animated guide, user pane uses decoded audio / live analyser on playback.

## Phase 3 — Bug hunt (simulated sessions)

1. **Rapid tab switching while recording** — stream is intentionally stopped to save battery; user may need to press Record again. Accepted; no crash.
2. **Refresh mid-practice** — state is not persisted mid-drill by design; user restarts cleanly. Accepted.
3. **30+ days of history** — arrays are capped (`passageHistory` 40, mode accuracy 60, compare stars 120) so the progress view stays light.
4. **Shadow mode without recognition** — user is nudged to practice aloud and use Next; no crash.
5. **Compare `MediaRecorder` mime fallback** — guarded with feature detection; falls back to default type.
6. **Space key** — ignores when focus is on interactive elements where default behavior matters; practice shortcuts scoped by active view.
7. **Star rating spam** — allowed; each tap logs a row (harmless). Could average later; left simple for learners.
8. **Pairs category default** — `state.pairCurrentCategory` was read before repopulating the `<select>`, which could leave an empty queue on first paint. **Fix:** Assign category from `sel.value` after options are built.

## Totals

- **Phase 2 issues addressed:** 14
- **Phase 3 issues addressed:** 8

## Residual limitations (by design or platform)

- **SpeechRecognition** quality varies by device and accent; fuzzy matching reduces false negatives but cannot be perfect.
- **Passage alignment** uses a lightweight word-gate, not forced alignment; very noisy rooms may desync until the user pauses.
- **GitHub web UI “upload files”** flow may evolve; if the wording changes slightly, the intent is: add files to the repo root and enable Pages on the default branch.
