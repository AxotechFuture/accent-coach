/**
 * Static smoke test: serves the repo root briefly, fetches HTML, sanity-checks assets.
 * Uses only Node built-ins (no browser binary).
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const port = 43177 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;

function waitForHttp(url, attempts = 40) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tryOnce = () => {
      fetch(url)
        .then((r) => {
          if (r.ok) resolve(r);
          else if (++n >= attempts) reject(new Error(`HTTP ${r.status}`));
          else setTimeout(tryOnce, 100);
        })
        .catch(() => {
          if (++n >= attempts) reject(new Error('Server did not respond'));
          else setTimeout(tryOnce, 100);
        });
    };
    tryOnce();
  });
}

const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
  cwd: root,
  stdio: 'ignore',
});

try {
  const res = await waitForHttp(`${base}/`);
  const html = await res.text();

  const checks = [
    ['title', html.includes('AccentCoach')],
    ['main landmark', html.includes('id="main-panel"')],
    ['app script', html.includes('src="app.js"')],
    ['content script', html.includes('src="content.js"')],
    ['stylesheet', html.includes('href="styles.css"')],
    ['tabs scroll', html.includes('class="tabs-scroll"')],
    ['fluency tab', html.includes('id="tab-fluency"')],
    ['accent tab', html.includes('id="tab-accent"')],
    ['fluency view', html.includes('id="view-fluency"')],
    ['accent view', html.includes('id="view-accent"')],
    ['breath circle', html.includes('id="breath-circle"')],
    ['pacing passage', html.includes('id="pace-passage"')],
    ['daily plan', html.includes('id="daily-plan"')],
    ['filler card', html.includes('id="prompt-fillers"')],
  ];

  for (const [name, ok] of checks) {
    if (!ok) throw new Error(`Missing: ${name}`);
  }

  const appJs = await readFile(join(root, 'app.js'), 'utf8');
  const contentJs = await readFile(join(root, 'content.js'), 'utf8');
  if (!appJs.includes('setPassageCurrentIndex')) {
    throw new Error('app.js: expected passage highlight helper');
  }
  if (!appJs.includes('initFluencyView') || !appJs.includes('initAccentView')) {
    throw new Error('app.js: expected fluency/accent views');
  }
  if (!appJs.includes('countFillers') || !appJs.includes('renderFillerReport')) {
    throw new Error('app.js: expected filler-word counter');
  }
  if (!contentJs.includes('minimalPairCategories')) {
    throw new Error('content.js: expected minimal pairs');
  }
  for (const k of ['dailyPlan', 'pacingPassages', 'easyOnsetWords', 'stressSentences', 'schwaPhrases', 'linkingPhrases', 'flapTWords', 'fillerWords', 'eloquencePhrases']) {
    if (!contentJs.includes(k)) throw new Error(`content.js: expected ${k}`);
  }
  if (!contentJs.includes("id: 'ng_clarity'")) {
    throw new Error('content.js: expected Nigerian clarity pair category');
  }

  console.log('smoke-node: ok', { port, checks: checks.length });
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
}
