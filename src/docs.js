// docs.js — детектор застарілості "документації архітектури"
// (~/Projects/Architecture/<repo>.txt): для кожного git-репозиторія під
// коренем звіряє час останнього коміту з часом останньої зміни
// відповідного .txt-файлу. Не генерує документацію сам (розуміння
// архітектури коду - завдання для AI/людини, не для скрипта) - лише
// каже, де відповідь застаріла чи взагалі відсутня, щоб AI-асистент
// (чи людина) знав, куди дивитись, а не перечитував усе підряд щосесії.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { findGitRepos, run } from './sweep.js';

// Останній коміт репозиторію як Unix-timestamp (секунди) - той самий
// формат, що й Date.getTime()/1000, для прямого порівняння з mtime
// файлу документації без конвертацій туди-сюди.
async function lastCommitTimestamp(repoPath) {
    const result = await run('git', ['log', '-1', '--format=%ct'], repoPath);
    if (!result.ok || !result.stdout) return null; // немає жодного коміту
    const ts = parseInt(result.stdout, 10);
    return Number.isFinite(ts) ? ts : null;
}

/**
 * @param {object} opts
 * @param {string} opts.projectsRoot - корінь із репозиторіями (типово ~/Projects)
 * @param {string} [opts.docsRoot] - тека з .txt-документацією (типово <projectsRoot>/Architecture)
 * @param {string[]} [opts.repos] - обмежитись конкретними назвами тек замість повного сканування
 * @param {boolean} [opts.only_attention] - показати лише missing/stale (типово true)
 */
export async function checkDocs({ projectsRoot, docsRoot, repos, only_attention = true } = {}) {
    if (!projectsRoot) throw new Error('projectsRoot обов\'язковий (напр. "/home/sviat/Projects")');
    const resolvedDocsRoot = docsRoot || join(projectsRoot, 'Architecture');

    const allRepos = repos && repos.length
        ? repos.map((name) => ({ name, path: join(projectsRoot, name) }))
        : await findGitRepos(projectsRoot);

    const results = [];
    for (const repo of allRepos) {
        const docPath = join(resolvedDocsRoot, `${repo.name}.txt`);

        const commitTs = await lastCommitTimestamp(repo.path);
        if (commitTs === null) {
            // Немає жодного коміту (щойно ініціалізований репо) - нема з
            // чим звіряти "застарілість", але документація все одно
            // може бути доречна (чи навпаки, точно не потрібна для
            // порожнього репо) - повідомляємо статус окремо, не
            // прирівнюємо мовчки ні до missing, ні до current.
            results.push({ name: repo.name, docPath, status: 'no-commits', lastCommitAt: null, docUpdatedAt: null });
            continue;
        }

        let docMtimeMs;
        try {
            docMtimeMs = (await stat(docPath)).mtimeMs;
        } catch {
            results.push({
                name: repo.name,
                docPath,
                status: 'missing',
                lastCommitAt: new Date(commitTs * 1000).toISOString(),
                docUpdatedAt: null,
            });
            continue;
        }

        const docTs = Math.floor(docMtimeMs / 1000);
        const status = commitTs > docTs ? 'stale' : 'current';
        results.push({
            name: repo.name,
            docPath,
            status,
            lastCommitAt: new Date(commitTs * 1000).toISOString(),
            docUpdatedAt: new Date(docTs * 1000).toISOString(),
            staleBySeconds: status === 'stale' ? commitTs - docTs : 0,
        });
    }

    const filtered = only_attention ? results.filter((r) => r.status !== 'current') : results;

    return {
        scanned: results.length,
        missing: results.filter((r) => r.status === 'missing').length,
        stale: results.filter((r) => r.status === 'stale').length,
        repos: filtered,
    };
}
