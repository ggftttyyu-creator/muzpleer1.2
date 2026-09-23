// UI-смоук-тест: исполняет настоящий public/app.js в минимальной DOM-заглушке
// против живого сервера. Ловит то, что не видит node --check: отсутствующие
// импорты, обращения к удалённым id, падения рендереров, логику караоке.
//
// Запуск:  npm start  (в другом терминале)  →  node tools/ui-smoke.mjs
// Адрес сервера можно переопределить: MUZ_BASE=http://127.0.0.1:4173

const BASE = process.env.MUZ_BASE || 'http://127.0.0.1:4173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg + (extra !== '' ? `  (${extra})` : '')); }
};
const head = (t) => console.log('\n' + t);
let summary = () => {}; // переопределяется в конце прогона (нужен и сторожевому таймеру)

// Ожидание по условию: «подборка собрана» зависит от сети, и фиксированная
// пауза делает проверку то зелёной, то красной без изменения кода.
async function waitFor(fn, { ms = 12000, step = 150 } = {}) {
  const t0 = Date.now();
  for (;;) {
    try { if (fn()) return true; } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(step);
  }
}

/* ==================== минимальный DOM ==================== */
const realFetch = globalThis.fetch;
const els = new Map();
const handlersOf = (el) => (el.__h ||= {});

function makeEl(tag = 'div') {
  const cls = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    dataset: {}, style: {}, value: '', textContent: '', id: '', type: 'text',
    _html: '',
    _cache: new Map(),
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (c) => cls.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !cls.has(c) : !!force;
        if (on) cls.add(c); else cls.delete(c);
        return on;
      },
    },
    addEventListener(t, h) { (handlersOf(el)[t] ||= []).push(h); },
    removeEventListener() {},
    dispatch(t, ev = {}) {
      const list = handlersOf(el)[t] || [];
      list.forEach((h) => h.call(el, { key: ev.key, target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} }));
      return list.length;
    },
    click() { el.dispatch('click'); },
    querySelector(sel) { return getEl(sel); },
    querySelectorAll(sel) {
      const key = `${sel}::${el._html.length}::${el._html.slice(0, 80)}`;
      if (!el._cache.has(key)) el._cache.set(key, buildNodes(sel, el._html));
      return el._cache.get(key);
    },
    appendChild() {}, append() {}, prepend() {}, insertBefore() {}, replaceChildren() {},
    cloneNode() { return makeEl(tag); }, contains() { return false; },
    remove() {}, focus() {}, blur() {}, scrollIntoView() {},
    setAttribute() {}, getAttribute() { return null; },
    play: async () => {}, pause() {}, load() {}, removeAttribute() {}, setVolume() {}, seekTo() {},
    getContext: () => ({
      clearRect() {}, beginPath() {}, fill() {}, rect() {}, roundRect() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      getImageData: () => ({ data: new Uint8Array(4) }),
    }),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 300, height: 100, top: 0, left: 0, right: 300, bottom: 100 }),
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = String(v); el._cache.clear(); },
    get outerHTML() { return el._html; },
  };
  return el;
}

// Строки караоке приложение создаёт через innerHTML — разбираем их в узлы,
// чтобы можно было проверить класс .active.
function buildNodes(sel, html) {
  if (!sel.includes('.lvl')) return [];
  const out = [];
  const re = /<div class="lvl" data-i="(\d+)" data-t="([\d.]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const n = makeEl('div');
    n.dataset.i = m[1];
    n.dataset.t = m[2];
    out.push(n);
  }
  return out;
}

const getEl = (sel) => {
  if (!els.has(sel)) els.set(sel, makeEl('div'));
  return els.get(sel);
};
const navItems = [
  ['search', 'Поиск'], ['trends', 'В тренде'], ['radio', 'Радио'], ['foryou', 'Для вас'],
  ['favorites', 'Избранное'], ['settings', 'Настройки'],
].map(([v]) => { const b = makeEl('button'); b.dataset.view = v; return b; });
const SETTINGS = 5; // индекс пункта «Настройки»

// Корень документа. Тема живёт атрибутом data-theme на <html>, поэтому это
// единственный узел, у которого заглушка обязана запоминать атрибуты — иначе
// проверка смены темы была бы фиктивной.
const docRoot = makeEl('html');
let rootTheme = null;
docRoot.setAttribute = (k, v) => { if (k === 'data-theme') rootTheme = v; };
docRoot.getAttribute = (k) => (k === 'data-theme' ? rootTheme : null);

const docHandlers = {};
globalThis.document = {
  documentElement: docRoot,
  querySelector: (s) => getEl(s),
  querySelectorAll: (s) => (s === '.nav-item' ? navItems : []),
  createElement: (t) => makeEl(t),
  addEventListener(t, h) { (docHandlers[t] ||= []).push(h); },
  removeEventListener() {},
  dispatch(t, ev = {}) {
    (docHandlers[t] || []).forEach((h) => h({ key: ev.key, target: getEl('#q'), preventDefault() {} }));
  },
  body: makeEl('body'),
  title: '',
};
globalThis.window = globalThis;
globalThis.location = { href: 'http://127.0.0.1:4173/' };   // его читают экраны сбоя
globalThis.addEventListener = () => {};       // window.addEventListener в bindPlayer
globalThis.removeEventListener = () => {};
globalThis.navigator = {}; // mediaSession отсутствует — как в старом браузере
globalThis.localStorage = (() => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
})();
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('http') ? u : BASE + u, o);
globalThis.requestAnimationFrame = () => 0;

/* ==================== перехват ошибок ==================== */
const problems = [];
const die = (kind, e) => {
  const msg = `${kind}: ${e?.stack || e?.message || e}`;
  problems.push(msg);
  failed++;
  console.log('  ✗ ' + msg.split('\n')[0]);
};
// Ошибка в коде приложения не должна «подвешивать» прогон: печатаем и выходим.
process.on('uncaughtException', (e) => { die('uncaught', e); summary(); process.exit(1); });
process.on('unhandledRejection', (e) => die('unhandled', e));
// Страховка от зависаний: если прогон не дошёл до конца за 120 секунд — это провал.
const watchdog = setTimeout(() => {
  console.log('  ✗ прогон не завершился за 120 секунд (зависание)');
  failed++;
  summary();
  process.exit(1);
}, 120_000);
const origError = console.error;
console.error = (...a) => problems.push('console.error: ' + a.join(' '));

/* ==================== прогон ==================== */
console.log('UI-смоук против ' + BASE);
head('1. Загрузка модуля');
await import('../public/app.js');
await sleep(3000); // init(): провайдеры, тренды, статусы аккаунтов
const MP = globalThis.MuzPlayer;
ok(!!MP, 'app.js исполнился и создал window.MuzPlayer', problems.join('; '));
if (!MP) { console.log('\nМодуль упал — дальше проверять нечего.'); process.exit(1); }

ok(MP.state.providers.length === 6, 'получено 6 источников от /api/providers', MP.state.providers.length);
ok(getEl('#sources')._html.includes('Audius'), 'сайдбар «Источники» отрисован');
ok(getEl('#tabs')._html.length > 0, 'табы источников отрисованы');
ok(getEl('#acc-mini')._html.includes('acc-dot'), 'мини-индикатор аккаунтов заполнен');
ok(MP.state.yandexAuth === true, 'статус Яндекс.Музыки загружен (авторизован)');
await sleep(5500); // индикатор сервера обновляется пульсом раз в 5 секунд
ok(getEl('#health').textContent.includes('online'), 'индикатор сервера: ' + getEl('#health').textContent);

head('2. Вкладка «Настройки»');
navItems[SETTINGS].dispatch('click');
await sleep(600);
const set = getEl('#content');
ok(set._html.includes('Настройки'), 'заголовок вкладки');
ok(set._html.includes('Аккаунты и ключи'), 'блок аккаунтов и ключей');
ok(set._html.includes('id="set-yandex"'), 'кнопка Яндекс.Музыки переехала в настройки');
ok(set._html.includes('id="set-youtube"'), 'кнопка YouTube-ключа переехала в настройки');
ok(!set._html.includes('yandex-status') && !set._html.includes('youtube-status'), 'старых id из сайдбара больше нет');
ok((set._html.match(/<tr>/g) || []).length === 6, 'в настройках таблица по 6 источникам', (set._html.match(/<tr>/g) || []).length);
ok(set._html.includes('Тексты и караоке') && set._html.includes('LRCLIB'), 'блок «Тексты и караоке» с указанием источника');
ok(set._html.includes('Горячие клавиши'), 'список горячих клавиш');
ok(getEl('.topbar').style.display === 'none', 'панель поиска скрыта в настройках');
await sleep(700);
ok(/источник/i.test(getEl('#set-health').textContent), 'блок «О программе» получил /api/health: ' + getEl('#set-health').textContent);

head('2б. Настройки: переключатели и модалка ключа');
const toggleAuto = getEl('#content').querySelector('#set-autolyrics');
const before = MP.state.prefs.autoLyrics;
toggleAuto.dispatch('click');
ok(MP.state.prefs.autoLyrics === !before, 'переключатель «автокараоке» меняет состояние', MP.state.prefs.autoLyrics);
ok(JSON.parse(globalThis.localStorage.getItem('muz:prefs')).autoLyrics === !before, 'настройка сохранилась в localStorage');
toggleAuto.dispatch('click');
getEl('#content').querySelector('#set-youtube').dispatch('click');
ok(getEl('#modal').classList.contains('open'), 'кнопка YouTube открывает модалку с ключом');
ok(getEl('#modal-body')._html.includes('AIzaSy') || getEl('#modal-body')._html.includes('yt-key-input'), 'в модалке есть поле ввода ключа');
ok(getEl('#modal-body')._html.includes('console.cloud.google.com'), 'в модалке инструкция, где взять ключ');
getEl('#modal').classList.remove('open');

head('3. Возврат на «Поиск»');
navItems[0].dispatch('click');
await sleep(1200);
ok(getEl('.topbar').style.display === '', 'панель поиска вернулась');
ok(MP.state.view === 'search', 'view снова search');
ok(getEl('#content')._html.includes('rows') || getEl('#content')._html.includes('empty'), 'лента отрисована');

head('4. Караоке: синхронный текст');
const track = { uid: 'smoke:sonne', id: '1', provider: 'audius', title: 'Sonne', artist: 'Rammstein', duration: 272, playable: true };
MP.state.tracks = [track]; MP.state.queue = [track]; MP.state.qi = 0;
getEl('#lyrics-panel').classList.remove('open');
MP.toggleLyrics();
await sleep(3000);
const body = getEl('#lyr-body');
const nodes = body.querySelectorAll('.lvl');
ok(getEl('#lyrics-panel').classList.contains('open'), 'панель караоке открылась');
ok(nodes.length === 40, 'Sonne: 40 строк с таймкодами', nodes.length);
ok(getEl('#lyr-src').textContent.includes('синхрон'), 'подпись источника: ' + getEl('#lyr-src').textContent);
MP.audio.currentTime = 35;
MP.syncLyrics();
ok(nodes[1].classList.contains('active'), 'на 35-й секунде подсвечена 2-я строка');
ok(!nodes[0].classList.contains('active'), 'предыдущая строка снята');
MP.audio.currentTime = 0;
MP.syncLyrics();
ok(!nodes.some((n) => n.classList.contains('active')), 'до первой строки подсветки нет');
MP.audio.currentTime = 100;
MP.syncLyrics();
const active = nodes.findIndex((n) => n.classList.contains('active'));
ok(active > 1, 'на 100-й секунде активна строка №' + (active + 1));

MP.audio.currentTime = 0;
MP.audio.src = '/api/stream?p=audius&id=smoke'; // трек «загружен» — иначе перемотка намеренно игнорируется
nodes[5].dispatch('click');
ok(Math.abs(MP.audio.currentTime - Number(nodes[5].dataset.t)) < 0.01,
  'клик по строке перематывает на её время (' + MP.audio.currentTime + ' с)');
MP.syncLyrics();
ok(nodes[5].classList.contains('active'), 'после перемотки подсвечена та же строка');

head('5. Караоке: поиск несуществующего трека (пустой результат)');
await MP.loadLyricsFor({ uid: 'smoke:none', title: 'ываыва', artist: 'фывафыва', duration: 100 });
ok(getEl('#lyr-body')._html.includes('не найден') || getEl('#lyr-body')._html.includes('🙈'), 'показан понятный пустой экран');

head('6. Автокараоке при старте трека');
MP.state.prefs.autoLyrics = true;
getEl('#lyrics-panel').classList.remove('open');
MP.state.lyrUid = null;
MP.playFromList(0);
await sleep(3000);
ok(getEl('#lyrics-panel').classList.contains('open'), 'панель открылась сама (настройка включена)');
ok(getEl('#lyr-body').querySelectorAll('.lvl').length === 40, 'текст подгрузился при старте трека');

head('7. Хоткей L и Esc');
getEl('#lyrics-panel').classList.remove('open');
document.dispatch('keydown', { key: 'L' });
await sleep(2500);
ok(getEl('#lyrics-panel').classList.contains('open'), 'L открывает панель');
document.dispatch('keydown', { key: 'Escape' });
ok(!getEl('#lyrics-panel').classList.contains('open'), 'Esc закрывает панель');
document.dispatch('keydown', { key: 'Q' });
ok(getEl('#queue-panel').classList.contains('open'), 'Q открывает очередь');
document.dispatch('keydown', { key: 'Q' });
ok(!getEl('#queue-panel').classList.contains('open'), 'Q закрывает очередь');

head('8. Плеер: прогресс и перемотка без исключений');
MP.audio.duration = 272;
MP.audio.currentTime = 12;
getEl('#audio').dispatch('timeupdate');
MP.audio.currentTime = 200;
getEl('#audio').dispatch('timeupdate');
ok(true, 'timeupdate обработан');

summary = () => {
  console.error = origError;
  if (problems.length) {
    console.log('  ✗ проблемы:');
    problems.forEach((p) => console.log('   · ' + String(p).split('\n')[0]));
  } else {
    console.log('  ✓ ни одного исключения и ошибки в консоли');
  }
  console.log(failed ? `\nПРОВАЛ: ${failed} проверок не прошло.\n` : '\nВСЁ ЗЕЛЁНОЕ.\n');
};

head('9. Режим «сервер не отвечает»');
MP.state.offline = true;
navItems[0].dispatch('click'); // клик по «Поиск», как это делает пользователь
await sleep(50);
ok(getEl('#content')._html.includes('не отвечает'), 'при offline показана инструкция, а не пустота');
ok(getEl('#content')._html.includes('npm start'), 'в инструкции есть команда запуска');
MP.state.offline = false;

head('9б. Сторож загрузки и экран фатального сбоя');
ok(globalThis.__muzBoot === true, '__muzBoot выставлен: сторож из index.html не будет ругаться зря');
globalThis.__muzFail('тестовая ошибка: модуль упал');
ok(getEl('#content')._html.includes('Плеер не запустился'), 'window.__muzFail рисует экран сбоя');
ok(getEl('#content')._html.includes('тестовая ошибка'), 'в экране сбоя виден текст ошибки');
ok(/\b0\.\d+\.\d+\b/.test(getEl('#content')._html), 'в экране сбоя есть штамп сборки — сразу видно, свежая версия или нет');

head('10. Синхронизация в реальном времени (без ручных вызовов)');
// Панель закрылась на шаге 7 (Esc) — открываем, как это делает пользователь.
getEl('#lyrics-panel').classList.add('open');
await MP.loadLyricsFor(MP.state.queue[MP.state.qi]);
const lyrNodes = getEl('#lyr-body').querySelectorAll('.lvl');
MP.audio.currentTime = 32;
getEl('#audio').dispatch('timeupdate');           // так это делает настоящий <audio>
await sleep(300);
const idxA = lyrNodes.findIndex((n) => n.classList.contains('active'));
ok(idxA >= 0, 'на 32-й секунде подсветка появилась сама (строка №' + (idxA + 1) + ')');

MP.audio.currentTime = 62;                         // НЕ вызываем syncLyrics вручную
await sleep(400);
const idxB = lyrNodes.findIndex((n) => n.classList.contains('active'));
ok(idxB > idxA, `через 30 секунд подсветка сама уехала дальше (${idxA + 1} → ${idxB + 1})`);

// Второй источник времени — таймер (нужен для YouTube, где нет timeupdate)
MP.audio.currentTime = 100;
await sleep(500);
const idxC = lyrNodes.findIndex((n) => n.classList.contains('active'));
ok(idxC > idxB, `тикер тоже двигает подсветку без событий (${idxB + 1} → ${idxC + 1})`);

// Режим YouTube: время берётся из IFrame-плеера
MP.state.mode = 'yt';
MP.state.ytCur = 130;
await sleep(500);
const idxYt = lyrNodes.findIndex((n) => n.classList.contains('active'));
ok(idxYt > idxC, `в режиме YouTube подсветка идёт по времени плеера (строка №${idxYt + 1})`);
MP.state.mode = 'audio';

head('11. Перемешивание: настоящий рандом без повторов');
const q10 = Array.from({ length: 10 }, (_, i) => ({ uid: 'sh' + i, id: 'id' + i, provider: 'audius', title: 'трек ' + i, artist: 'а' + i, duration: 100, playable: true }));
MP.state.queue = q10; MP.state.qi = 0; MP.audio.currentTime = 0;
const shuffleBtn = getEl('#btn-shuffle');
shuffleBtn.dispatch('click');                 // выкл → рандом
ok(MP.state.shuffleMode === 'random', 'кнопка включает режим настоящего рандома', MP.state.shuffleMode);
ok(shuffleBtn.classList.contains('on'), 'кнопка подсвечена');
ok(MP.state.bag && MP.state.bag.left === 9, 'мешок не предлагает текущий трек сразу (осталось 9)', MP.state.bag?.left);
const visited = [];
for (let k = 0; k < 9; k++) { MP.state.qi = MP.state.bag.take(MP.state.qi); visited.push(MP.state.qi); }
ok(new Set(visited).size === 9, 'за цикл выпали 9 разных треков — повторов нет', JSON.stringify(visited));
ok(!visited.includes(0), 'только что игравший трек в этом цикле не повторился');
shuffleBtn.dispatch('click');                 // рандом → умный
ok(MP.state.shuffleMode === 'smart' && shuffleBtn.classList.contains('smart'), 'третий режим — умный шаффл', MP.state.shuffleMode);
shuffleBtn.dispatch('click');                 // умный → выкл
ok(MP.state.shuffleMode === 'off' && !shuffleBtn.classList.contains('on'), 'режим выключается');

head('12. Вкусы: прослушивания и пропуски учитываются');
const playsBefore = MP.state.taste.totalPlays;
MP.state.queue = [q10[0]]; MP.state.qi = 0;
MP.playFromList && MP.playFromList(0);
MP.state.countedUid = null;
MP.audio.currentTime = 30;                    // «дослушал» до порога
getEl('#audio').dispatch('timeupdate');
ok(MP.state.taste.totalPlays === playsBefore + 1, 'прослушивание засчитано', `${playsBefore} → ${MP.state.taste.totalPlays}`);
ok(Object.keys(MP.state.taste.artists).length > 0, 'артист появился в профиле');
ok(!!globalThis.localStorage.getItem('muz:taste'), 'профиль сохраняется в localStorage');
const skipsBefore = MP.state.taste.totalSkips;
MP.state.queue = [q10[1], q10[2]]; MP.state.qi = 0; MP.state.countedUid = null;
MP.state.prefs.countSkips = true;
MP.audio.currentTime = 12;
MP.state.queue = [q10[1], q10[2]]; MP.state.qi = 0;
MP.state.bag = null;
MP.state.shuffleMode = 'off';
MP.audio.currentTime = 12;
globalThis.__step = globalThis.__step || (() => {});
getEl('#btn-next').dispatch('click');         // «дальше» на середине трека = пропуск
ok(MP.state.taste.totalSkips === skipsBefore + 1, 'пропуск засчитан как «не зашло»', `${skipsBefore} → ${MP.state.taste.totalSkips}`);

head('13. Вкладка «Для вас»');
navItems[3].dispatch('click');
await sleep(2500);
const fy = getEl('#content');
ok(fy._html.includes('Для вас'), 'экран открылся');
ok(fy._html.includes('Подобрано для вас'), 'есть блок подборки');
ok(/прослушиван/i.test(fy._html), 'показан профиль вкусов');
ok(fy._html.includes('Ваши артисты') || fy._html.includes('Профиль пока пустой'), 'есть блок артистов или понятная пустышка');
const picks = getEl('#fy-picks');
const drawn = await waitFor(() => picks._html.includes('row') || picks._html.includes('empty'));
ok(drawn, 'подборка отрисована (ждём сборку из источников)');

head('14. Автоподбор в конце очереди');
MP.state.prefs.autoplay = true;
MP.state.queue = [q10[0], q10[1]];
MP.state.qi = 1;
const qLenBefore = MP.state.queue.length;
getEl('#btn-next').dispatch('click');          // дошли до конца — должен подключиться автоподбор
await sleep(6000);
ok(MP.state.queue.length > qLenBefore, 'очередь дополнилась треками по вкусу', `${qLenBefore} → ${MP.state.queue.length}`);
ok(MP.state.qi < MP.state.queue.length, 'воспроизведение продолжается с нового трека');
MP.state.prefs.autoplay = false;
MP.state.queue = [q10[0], q10[1]];
MP.state.qi = 1;
getEl('#btn-next').dispatch('click');
await sleep(1500);
ok(MP.state.queue.length === 2, 'с выключенным автоподбором очередь не растёт', String(MP.state.queue.length));

head('15. Темы оформления');
MP.switchView('settings');
const setHTML = getEl('#content').innerHTML;
ok(MP.themes.length >= 6, 'в списке тем не меньше шести', MP.themes.length);
ok(MP.themes.every((t) => setHTML.includes(`id="theme-${t.id}"`)), 'в настройках есть карточка каждой темы');
ok(MP.themes.every((t) => setHTML.includes(t.hint)), 'у каждой темы есть подпись, чем она отличается');
const lightList = MP.themes.filter((t) => !t.dark).map((t) => t.name);
ok(lightList.length >= 2, 'есть светлые темы для яркого экрана: ' + lightList.join(', '));

getEl('#theme-neon').dispatch('click');
ok(document.documentElement.getAttribute('data-theme') === 'neon', 'тема применяется сразу по клику',
  document.documentElement.getAttribute('data-theme'));
ok(JSON.parse(globalThis.localStorage.getItem('muz:prefs')).theme === 'neon', 'выбор темы сохраняется в настройках');
ok(getEl('#theme-neon').classList.contains('on') && !getEl('#theme-aurora').classList.contains('on'),
  'галерея подсвечивает выбранную тему');

MP.applyTheme('day');
ok(document.documentElement.getAttribute('data-theme') === 'day', 'светлая тема тоже применяется');
MP.applyTheme('нет-такой-темы');
ok(document.documentElement.getAttribute('data-theme') === 'aurora',
  'несуществующая тема не ломает вид — берётся запасная');

MP.applyTheme('day');
document.dispatch('keydown', { key: 't' });
ok(document.documentElement.getAttribute('data-theme') === 'paper', 'клавиша T переключает тему по кругу',
  document.documentElement.getAttribute('data-theme'));

MP.toggleThemePop(true);
ok(getEl('#theme-pop').classList.contains('open'), 'быстрый выбор темы открывается у строки поиска');
ok(getEl('#theme-pop').innerHTML.includes('pop-theme-'), 'в быстром выборе есть все темы');
document.dispatch('keydown', { key: 'Escape' });
ok(!getEl('#theme-pop').classList.contains('open'), 'Esc закрывает быстрое окно темы');
MP.applyTheme('aurora');

head('Итог');
clearTimeout(watchdog);
summary();
process.exit(failed ? 1 : 0);
