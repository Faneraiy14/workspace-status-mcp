// write-doc.js — записує один файл документації репо і поруч
// закарбовує commit-хеш репозиторія на момент запису ({commitHash, writtenAt}).
// Типово: <repo>/.arch/<file> + <repo>/.arch/.meta.json (див. arch.js);
// з явним docsRoot - стара схема <docsRoot>/<repo>.txt + <docsRoot>/.meta/<repo>.json.
//
// Навіщо: check_docs раніше вмів звіряти лише "mtime файлу документації
// проти часу останнього коміту" - робочий, але грубий сигнал (torn між
// "хтось торкнувся файлу" і "документація й досі описує поточний код").
// Коли документ написано через цей інструмент, checkDocs() може замість
// цього порахувати РЕАЛЬНУ кількість комітів між збереженим хешем і HEAD
// (git rev-list --count) - той самий патерн, що вже виправдав себе в
// check_release_drift для дрейфу джерело->реліз.
//
// Сам текст документації інструмент не генерує (розуміння коду для
// документування - завдання AI/людини) - лише приймає готовий текст і
// відповідально прив'язує його до конкретного коміту.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { run } from './sweep.js';
import { locate, checkFileName, DEFAULT_FILE } from './arch.js';

/**
 * @param {object} opts
 * @param {string} opts.projectsRoot - корінь із репозиторіями (типово ~/Projects)
 * @param {string} opts.repo - назва теки репозиторія (напр. "anylint")
 * @param {string} opts.content - текст документації (весь файл при mode:'replace', лише новий шматок при mode:'append')
 * @param {string} [opts.file] - файл у <repo>/.arch/ (типово "README.txt"; датовані записи - "changelog.txt"). Ігнорується для docsRoot-схеми
 * @param {string} [opts.docsRoot] - стара центральна тека з <repo>.txt; якщо не задано - <repo>/.arch/
 * @param {'replace'|'append'} [opts.mode] - типово 'replace' (весь файл). 'append' дописує
 *   content ПІСЛЯ вже наявного вмісту (один порожній рядок-роздільник) - для одного
 *   нового датованого запису НЕ треба перечитувати й пересилати весь файл заново.
 */
export async function writeDoc({ projectsRoot, repo, content, file, docsRoot, mode = 'replace' } = {}) {
    if (!projectsRoot) throw new Error('projectsRoot обов\'язковий (напр. "/home/sviat/Projects")');
    if (!repo) throw new Error('repo обов\'язковий (напр. "anylint")');
    if (!/^[\w.\-`]+$/.test(repo) || repo.startsWith('.')) throw new Error('repo: лише назва теки, без шляху');
    if (typeof content !== 'string' || content.trim() === '') throw new Error('content не може бути порожнім');
    if (mode !== 'replace' && mode !== 'append') throw new Error('mode має бути "replace" чи "append"');

    const loc = locate({ projectsRoot, docsRoot, repo });
    const fileName = loc.layout === 'central' ? loc.centralFile : checkFileName(file || DEFAULT_FILE);
    const docPath = join(loc.dir, fileName);

    const head = await run('git', ['rev-parse', 'HEAD'], loc.repoPath);
    if (!head.ok) {
        throw new Error(`Не вдалося визначити HEAD у ${loc.repoPath}: ${head.error}`);
    }

    let finalContent = content;
    if (mode === 'append') {
        // Немає файлу ще - поводимось як звичайний перший запис (без
        // зайвого порожнього рядка на початку). Є - один порожній рядок
        // між старим і новим, незалежно від того, скільки завершальних
        // переносів рядка вже було в старому вмісті.
        let existing = '';
        try {
            existing = await readFile(docPath, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        finalContent = existing.trim() === '' ? content : `${existing.replace(/\s+$/, '')}\n\n${content}`;
    }

    await mkdir(loc.dir, { recursive: true });
    await writeFile(docPath, finalContent, 'utf8');

    const meta = { commitHash: head.stdout, writtenAt: Math.floor(Date.now() / 1000) };
    await mkdir(dirname(loc.metaFile), { recursive: true });
    await writeFile(loc.metaFile, JSON.stringify(meta, null, 2), 'utf8');

    return { docPath, metaPath: loc.metaFile, commitHash: meta.commitHash, writtenAt: new Date(meta.writtenAt * 1000).toISOString() };
}
