// Проверка раскладки на живом сервере в настоящем браузере.
//
// Зачем отдельный инструмент: `npm run smoke` исполняет логику в DOM-заглушке, где
// вообще нет вёрстки. А самый обидный класс ошибок — когда контейнер растягивается
// под содержимое (грид-элемент с min-height: auto, флекс-элемент без min-height: 0),
// `overflow-y: auto` не срабатывает, и низ страницы просто обрезан: «листание вниз»
// перестаёт работать при внешне живом интерфейсе. Это ловится только замером в браузере.
//
// Запуск:  npm start  →  npm run layout
// Браузер ищется автоматически; можно указать свой: MUZ_CHROME=/путь/к/chrome

import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, findChrome, ensureServer, runChrome } from './chrome.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagePath = path.join(root, 'public', '__layout-check.html');
const pageUrl = `${BASE}/__layout-check.html`;

const HARNESS = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" /><title>layout-check</title>
<style>html,body{margin:0;background:#111;color:#eee;font:13px monospace}iframe{width:1280px;height:760px;border:0}pre{padding:10px;white-space:pre-wrap}</style>
</head><body>
<iframe id="f" src="/"></iframe>
<pre id="out">…</pre>
<script>
const log = [];
const say = (s) => { log.push(s); document.getElementById('out').textContent = log.join('\\n'); };

function probe(win, doc, sel, label) {
  const el = doc.querySelector(sel);
  if (!el) { say('❌ ' + label + ': элемент ' + sel + ' не найден'); return; }
  el.style.scrollBehavior = 'auto';  // smooth-прокрутка читается как 0 сразу после установки scrollTop
  const ch = el.clientHeight, sh = el.scrollHeight;
  el.scrollTop = 1e6;
  const moved = el.scrollTop;
  el.scrollTop = 0;
  const cs = win.getComputedStyle(el);
  const verdict = sh <= ch ? '✅ прокручивать нечего — всё влезло'
    : moved > 0 ? '✅ прокрутка вниз работает (scrollTop=' + moved + ')'
    : '❌ ПРОКРУТКИ НЕТ: контент ' + sh + ' выше контейнера ' + ch + ', но обрезан';
  say(verdict + '\\n   ' + label + '  ' + sel + '  [overflow-y=' + cs.overflowY + ', ' + ch + '/' + sh + ']');
}

setTimeout(() => {
  const f = document.getElementById('f');
  const win = f.contentWindow, doc = f.contentDocument;
  if (!doc || !doc.querySelector('#content')) { say('❌ страница плеера не загрузилась'); return; }
  say('окно ' + win.innerWidth + '×' + win.innerHeight + ' | строк в ленте: ' + doc.querySelectorAll('#content .row').length + '\\n');
  probe(win, doc, '#content', 'лента');
  probe(win, doc, '.sidebar', 'сайдбар');

  const st = win.MuzPlayer && win.MuzPlayer.state;
  if (!st) { say('❌ MuzPlayer не инициализировался'); return; }
  // настройки — длинная страница, её тоже меряем
  win.MuzPlayer.switchView('settings');
  setTimeout(() => {
    probe(win, doc, '#content', 'настройки');
    win.MuzPlayer.switchView('search');
    // караоке
    const t = { uid: 'layout:1', id: '1', provider: 'audius', title: 'Sonne', artist: 'Rammstein', duration: 272, playable: true };
    st.tracks = [t]; st.queue = [t]; st.qi = 0;
    win.MuzPlayer.toggleLyrics();
    setTimeout(() => {
      probe(win, doc, '.lyr-body', 'текст песни');
      // очередь из 60 треков
      st.tracks = Array.from({ length: 60 }, (_, i) => ({ uid: 'q' + i, id: 'x' + i, provider: 'audius', title: 'трек ' + i, artist: 'исполнитель ' + i, playable: true }));
      win.MuzPlayer.playFromList(0);
      doc.querySelector('#queue-panel').classList.add('open');
      setTimeout(() => {
        probe(win, doc, '.queue-list', 'очередь');
        say('\\n=== ГОТОВО ===');
      }, 400);
    }, 3000);
  }, 600);
}, 4000);
</script></body></html>`;

const chrome = await findChrome();
if (!chrome) {
  console.log('Не нашёл Chrome/Chromium. Укажите путь вручную:');
  console.log('  MUZ_CHROME="/путь/к/chrome" npm run layout');
  process.exit(2);
}

if (!(await ensureServer())) process.exit(2);

await writeFile(pagePath, HARNESS, 'utf8');
let out = '';
try {
  out = await runChrome(chrome, { url: pageUrl, budgetMs: 20_000, tag: 'layout' });
} finally {
  await unlink(pagePath).catch(() => {});
}

const m = out.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!m) {
  console.log('Не получил замеров от браузера. Попробуйте ещё раз или откройте вручную:');
  console.log('  ' + pageUrl + '  (страница __layout-check.html создаётся на время проверки)');
  process.exit(1);
}

const text = m[1]
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

console.log('=== Проверка раскладки ===\n');
console.log(text.trim());

const failed = (text.match(/❌/g) || []).length;
console.log(failed ? `\nПРОВАЛ: проблемных мест — ${failed}\n` : '\nВСЁ ПРОКРУЧИВАЕТСЯ.\n');
process.exit(failed ? 1 : 0);
