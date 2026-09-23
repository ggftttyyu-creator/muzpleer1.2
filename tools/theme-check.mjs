// Живая проверка тем оформления: настоящий Chrome, настоящая таблица стилей.
//
// Зачем отдельно от `npm test`: тесты сверяют палитры, разбирая CSS текстом.
// Здесь браузер сам считает итоговые значения (что реально попало в элементы),
// проверяет контраст по WCAG и — главное — что выбранная тема переживает
// перезагрузку страницы и применяется до первой отрисовки.
//
// Запуск:  npm start  →  npm run themes

import { writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { BASE, findChrome, ensureServer, runChrome } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const SEED_THEME = 'sunset'; // не тема по умолчанию — иначе проверка ничего не докажет

const HARNESS = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="/styles.css" />
<script type="module">
  import { THEMES } from '/theme.js';

  const root = document.documentElement;
  const read = (n) => getComputedStyle(root).getPropertyValue(n).trim();
  // Hex → три канала. В CSS темы цвета заданы как #rrggbb, поэтому обычный
  // разбор «первых чисел» из строки здесь не годится.
  const rgb = (c) => {
    const h = String(c).replace('#', '').trim();
    const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const lum = ([r, g, b]) => {
    const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
  };

  const rows = [];
  for (const t of THEMES) {
    root.setAttribute('data-theme', t.id);
    const cs = getComputedStyle(root);          // пересчёт стилей после смены атрибута
    const bg = read('--bg'), text = read('--text'), muted = read('--muted');
    const accent = read('--accent'), ink = read('--accent-ink');
    rows.push({
      id: t.id, name: t.name, dark: t.dark,
      bg, text, accent, scheme: cs.colorScheme.trim(),
      bgImage: getComputedStyle(document.body).backgroundImage.slice(0, 40),
      c: { text: ratio(text, bg), muted: ratio(muted, bg), accent: ratio(accent, bg), ink: ratio(ink, accent) },
    });
  }

  // Возвращаем тему по умолчанию, но в хранилище кладём «закат»: следующая
  // страница (index.html) должна открыться уже в нём — это проверка запоминания.
  root.setAttribute('data-theme', THEMES[0].id);
  localStorage.setItem('muz:prefs', JSON.stringify({ theme: '${SEED_THEME}' }));
  document.body.textContent = 'REPORT' + JSON.stringify(rows) + 'END';
</script>
</head><body></body></html>`;

let failed = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) console.log('  ✓ ' + msg);
  else { failed++; console.log('  ✗ ' + msg + (extra !== '' ? `  (${extra})` : '')); }
};

if (!(await ensureServer())) process.exit(1);
const chrome = await findChrome();
if (!chrome) { console.log('Chrome не найден — проверка тем пропущена.'); process.exit(1); }

const pagePath = path.join(pub, '__themes.html');
await writeFile(pagePath, HARNESS, 'utf8');
const profile = await mkdtemp(path.join(os.tmpdir(), 'muz-themes-'));

try {
  console.log('Считаю палитры и контраст в браузере…\n');
  const dom = await runChrome(chrome, { url: `${BASE}/__themes.html`, budgetMs: 8000, tag: 'themes', profileDir: profile });
  const m = dom.match(/REPORT(\[[\s\S]*?\])END/);
  if (!m) {
    console.log('✗ тема не отчиталась из браузера — проверьте консоль страницы');
    process.exit(1);
  }
  const rows = JSON.parse(m[1]);

  console.log('  тема        фон        текст     приглуш.  акцент    режим');
  for (const r of rows) {
    console.log(
      '  ' + r.name.padEnd(11) +
      r.bg.padEnd(11) +
      String(r.c.text).padStart(5) + '×' +
      String(r.c.muted).padStart(6) + '×' +
      String(r.c.accent).padStart(6) + '×   ' +
      (r.scheme || '—'),
    );
  }
  console.log('');

  ok(rows.length >= 6, 'все темы отдают палитру', `${rows.length} шт.`);
  for (const r of rows) {
    ok(r.c.text >= 8, `«${r.name}»: основной текст читается (${r.c.text}× на фоне)`);
    ok(r.c.muted >= 4.5, `«${r.name}»: подписи читаются (${r.c.muted}×)`);
    ok(r.c.accent >= 3, `«${r.name}»: акцент заметен (${r.c.accent}×)`);
    ok(r.c.ink >= 4.5, `«${r.name}»: текст на акцентной кнопке читается (${r.c.ink}×)`);
    ok(r.scheme === (r.dark ? 'dark' : 'light'),
      `«${r.name}»: системные элементы (полосы прокрутки, поля) в ${r.dark ? 'тёмном' : 'светлом'} режиме`,
      r.scheme);
    ok(r.bgImage.includes('gradient'), `«${r.name}»: у темы своё свечение фона`);
  }
  const bgs = new Set(rows.map((r) => r.bg));
  ok(bgs.size === rows.length, 'фоны тем не повторяются', `${bgs.size} из ${rows.length}`);

  // Главная проверка: выбор темы переживает перезагрузку и применяется до отрисовки
  console.log('\nПерезагружаю плеер с сохранённой темой…');
  const home = await runChrome(chrome, { url: `${BASE}/`, budgetMs: 9000, tag: 'home', profileDir: profile });
  ok(/<html[^>]*data-theme="sunset"/.test(home),
    `после перезагрузки применилась сохранённая тема «${SEED_THEME}» до первой отрисовки`);
  ok(!/<html[^>]*data-theme="aurora"/.test(home), 'тема по умолчанию не мелькает вместо сохранённой');
  ok(home.includes('id="btn-theme"'), 'кнопка выбора темы есть на странице');
} finally {
  await unlink(pagePath).catch(() => {});
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log('');
if (failed) {
  console.log(`ПРОВАЛ: ${failed} проверок не прошло.`);
  process.exit(1);
}
console.log('ТЕМЫ РАБОТАЮТ: палитры, контраст и запоминание выбора в порядке.');
