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
  mkdirSync(join(root, 'Architecture'));
  writeFileSync(join(root, 'Architecture', 'demo.txt'), DOC);
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
  mkdirSync(join(root, 'Architecture'));
  writeFileSync(join(root, 'Architecture', 'big.txt'), 'Назва\n=====\n' + 'слово '.repeat(400));
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

test('реальні великі доки: NyxOS/NyxilumLang мають зміст і розділ коротший за файл', async () => {
  const { existsSync, statSync } = await import('node:fs');
  const root = join(process.env.HOME, 'Projects');
  if (!existsSync(join(root, 'Architecture', 'NyxOS.txt'))) return;
  const toc = await readDoc({ projectsRoot: root, repo: 'NyxOS' });
  assert.ok(toc.text.length < 12000, `зміст завеликий: ${toc.text.length}`);
  const size = statSync(join(root, 'Architecture', 'NyxOS.txt')).size;
  const part = await readDoc({ projectsRoot: root, repo: 'NyxOS', section: 3, max_chars: 3000 });
  assert.ok(part.text.length < 3400 && part.text.length < size / 20);
});
