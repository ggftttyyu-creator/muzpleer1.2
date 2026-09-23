// Тесты системы тем: `npm test`
//
// Темы — это данные (public/theme.js) + палитры (public/styles.css). Тест
// сверяет их между собой и не даёт теме «отстать»: новая тема без полного
// набора переменных, нечитаемый контраст или забытый жёстко зашитый цвет
// в правилах — сразу красный тест, а не сюрприз в интерфейсе.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  THEMES, THEME_IDS, DEFAULT_THEME, isTheme, normalizeTheme,
  themeById, nextTheme, applyThemeTo, swatchGradient,
} from '../public/theme.js';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// Все переменные, которые обязана определить каждая тема. Если правило
// использует var(--x), а тема его не задала — элемент «отвалится» от темы.
const REQUIRED = [
  'bg', 'glow-1', 'glow-2', 'glow-3', 'tint', 'shade', 'panel', 'panel-2',
  'line', 'line-2', 'text', 'text-2', 'muted', 'accent', 'accent-2',
  'accent-rgb', 'accent-2-rgb', 'accent-soft', 'accent-ink', 'accent-grad',
  'ok', 'ok-rgb', 'warn', 'warn-rgb', 'bad', 'bad-rgb', 'fav',
  'glass', 'modal-bg', 'toast-bg', 'backdrop', 'radius', 'shadow',
];

/** Разбираем styles.css на блоки тем: { id → { переменная: значение } } */
function parseThemes(source) {
  const out = new Map();
  const re = /:root(?:\[data-theme="([^"]+)"\])?\s*\{([\s\S]*?)\n\}/g;
  for (const m of source.matchAll(re)) {
    const id = m[1] || DEFAULT_THEME; // базовый :root — это тема по умолчанию
    const tokens = {};
    for (const t of m[2].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens[t[1]] = t[2].trim();
    if (out.has(id)) out.set(id, { ...out.get(id), ...tokens });
    else out.set(id, tokens);
  }
  return out;
}

const parsed = parseThemes(css);
const hex = (h) => {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const luminance = (rgb) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
/** Контраст по WCAG 2.1 */
function contrast(a, b) {
  const [l1, l2] = [luminance(hex(a)), luminance(hex(b))].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

test('темы: у каждой записи из theme.js есть CSS-блок', () => {
  for (const t of THEMES) {
    assert.ok(parsed.has(t.id), `нет блока :root[data-theme="${t.id}"] в styles.css`);
  }
  assert.equal(parsed.size, THEMES.length, 'в CSS лишние темы, которых нет в списке');
});

test('темы: у каждой заполнен полный набор переменных', () => {
  for (const t of THEMES) {
    const tokens = parsed.get(t.id);
    const missing = REQUIRED.filter((k) => !(k in tokens));
    assert.deepEqual(missing, [], `тема «${t.name}» не задаёт: ${missing.join(', ')}`);
  }
});

test('темы: тексты и акценты читаемы (WCAG)', () => {
  for (const t of THEMES) {
    const k = parsed.get(t.id);
    assert.ok(contrast(k.text, k.bg) >= 8, `«${t.name}»: основной текст на фоне ${contrast(k.text, k.bg).toFixed(1)} < 8`);
    assert.ok(contrast(k.muted, k.bg) >= 4.5, `«${t.name}»: приглушённый текст ${contrast(k.muted, k.bg).toFixed(1)} < 4.5`);
    assert.ok(contrast(k.accent, k.bg) >= 3, `«${t.name}»: акцент на фоне ${contrast(k.accent, k.bg).toFixed(1)} < 3`);
    assert.ok(contrast(k['accent-ink'], k.accent) >= 4.5, `«${t.name}»: подпись на акценте ${contrast(k['accent-ink'], k.accent).toFixed(1)} < 4.5`);
    assert.ok(contrast(k['text-2'], k.bg) >= 5, `«${t.name}»: вторичный текст слишком бледный`);
  }
});

test('темы: образцы в интерфейсе взяты из самой палитры', () => {
  for (const t of THEMES) {
    const body = css.slice(css.indexOf(`[data-theme="${t.id}"]`));
    const block = body.slice(0, body.indexOf('\n}'));
    for (const color of t.swatch) {
      assert.ok(block.includes(color), `образец ${color} темы «${t.name}» не встречается в её палитре`);
    }
  }
});

test('темы: сгруппированы по светлоте, есть и тёмные, и светлые', () => {
  for (const t of THEMES) {
    const k = parsed.get(t.id);
    const dark = luminance(hex(k.bg)) < 0.2;
    assert.equal(Boolean(t.dark), dark, `тема «${t.name}»: флаг dark не совпадает с фоном`);
  }
  assert.ok(THEMES.some((t) => t.dark) && THEMES.some((t) => !t.dark), 'нужны и тёмные, и светлые темы');
});

test('темы: в правилах не осталось жёстко зашитых цветов', () => {
  // Кроме белого (текст на градиенте), чёрного (кадр видео) и красного бренда YouTube.
  const rules = css.replace(/:root[^\{]*\{[\s\S]*?\n\}/g, '');
  const literals = [...rules.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba\([^)]*\)/g)]
    .map((m) => m[0])
    .filter((c) => !['#fff', '#000', '#ff0000'].includes(c));
  assert.deepEqual(literals, [], 'цвет не из темы: ' + literals.join(', '));
});

test('темы: выбор применяется и запоминается', () => {
  assert.equal(isTheme('neon'), true);
  assert.equal(isTheme('нет-такой'), false);
  assert.equal(normalizeTheme('мусор'), DEFAULT_THEME, 'мусор из localStorage не должен ломать вид');
  assert.equal(normalizeTheme(null), DEFAULT_THEME);

  const root = { attr: null, setAttribute(k, v) { this.attr = { [k]: v }; } };
  assert.equal(applyThemeTo(root, 'day'), 'day');
  assert.equal(root.attr['data-theme'], 'day');
  assert.equal(applyThemeTo(root, 'взлом'), DEFAULT_THEME, 'несуществующая тема → запасная');
  assert.equal(root.attr['data-theme'], DEFAULT_THEME);
});

test('темы: переключение клавишей идёт по кругу и возвращается в начало', () => {
  let id = THEME_IDS[0];
  const seen = new Set([id]);
  for (let i = 0; i < THEME_IDS.length - 1; i++) { id = nextTheme(id); seen.add(id); }
  assert.equal(seen.size, THEME_IDS.length, 'за круг должны быть все темы без повторов');
  assert.equal(nextTheme(id), THEME_IDS[0], 'после последней темы снова первая');
  assert.equal(nextTheme(THEME_IDS[0], -1), THEME_IDS[THEME_IDS.length - 1], 'назад — через конец списка');
  assert.equal(themeById('sunset').name, 'Закат');
  assert.ok(swatchGradient({ id: 'paper' }).includes('#0f766e'), 'образец строится из палитры темы');
});

test('темы: применяются до первой отрисовки (без мигания чужой палитрой)', () => {
  const boot = html.indexOf("dataset.theme");
  const styles = html.indexOf('styles.css');
  const app = html.indexOf('/app.js');
  assert.ok(boot > -1, 'в index.html нет ранней подстановки темы');
  assert.ok(boot < styles, 'тема должна подставляться до подключения стилей');
  assert.ok(boot < app, 'и до сценария приложения');
  assert.ok(appJs.includes("from './theme.js'"), 'app.js должен использовать общий модуль тем');
  assert.ok(/prefs\.theme|theme\b/.test(appJs), 'app.js должен хранить выбранную тему');
});
