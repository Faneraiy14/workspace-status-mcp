import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOutline, readDoc } from '../src/read-doc.js';

const DOC = [
  'Проєкт', '=======', '', 'Вступ про проєкт.', '',
  'Тех. стек', '---------', 'Node і zod.', '',
  'АРХІТЕКТУРА', 'Файл a.js робить A.', 'Файл b.js робить B — унікальнеслово.', '',
  '## 24.09.2026 — Інсталятор', 'Рядок 1 інсталятора.', 'Рядок 2 інсталятора.', '',
  '07.10.2026 - Етап 1: зроблено щось.', 'Продовження етапу.', 'У тексті згадка 15.09.2026) не є заголовком.',
  '',
  'ДОДАНО (08.10.2026): ще одне', 'Тіло додавання.',
].join('\n');

function mkDocs() {
  const root = mkdtempSync(join(tmpdir(), 'rd-'));
  mkdirSync(join(root, 'demo', '.arch'), { recursive: true });
  writeFileSync(join(root, 'demo', '.arch', 'README.txt'), DOC);
  return root;
}

test('parseOutline впізнає всі 4 види заголовків і не плутає згадку дати', () => {
  const t = parseOutline(DOC).map(s => `${s.kind}:${s.title}`);
  assert.deepEqual(t, [
    'underline:Проєкт', 'underline:Тех. стек', 'caps:АРХІТЕКТУРА', 'markdown:24.09.2026 — Інсталятор',
    'dated:07.10.2026 - Етап 1: зроблено щось.', 'dated:ДОДАНО (08.10.2026): ще одне',
  ]);
});

test('зміст, розділ за номером і за фрагментом, офсет', async () => {
  const root = mkDocs();
  const toc = await readDoc({ projectsRoot: root, repo: 'demo' });
  assert.match(toc.text, /6 розділів/);
  const byNum = await readDoc({ projectsRoot: root, repo: 'demo', section: 3 });
  assert.match(byNum.text, /унікальнеслово/);
  assert.ok(!byNum.text.includes('Інсталятор'));
  const byName = await readDoc({ projectsRoot: root, repo: 'demo', section: 'інсталятор' });
  assert.match(byName.text, /Рядок 2 інсталятора/);
  // обрізання + продовження
  const a = await readDoc({ projectsRoot: root, repo: 'demo', section: 4, max_chars: 500 });
  assert.ok(!a.text.includes('обрізано'));
});

test('обрізання довгого розділу і offset', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rd-'));
  mkdirSync(join(root, 'big', '.arch'), { recursive: true });
  writeFileSync(join(root, 'big', '.arch', 'README.txt'), 'Назва\n=====\n' + 'слово '.repeat(400));
  const a = await readDoc({ projectsRoot: root, repo: 'big', section: 1, max_chars: 500 });
  assert.match(a.text, /обрізано, лишилось \d+ символів: повтори з offset=\d+/);
  const off = Number(a.text.match(/offset=(\d+)/)[1]);
  const b = await readDoc({ projectsRoot: root, repo: 'big', section: 1, max_chars: 5000, offset: off });
  assert.ok(!b.text.includes('обрізано'));
});

test('query: збіги з контекстом і назвою розділу; нема збігів', async () => {
  const root = mkDocs();
  const q = await readDoc({ projectsRoot: root, repo: 'demo', query: 'УНІКАЛЬНЕСЛОВО' });
  assert.match(q.text, /1 збігів/);
  assert.match(q.text, /АРХІТЕКТУРА/);
  assert.match((await readDoc({ projectsRoot: root, repo: 'demo', query: 'нема такого' })).text, /Нічого не знайдено/);
});

test('помилки: нема документа, неіснуючий розділ, небезпечне імʼя repo', async () => {
  const root = mkDocs();
  assert.equal((await readDoc({ projectsRoot: root, repo: 'нема' }).catch(e => ({ ok: false, text: e.message }))).ok, false);
  const bad = await readDoc({ projectsRoot: root, repo: 'demo', section: 'zzz' });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /Зміст/);
  await assert.rejects(readDoc({ projectsRoot: root, repo: '../etc/passwd' }), /repo:/);
});

test('кілька файлів у .arch/: перелік, file=, query по всіх, захист імені файлу', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rd-'));
  const arch = join(root, 'multi', '.arch');
  mkdirSync(arch, { recursive: true });
  writeFileSync(join(arch, 'README.txt'), 'Огляд\n=====\nКоротко про проєкт.');
  writeFileSync(join(arch, 'kernel.txt'), 'Ядро\n====\nПереривання і спільнеслово.');
  writeFileSync(join(arch, 'changelog.txt'), '27.10.2026 — зроблено\nспільнеслово в журналі.');
  writeFileSync(join(arch, '.meta.json'), '{}');
  const toc = await readDoc({ projectsRoot: root, repo: 'multi' });
  assert.match(toc.text, /3 файлів/);
  assert.ok(toc.text.indexOf('README.txt') < toc.text.indexOf('kernel.txt'));
  assert.ok(toc.text.indexOf('kernel.txt') < toc.text.indexOf('changelog.txt'), 'changelog останнім');
  assert.ok(!toc.text.includes('.meta.json'));
  const k = await readDoc({ projectsRoot: root, repo: 'multi', file: 'kernel.txt', section: 1 });
  assert.match(k.text, /Переривання/);
  const q = await readDoc({ projectsRoot: root, repo: 'multi', query: 'спільнеслово' });
  assert.match(q.text, /2 збігів/);
  assert.match(q.text, /kernel\.txt/);
  assert.match(q.text, /changelog\.txt/);
  const nope = await readDoc({ projectsRoot: root, repo: 'multi', file: 'nope.txt' });
  assert.equal(nope.ok, false);
  await assert.rejects(readDoc({ projectsRoot: root, repo: 'multi', file: '../../etc/passwd' }), /file:/);
  await assert.rejects(readDoc({ projectsRoot: root, repo: 'multi', file: '.meta.json' }), /file:/);
});

test('стара схема: явний docsRoot читає <docsRoot>/<repo>.txt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rd-'));
  mkdirSync(join(root, 'Architecture'));
  writeFileSync(join(root, 'Architecture', 'old.txt'), DOC);
  const toc = await readDoc({ projectsRoot: root, repo: 'old', docsRoot: join(root, 'Architecture') });
  assert.match(toc.text, /6 розділів/);
});

test('реальні великі доки: NyxOS має кілька файлів у .arch/, розділ коротший за файл', async () => {
  const { existsSync } = await import('node:fs');
  const root = join(process.env.HOME, 'Projects');
  if (!existsSync(join(root, 'NyxOS', '.arch', 'README.txt'))) return;
  const toc = await readDoc({ projectsRoot: root, repo: 'NyxOS' });
  assert.ok(toc.text.length < 12000, `зміст завеликий: ${toc.text.length}`);
  const part = await readDoc({ projectsRoot: root, repo: 'NyxOS', section: 1, max_chars: 3000 });
  assert.ok(part.text.length < 3400);
});

test('parseOutline: рамки записів --- / === / == / [РРРР-ММ-ДД] теж розділи', () => {
  const t = ['--- Перший запис', '    (15.09.2026) ---', 'текст', '=== 10.10.2026 — другий ===', 'x',
    '== Третій ==', 'y', '[2026-10-14] Четвертий', 'z', '--- однорядкова рамка без закриття'].join('\n');
  assert.deepEqual(parseOutline(t).map(s => s.title), ['Перший запис (15.09.2026)', '10.10.2026 — другий', 'Третій', '[2026-10-14] Четвертий', 'однорядкова рамка без закриття']);
});
