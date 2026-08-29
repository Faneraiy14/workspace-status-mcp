// docs.js — детектор застарілості "документації архітектури"
// (~/Projects/Architecture/<repo>.txt). Не генерує документацію сам
// (розуміння архітектури коду - завдання для AI/людини, не для скрипта)
// - лише каже, де відповідь застаріла чи взагалі відсутня, щоб
// AI-асистент (чи людина) знав, куди дивитись, а не перечитував усе
// підряд щосесії.
//
// Два способи виміряти "застарілість", залежно від того, чи документ
// колись писався через write-doc.js:
// - commit-трекінг (Architecture/.meta/<repo>.json є) - точна кількість
//   комітів між збереженим хешем і HEAD через git rev-list --count.
// - mtime-трекінг (тільки для документів, написаних напряму, без
//   write-doc.js - увесь наявний масив Architecture/*.txt на момент
//   появи write-doc.js) - грубіший запасний варіант: час mtime файлу
//   документації проти часу останнього коміту репо.
//
// "points" - кілька незалежних пар (projectsRoot, docsRoot): не всі
// репо обов'язково лежать під ОДНИМ коренем з документацією поруч у
// тому самому дереві (напр. репо, винесене з ~/Projects на робочий
// стіл, з документом прямо поруч на робочому столі, а не в
// ~/Projects/Architecture). projectsRoot/docsRoot (однина) лишаються
// зручним скороченням для найчастішого випадку - рівно одна точка.

import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findGitRepos, run } from './sweep.js';
import { metaPath } from './write-doc.js';

// Останній коміт репозиторію як Unix-timestamp (секунди) - той самий
// формат, що й Date.getTime()/1000, для прямого порівняння з mtime
// файлу документації без конвертацій туди-сюди.
async function lastCommitTimestamp(repoPath) {
    const result = await run('git', ['log', '-1', '--format=%ct'], repoPath);
    if (!result.ok || !result.stdout) return null; // немає жодного коміту
    const ts = parseInt(result.stdout, 10);
    return Number.isFinite(ts) ? ts : null;
}

async function readMeta(docsRoot, repoName) {
    try {
        const parsed = JSON.parse(await readFile(metaPath(docsRoot, repoName), 'utf8'));
        return typeof parsed.commitHash === 'string' && typeof parsed.writtenAt === 'number' ? parsed : null;
    } catch {
        return null; // нема файлу метаданих, чи він пошкоджений - однаково відкат на mtime
    }
}

// null, якщо збережений хеш недосяжний з HEAD (force-push, rebase,
// перезаписана історія) - у такому разі викликач відкочується на
// mtime-трекінг замість падіння з помилкою.
async function commitsSince(repoPath, commitHash) {
    const result = await run('git', ['rev-list', '--count', `${commitHash}..HEAD`], repoPath);
    if (!result.ok) return null;
    const n = parseInt(result.stdout, 10);
    return Number.isFinite(n) ? n : null;
}

async function checkOneRepo(repo, projectsRoot, docsRoot) {
    const docPath = join(docsRoot, `${repo.name}.txt`);

    const commitTs = await lastCommitTimestamp(repo.path);
    if (commitTs === null) {
        // Немає жодного коміту (щойно ініціалізований репо) - нема з чим
        // звіряти "застарілість", але документація все одно може бути
        // доречна (чи навпаки, точно не потрібна для порожнього репо) -
        // повідомляємо статус окремо, не прирівнюємо мовчки ні до
        // missing, ні до current.
        return { name: repo.name, projectsRoot, docPath, status: 'no-commits', lastCommitAt: null, docUpdatedAt: null };
    }

    let docMtimeMs;
    try {
        docMtimeMs = (await stat(docPath)).mtimeMs;
    } catch {
        return {
            name: repo.name,
            projectsRoot,
            docPath,
            status: 'missing',
            lastCommitAt: new Date(commitTs * 1000).toISOString(),
            docUpdatedAt: null,
        };
    }

    const meta = await readMeta(docsRoot, repo.name);
    const since = meta ? await commitsSince(repo.path, meta.commitHash) : null;
    if (meta && since !== null) {
        return {
            name: repo.name,
            projectsRoot,
            docPath,
            status: since > 0 ? 'stale' : 'current',
            trackingMethod: 'commit',
            lastCommitAt: new Date(commitTs * 1000).toISOString(),
            writtenAtCommit: meta.commitHash.slice(0, 12),
            writtenAt: new Date(meta.writtenAt * 1000).toISOString(),
            commitsSinceWrite: since,
        };
    }

    const docTs = Math.floor(docMtimeMs / 1000);
    const status = commitTs > docTs ? 'stale' : 'current';
    return {
        name: repo.name,
        projectsRoot,
        docPath,
        status,
        trackingMethod: 'mtime',
        lastCommitAt: new Date(commitTs * 1000).toISOString(),
        docUpdatedAt: new Date(docTs * 1000).toISOString(),
        staleBySeconds: status === 'stale' ? commitTs - docTs : 0,
    };
}

/**
 * @param {object} opts
 * @param {string} [opts.projectsRoot] - корінь із репозиторіями (типово ~/Projects) - скорочення для points: [{projectsRoot, docsRoot}]
 * @param {string} [opts.docsRoot] - тека з .txt-документацією для projectsRoot (типово <projectsRoot>/Architecture)
 * @param {{projectsRoot: string, docsRoot?: string}[]} [opts.points] - кілька незалежних пар корінь+документація за один виклик; має пріоритет над projectsRoot/docsRoot, якщо задано
 * @param {string[]} [opts.repos] - обмежитись конкретними назвами тек замість повного сканування (застосовується в межах КОЖНОЇ точки окремо)
 * @param {boolean} [opts.only_attention] - показати лише missing/stale (типово true)
 */
export async function checkDocs({ projectsRoot, docsRoot, points, repos, only_attention = true } = {}) {
    const resolvedPoints = points && points.length ? points : projectsRoot ? [{ projectsRoot, docsRoot }] : null;
    if (!resolvedPoints) throw new Error('projectsRoot або points обов\'язковий (напр. "/home/sviat/Projects")');
    for (const p of resolvedPoints) {
        if (!p.projectsRoot) throw new Error('кожен елемент points повинен мати projectsRoot');
    }

    const results = [];
    for (const point of resolvedPoints) {
        const pointDocsRoot = point.docsRoot || join(point.projectsRoot, 'Architecture');
        const pointRepos = repos && repos.length
            ? repos.map((name) => ({ name, path: join(point.projectsRoot, name) }))
            : await findGitRepos(point.projectsRoot);

        for (const repo of pointRepos) {
            results.push(await checkOneRepo(repo, point.projectsRoot, pointDocsRoot));
        }
    }

    const filtered = only_attention ? results.filter((r) => r.status !== 'current') : results;

    return {
        scanned: results.length,
        missing: results.filter((r) => r.status === 'missing').length,
        stale: results.filter((r) => r.status === 'stale').length,
        repos: filtered,
    };
}
