# AccentCoach

AccentCoach is a single-page web app for **American English clarity practice**. It runs entirely in your browser: no accounts, no servers, and no paid APIs. Practice includes minimal pairs, read-aloud passages with live highlighting, record-and-compare sentences, dialogue shadowing, and open-ended speaking prompts.

## Who it is for

Learners who want a **calm, self-paced** routine—especially if English is not your first language and you want clearer stress, rhythm, and consonant contrasts. Tips are written to be broadly useful (including common friction points for speakers influenced by West African English) without assuming a single background.

## How to use it

1. Open `index.html` in **Chrome** or **Edge** for the best experience (Web Speech API support).
2. Allow the microphone when asked. On some computers, opening the file directly (`file://`) blocks the mic; hosting on **GitHub Pages** avoids that—see `DEPLOY.md`.
3. Use **Home** for a warm-up tip, streak, and a quick microphone check.
4. Try each practice mode from the tabs or the large cards on the home screen.

### Modes

- **Minimal pairs** — Hear each word, then say the highlighted word. You get instant feedback and slower replay on misses.
- **Read aloud** — Pick a passage, read along, and watch words highlight as you go. At the end you see accuracy, pace, and focus words.
- **Record & compare** — Listen to a model sentence, record yourself, play both back, and rate yourself. The **native** waveform is a gentle animated guide while the system speaks (browsers do not expose TTS audio to the waveform engine); your clip uses a real waveform.
- **Shadowing & prompts** — Shadow short dialogues line by line, or answer an open prompt while we capture a live transcript (when the browser supports it).

### Keyboard shortcuts

- **Space** — Start or stop recording in **Record & compare** and **Open prompt** (when focus is not inside a button you are trying to click).
- **R** — Replay the native model sentence in **Record & compare**.
- **→** — Next pair (minimal pairs) or next compare sentence.
- **←** — Previous minimal pair.

## Files

| File        | Purpose                                      |
| ----------- | -------------------------------------------- |
| `index.html`| Page structure and regions                   |
| `styles.css`| Layout, colors, responsive rules             |
| `app.js`    | Speech, recording, progress, navigation      |
| `content.js`| Word lists, passages, prompts, dialogues    |
| `DEPLOY.md` | Simple free hosting (GitHub Pages)          |

## Privacy

Everything is stored in **localStorage** on your device. Clearing site data or using a private window will remove progress.

## License

The app code is provided as-is for personal learning. Passages marked as public domain in `content.js` retain their original status; other text is original for this project.
