// Скриншоты тем: `npm run shots` — по одному PNG на каждую тему в папку shots/.
//
// Зачем это в проекте: любую тему нужно один раз увидеть глазами. Тесты
// проверяют числами (контраст, набор переменных), но «выглядит ли хорошо»
// числами не измерить — поэтому инструмент делает снимки реального интерфейса,
// чтобы можно было посмотреть каждую палитру и сравнить.
//
// Запуск:  npm start  (в другом терминале)  →  npm run shots
// Аргумент: npm run shots -- rammstein      (свой поисковый запрос)

import { writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, findChrome, ensureServer, runChrome } from './chrome.mjs';
import { THEMES } from '../public/theme.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const query = process.argv.slice(2).filter((a) => !a.startsWith('-')).join(' ') || 'rammstein';

// Страница-обёртка: внутри iframe живёт настоящий плеер. Так снимок делается
// с нужной темой и без риска задеть настройки пользователя — профиль браузера
// создаётся пустой.
const HARNESS = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" />
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}
iframe{border:0;width:100vw;height:100vh;display:block}</style></head>
<body><iframe id="f"></iframe>
<script>
  const params = new URLSearchParams(location.search);
  try {
    localStorage.setItem('muz:prefs', JSON.stringify({
      theme: params.get('theme') || 'aurora',
      autoplay: true, countSkips: true, autoLyrics: false,
      compactSources: false, smartShuffle: true,
    }));
  } catch (e) {}
  const f = document.getElementById('f');
  f.addEventListener('load', () => {
    const d = f.contentDocument, w = f.contentWindow;
    if (!d || !w) return;
    setTimeout(() => {
      const q = params.get('q');
      if (q) { const inp = d.querySelector('#q'); if (inp) { inp.value = q; w.MuzPlayer.doSearch(q); } }
      if (params.get('view')) d.querySelector('.nav-item[data-view="' + params.get('view') + '"]')?.click();
    }, 1200);
  });
  f.src = '/';
</script></body></html>`;

if (!(await ensureServer())) process.exit(1);
const chrome = await findChrome();
if (!chrome) { console.log('Chrome не найден — снимки пропущены.'); process.exit(1); }

const outDir = path.join(root, 'shots');
await mkdir(outDir, { recursive: true });
const pagePath = path.join(root, 'public', '__shot.html');
await writeFile(pagePath, HARNESS, 'utf8');

try {
  console.log(`Делаю снимки тем (${THEMES.length} шт.), запрос «${query}»…\n`);
  for (const t of THEMES) {
    const file = path.join(outDir, `${t.id}.png`);
    const url = `${BASE}/__shot.html?theme=${t.id}&q=${encodeURIComponent(query)}`;
    await runChrome(chrome, {
      url,
      extraFlags: [`--screenshot=${file}`, '--hide-scrollbars', '--force-device-scale-factor=1'],
      budgetMs: 15_000,
      dumpDom: false,
      tag: `shot-${t.id}`,
      timeout: 90_000,
    });
    console.log(`  ✓ ${t.name.padEnd(8)} → shots/${t.id}.png`);
  }
  console.log('\nГотово. Открывайте папку shots/ и сравнивайте.');
} finally {
  await unlink(pagePath).catch(() => {});
}
