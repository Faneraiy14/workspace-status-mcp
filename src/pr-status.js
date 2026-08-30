// pr-status.js — знімок стану кількох GitHub PR одним викликом: state,
// mergeable, review decision, CI, і — окремо — скільки є top-level і
// inline review-коментарів та хто/коли писав останній. Мотивація:
// сесія, де ЦЕЙ САМЕ MCP-сервер тестувався живцем, весь день мала по
// колу ручні пари викликів `gh pr view --json ...` + `gh api
// .../pulls/{n}/comments` на кожен PR окремо (OpenSourceBikeShare
// #354-#357), той самий клас проблеми, що вже вирішений для git+CI
// у sweep_status - "перевірити купу однотипних штук одним викликом
// замість ручного циклу".
//
// Top-level (issue) і inline (review) коментарі GitHub — ДВІ окремі
// сутності з різними endpoint'ами (той самий урок, що вже осів у
// пам'яті сесії: пропущені inline-треди на #354, бо перевірявся лише
// review body) - обидва рахуються тут окремо, а не лише один із двох.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function ghJson(args) {
    try {
        const { stdout } = await execFileAsync('gh', args, { maxBuffer: 4 * 1024 * 1024 });
        return { ok: true, data: JSON.parse(stdout) };
    } catch (err) {
        return { ok: false, error: err.stderr?.trim() || err.message };
    }
}

function latestOf(comments) {
    if (!comments.length) return null;
    const last = comments.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    return { author: last.user?.login ?? '(невідомо)', at: last.created_at };
}

function summarizeChecks(statusCheckRollup) {
    if (!statusCheckRollup || statusCheckRollup.length === 0) return 'none';
    if (statusCheckRollup.some((c) => c.conclusion === 'FAILURE' || c.conclusion === 'failure')) return 'failure';
    if (statusCheckRollup.some((c) => c.status === 'IN_PROGRESS' || c.status === 'in_progress')) return 'pending';
    return 'success';
}

/**
 * Чиста, юніт-тестована частина: із уже завантажених сирих даних (не
 * робить жодних мережевих викликів сама) вирішує, чи PR "потребує
 * уваги" і формує компактний запис. Винесено окремо від fetchPr(),
 * щоб перевіряти цю логіку без реального gh/мережі.
 *
 * @param {object} raw - {state, mergedAt, mergeable, mergeStateStatus, reviewDecision, title, url, statusCheckRollup}
 * @param {Array<object>} issueComments - сирі об'єкти з gh api .../issues/{n}/comments
 * @param {Array<object>} reviewComments - сирі об'єкти з gh api .../pulls/{n}/comments
 */
export function classifyPr(raw, issueComments, reviewComments) {
    const ciStatus = summarizeChecks(raw.statusCheckRollup);
    const isOpen = raw.state === 'OPEN';

    const needsAttention =
        isOpen &&
        (raw.mergeStateStatus === 'DIRTY' ||
            raw.reviewDecision === 'CHANGES_REQUESTED' ||
            ciStatus === 'failure');

    return {
        title: raw.title,
        url: raw.url,
        state: raw.state,
        mergedAt: raw.mergedAt ?? null,
        mergeable: raw.mergeable ?? null,
        mergeStateStatus: raw.mergeStateStatus ?? null,
        reviewDecision: raw.reviewDecision ?? null,
        ciStatus,
        comments: { total: issueComments.length, last: latestOf(issueComments) },
        reviewComments: { total: reviewComments.length, last: latestOf(reviewComments) },
        needsAttention,
    };
}

async function fetchPr(repo, number) {
    const [prResult, issueCommentsResult, reviewCommentsResult] = await Promise.all([
        ghJson(['pr', 'view', String(number), '--repo', repo, '--json',
            'state,mergedAt,mergeable,mergeStateStatus,reviewDecision,title,url,statusCheckRollup']),
        ghJson(['api', `repos/${repo}/issues/${number}/comments`]),
        ghJson(['api', `repos/${repo}/pulls/${number}/comments`]),
    ]);

    if (!prResult.ok) {
        return { repo, number, error: prResult.error };
    }

    return {
        repo,
        number,
        ...classifyPr(
            prResult.data,
            issueCommentsResult.ok ? issueCommentsResult.data : [],
            reviewCommentsResult.ok ? reviewCommentsResult.data : []
        ),
    };
}

const MAX_CONCURRENCY = 6;

/**
 * @param {object} opts
 * @param {Array<{repo: string, number: number}>} opts.prs - список PR для перевірки, repo у форматі "власник/назва"
 * @param {boolean} [opts.only_attention] - показати лише PR, що потребують уваги (типово true)
 */
export async function checkPrStatus({ prs, only_attention = true } = {}) {
    if (!prs || prs.length === 0) throw new Error('prs обов\'язковий і не може бути порожнім (список {repo, number})');

    const results = [];
    for (let i = 0; i < prs.length; i += MAX_CONCURRENCY) {
        const batch = prs.slice(i, i + MAX_CONCURRENCY);
        const fetched = await Promise.all(batch.map((p) => fetchPr(p.repo, p.number)));
        results.push(...fetched);
    }

    const filtered = only_attention
        ? results.filter((r) => r.error || r.needsAttention)
        : results;

    return {
        checked: results.length,
        flagged: filtered.length,
        prs: filtered,
    };
}
