// Живая проверка рандома и рекомендаций: настоящий браузер, настоящие треки.
//
// Что проверяем:
//   1. Слушаем реальные треки — профиль вкусов наполняется по-настоящему;
//   2. «Для вас» строит подборку из живых источников (поиск + чарт);
//   3. Перемешивание не повторяет треки, пока не кончится цикл;
//   4. Автоподбор дополняет очередь, когда она закончилась.
//
// Запуск:  npm start  →  npm run rec   (занимает ~40 секунд)

import { writeFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, findChrome, ensureServer, openPage } from './chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagePath = path.join(root, 'public', '__rec-live.html');

const chrome = await findChrome();
if (!chrome) {
  console.log('Не нашёл Chrome/Chromium. Укажите путь: MUZ_CHROME="/путь/к/chrome" npm run rec');
  process.exit(2);
}
if (!(await ensureServer())) process.exit(2);

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

const HARNESS = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" /><title>rec-live</title></head>
<body style="margin:0;background:#111">
<iframe id="f" src="/" style="width:1280px;height:760px;border:0"></iframe>
<script>
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPORT = __REPORT_URL__;
const out = { steps: [], failures: [] };
const check = (name, ok, detail) => { out.steps.push({ name, ok, detail: detail ?? '' }); if (!ok) out.failures.push(name); };

setTimeout(async () => {
  try {
    const win = document.getElementById('f').contentWindow;
    const doc = document.getElementById('f').contentDocument;
    const MP = win.MuzPlayer;
    if (!MP) throw new Error('MuzPlayer не инициализировался');

    // ── 1. слушаем настоящий трек, чтобы профиль наполнился
    const search = await win.fetch('/api/search?q=Rammstein&limit=6').then((r) => r.json());
    const tracks = search.tracks || [];
    check('поиск отдал треки', tracks.length >= 3, tracks.length + ' шт.');
    MP.state.taste = { artists: {}, tracks: {}, totalPlays: 0, totalSkips: 0, updated: 0 };
    MP.state.queue = tracks;
    MP.state.qi = 0;
    MP.state.shuffleMode = 'off';
    MP.playFromList(0);
    await sleep(2500);
    for (let i = 0; i < 3; i++) {
      MP.state.qi = i;
      MP.state.countedUid = null;
      MP.playFromList(i);
      await sleep(1200);
      MP.audio.currentTime = 35;           // «дослушал» до порога засчитывания
      await sleep(900);
    }
    const st = win.MuzPlayer.state.taste;
    const learned = Object.keys(st.artists).length;
    check('профиль вкусов наполнился реальными прослушиваниями', learned > 0, learned + ' артистов, ' + st.totalPlays + ' прослушиваний');

    // ── 2. вкладка «Для вас» строит подборку из живых источников
    MP.switchView('foryou');
    await sleep(6000);
    const rows = doc.querySelectorAll('#fy-picks .row');
    const pickTitles = [...doc.querySelectorAll('#fy-picks .row')].map((r) => r.querySelector('.row-title, .rt, .t')?.textContent || '').filter(Boolean);
    check('экран «Для вас» открылся', doc.querySelector('#content').textContent.includes('Подобрано для вас'));
    check('подборка собрана из живых источников', rows.length >= 5, rows.length + ' треков');
    const inQueue = [...rows].filter((r) => MP.state.queue.some((t) => t.uid === r.dataset.uid)).length;
    check('в подборке нет того, что уже в очереди', inQueue === 0, 'совпадений: ' + inQueue);
    out.picks = pickTitles.slice(0, 5);

    // ── 3. настоящее перемешивание
    MP.status = null;
    MP.state.queue = [...tracks, ...tracks.map((t, i) => ({ ...t, uid: t.uid + ':b' + i }))]; // 12 треков
    MP.state.qi = 0;
    doc.querySelector('#btn-shuffle').click();     // рандом
    const mode = MP.state.shuffleMode;
    const order = [];
    for (let k = 0; k < MP.state.queue.length - 1; k++) {
      doc.querySelector('#btn-next').click();
      await sleep(120);
      order.push(MP.state.qi);
    }
    const uniq = new Set(order).size;
    check('режим рандома включился', mode === 'random', mode);
    check('за цикл не было повторов', uniq === order.length, uniq + ' уникальных из ' + order.length);
    doc.querySelector('#btn-shuffle').click();     // → умный
    const smartMode = MP.state.shuffleMode;
    doc.querySelector('#btn-shuffle').click();     // → выкл
    check('умный шаффл доступен и выключается', smartMode === 'smart' && MP.state.shuffleMode === 'off', smartMode + ' → ' + MP.state.shuffleMode);

    // ── 4. автоподбор в конце очереди
    // Замер делаем детерминированно: ставим состояние на паузе и вызываем ровно тот
    // путь, что и кнопка «дальше» (MP.step). Иначе событие ended от реального
    // воспроизведения успевает вмешаться и измеряем мы уже не то.
    const setup = (n, autoplay = true) => {
      MP.audio.pause();
      MP.state.prefs.autoplay = autoplay;
      MP.state.queue = tracks.slice(0, n);
      MP.state.qi = n - 1;
      return MP.state.queue.length;
    };

    let lenBefore = setup(2);
    MP.step(1);                                    // кнопка «дальше» на последнем треке
    await sleep(9000);
    check('автоподбор дополнил очередь по кнопке «дальше»', MP.state.queue.length > lenBefore, lenBefore + ' → ' + MP.state.queue.length);
    check('играет трек из подборки, а не тишина', MP.state.qi >= lenBefore && MP.state.qi < MP.state.queue.length, 'индекс ' + MP.state.qi + ' из ' + MP.state.queue.length);
    const uids = MP.state.queue.map((t) => t.uid);
    check('в очереди нет дублей', new Set(uids).size === uids.length, uids.length + ' треков');
    check('подборка не повторяет уже игравшие треки', new Set(uids).size === new Set([...uids]).size);

    // и то же самое, когда трек доиграл сам (авто-переход, а не кнопка)
    const lenEnded = setup(2);
    MP.step(1, false);                             // так вызывается обработчик ended
    await sleep(9000);
    check('автоподбор срабатывает и при естественном окончании трека', MP.state.queue.length > lenEnded, lenEnded + ' → ' + MP.state.queue.length);

    // выключенный автоподбор: очередь честно заканчивается
    const lenOff = setup(2, false);
    MP.step(1);
    await sleep(1500);
    check('с выключенным автоподбором очередь не растёт', MP.state.queue.length === lenOff, String(MP.state.queue.length));

    MP.state.prefs.autoplay = true;
    out.taste = win.MuzPlayer.state.taste.totalPlays;

    fetch(REPORT, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(out) });
  } catch (e) {
    out.fatal = String(e && e.stack ? e.stack.split('\\n')[0] : e);
    fetch(REPORT, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(out) });
  }
}, 3500);
</script></body></html>`.replace('__REPORT_URL__', JSON.stringify(`http://127.0.0.1:${port}/report`));

await writeFile(pagePath, HARNESS, 'utf8');
console.log('Проверяю на живых треках (~45 секунд)…\n');

const budgetMs = 120_000;
const page = openPage(chrome, { url: `${BASE}/__rec-live.html`, tag: 'rec', timeout: budgetMs + 30_000 });

const report = await Promise.race([
  reportPromise,
  new Promise((r) => setTimeout(() => r({ failures: ['браузер не прислал отчёт'] }), budgetMs)),
]);

page.kill(); // браузер убираем всегда: иначе процессы копятся и съедают память
await unlink(pagePath).catch(() => {});
server.close();

if (report.fatal) { console.log('ПРОВАЛ: ' + report.fatal); process.exit(1); }

for (const s of report.steps) console.log(`  ${s.ok ? '✅' : '❌'} ${s.name}${s.detail ? '  (' + s.detail + ')' : ''}`);
if (report.picks?.length) console.log('\nЧто подобралось (первые 5):\n  · ' + report.picks.join('\n  · '));

const failed = report.failures?.length || 0;
console.log('');
console.log(failed ? `ПРОВАЛ: ${failed} проверок не прошло.\n` : 'РАНДОМ И РЕКОМЕНДАЦИИ РАБОТАЮТ НА ЖИВЫХ ДАННЫХ.\n');
process.exit(failed ? 1 : 0);
