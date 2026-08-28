// sweep.js — знімок стану по всіх локальних git-репозиторіях під заданим
// коренем (типово ~/Projects) одним викликом: гілка, чи є незакомічені
// зміни, чи є неопубліковані коміти, і (опційно) статус останнього
// GitHub Actions CI-запуску. Мотивація: без цього доводиться вручну
// заходити в кожен репо окремо (git status, gh run list) - той самий
// клас проблеми, що й watch_ci у ci-watch-mcp, тільки "по всіх репо
// одразу", а не "по одному коміту".

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_CONCURRENCY = 8;

async function run(cmd, args, cwd) {
    try {
        const { stdout } = await execFileAsync(cmd, args, { cwd, maxBuffer: 4 * 1024 * 1024 });
        return { ok: true, stdout: stdout.trim() };
    } catch (err) {
        return { ok: false, stdout: '', error: err.stderr?.trim() || err.message };
    }
}

async function findGitRepos(root) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
        throw new Error(`Не вдалося прочитати ${root}: ${err.message}`);
    }

    const repos = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(root, entry.name);
        try {
            await stat(join(path, '.git'));
            repos.push({ name: entry.name, path });
        } catch {
            // не .git - не репозиторій, пропускаємо (без рекурсії вглиб:
            // "усі репо в ~/Projects" мають на увазі рівно один рівень
            // вкладеності, не сканування залежностей/node_modules/vendor
            // всередині кожного репо).
        }
    }
    return repos;
}

// Пара [ahead, behind] відносно upstream-гілки; null, якщо upstream не
// налаштовано (типово для щойно ініціалізованих чи повністю локальних
// репозиторіїв - не помилка, а нормальний стан).
async function aheadBehind(cwd) {
    const upstream = await run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
    if (!upstream.ok) return null;

    const counts = await run('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], cwd);
    if (!counts.ok) return null;

    const [ahead, behind] = counts.stdout.split(/\s+/).map(Number);
    return { ahead, behind };
}

async function latestCiRun(cwd) {
    const hasWorkflows = await stat(join(cwd, '.github', 'workflows')).then(() => true).catch(() => false);
    if (!hasWorkflows) return null;

    const result = await run(
        'gh',
        ['run', 'list', '--limit', '1', '--json', 'status,conclusion,workflowName,url,createdAt'],
        cwd
    );
    if (!result.ok || !result.stdout) return null;

    try {
        const [latest] = JSON.parse(result.stdout);
        return latest ?? null;
    } catch {
        return null;
    }
}

async function inspectRepo({ name, path }, { checkCi }) {
    const [branch, dirty, ab, ci] = await Promise.all([
        run('git', ['branch', '--show-current'], path),
        run('git', ['status', '--porcelain'], path),
        aheadBehind(path),
        checkCi ? latestCiRun(path) : Promise.resolve(undefined),
    ]);

    const dirtyCount = dirty.ok ? dirty.stdout.split('\n').filter(Boolean).length : null;

    const entry = {
        name,
        path,
        branch: branch.ok ? branch.stdout || '(detached HEAD)' : '(невідомо)',
        uncommittedFiles: dirtyCount,
        ahead: ab?.ahead ?? null,
        behind: ab?.behind ?? null,
        hasUpstream: ab !== null,
    };
    if (checkCi) {
        entry.ci = ci
            ? { status: ci.status, conclusion: ci.conclusion, workflow: ci.workflowName, url: ci.url }
            : null; // null = або нема workflow-файлів, або ще жодного запуску
    }
    return entry;
}

// Репозиторій "потребує уваги", якщо: є незакомічені зміни, є коміти,
// не запушені на upstream (чи взагалі нема upstream попри наявність
// коду), або останній CI-запуск не "success". Мовчазно-чисті репо
// (нічого не змінювалось, CI зелений) відсіюються за замовчуванням, щоб
// відповідь була компактною й одразу показувала, куди дивитись.
function needsAttention(entry) {
    if (entry.uncommittedFiles) return true;
    if (entry.ahead) return true;
    if (entry.ci && entry.ci.status === 'completed' && entry.ci.conclusion !== 'success') return true;
    if (entry.ci && entry.ci.status === 'in_progress') return true;
    return false;
}

/**
 * @param {object} opts
 * @param {string} opts.root - корінь, під яким шукати репозиторії (типово ~/Projects)
 * @param {string[]} [opts.repos] - обмежитись конкретними назвами тек замість повного сканування root
 * @param {boolean} [opts.check_ci] - опитувати GitHub Actions (типово true; вимкнути для швидшого, чисто локального знімку)
 * @param {boolean} [opts.only_attention] - показати лише репо, що потребують уваги (типово true)
 */
export async function sweepStatus({ root, repos, check_ci = true, only_attention = true } = {}) {
    if (!root) throw new Error('root обов\'язковий (напр. "/home/sviat/Projects")');

    const allRepos = repos && repos.length
        ? repos.map((name) => ({ name, path: join(root, name) }))
        : await findGitRepos(root);

    const results = [];
    for (let i = 0; i < allRepos.length; i += MAX_CONCURRENCY) {
        const batch = allRepos.slice(i, i + MAX_CONCURRENCY);
        const inspected = await Promise.all(batch.map((r) => inspectRepo(r, { checkCi: check_ci })));
        results.push(...inspected);
    }

    const filtered = only_attention ? results.filter(needsAttention) : results;

    return {
        scanned: results.length,
        flagged: filtered.length,
        repos: filtered,
    };
}
