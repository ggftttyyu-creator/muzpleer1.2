// Проверка караоке в реальном времени: трек играет сам, мы ничего не нажимаем —
// и смотрим, едет ли подсветка сама по себе.
//
// Почему отдельный инструмент: `npm run smoke` проверяет логику в DOM-заглушке,
// но там время задаётся вручную. Именно так однажды и уехал баг: обработчики
// вызова были живы, а автоматики (timeupdate + тикер) не было — в тесте это
// выглядело нормально, а в жизни текст обновлялся только при переоткрытии панели.
// Здесь браузер играет настоящий трек и сам присылает отчёт.
//
// Запуск:  npm start  →  npm run lyrics      (занимает ~30 секунд)

import { writeFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, findChrome, ensureServer, openPage } from './chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagePath = path.join(root, 'public', '__lyrics-live.html');
const SAMPLE_MS = 3000;  // как часто фиксируем состояние
const SAMPLES = 8;       // ~24 секунды наблюдения

const chrome = await findChrome();
if (!chrome) {
  console.log('Не нашёл Chrome/Chromium. Укажите путь: MUZ_CHROME="/путь/к/chrome" npm run lyrics');
  process.exit(2);
}
if (!(await ensureServer())) process.exit(2);

/* ==================== приёмник отчёта ==================== */
let resolveReport;
const reportPromise = new Promise((r) => (resolveReport = r));
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    res.end('ok');
    try { resolveReport(JSON.parse(body)); } catch (e) { resolveReport({ error: String(e) }); }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

/* ==================== стенд ==================== */
const HARNESS = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" /><title>lyrics-live</title></head>
<body style="margin:0;background:#111">
<iframe id="f" src="/" style="width:1280px;height:760px;border:0"></iframe>
<script>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPORT = __REPORT_URL__;
setTimeout(async () => {
  try {
    const win = document.getElementById('f').contentWindow;
    const doc = document.getElementById('f').contentDocument;
    const MP = win.MuzPlayer;
    if (!MP) throw new Error('MuzPlayer не инициализировался');
    const list = await win.fetch('/api/trending?provider=yandex&limit=6').then((r) => r.json());
    const i = list.tracks.findIndex((t) => /8 миля/.test(t.title));
    MP.state.tracks = list.tracks;
    MP.playFromList(i >= 0 ? i : 0);
    MP.toggleLyrics();
    await sleep(2500);
    const nodes = doc.querySelectorAll('#lyr-body .lvl');
    const body = doc.querySelector('#lyr-body');
    const a = MP.audio;
    const idx = () => [...nodes].findIndex((n) => n.classList.contains('active'));
    const rows = [];
    for (let n = 0; n < __SAMPLES__; n++) {
      // Ничего не вызываем и не двигаем — только читаем состояние.
      rows.push({
        sec: n * __SAMPLE_MS__ / 1000,
        t: +a.currentTime.toFixed(2),
        paused: a.paused,
        line: idx() + 1,
        scrollTop: Math.round(body.scrollTop),
      });
      await sleep(__SAMPLE_MS__);
    }
    fetch(REPORT, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ track: doc.querySelector('#np-title').textContent, lines: nodes.length, src: doc.querySelector('#lyr-src').textContent, rows }) });
  } catch (e) {
    fetch(REPORT, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ error: String(e) }) });
  }
}, 3500);
</script></body></html>`
  .replace('__REPORT_URL__', JSON.stringify(`http://127.0.0.1:${port}/report`))
  .replace('__SAMPLES__', String(SAMPLES))
  .replace(/__SAMPLE_MS__/g, String(SAMPLE_MS));

await writeFile(pagePath, HARNESS, 'utf8');
console.log(`Слушаю трек в браузере ~${Math.round((SAMPLES * SAMPLE_MS + 6000) / 1000)} секунд…\n`);

const budgetMs = SAMPLES * SAMPLE_MS + 30_000;
const page = openPage(chrome, { url: `${BASE}/__lyrics-live.html`, tag: 'lyrics', timeout: budgetMs + 30_000 });

const report = await Promise.race([
  reportPromise,
  new Promise((r) => setTimeout(() => r({ error: 'браузер не прислал отчёт' }), budgetMs)),
]);

page.kill(); // браузер убираем всегда: иначе процессы копятся и съедают память
await unlink(pagePath).catch(() => {});
server.close();

/* ==================== вердикт ==================== */
if (report.error) {
  console.log('ПРОВАЛ: ' + report.error);
  process.exit(1);
}

console.log(`Трек: «${report.track}» | строк: ${report.lines} | ${report.src}\n`);
console.log('  сек |  время | строка | прокрутка');
for (const r of report.rows) {
  console.log(`  ${String(r.sec).padStart(3)} | ${String(r.t).padStart(6)} | ${String(r.line).padStart(6)} | ${String(r.scrollTop).padStart(9)}`);
}

const plays = report.rows.filter((r) => !r.paused && r.t > 0).length;
const lines = [...new Set(report.rows.map((r) => r.line))].filter((n) => n > 0);
const scrolls = [...new Set(report.rows.map((r) => r.scrollTop))];
const problems = [];
if (plays < 2) problems.push('трек не воспроизводился — замер недействителен');
if (report.lines < 5) problems.push('текст не загрузился');
if (lines.length < 3) problems.push('подсветка не двигалась сама: нужно открыть/закрыть панель — синхронизации нет');
if (scrolls.length < 2) problems.push('текст не прокручивался вслед за подсветкой');

console.log('');
if (problems.length) {
  console.log('ПРОВАЛ:');
  problems.forEach((p) => console.log('  ❌ ' + p));
  console.log('');
  process.exit(1);
}
console.log(`  ✅ трек играл сам, подсветка прошла строк ${lines[0]} → ${lines[lines.length - 1]} без единого нажатия`);
console.log(`  ✅ панель прокручивалась (scrollTop ${scrolls[0]} → ${scrolls[scrolls.length - 1]})\n`);
console.log('СИНХРОНИЗАЦИЯ В РЕАЛЬНОМ ВРЕМЕНИ РАБОТАЕТ.\n');
process.exit(0);
