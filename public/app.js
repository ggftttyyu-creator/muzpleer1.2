// MuzPlayer — клиентская логика плеера.
// Всё аудио идёт через /api/stream (тот же origin), поэтому работают
// Range-перемотка, MediaSession и WebAudio-визуализатор.
import { YouTubeDock } from './youtube.js';
import {
  ShuffleBag, WeightedBag, emptyTaste, recordPlay, recordSkip, tasteStats,
  topArtists, recentTracks, resetTaste, recommend, smartWeight,
} from './rec.js';
import { THEMES, DEFAULT_THEME, normalizeTheme, themeById, nextTheme, applyThemeTo, swatchGradient } from './theme.js';

const VERSION = '0.6.0';

const $ = (s) => document.querySelector(s);
const audio = $('#audio');

// Настройки по умолчанию. Тема по умолчанию — та же, что подставляется
// в index.html до отрисовки, иначе интерфейс мигнёт другой палитрой.
const DEFAULT_PREFS = { autoLyrics: false, compactSources: false, autoplay: true, countSkips: true, smartShuffle: true, theme: DEFAULT_THEME };

// Мост для сторожевого скрипта из index.html: любая ошибка на странице
// превращается в понятное сообщение, а не в пустой тёмный экран.
window.__muzFail = (msg) => showFatal(msg);

const state = {
  view: 'search',
  provider: 'all',
  tracks: [],          // текущий список на экране
  queue: [],           // очередь воспроизведения
  qi: -1,              // индекс в очереди
  shuffleMode: 'off',  // off | random | smart
  bag: null,           // мешок перемешивания (настоящий рандом без повторов)
  shuffleHistory: [],  // куда вернуться по «назад» в режиме перемешивания
  repeat: 'off',       // off | all | one
  taste: load('muz:taste', emptyTaste()),   // профиль прослушиваний
  countedUid: null,    // трек, уже засчитанный в статистику (чтобы не считать дважды)
  autoBusy: false,     // идёт подбор треков — второй раз не запускаем
  candCache: { at: 0, list: [] },
  providers: [],
  genres: [],
  radioTag: null,
  favs: load('muz:favs', []),
  dragging: false,
  vizOn: false,
  mode: 'audio',   // audio | yt
  ytCur: 0,
  ytDur: 0,
  ytHasKey: false,
  yandexAuth: false,
  // аккаунты и ключи — храним в состоянии, а рисуем в настройках
  yandex: { authorized: false, account: null },
  youtube: { hasKey: false, quota: null },
  // караоке
  lyrUid: null,
  lyrData: null,
  lyrIdx: -1,
  lyrScrollAt: 0,
  offline: false,     // сервер не отвечает — показываем понятный экран, а не пустоту
  // Сливаем с настройками по умолчанию: старые сохранения не знают про новые
  // ключи (например, про тему), и без слияния они оказались бы undefined.
  prefs: { ...DEFAULT_PREFS, ...load('muz:prefs', {}) },
};

function savePrefs() { save('muz:prefs', state.prefs); }

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

const img = (u) => (u ? `/api/img?u=${encodeURIComponent(u)}` : '');
const fmt = (s) => {
  if (!s || !isFinite(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const favKey = (t) => t.uid;

/* ==================== YouTube-док ==================== */
const ytDock = new YouTubeDock({
  frame: $('#yt-frame'),
  note: $('#yt-note'),
  onState: (code) => onYouTubeState(code),
  onProgress: (cur, dur) => {
    state.ytCur = cur;
    state.ytDur = dur;
    if (state.mode === 'yt') { paintProgress(); syncLyrics(); countPlayIfDue(); }
  },
});

function onYouTubeState(code) {
  if (state.mode !== 'yt') return;
  if (code === 1) setPlayIcon(true);            // играет
  if (code === 2) setPlayIcon(false);           // пауза
  if (code === 3) setPlayIcon(true);            // буферизация
  if (code === 0) step(1, false);               // видео закончилось
  if (code === -2) setPlayIcon(false);          // ошибка плеера
}

/** Достаём videoId из ссылки YouTube (для вставки в строку поиска). */
function youTubeId(s) {
  const v = String(s || '').trim();
  // только реальные ссылки: голый 11-символьный запрос не должен уводить в YouTube
  const m =
    v.match(/[?&]v=([\w-]{11})/) ||
    v.match(/youtu\.be\/([\w-]{11})/) ||
    v.match(/youtube\.com\/(?:embed|shorts|live)\/([\w-]{11})/);
  return m ? m[1] : null;
}

/** Играем по ссылке. Ключ не нужен: IFrame-плеер умеет играть по ID напрямую. */
async function playYouTubeLink(id) {
  let track = {
    uid: `youtube:${id}`,
    provider: 'youtube',
    id,
    title: 'YouTube · ' + id,
    artist: 'YouTube',
    album: '',
    artwork: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    playable: true,
    preview: false,
    embed: true,
    externalUrl: `https://youtu.be/${id}`,
  };
  // Есть ключ — подтянем нормальные метаданные (1 unit квоты)
  try {
    const d = await api('/api/youtube/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: id }),
    });
    if (d.track) track = d.track;
  } catch {
    toast('Играю по ссылке. Без API-ключа название подтянется только из плеера.', '', 4500);
  }
  const at = state.qi >= 0 ? state.qi + 1 : 0;
  state.queue.splice(at, 0, track);
  state.qi = at;
  playCurrent();
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function toast(msg, kind = '', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}

/* ==================== Инициализация ==================== */
async function init() {
  bindPlayer();
  bindKeys();
  // Обработчики навешены — сторожевой таймер можно выключать.
  window.__muzBoot = true;
  try {
    const { providers, genres } = await api('/api/providers');
    state.providers = providers;
    state.genres = genres || [];
    renderSources();
    renderTabs();
  } catch (e) {
    // Сервер не запущен или упал: вместо пустого интерфейса — инструкция.
    renderOffline(e.message);
  }
  state.ready = true;
  checkYandex();
  checkYouTube();
  if (state.view === 'search') home();

  // Пульс сервера: раз в 5 секунд. Заодно подхватывает возвращение сервера
  // и гасит экран «не отвечает», когда он снова поднялся.
  setInterval(async () => {
    try {
      const h = await api('/api/health');
      $('#health').textContent = `● online · ${h.providers} src`;
      if (state.offline) await recoverFromOffline();
    } catch {
      $('#health').textContent = '● offline';
      if (!state.offline) renderOffline('сервер перестал отвечать');
    }
  }, 5000);

  setInterval(checkYandex, 30_000);
}

/* ==================== Провайдеры ==================== */
function renderSources() {
  const host = $('#sources');
  host.innerHTML = state.providers
    .map((p) => {
      const st = p.capabilities.stream;
      const label =
        st === 'full' ? 'полный'
        : st === 'preview' ? '30 сек'
        : st === 'embed' ? 'iframe'
        : st === 'none' ? 'без звука'
        : 'нет';
      const cls = st === 'full' ? 'full' : st === 'preview' ? 'preview' : '';
      // серые источники — те, что не заработают без входа/ключа
      const ok =
        !(p.id === 'yandex' && !p.status?.authorized) && !(p.id === 'youtube' && !p.status?.hasKey);
      return `<button class="source ${ok ? '' : 'off'}" data-prov="${p.id}" title="${esc(p.description)}">
        <i class="dot" style="color:${p.accent};background:${p.accent}"></i>
        <span>${esc(p.name)}</span><span class="st ${cls}">${label}</span>
      </button>`;
    })
    .join('');
  host.querySelectorAll('.source').forEach((b) =>
    b.addEventListener('click', () => selectProvider(b.dataset.prov)),
  );
}

function renderTabs() {
  const tabs = [{ id: 'all', name: 'Все источники', accent: '#7c5cff' }, ...state.providers];
  $('#tabs').innerHTML = tabs
    .map((t) => {
      const badge = t.id !== 'all' && t.capabilities ? (t.capabilities.stream === 'preview' ? '<span class="badge">30s</span>' : '') : '';
      return `<button class="tab ${state.provider === t.id ? 'active' : ''}" data-prov="${t.id}">${esc(t.name)}${badge}</button>`;
    })
    .join('');
  $('#tabs').querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => selectProvider(b.dataset.prov)),
  );
}

function selectProvider(id) {
  state.provider = id;
  renderTabs();
  renderSources();
  const q = $('#q').value.trim();
  if (state.view === 'radio') return loadRadio(state.radioTag);
  if (q) doSearch(q);
  else home();
}

/* ==================== Экраны ==================== */
function skeleton(n = 7) {
  $('#content').innerHTML = `<div class="rows">${Array.from({ length: n })
    .map(() => `<div class="sk"><i class="h46"></i><i class="h46"></i><div><i class="h14"></i><i class="h12"></i></div></div>`)
    .join('')}</div>`;
}

/** Экран фатального сбоя: показывает саму ошибку, чтобы её можно было назвать. */
function showFatal(msg = '') {
  const el = $('#content');
  if (!el) return;
  el.innerHTML = `
    <div class="empty" style="padding:48px 20px">
      <div class="big">💥</div>
      <h4>Плеер не запустился</h4>
      <p>Ошибка: <code>${esc(String(msg).slice(0, 400))}</code></p>
      <p>Обновите страницу со сбросом кэша — <b>Ctrl + Shift + R</b> (на Mac: Cmd + Shift + R).
      Если не помогло, пришлите этот текст: в нём точная причина.</p>
      <p class="hint">Сборка ${VERSION} · ${esc(location.href)}</p>
    </div>`;
}

/** Экран «сервер не запущен»: без него интерфейс выглядит просто пустым. */
function renderOffline(detail = '') {
  state.offline = true;
  $('#content').innerHTML = `
    <div class="empty" style="padding:56px 20px">
      <div class="big">🔌</div>
      <h4>Сервер MuzPlayer не отвечает</h4>
      <p>Интерфейс — только половина плеера: поиск, потоки, тексты и аккаунты идут через локальный сервер.
      Запустите его в папке проекта:</p>
      <div class="code-box">npm start</div>
      <p class="hint">и откройте <b>http://localhost:4173</b>.<br />
      Файл <code>index.html</code>, открытый двойным щелчком, работать не может — браузеру нужен сервер,
      иначе не загрузятся ES-модули и API.<br />
      ${detail ? 'Причина: ' + esc(detail) : ''}<br />Сборка ${VERSION}</p>
    </div>`;
}

/** Сервер вернулся: перечитываем провайдеров и возвращаем нормальный экран. */
async function recoverFromOffline() {
  const { providers, genres } = await api('/api/providers');
  state.offline = false;
  state.providers = providers;
  state.genres = genres || [];
  renderSources();
  renderTabs();
  toast('Сервер снова на связи ✅', 'ok');
  checkYandex();
  checkYouTube();
  home();
}

async function home() {
  state.view = 'search';
  if (state.offline) return renderOffline();
  state.tracks = [];
  skeleton();
  const tasks = [];
  if (state.provider === 'all' || state.provider === 'audius') {
    tasks.push(api('/api/trending?provider=audius&limit=12').then((d) => (['Audius — в тренде', d.tracks])));
  }
  if (state.provider === 'all' || state.provider === 'deezer') {
    tasks.push(api('/api/trending?provider=deezer&limit=12').then((d) => (['Deezer — чарт', d.tracks])).catch(() => null));
  }
  if (state.provider === 'radio') return loadRadio(state.radioTag);

  // Яндекс подключён — сразу показываем «Мне нравится»
  if (state.yandexAuth && (state.provider === 'all' || state.provider === 'yandex')) {
    tasks.push(
      api('/api/trending?provider=yandex&limit=12')
        .then((d) => ['Яндекс.Музыка — Мне нравится', d.tracks])
        .catch(() => null),
    );
  }

  // YouTube без ключа искать не умеет вообще — показываем понятный CTA вместо пустоты
  if (state.provider === 'youtube' || (state.provider === 'all' && state.ytHasKey)) {
    const st = await api('/api/youtube/status').catch(() => ({ hasKey: false }));
    if (state.view !== 'search') return;
    if (!st.hasKey && state.provider === 'youtube') {
      $('#content').innerHTML = youtubeCta();
      $('#yt-cta')?.addEventListener('click', youtubeKeyDialog);
      return;
    }
    if (st.hasKey) {
      tasks.push(
        api('/api/trending?provider=youtube&limit=12')
          .then((d) => ['YouTube — музыкальный чарт (1 unit квоты)', d.tracks])
          .catch(() => null),
      );
    }
  }

  const res = (await Promise.allSettled(tasks)).filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
  if (state.view !== 'search') return; // пользователь уже ушёл в другую вкладку
  let html = '';
  for (const [title, tracks] of res) {
    if (!tracks?.length) continue;
    state.tracks.push(...tracks);
    html += `<div class="section-title">${esc(title)}</div>` + rowsHTML(tracks, state.tracks.length - tracks.length);
  }
  $('#content').innerHTML =
    html ||
    `<div class="empty"><div class="big">🎧</div><h4>Начните с поиска</h4>
     <p>Введите название трека или артиста — плеер опросит все включённые источники.<br />
     Полные треки дают <b>Audius</b> и <b>Радио</b>, превью по 30 секунд — <b>Deezer</b> и <b>iTunes</b>.</p></div>`;
  wireRows();
}

async function doSearch(q) {
  state.view = 'search';
  if (state.offline) return renderOffline();
  skeleton(8);
  try {
    const d = await api(`/api/search?q=${encodeURIComponent(q)}&provider=${state.provider}&limit=20`);
    if (state.view !== 'search') return; // пришли результаты, но мы уже в настройках
    state.tracks = d.tracks || [];
    if (d.errors?.length) {
      d.errors.forEach((e) => toast(`${e.provider}: ${e.error}`, 'err', 6000));
    }
    if (!state.tracks.length) {
      $('#content').innerHTML = `<div class="empty"><div class="big">🔍</div><h4>Ничего не найдено</h4><p>Попробуйте другой запрос или переключите источник.</p></div>`;
      return;
    }
    const previews = state.tracks.filter((t) => t.preview).length;
    $('#content').innerHTML =
      `<div class="section-title">Найдено ${state.tracks.length}${
        previews ? ` · ${previews} только как 30-сек превью` : ''
      }</div>` + rowsHTML(state.tracks, 0);
    wireRows();
  } catch (e) {
    $('#content').innerHTML = `<div class="empty"><div class="big">⚠️</div><h4>Ошибка поиска</h4><p>${esc(e.message)}</p></div>`;
  }
}

async function loadRadio(tag) {
  state.view = 'radio';
  state.radioTag = tag || null;
  const chips = state.genres
    .map((g) => `<button class="chip ${state.radioTag === g.tag ? 'active' : ''}" data-tag="${esc(g.tag)}">${esc(g.label)}</button>`)
    .join('');
  $('#content').innerHTML = `<div class="section-title">Жанры</div><div class="genre-chips">${chips}</div><div class="section-title">Станции</div><div class="rows" id="radio-rows"></div>`;
  $('#content').querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => loadRadio(state.radioTag === c.dataset.tag ? null : c.dataset.tag)),
  );
  const host = $('#radio-rows');
  host.innerHTML = Array.from({ length: 6 }).map(() => `<div class="sk"><i class="h46"></i><i class="h46"></i><div><i class="h14"></i><i class="h12"></i></div></div>`).join('');
  try {
    const d = await api(`/api/trending?provider=radio&limit=30${state.radioTag ? '&tag=' + encodeURIComponent(state.radioTag) : ''}`);
    state.tracks = d.tracks || [];
    host.outerHTML = rowsHTML(state.tracks, 0);
    wireRows();
  } catch (e) {
    host.outerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`;
  }
}

function renderFavorites() {
  state.view = 'favorites';
  state.tracks = state.favs.slice();
  $('#content').innerHTML = state.tracks.length
    ? `<div class="section-title">Избранное · ${state.tracks.length}</div>` + rowsHTML(state.tracks, 0)
    : `<div class="empty"><div class="big">💜</div><h4>Пока пусто</h4><p>Жмите на сердечко у трека — он появится здесь (хранится локально в браузере).</p></div>`;
  wireRows();
}

/* ==================== Отрисовка списка ==================== */
function rowsHTML(tracks, offset) {
  return `<div class="rows">${tracks
    .map((t, i) => {
      const isFav = state.favs.some((f) => favKey(f) === favKey(t));
      const art = t.artwork
        ? `<img class="art" loading="lazy" src="${img(t.artwork)}" alt="" onerror="this.classList.add('ph');this.removeAttribute('src')" />`
        : `<div class="art ph"><svg viewBox="0 0 24 24"><use href="#i-radio"/></svg></div>`;
      let tags = `<span class="tag">${esc(t.provider)}</span>`;
      if (!t.playable) tags += `<span class="tag off">нет стрима</span>`;
      else if (t.live) tags += `<span class="tag live">LIVE</span>`;
      else if (t.preview) tags += `<span class="tag preview">30 сек</span>`;
      else if (t.embed) tags += `<span class="tag yt">iframe</span>`;
      else tags += `<span class="tag full">полный</span>`;
      if (t.extra?.bitrate) tags += `<span class="tag">${t.extra.bitrate} kbps</span>`;

      return `<div class="row ${t.playable ? '' : 'dim'}" data-uid="${esc(t.uid)}" data-i="${offset + i}">
        <div class="num">${state.qi >= 0 && state.queue[state.qi]?.uid === t.uid ? '▶' : i + 1}</div>
        ${art}
        <div class="info">
          <div class="title">${esc(t.title)}</div>
          <div class="sub">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</div>
        </div>
        <div class="tags">${tags}</div>
        <div class="dur">${t.live ? '∞' : t.duration ? fmt(t.duration) : '—'}</div>
        <div class="acts">
          <button data-act="next" title="Играть следующим"><svg viewBox="0 0 24 24"><use href="#i-next"/></svg></button>
          <button data-act="add" title="В очередь"><svg viewBox="0 0 24 24"><use href="#i-plus"/></svg></button>
          <button data-act="fav" class="${isFav ? 'on' : ''}" title="В избранное"><svg viewBox="0 0 24 24"><use href="#i-heart"/></svg></button>
          ${t.externalUrl ? `<a href="${esc(t.externalUrl)}" target="_blank" rel="noopener" title="Открыть в источнике" style="padding:6px;color:var(--muted);display:grid;place-items:center"><svg viewBox="0 0 24 24"><use href="#i-ext"/></svg></a>` : ''}
        </div>
      </div>`;
    })
    .join('')}</div>`;
}

function wireRows() {
  $('#content').querySelectorAll('.row').forEach((row) => {
    const idx = Number(row.dataset.i);
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-act]') || e.target.closest('a')) return;
      playFromList(idx);
    });
    row.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = state.tracks[idx];
        if (!t) return;
        const act = btn.dataset.act;
        if (act === 'add') { state.queue.push(t); renderQueue(); toast(`В очередь: ${t.title}`, 'ok', 2200); }
        if (act === 'next') { state.queue.splice(state.qi + 1, 0, t); renderQueue(); toast(`Следующим: ${t.title}`, 'ok', 2200); }
        if (act === 'fav') { toggleFav(t); btn.classList.toggle('on', isFav(t)); }
      });
    });
  });
  markPlaying();
}

const isFav = (t) => state.favs.some((f) => favKey(f) === favKey(t));
function toggleFav(t) {
  const i = state.favs.findIndex((f) => favKey(f) === favKey(t));
  if (i >= 0) { state.favs.splice(i, 1); toast('Убрано из избранного'); }
  else { state.favs.push(t); toast('Добавлено в избранное 💜', 'ok', 2200); }
  save('muz:favs', state.favs);
  $('#fav-count').textContent = state.favs.length;
  $('#np-fav').classList.toggle('on', isFav(t));
  if (state.view === 'favorites') renderFavorites();
}

/* ==================== Воспроизведение ==================== */
function playFromList(i) {
  state.queue = state.tracks.slice();
  state.qi = i;
  renderQueue();
  playCurrent();
}

const cur = () => state.queue[state.qi];

function playCurrent() {
  const t = cur();
  if (!t) return;
  if (!t.playable) {
    toast(
      t.provider === 'yandex'
        ? 'Яндекс.Музыка не отдала этот трек: обычно это подписка (Плюс) или региональное ограничение.'
        : 'Этот трек недоступен для стрима в источнике.',
      'err', 6000,
    );
    return;
  }
  if (t.provider === 'youtube') return playYouTubeTrack(t);

  if (state.mode === 'yt') stopYouTube();
  state.mode = 'audio';
  state.countedUid = null; // новый трек — можно засчитывать прослушивание
  audio.src = `/api/stream?p=${encodeURIComponent(t.provider)}&id=${encodeURIComponent(t.id)}`;
  audio.play().catch((e) => toast('Не удалось воспроизвести: ' + e.message, 'err'));
  updateNowPlaying(t);
  renderQueue();
  markPlaying();
}

/** YouTube играет в отдельном IFrame-плеере, звук идёт мимо <audio>. */
async function playYouTubeTrack(t) {
  state.mode = 'yt';
  state.countedUid = null;
  audio.pause();
  audio.removeAttribute('src');
  try { audio.load(); } catch {}
  $('#viz').style.display = 'none';
  $('#yt-dock').classList.add('open');
  $('#yt-dock').classList.remove('min');
  $('#yt-title').textContent = t.title;
  ytDock.setVolume(audio.muted ? 0 : audio.volume);

  updateNowPlaying(t);
  renderQueue();
  markPlaying();

  try {
    await ytDock.play(t.id);
    $('#yt-note').textContent = '';
  } catch (e) {
    $('#yt-note').textContent = '⚠️ ' + e.message;
    setPlayIcon(false);
    return;
  }

  // IFrame-плеер знает настоящее название и автора — уточняем карточку
  setTimeout(() => {
    if (state.mode !== 'yt') return;
    const d = ytDock.getVideoData();
    const c = cur();
    if (!d?.title || !c) return;
    Object.assign(c, {
      title: d.title,
      artist: d.author || c.artist,
      artwork: c.artwork || `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`,
    });
    $('#yt-title').textContent = d.title;
    updateNowPlaying(c);
    renderQueue();
  }, 1800);
}

function stopYouTube() {
  try { ytDock.pause(); } catch {}
  $('#yt-dock').classList.remove('open');
  $('#viz').style.display = '';
  state.mode = 'audio';
}

function updateNowPlaying(t) {
  $('#np-title').textContent = t.title;
  $('#np-sub').textContent = `${t.artist} · ${t.provider}${t.preview ? ' · 30 сек превью' : ''}`;
  $('#np-art').innerHTML = t.artwork
    ? `<img src="${img(t.artwork)}" alt="" />`
    : `<svg viewBox="0 0 24 24"><use href="#i-radio"/></svg>`;
  $('#np-art').classList.toggle('spin', !!t.live);
  $('#np-fav').classList.toggle('on', isFav(t));

  audio.loop = state.repeat === 'one';
  $('#bar').classList.toggle('live', !!t.live);

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album || t.provider,
      artwork: t.artwork ? [{ src: img(t.artwork), sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  }
  document.title = `${t.title} — ${t.artist} · MuzPlayer`;

  // Караоке включается само, если панель открыта или включена настройка
  if ($('#lyrics-panel').classList.contains('open') || state.prefs?.autoLyrics) {
    if (state.prefs?.autoLyrics) $('#lyrics-panel').classList.add('open');
    loadLyricsFor(t);
  }
}

function toggle() {
  if (!cur()) { if (state.tracks[0]) playFromList(0); return; }
  if (state.mode === 'yt') {
    ytDock.isPlaying() ? ytDock.pause() : ytDock.resume();
    return;
  }
  if (audio.paused) audio.play().catch((e) => toast(e.message, 'err'));
  else audio.pause();
}

/** Короткое имя очереди для мешка: треки могли добавить или убрать. */
function syncBag() {
  if (state.shuffleMode === 'off') { state.bag = null; return; }
  const n = state.queue.length;
  const playable = (i) => i >= 0 && i < n;
  if (!state.bag || state.bag.total !== n) {
    // очередь изменилась — собираем мешок заново, начиная не с текущего трека
    state.bag = state.shuffleMode === 'smart'
      ? new WeightedBag(n, (i) => smartWeight(state.taste, state.queue[i], Date.now()))
      : new ShuffleBag(n);
    if (playable(state.qi)) state.bag.forget(state.qi);
    return state.bag;
  }
  if (playable(state.qi)) state.bag.forget(state.qi);
  if (state.shuffleMode === 'smart') state.bag.weightFn = (i) => smartWeight(state.taste, state.queue[i], Date.now());
  return state.bag;
}

/** Пропуск: человек ушёл с трека раньше времени — сигнал «не зашло». */
function maybeRecordSkip(track) {
  if (!state.prefs.countSkips || !track) return;
  if (state.countedUid === track.uid) return; // этот трек уже засчитан как прослушанный
  const pos = state.mode === 'yt' ? state.ytCur : audio.currentTime || 0;
  if (pos < 3) return; // просто пролистали список — это не оценка
  recordSkip(state.taste, track);
  saveTaste();
}

/** Засчитываем прослушивание, когда трек реально поиграл (а не мелькнул). */
function countPlayIfDue() {
  const t = cur();
  if (!t || state.countedUid === t.uid) return;
  const pos = state.mode === 'yt' ? state.ytCur || 0 : audio.currentTime || 0;
  const dur = (state.mode === 'yt' ? state.ytDur : audio.duration) || t.duration || 0;
  const need = Math.min(20, Math.max(8, dur * 0.3));
  if (pos >= need) {
    state.countedUid = t.uid;
    recordPlay(state.taste, t);
    saveTaste();
  }
}

function saveTaste() {
  save('muz:taste', state.taste);
  if (state.view === 'foryou') renderForYou();
  if (state.view === 'settings') renderSettings();
}

function step(dir, fromUser = true) {
  if (!state.queue.length) return;
  const current = cur();
  if (fromUser && dir > 0) maybeRecordSkip(current);

  // Перемешивание. Раньше здесь был Math.random() по длине очереди: трек мог
  // выпасть дважды подряд, а часть очереди — не сыграть никогда. Теперь порядок
  // задаёт мешок: пока не сыграют все треки, повторов не будет.
  if (state.shuffleMode !== 'off' && state.queue.length > 1) {
    if (dir > 0) {
      const bag = syncBag();
      const next = bag.take(state.qi);
      if (next !== null && next !== undefined && next !== state.qi) {
        if (state.qi >= 0) state.shuffleHistory.push(state.qi);
        state.qi = next;
        return playCurrent();
      }
    } else if (state.shuffleHistory.length) {
      const prev = state.shuffleHistory.pop();
      if (prev >= 0 && prev < state.queue.length) { state.qi = prev; return playCurrent(); }
    }
  }

  state.qi += dir;
  if (state.qi >= state.queue.length) {
    state.qi = state.queue.length - 1;
    if (state.repeat === 'all') { state.qi = 0; return playCurrent(); }
    // Автоподбор включён (по умолчанию) — очередь сама продолжается треками по вкусу.
    // Выключен — честно останавливаемся: зацикливать умеет режим повтора.
    if (state.prefs.autoplay) return autoExtend(true);
    audio.pause();
    if (fromUser) toast('Очередь закончилась. Автоподбор включён в настройках → «Вкусы и рекомендации».', '', 5000);
    return;
  }
  if (state.qi < 0) state.qi = state.queue.length - 1;
  playCurrent();
}

/* ==================== Подбор треков (рекомендации) ==================== */

function queueUids() {
  return new Set(state.queue.map((t) => t.uid));
}

/** Собираем пул кандидатов: поиск по любимым артистам + чарт. Кэш 10 минут. */
async function gatherCandidates(seeds) {
  const fresh = Date.now() - state.candCache.at < 10 * 60 * 1000 && state.candCache.list.length;
  if (fresh) return state.candCache.list;
  const artists = [];
  for (const t of seeds) if (t.artist) artists.push(t.artist);
  for (const a of topArtists(state.taste, 3)) artists.push(a.name);
  const uniq = [...new Set(artists.map((s) => String(s).split(/[,&]/)[0].trim()).filter(Boolean))].slice(0, 4);

  const list = [];
  const res = await Promise.allSettled([
    ...uniq.map((q) => api(`/api/search?q=${encodeURIComponent(q)}&limit=8`).then((d) => d.tracks || [])),
    api('/api/trending?provider=audius&limit=15').then((d) => d.tracks || []).catch(() => []),
  ]);
  for (const r of res) if (r.status === 'fulfilled') list.push(...r.value);
  state.candCache = { at: Date.now(), list };
  return list;
}

/** Семена: что играет сейчас + свежая история + избранное. */
function seedsForRecommendations() {
  const seeds = [];
  const c = cur();
  if (c) seeds.push(c);
  for (const t of recentTracks(state.taste, 6)) seeds.push(t);
  for (const f of state.favs.slice(-6)) seeds.push(f);
  return seeds;
}

/** Собрать рекомендации (используется и в «Для вас», и в автоподборе). */
async function buildRecommendations(limit = 12) {
  const seeds = seedsForRecommendations();
  const candidates = await gatherCandidates(seeds);
  const res = recommend({
    seeds,
    candidates,
    taste: state.taste,
    limit,
    excludeUids: queueUids(),
  });
  return res;
}

/** Дошли до конца очереди — дополняем её треками по вкусу. */
async function autoExtend(continuePlaying = true) {
  if (state.autoBusy) return;
  state.autoBusy = true;
  try {
    if (continuePlaying) toast('Подбираю, что включить дальше…', '', 2500);
    const picks = await buildRecommendations(12);
    if (!picks.length) {
      toast('Подборка пуста — нажмите «Для вас», чтобы посмотреть вручную', '', 5000);
      if (continuePlaying) audio.pause();
      return;
    }
    const wasEnd = state.qi + 1;
    state.queue.push(...picks);
    state.bag = null;
    syncBag();
    renderQueue();
    toast(`Добавлено по вашему вкусу: ${picks.length} треков`, 'ok', 4000);
    if (continuePlaying) {
      state.qi = wasEnd;
      if (state.qi >= state.queue.length) state.qi = 0;
      playCurrent();
    }
  } catch (e) {
    toast('Не смог подобрать: ' + e.message, 'err');
    if (!continuePlaying && cur()) audio.pause();
  } finally {
    state.autoBusy = false;
  }
}

function renderQueue() {
  const host = $('#queue-list');
  // В режиме перемешивания видно, сколько треков ещё не выпадало из мешка
  const left = state.shuffleMode !== 'off' && state.bag ? state.bag.left : null;
  host.innerHTML = state.queue.length
    ? state.queue
        .map(
          (t, i) => `<div class="qitem ${i === state.qi ? 'playing' : ''}" data-q="${i}">
        ${t.artwork ? `<img src="${img(t.artwork)}" alt="" loading="lazy" />` : `<div class="qitem-ph"></div>`}
        <div><div class="qt">${esc(t.title)}</div><div class="qs">${esc(t.artist)}${t.live ? ' · LIVE' : ''}</div></div>
        <div class="dur" style="font-size:11px;color:var(--muted)">${i === state.qi ? '▶' : t.live ? '∞' : fmt(t.duration)}</div>
      </div>`,
        )
        .join('')
    : `<div class="empty" style="padding:30px 12px"><p>Очередь пуста.<br />Кликните по треку, чтобы начать.</p></div>`;

  const hint = $('#queue-hint');
  if (hint) {
    hint.textContent =
      left === null ? ''
      : state.shuffleMode === 'smart' ? `Умный шаффл · в мешке ${left} из ${state.queue.length}`
      : `Рандом без повторов · в мешке ${left} из ${state.queue.length}`;
  }
  const auto = $('#queue-autoplay');
  if (auto) {
    auto.classList.toggle('on', !!state.prefs.autoplay);
    auto.textContent = state.prefs.autoplay ? 'Автоподбор вкл' : 'Автоподбор';
  }

  host.querySelectorAll('.qitem').forEach((el) =>
    el.addEventListener('click', () => { state.qi = Number(el.dataset.q); playCurrent(); }),
  );
}

function markPlaying() {
  const uid = cur()?.uid;
  $('#content').querySelectorAll('.row').forEach((r) => {
    const on = r.dataset.uid === uid;
    r.classList.toggle('playing', on);
    const num = r.querySelector('.num');
    if (num) num.textContent = on ? '▶' : Number(r.dataset.i) + 1;
  });
}

/* ==================== Привязки UI ==================== */
function bindPlayer() {
  $('#btn-play').addEventListener('click', toggle);
  $('#btn-next').addEventListener('click', () => step(1));
  $('#btn-prev').addEventListener('click', () => { if (audio.currentTime > 3) audio.currentTime = 0; else step(-1); });
  $('#np-fav').addEventListener('click', () => { const t = cur(); if (t) { toggleFav(t); } });

  // Три режима перемешивания: выкл → настоящий рандом → умный (по вкусам).
  // Полный порядок тасуется заранее, поэтому «дальше» не повторяет уже сыгранное.
  const cycleShuffle = () => {
    const order = state.shuffleMode === 'off' ? ['random', 'smart', 'off'] : state.shuffleMode === 'random' ? ['smart', 'off'] : ['off'];
    state.shuffleMode = order[0];
    const btn = $('#btn-shuffle');
    btn.classList.toggle('on', state.shuffleMode !== 'off');
    btn.classList.toggle('smart', state.shuffleMode === 'smart');
    btn.title =
      state.shuffleMode === 'off' ? 'Перемешивание выключено (S)'
      : state.shuffleMode === 'random' ? 'Настоящий рандом: без повторов, пока очередь не кончится (S)'
      : 'Умный шаффл: сначала то, что вам заходит (S)';
    state.bag = null;
    state.shuffleHistory = [];
    if (state.shuffleMode !== 'off') {
      syncBag();
      state.shuffleHistory.push(state.qi);
    }
    toast(
      state.shuffleMode === 'off' ? 'Перемешивание выкл'
      : state.shuffleMode === 'random' ? 'Перемешивание: настоящий рандом — повторов не будет'
      : 'Умный шаффл: поднимаю ваши любимые треки',
      state.shuffleMode === 'smart' ? 'ok' : '', 2600,
    );
  };
  $('#btn-shuffle').addEventListener('click', cycleShuffle);
  window.__cycleShuffle = cycleShuffle;

  const rIcon = $('#btn-repeat');
  $('#btn-repeat').addEventListener('click', () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    rIcon.classList.toggle('on', state.repeat !== 'off');
    rIcon.querySelector('use').setAttribute('href', state.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
    if (cur()) audio.loop = state.repeat === 'one';
    toast(state.repeat === 'off' ? 'Повтор выкл' : state.repeat === 'all' ? 'Повтор: вся очередь' : 'Повтор: один трек', '', 1800);
  });

  $('#vol').addEventListener('input', (e) => { audio.volume = Number(e.target.value); audio.muted = false; syncMute(); });
  $('#vol').addEventListener('input', (e) => {
    audio.volume = Number(e.target.value);
    audio.muted = false;
    if (state.mode === 'yt') ytDock.setVolume(audio.volume);
    syncMute();
  });
  $('#btn-mute').addEventListener('click', () => {
    audio.muted = !audio.muted;
    if (state.mode === 'yt') ytDock.setVolume(audio.muted ? 0 : audio.volume);
    syncMute();
  });
  function syncMute() {
    $('#btn-mute').querySelector('use').setAttribute('href', audio.muted || audio.volume === 0 ? '#i-vol-x' : '#i-vol');
  }

  // Прогресс / перемотка
  const bar = $('#bar');
  const seek = (e) => {
    const r = bar.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (state.mode === 'yt') {
      if (state.ytDur) ytDock.seek(p * state.ytDur);
      return;
    }
    if (cur()?.live || !audio.duration) return;
    audio.currentTime = p * audio.duration;
    paintProgress();
  };
  bar.addEventListener('mousedown', (e) => { state.dragging = true; seek(e); });
  window.addEventListener('mousemove', (e) => state.dragging && seek(e));
  window.addEventListener('mouseup', () => (state.dragging = false));

  // timeupdate приходит от <audio> ~4 раза в секунду: двигаем и прогресс, и караоке
  audio.addEventListener('timeupdate', () => { paintProgress(); syncLyrics(); countPlayIfDue(); });
  audio.addEventListener('progress', paintProgress);
  audio.addEventListener('play', () => { setPlayIcon(true); startViz(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  audio.addEventListener('pause', () => { setPlayIcon(false); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
  audio.addEventListener('ended', () => step(1, false));
  audio.addEventListener('error', () => {
    if (state.mode === 'yt' || !audio.src) return;
    toast('Поток не открылся. Возможно, трек недоступен, или у станции проблемы с эфиром.', 'err', 5000);
    setPlayIcon(false);
  });

  if ('mediaSession' in navigator) {
    const h = { play: () => audio.play(), pause: () => audio.pause(), nexttrack: () => step(1), previoustrack: () => step(-1) };
    for (const [k, fn] of Object.entries(h)) {
      try { navigator.mediaSession.setActionHandler(k, fn); } catch {}
    }
  }

  // Очередь
  // Очередь (и караоке — одновременно открыт максимум один дровер)
  $('#btn-queue').addEventListener('click', () => {
    $('#queue-panel').classList.toggle('open');
    $('#lyrics-panel').classList.remove('open');
  });
  // Ручная прокрутка текста: 4 секунды не перебиваем автопрокруткой
  ['wheel', 'touchmove', 'mousedown'].forEach((ev) =>
    $('#lyr-body').addEventListener(ev, () => (state.lyrScrollAt = Date.now()), { passive: true }),
  );
  $('#queue-close').addEventListener('click', () => $('#queue-panel').classList.remove('open'));
  $('#queue-autoplay')?.addEventListener('click', () => {
    state.prefs.autoplay = !state.prefs.autoplay;
    savePrefs();
    renderQueue();
    toast(
      state.prefs.autoplay
        ? 'Автоподбор включён: очередь будет дополняться треками по вашему вкусу'
        : 'Автоподбор выключен: очередь просто закончится',
      '', 3200,
    );
    if (state.view === 'settings') renderSettings();
  });
  $('#queue-clear').addEventListener('click', () => { state.queue = []; state.qi = -1; renderQueue(); toast('Очередь очищена', '', 1800); });

  // Навигация: одна точка входа — switchView (поиск / тренды / радио / избранное / настройки)
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.addEventListener('click', () => switchView(b.dataset.view)),
  );

  // Поиск с дебаунсом
  let timer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    // ссылку YouTube играем по Enter, а не на каждый введённый символ
    if (youTubeId(q)) return;
    timer = setTimeout(() => (q ? doSearch(q) : home()), 380);
  });
  $('#q').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim();
    if (!q) return;
    const vid = youTubeId(q);
    if (vid) return playYouTubeLink(vid);
    doSearch(q);
  });

  // Док YouTube
  $('#yt-close').addEventListener('click', () => { stopYouTube(); setPlayIcon(false); });
  $('#yt-collapse').addEventListener('click', () => $('#yt-dock').classList.toggle('min'));

  // Модалка
  $('#modal-x').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
}

function setPlayIcon(playing) {
  $('#play-icon').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#btn-play').classList.remove('loading');
}

function paintProgress() {
  const t = cur();

  // YouTube: время берём из IFrame-плеера, а не из <audio>
  if (state.mode === 'yt') {
    const d = state.ytDur || 0;
    const c = state.ytCur || 0;
    const p = d ? (c / d) * 100 : 0;
    $('#bar-fill').style.width = p + '%';
    $('#bar-knob').style.left = `calc(${p}% - 5px)`;
    $('#bar-buffer').style.width = p + '%';
    $('#t-cur').textContent = fmt(c);
    $('#t-total').textContent = d ? fmt(d) : '—';
    return;
  }

  if (t?.live) {
    $('#t-cur').textContent = 'LIVE';
    $('#t-total').textContent = '';
    return;
  }
  const d = audio.duration || 0;
  const p = d ? (audio.currentTime / d) * 100 : 0;
  $('#bar-fill').style.width = p + '%';
  $('#bar-knob').style.left = `calc(${p}% - 5px)`;
  $('#bar-buffer').style.width = p + '%';
  $('#t-cur').textContent = fmt(audio.currentTime);
  $('#t-total').textContent = d ? fmt(d) : (t?.duration ? fmt(t.duration) : '0:00');
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === 'Escape') {
      closeModal();
      $('#queue-panel').classList.remove('open');
      $('#lyrics-panel').classList.remove('open');
      toggleThemePop(false);
    }
    if (typing && e.key !== 'Escape') return;
    switch (e.key) {
      case ' ': e.preventDefault(); toggle(); break;
      case 'ArrowRight': e.shiftKey ? step(1) : (audio.currentTime += 5); break;
      case 'ArrowLeft': e.shiftKey ? step(-1) : (audio.currentTime -= 5); break;
      case 'ArrowUp': e.preventDefault(); audio.volume = Math.min(1, audio.volume + 0.05); $('#vol').value = audio.volume; if (state.mode === 'yt') ytDock.setVolume(audio.volume); break;
      case 'ArrowDown': e.preventDefault(); audio.volume = Math.max(0, audio.volume - 0.05); $('#vol').value = audio.volume; if (state.mode === 'yt') ytDock.setVolume(audio.volume); break;
      case 'm': case 'M': case 'ь': case 'Ь': audio.muted = !audio.muted; if (state.mode === 'yt') ytDock.setVolume(audio.muted ? 0 : audio.volume); break;
      case 's': case 'S': case 'ы': case 'Ы': $('#btn-shuffle').click(); break; // выкл → рандом → умный
      case 'r': case 'R': case 'к': case 'К': $('#btn-repeat').click(); break;
      case 'q': case 'Q': case 'й': case 'Й': $('#queue-panel').classList.toggle('open'); break;
      case 'l': case 'L': case 'д': case 'Д': toggleLyrics(); break;
      case 't': case 'T': case 'е': case 'Е': {
        // Переключение по кругу: удобно, когда хочется «поиграть» темами
        const next = nextTheme(state.prefs.theme);
        applyThemeUI(next, true);
        break;
      }
      case '/': e.preventDefault(); $('#q').focus(); break;
    }
  });
}

/* ==================== Визуализатор (WebAudio) ==================== */
let actx, analyser, dataArr;
function startViz() {
  if (state.vizOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    if (!analyser) {
      const src = actx.createMediaElementSource(audio);
      analyser = actx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.75;
      src.connect(analyser);
      analyser.connect(actx.destination);
      dataArr = new Uint8Array(analyser.frequencyBinCount);
    }
    state.vizOn = true;
    drawViz();
  } catch {
    $('#viz').style.display = 'none'; // визуализатор недоступен — не мешаем
  }
}

function drawViz() {
  const c = $('#viz');
  const ctx = c.getContext('2d');
  const w = (c.width = 140), h = (c.height = 34);
  const bars = 26;
  (function frame() {
    if (!state.vizOn) return;
    requestAnimationFrame(frame);
    analyser.getByteFrequencyData(dataArr);
    ctx.clearRect(0, 0, w, h);
    const bw = w / bars;
    for (let i = 0; i < bars; i++) {
      const v = dataArr[Math.floor((i / bars) * dataArr.length * 0.7)] / 255;
      const bh = Math.max(2, v * h);
      const g = ctx.createLinearGradient(0, h, 0, h - bh);
      g.addColorStop(0, '#7c5cff');
      g.addColorStop(1, '#22d3ee');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect?.(i * bw + 1, h - bh, bw - 2.4, bh, 2);
      if (!ctx.roundRect) ctx.rect(i * bw + 1, h - bh, bw - 2.4, bh);
      ctx.fill();
    }
  })();
}

/* ==================== Яндекс.Музыка ==================== */
async function checkYandex() {
  try {
    const s = await api('/api/yandex/status');
    const wasAuth = state.yandexAuth;
    state.yandex = s;
    state.yandexAuth = !!s.authorized;
    updateAccountMini();
    if (state.view === 'settings') renderSettings();
    // только что авторизовались — дотянем раздел «Мне нравится» на главную
    if (!wasAuth && state.yandexAuth && !$('#q').value.trim() && state.view === 'search' && state.ready) home();
  } catch {}
}

async function yandexFlow() {
  if (state.yandexAuth) {
    await api('/api/yandex/logout', { method: 'POST' });
    toast('Яндекс.Музыка отключена');
    checkYandex();
    return;
  }
  openModal('Вход в Яндекс.Музыку', '<p>Запрашиваю код…</p>');
  try {
    const d = await api('/api/yandex/device/start', { method: 'POST' });
    openModal(
      'Вход в Яндекс.Музыку',
      `<p>1. Откройте <a class="link" href="${esc(d.verification_url)}" target="_blank" rel="noopener" style="color:var(--accent-2)">${esc(d.verification_url)}</a>
       2. Введите код:</p>
       <div class="code-box">${esc(d.user_code)}</div>
       <p><span class="spinner"></span> Ожидаю подтверждения… <span id="ya-timer"></span></p>
       <p class="hint">Пароль не нужен: вы подтверждаете вход на стороне Яндекса. Код живёт ${Math.round(d.expires_in / 60)} мин.</p>`,
    );
    let left = d.expires_in;
    const tick = setInterval(() => { const el = $('#ya-timer'); if (el) el.textContent = `(${left--} с)`; if (left < 0) clearInterval(tick); }, 1000);
    const poll = setInterval(async () => {
      try {
        const r = await api('/api/yandex/device/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_code: d.device_code }),
        });
        if (r.status === 'ok') {
          clearInterval(poll); clearInterval(tick);
          closeModal();
          toast('Яндекс.Музыка подключена ✅', 'ok');
          checkYandex(); renderSources(); renderTabs();
        } else if (r.status === 'error') {
          clearInterval(poll); clearInterval(tick);
          openModal('Ошибка входа', `<p>${esc(r.description || r.error)}</p>`);
        }
      } catch (e) {
        clearInterval(poll); clearInterval(tick);
        toast('Ошибка опроса: ' + e.message, 'err');
      }
    }, Math.max(3, d.interval) * 1000);
  } catch (e) {
    openModal('Ошибка', `<p>${esc(e.message)}</p>`);
  }
}

/* ==================== YouTube: ключ и квота ==================== */
function youtubeCta() {
  return `<div class="empty"><div class="big">▶️</div><h4>YouTube требует API-ключ</h4>
    <p>Google не отдаёт аудиопоток через API — видео играет во встроенном плеере,
    а для поиска нужен ключ YouTube Data API v3. Сам ключ бесплатный.<br /><br />
    Квота: 10 000 units в сутки · поиск = 100 units (~100 поисков) · чарт = 1 unit.<br />
    Ссылку на видео можно вставить прямо в строку поиска — это работает и без ключа.</p>
    <p style="margin-top:18px"><button class="btn-mini" id="yt-cta">Вставить API-ключ</button></p></div>`;
}

async function checkYouTube() {
  try {
    const s = await api('/api/youtube/status');
    state.youtube = s;
    state.ytHasKey = !!s.hasKey;
    updateAccountMini();
    if (state.view === 'settings') renderSettings();
  } catch {}
}

/** Мини-индикатор аккаунтов в сайдбаре: клик открывает настройки. */
function updateAccountMini() {
  const el = $('#acc-mini');
  if (!el) return;
  el.innerHTML =
    `<span class="acc-dot ${state.yandexAuth ? 'on' : ''}" title="Яндекс.Музыка: ${state.yandexAuth ? 'подключено' : 'не подключено'}">Я</span>` +
    `<span class="acc-dot ${state.ytHasKey ? 'on' : ''}" title="YouTube: ${state.ytHasKey ? 'ключ есть' : 'ключа нет'}">YT</span>`;
}

function youtubeKeyDialog() {
  openModal(
    'YouTube Data API v3',
    `<p>1. Откройте <a class="link" style="color:var(--accent-2)" target="_blank" rel="noopener"
       href="https://console.cloud.google.com/apis/library/youtube.googleapis.com">Google Cloud Console</a>
       и включите <b>YouTube Data API v3</b>.<br />
       2. Создайте ключ: <b>Credentials → Create credentials → API key</b>.<br />
       3. Вставьте его сюда — ключ сохранится <b>локально на сервере</b> и уходит только на googleapis.com.</p>
     <input id="yt-key-input" class="modal-input" type="text" spellcheck="false" placeholder="AIzaSy…" />
     <div style="display:flex;gap:8px;margin-top:14px">
       <button class="btn-primary" id="yt-key-save">Сохранить</button>
       ${state.ytHasKey ? '<button class="btn-mini" id="yt-key-del">Удалить ключ</button>' : ''}
     </div>
     <p class="hint">Поиск стоит 100 units из 10 000 в день, музыкальный чарт — 1 unit.
     Результаты кэшируются на 10 минут, поэтому повторные запросы квоту не жгут.</p>`,
  );
  $('#yt-key-input')?.focus();
  $('#yt-key-save')?.addEventListener('click', async () => {
    const key = $('#yt-key-input').value.trim();
    if (!key) return;
    const btn = $('#yt-key-save');
    btn.textContent = 'Проверяю…';
    try {
      const s = await api('/api/youtube/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      toast(`Ключ принят ✅ осталось ≈${s.quota.searchesLeft} поисков на сегодня`, 'ok', 5000);
      closeModal();
      checkYouTube();
      if (state.provider === 'youtube' || state.provider === 'all') home();
    } catch (e) {
      btn.textContent = 'Сохранить';
      toast('Ключ не принят: ' + e.message, 'err', 8000);
    }
  });
  $('#yt-key-del')?.addEventListener('click', async () => {
    await api('/api/youtube/key/clear', { method: 'POST' });
    toast('Ключ YouTube удалён');
    closeModal();
    checkYouTube();
  });
}

/* ==================== Настройки ==================== */
function renderSettings() {
  state.view = 'settings';
  const list = state.providers || [];
  const st = tasteStats(state.taste);
  const tops = topArtists(state.taste, 3);
  const y = state.yandex || {};
  const q = state.youtube?.quota;

  const srcRows = list
    .map((x) => {
      const c = x.capabilities || {};
      const kind =
        c.stream === 'full' ? '<span class="tag full">полный трек</span>'
        : c.stream === 'preview' ? '<span class="tag preview">30 сек</span>'
        : c.stream === 'embed' ? '<span class="tag yt">iframe</span>'
        : '<span class="tag off">без звука</span>';
      const access = x.requiresAuth
        ? x.status?.authorized
          ? '<span class="tag full">подключено</span>'
          : '<span class="tag off">нужен вход</span>'
        : '<span class="tag">ключ не нужен</span>';
      const caps = [c.search && 'поиск', c.trending && 'подборки', c.radio && 'радио'].filter(Boolean).join(' · ');
      return `<tr>
        <td class="nm"><i class="dot" style="background:${x.accent}"></i>${esc(x.name)}</td>
        <td>${kind}</td>
        <td>${access}</td>
        <td class="muted">${esc(x.description || '')}<br /><span style="opacity:.7">${caps}</span></td>
      </tr>`;
    })
    .join('');

  const keys = [
    ['Space', 'Play / пауза'],
    ['← →', '±5 секунд'],
    ['Shift + ← →', 'Предыдущий / следующий'],
    ['↑ ↓', 'Громкость'],
    ['L', 'Текст песни и караоке'],
    ['Q', 'Очередь'],
    ['M', 'Без звука'],
    ['S', 'Перемешивание'],
    ['T', 'Тема оформления'],
    ['R', 'Повтор'],
    ['/', 'Поиск'],
    ['Esc', 'Закрыть панели'],
  ]
    .map(([k, d]) => `<div class="kbd-row"><b>${k}</b><span>${d}</span></div>`)
    .join('');

  $('#content').innerHTML = `
    <div class="section-title">Настройки</div>
    <div class="settings">
      <div class="card">
        <h4><svg viewBox="0 0 24 24"><use href="#i-palette"/></svg>Оформление</h4>
        <p class="desc">Тема применяется сразу и запоминается — при следующем запуске плеер
        откроется в ней же. Клавиша <b>T</b> переключает темы по кругу, а значок палитры у строки
        поиска открывает быстрый выбор. Светлые темы («День», «Бумага») читаются на солнце,
        тёмные — вечером.</p>
        ${themeGalleryHTML()}
      </div>

      <div class="card">
        <h4><svg viewBox="0 0 24 24"><use href="#i-heart"/></svg>Аккаунты и ключи</h4>
        <div class="row-setting">
          <div class="rs-main">
            <div class="rs-title">Яндекс.Музыка</div>
            <div class="rs-sub ${y.authorized ? 'ok' : ''}">${
              y.authorized
                ? '● ' + esc(y.account?.name || y.account?.login || 'подключено') + ' — поиск, «Мне нравится» и полный звук 320 kbps'
                : 'Не подключено. Вход по коду через ya.ru/device — пароль приложению не передаётся.'
            }</div>
          </div>
          <button class="btn-mini" id="set-yandex">${y.authorized ? 'Отключить' : 'Подключить'}</button>
        </div>
        <div class="row-setting">
          <div class="rs-main">
            <div class="rs-title">YouTube</div>
            <div class="rs-sub ${state.ytHasKey ? 'ok' : ''}">${
              state.ytHasKey
                ? `● ключ есть · осталось ≈${q?.searchesLeft ?? 0} поисков сегодня (${q?.used ?? 0} из ${q?.limit ?? 10000} units)`
                : 'Ключа нет — поиск по YouTube выключен. Ссылку на видео можно вставлять в строку поиска и без ключа.'
            }</div>
          </div>
          <button class="btn-mini" id="set-youtube">${state.ytHasKey ? 'Сменить ключ' : 'Вставить ключ'}</button>
        </div>
      </div>

      <div class="card">
        <h4><svg viewBox="0 0 24 24"><use href="#i-radio"/></svg>Источники музыки</h4>
        <p class="desc">Каждый сервис — отдельный плагин в <code>src/providers/</code>. Добавить новый источник = один файл.</p>
        <table class="src-table">${srcRows}</table>
      </div>

      <div class="card">
        <h4><svg viewBox="0 0 24 24"><use href="#i-text"/></svg>Тексты и караоке</h4>
        <div class="row-setting">
          <div class="rs-main">
            <div class="rs-title">Открывать текст автоматически</div>
            <div class="rs-sub">Панель караоке будет появляться сама при старте трека</div>
          </div>
          <button class="toggle ${state.prefs.autoLyrics ? 'on' : ''}" id="set-autolyrics" title="Автокараоке"></button>
        </div>
        <p class="desc">Синхронные тексты с таймкодами даёт <b>LRCLIB</b> — открытый API без ключа.
        Если там пусто, подтягивается простой текст с lyrics.ovh (без подсветки).
        Musixmatch доступен только по платному одобрению, а Genius закрыт Cloudflare и текстов через API не отдаёт.</p>
      </div>

      <div class="card">
        <h4><svg viewBox="0 0 24 24"><use href="#i-dl"/></svg>Данные</h4>
        <div class="row-setting">
          <div class="rs-main">
            <div class="rs-title">Избранное</div>
            <div class="rs-sub">${state.favs.length} треков · хранятся локально в браузере</div>
          </div>
          <button class="btn-mini" id="fav-export">Экспорт</button>
          <button class="btn-mini" id="fav-import">Импорт</button>
          <button class="btn-mini" id="fav-clear">Очистить</button>
          <input type="file" id="fav-file" accept="application/json,.json" hidden />
        </div>
        <div class="row-setting">
          <div class="rs-main">
            <div class="rs-title">Очередь воспроизведения</div>
            <div class="rs-sub">${state.queue.length} треков сейчас в очереди</div>
          </div>
          <button class="btn-mini" id="queue-clear2">Очистить очередь</button>
        </div>
      </div>

      <div class="card">
        <h4><svg viewBox="0 0 24 24"><use href="#i-sparkles"/></svg>Вкусы и рекомендации</h4>
        <p class="desc">Плеер запоминает, что вы слушаете и что пропускаете, и подбирает треки похожего
        артиста и настроения. Всё считается <b>локально</b> и никуда не отправляется.</p>
        <div class="row-setting">
          <div class="rs-main">
            <div class="rs-title">Автоподбор</div>
            <div class="rs-sub">Когда очередь заканчивается, добавляю 12 треков по вкусу вместо тишины</div>
          </div>
          <button class="toggle ${state.prefs.autoplay ? 'on' : ''}" id="set-autoplay"></button>
        </div>
        <div class="row-setting">
          <div class="rs-main">
            <div class="rs-title">Учитывать пропуски</div>
            <div class="rs-sub">Пропущенный в начале трек опускает артиста в рекомендациях</div>
          </div>
          <button class="toggle ${state.prefs.countSkips ? 'on' : ''}" id="set-skips"></button>
        </div>
        <div class="row-setting">
          <div class="rs-main">
            <div class="rs-title">Профиль вкусов</div>
            <div class="rs-sub">${
              st.plays
                ? `${st.plays} прослушиваний · ${st.artists} артистов${st.skips ? ` · ${st.skips} пропусков` : ''}${
                    tops.length ? `<br />Чаще всего: ${tops.map((a) => esc(a.name)).join(', ')}` : ''
                  }`
                : 'Пусто — послушайте пару треков, и подборки заработают'
            }</div>
          </div>
          <button class="btn-mini" id="taste-open">Открыть «Для вас»</button>
          <button class="btn-mini" id="taste-reset">Забыть</button>
        </div>
      </div>

      <div class="card">
        <h4><svg viewBox="0 0 24 24"><use href="#i-queue"/></svg>Горячие клавиши</h4>
        <div class="kbd-grid">${keys}</div>
      </div>

      <div class="card">
        <h4><svg viewBox="0 0 24 24"><use href="#i-gear"/></svg>О программе</h4>
        <p class="desc">MuzPlayer v${VERSION} — локальный плеер поверх публичных API музыкальных сервисов.
        Всё идёт через ваш собственный сервер: токены и ключи не покидают машину.</p>
        <p class="desc">Если интерфейс выглядит старым (нет вкладки «Настройки» или караоке) —
        обновите страницу со сбросом кэша: <b>Ctrl + Shift + R</b>.</p>
        <p class="desc" id="set-health">…</p>
      </div>
    </div>`;

  for (const t of THEMES) {
    $(`#theme-${t.id}`)?.addEventListener('click', () => applyThemeUI(t.id, true));
  }
  $('#set-yandex')?.addEventListener('click', yandexFlow);
  $('#set-autoplay')?.addEventListener('click', (e) => {
    state.prefs.autoplay = !state.prefs.autoplay;
    savePrefs();
    e.currentTarget.classList.toggle('on', state.prefs.autoplay);
    renderQueue();
    toast(state.prefs.autoplay ? 'Автоподбор включён' : 'Автоподбор выключен', '', 2000);
  });
  $('#set-skips')?.addEventListener('click', (e) => {
    state.prefs.countSkips = !state.prefs.countSkips;
    savePrefs();
    e.currentTarget.classList.toggle('on', state.prefs.countSkips);
    toast(state.prefs.countSkips ? 'Пропуски учитываются' : 'Пропуски не учитываются', '', 2000);
  });
  $('#taste-open')?.addEventListener('click', () => switchView('foryou'));
  $('#taste-reset')?.addEventListener('click', () => {
    if (!confirm('Забыть историю прослушиваний?')) return;
    resetTaste(state.taste);
    saveTaste();
    state.candCache = { at: 0, list: [] };
    toast('История очищена');
    renderSettings();
  });
  $('#set-youtube')?.addEventListener('click', youtubeKeyDialog);
  $('#set-autolyrics')?.addEventListener('click', (e) => {
    state.prefs.autoLyrics = !state.prefs.autoLyrics;
    savePrefs();
    e.currentTarget.classList.toggle('on', state.prefs.autoLyrics);
    toast(state.prefs.autoLyrics ? 'Караоке будет открываться само' : 'Автокараоке выключено', '', 2000);
  });
  $('#fav-export')?.addEventListener('click', exportFavs);
  $('#fav-import')?.addEventListener('click', () => $('#fav-file').click());
  $('#fav-file')?.addEventListener('change', importFavs);
  $('#fav-clear')?.addEventListener('click', () => {
    if (!confirm('Удалить все треки из избранного?')) return;
    state.favs = [];
    save('muz:favs', state.favs);
    $('#fav-count').textContent = '0';
    toast('Избранное очищено');
    renderSettings();
  });
  $('#queue-clear2')?.addEventListener('click', () => {
    state.queue = [];
    state.qi = -1;
    renderQueue();
    toast('Очередь очищена');
    renderSettings();
  });

  api('/api/health')
    .then((h) => {
      const el = $('#set-health');
      if (el) el.textContent = `Сервер отвечает. Источников подключено: ${h.providers}. Пользователей не требуется — это локальная установка.`;
    })
    .catch(() => {
      const el = $('#set-health');
      if (el) el.textContent = 'Сервер не отвечает.';
    });
}

function exportFavs() {
  const blob = new Blob([JSON.stringify(state.favs, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'muzplayer-favorites.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Файл с избранным сохранён', 'ok');
}

async function importFavs(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const list = JSON.parse(await file.text());
    if (!Array.isArray(list)) throw new Error('ожидался массив треков');
    const seen = new Set(state.favs.map((f) => f.uid));
    const added = list.filter((t) => t?.uid && !seen.has(t.uid));
    state.favs.push(...added);
    save('muz:favs', state.favs);
    $('#fav-count').textContent = state.favs.length;
    toast(`Добавлено треков: ${added.length}`, 'ok');
    renderSettings();
  } catch (err) {
    toast('Не разобрал файл: ' + err.message, 'err');
  } finally {
    e.target.value = '';
  }
}

/* ==================== Караоке ==================== */
function toggleLyrics() {
  const panel = $('#lyrics-panel');
  if (panel.classList.contains('open')) {
    panel.classList.remove('open');
    return;
  }
  panel.classList.add('open');
  $('#queue-panel').classList.remove('open'); // два дровера одновременно не нужны
  loadLyricsFor(cur());
}

function seekToSeconds(sec) {
  if (state.mode === 'yt') ytDock.seek(sec);
  else if (audio.src) audio.currentTime = sec;
  state.lyrScrollAt = 0; // клик — это не «ручная прокрутка»: строку нужно отцентровать
  syncLyrics(true);
}

async function loadLyricsFor(t) {
  const body = $('#lyr-body');
  if (!t) {
    body.innerHTML = `<div class="empty" style="padding:40px 12px"><div class="big">🎤</div><h4>Ничего не играет</h4><p>Включите трек — текст подгрузится автоматически.</p></div>`;
    state.lyrData = null;
    state.lyrUid = null;
    $('#lyr-src').textContent = '';
    return;
  }
  if (state.lyrUid === t.uid && state.lyrData) {
    renderLyrics();
    return;
  }
  state.lyrUid = t.uid;
  state.lyrData = null;
  state.lyrIdx = -1;
  $('#lyr-src').textContent = '';
  body.innerHTML = `<div class="empty" style="padding:40px 12px"><p><span class="spinner"></span> Ищу текст для «${esc(t.title)}»…</p></div>`;

  const q = new URLSearchParams({
    title: t.title || '',
    artist: t.artist || '',
    album: t.album || '',
    duration: t.duration ? String(Math.round(t.duration)) : '',
  });
  try {
    const d = await api('/api/lyrics?' + q.toString());
    if (state.lyrUid !== t.uid) return; // трек успели переключить
    state.lyrData = d;
    $('#lyr-src').textContent = d.found ? `${d.source}${d.synced ? ' · синхрон' : ' · без тайминга'}` : '';
    renderLyrics();
  } catch (e) {
    body.innerHTML = `<div class="empty" style="padding:30px 12px"><p>${esc(e.message)}</p></div>`;
  }
}

function renderLyrics() {
  const d = state.lyrData;
  const body = $('#lyr-body');
  if (!d) return;
  if (!d.found) {
    body.innerHTML = `<div class="empty" style="padding:40px 12px"><div class="big">🙈</div>
      <h4>Текст не найден</h4><p>${esc(d.reason || '')}</p></div>`;
    return;
  }
  if (d.synced && d.lines.length) {
    body.innerHTML = `<div class="lyr-lines">${d.lines
      .map((l, i) => `<div class="lvl" data-i="${i}" data-t="${l.t}">${esc(l.text)}</div>`)
      .join('')}</div>`;
    body.querySelectorAll('.lvl').forEach((el) =>
      el.addEventListener('click', () => seekToSeconds(Number(el.dataset.t))),
    );
  } else {
    const lines = (d.plain || '')
      .split('\n')
      .map((l) => (l.trim() ? `<p>${esc(l.trim())}</p>` : '<p class="sp"></p>'))
      .join('');
    body.innerHTML =
      `<p class="hint" style="margin:0 0 14px">Для этого трека есть только текст без таймкодов — караоке-подсветка недоступна.</p>` +
      `<div class="lyr-plain">${lines}</div>`;
  }
  state.lyrIdx = -1;
  syncLyrics(true);
}

function syncLyrics(force) {
  const d = state.lyrData;
  if (!d?.synced || !d.lines?.length) return;
  // Без force работаем только когда панель открыта — иначе это лишняя нагрузка
  if (!force && !$('#lyrics-panel').classList.contains('open')) return;
  const t = state.mode === 'yt' ? state.ytCur || 0 : audio.currentTime || 0;
  let idx = -1;
  for (let i = 0; i < d.lines.length; i++) {
    if (d.lines[i].t <= t + 0.12) idx = i;
    else break;
  }
  if (idx === state.lyrIdx && !force) return;
  state.lyrIdx = idx;
  const nodes = $('#lyr-body').querySelectorAll('.lvl');
  if (!nodes.length) return;
  nodes.forEach((n, i) => {
    n.classList.toggle('active', i === idx);
    n.classList.toggle('near', Math.abs(i - idx) === 1);
  });
  const active = nodes[idx];
  const userScrolled = Date.now() - (state.lyrScrollAt || 0) < 4000;
  if (active && !userScrolled) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ==================== Общие помощники UI ==================== */
const openModal = (title, html) => {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').classList.add('open');
};
const closeModal = () => $('#modal').classList.remove('open');

function switchView(v) {
  document.querySelectorAll('.nav-item').forEach((x) => x.classList.toggle('active', x.dataset.view === v));
  // настройки — отдельная «страница»: поиск и табы источников там лишние
  const topbar = $('.topbar');
  if (topbar) topbar.style.display = v === 'settings' ? 'none' : '';
  if (v === 'search') home();
  else if (v === 'trends') { $('#q').value = ''; home(); }
  else if (v === 'radio') loadRadio(state.radioTag);
  else if (v === 'foryou') renderForYou();
  else if (v === 'favorites') renderFavorites();
  else if (v === 'settings') renderSettings();
}

/* ==================== Темы оформления ==================== */

// Тема — это атрибут data-theme на <html>: вся палитра живёт в styles.css.
// Здесь только выбор, запоминание и синхронизация интерфейса выбора.
function applyThemeUI(id, notify = false) {
  const applied = applyThemeTo(document.documentElement, id);
  const changed = state.prefs.theme !== applied;
  state.prefs.theme = applied;
  savePrefs();

  const meta = themeById(applied);
  // Галерея в настройках и карточки в быстром окне — отдельные узлы,
  // поэтому подсветку обновляем в обоих местах.
  for (const t of THEMES) {
    const on = t.id === applied;
    for (const sel of [`#theme-${t.id}`, `#pop-theme-${t.id}`]) {
      const el = $(sel);
      if (el) el.classList.toggle('on', on);
    }
  }
  const btn = $('#btn-theme');
  if (btn) btn.title = `Тема: ${meta.name} — открыть выбор (T)`;

  if (changed) {
    // Короткая переливка: смена палитры не должна выглядеть как рывок.
    const root = document.body || document.documentElement;
    if (root?.classList) {
      root.classList.add('theme-swap');
      setTimeout(() => root.classList.remove('theme-swap'), 420);
    }
    if (notify) toast(`Тема: ${meta.name}`, 'ok', 1800);
  }
  renderThemePop();
  return applied;
}

const themeCardHTML = (t, prefix) => `<button class="theme-card" id="${prefix}-${t.id}" data-theme-id="${t.id}"
    title="${esc(t.name)} — ${esc(t.hint)}">
    <span class="theme-preview" style="background-image:${swatchGradient(t)}">
      <i class="tp-bar"></i><i class="tp-dot"></i>
    </span>
    <span class="tc-text"><b>${esc(t.name)}</b><small>${esc(t.hint)}</small></span>
    <svg class="tc-check" viewBox="0 0 24 24"><use href="#i-check"/></svg>
  </button>`;

function themeGalleryHTML() {
  const cur = normalizeTheme(state.prefs.theme);
  return `<div class="theme-grid">${THEMES.map((t) => themeCardHTML(t, 'theme').replace(
    'class="theme-card"',
    `class="theme-card${t.id === cur ? ' on' : ''}"`,
  )).join('')}</div>`;
}

// Быстрое окно у строки поиска: чтобы менять тему в один клик, не уходя в настройки.
function renderThemePop() {
  const host = $('#theme-pop');
  if (!host) return;
  const cur = normalizeTheme(state.prefs.theme);
  host.innerHTML = `
    <div class="pop-head">Тема оформления <span class="pop-hint">клавиша T</span></div>
    <div class="theme-grid compact">${THEMES.map((t) => themeCardHTML(t, 'pop-theme').replace(
      'class="theme-card"',
      `class="theme-card${t.id === cur ? ' on' : ''}"`,
    )).join('')}</div>`;
}

function toggleThemePop(force) {
  const host = $('#theme-pop');
  if (!host) return;
  renderThemePop();
  const open = force === undefined ? !host.classList.contains('open') : !!force;
  host.classList.toggle('open', open);
}

function bindThemeControls() {
  $('#btn-theme')?.addEventListener('click', (e) => { e.stopPropagation(); toggleThemePop(); });
  // Карточки живут в перерисовываемых блоках, поэтому вешаем обработчики
  // на конкретные id (их создаёт тема) — так надёжнее делегирования по классу.
  for (const t of THEMES) {
    for (const sel of [`#theme-${t.id}`, `#pop-theme-${t.id}`]) {
      $(sel)?.addEventListener('click', () => {
        applyThemeUI(t.id, true);
        toggleThemePop(false);
      });
    }
  }
  applyThemeUI(state.prefs.theme);   // тема из настроек → в палитру и в подсветку
  renderThemePop();
}

/* ==================== «Для вас»: подборки по вкусу ==================== */

async function renderForYou() {
  state.view = 'foryou';
  const st = tasteStats(state.taste);
  const recent = recentTracks(state.taste, 10).filter((t) => t.playable !== false && t.id);
  const artists = topArtists(state.taste, 8);

  const artistChips = artists.length
    ? `<div class="section-title">Ваши артисты</div>
       <div class="genre-chips">${artists
         .map((a) => `<button class="chip" data-artist="${esc(a.name)}">${esc(a.name)} <i style="opacity:.55;font-style:normal">${a.plays}▶</i></button>`)
         .join('')}</div>`
    : '';

  const recentBlock = recent.length
    ? `<div class="section-title">Продолжить слушать</div>${rowsHTML(recent, 0)}`
    : '';

  $('#content').innerHTML = `
    <div class="section-title">Для вас</div>
    <div class="foryou-head">
      <span>Профиль: <b>${st.plays}</b> прослушиваний · <b>${st.artists}</b> артистов${st.skips ? ` · пропущено ${st.skips}` : ''}</span>
      <span>
        <button class="btn-mini" id="fy-refresh">Обновить подборку</button>
        <button class="btn-mini" id="fy-reset">Забыть историю</button>
      </span>
    </div>
    ${
      st.plays < 2
        ? `<div class="empty" style="padding:34px 16px"><div class="big">🌱</div><h4>Профиль пока пустой</h4>
             <p>Включите несколько треков — я запомню артистов и вкусы, а потом начну подбирать сам.<br />
             Пропущенные треки тоже учитываются: они опускают артиста вниз.</p></div>`
        : ''
    }
    <div class="section-title">Подобрано для вас</div>
    <div id="fy-picks" class="rows">${'<div class="row sk"><div class="num"></div><div class="ph-art"></div><div></div><div></div><div></div></div>'.repeat(4)}</div>
    ${recentBlock}
    ${artistChips}`;

  $('#fy-refresh')?.addEventListener('click', () => renderForYou());
  $('#fy-reset')?.addEventListener('click', () => {
    if (!confirm('Забыть историю прослушиваний? Подборки начнутся с нуля.')) return;
    resetTaste(state.taste);
    saveTaste();
    state.candCache = { at: 0, list: [] };
    toast('История очищена');
    renderForYou();
  });
  $('#content').querySelectorAll('.chip[data-artist]').forEach((c) =>
    c.addEventListener('click', () => {
      $('#q').value = c.dataset.artist;
      switchView('search');
      doSearch(c.dataset.artist);
    }),
  );
  wireRows();

  renderRecommendations();
}

/** Подборка подгружается отдельно: сначала показываем скелетон, потом список. */
async function renderRecommendations() {
  const host = $('#fy-picks');
  if (!host) return;
  let picks = [];
  try {
    picks = await buildRecommendations(14);
  } catch (e) {
    host.innerHTML = `<div class="empty" style="padding:24px 12px"><p>Не удалось собрать подборку: ${esc(e.message)}</p></div>`;
    return;
  }
  state.tracks = picks;
  host.innerHTML = picks.length
    ? rowsHTML(picks, 0)
    : `<div class="empty" style="padding:24px 12px"><div class="big">🎧</div><h4>Пока нечего предложить</h4>
         <p>Источники не отдали подходящих треков. Послушайте что-нибудь и обновите подборку.</p></div>`;
  wireRows();
}

/* ==================== Старт ==================== */
// Караоке-подсветка: у <audio> есть timeupdate, но у YouTube время приходит из
// IFrame-плеера, поэтому дополнительно тикаем таймером ~4,5 раза в секунду.
setInterval(() => {
  if ($('#lyrics-panel').classList.contains('open')) syncLyrics();
}, 220);

$('#acc-mini').addEventListener('click', () => switchView('settings'));
// Тему подставил ещё скрипт в index.html — здесь приводим к ней интерфейс выбора
// и заодно переносим значение из localStorage в состояние приложения.
bindThemeControls();
$('#btn-lyrics').addEventListener('click', toggleLyrics);
$('#lyrics-close').addEventListener('click', () => $('#lyrics-panel').classList.remove('open'));
$('#fav-count').textContent = state.favs.length;
audio.volume = 0.8;
// .catch — обязателен: async-функция превращает падение в отклонённый промис,
// без этого «плеер молча мёртв».
init().catch((e) => showFatal('Сбой запуска: ' + (e && e.message ? e.message : e)));

// Экспорт для отладки из консоли
window.MuzPlayer = {
  state, audio, playFromList, doSearch, toggleLyrics, renderSettings, switchView,
  loadLyricsFor, syncLyrics, step, autoExtend, buildRecommendations, recordPlay, recordSkip,
  // темы: список, применение и открытие быстрого выбора — для проверок в браузере
  themes: THEMES, applyTheme: applyThemeUI, toggleThemePop,
};
