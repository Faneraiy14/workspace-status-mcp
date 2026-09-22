// write-doc.js — записує ~/Projects/Architecture/<repo>.txt і поруч
// закарбовує commit-хеш репозиторія на момент запису
// (Architecture/.meta/<repo>.json: {commitHash, writtenAt}).
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
import { join } from 'node:path';
import { run } from './sweep.js';

export function metaPath(docsRoot, repo) {
    return join(docsRoot, '.meta', `${repo}.json`);
}

/**
 * @param {object} opts
 * @param {string} opts.projectsRoot - корінь із репозиторіями (типово ~/Projects)
 * @param {string} opts.repo - назва теки репозиторія (напр. "anylint")
 * @param {string} opts.content - текст документації (весь файл при mode:'replace', лише новий шматок при mode:'append')
 * @param {string} [opts.docsRoot] - тека з .txt-документацією (типово "<projectsRoot>/Architecture")
 * @param {'replace'|'append'} [opts.mode] - типово 'replace' (весь файл). 'append' дописує
 *   content ПІСЛЯ вже наявного вмісту (один порожній рядок-роздільник) - для одного
 *   нового датованого запису НЕ треба перечитувати й пересилати весь файл заново.
 */
export async function writeDoc({ projectsRoot, repo, content, docsRoot, mode = 'replace' } = {}) {
    if (!projectsRoot) throw new Error('projectsRoot обов\'язковий (напр. "/home/sviat/Projects")');
    if (!repo) throw new Error('repo обов\'язковий (напр. "anylint")');
    if (typeof content !== 'string' || content.trim() === '') throw new Error('content не може бути порожнім');
    if (mode !== 'replace' && mode !== 'append') throw new Error('mode має бути "replace" чи "append"');

    const resolvedDocsRoot = docsRoot || join(projectsRoot, 'Architecture');
    const repoPath = join(projectsRoot, repo);
    const docPath = join(resolvedDocsRoot, `${repo}.txt`);

    const head = await run('git', ['rev-parse', 'HEAD'], repoPath);
    if (!head.ok) {
        throw new Error(`Не вдалося визначити HEAD у ${repoPath}: ${head.error}`);
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

    await mkdir(resolvedDocsRoot, { recursive: true });
    await writeFile(docPath, finalContent, 'utf8');

    const meta = { commitHash: head.stdout, writtenAt: Math.floor(Date.now() / 1000) };
    const resolvedMetaPath = metaPath(resolvedDocsRoot, repo);
    await mkdir(join(resolvedDocsRoot, '.meta'), { recursive: true });
    await writeFile(resolvedMetaPath, JSON.stringify(meta, null, 2), 'utf8');

    return { docPath, metaPath: resolvedMetaPath, commitHash: meta.commitHash, writtenAt: new Date(meta.writtenAt * 1000).toISOString() };
}
