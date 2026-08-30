import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPr, checkPrStatus } from '../src/pr-status.js';

// --- Юніт-тести classifyPr() на фікстурах, без мережі -----------------

function rawPr(overrides = {}) {
    return {
        state: 'OPEN',
        mergedAt: null,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        reviewDecision: null,
        title: 'Тестовий PR',
        url: 'https://github.com/x/y/pull/1',
        statusCheckRollup: [],
        ...overrides,
    };
}

test('classifyPr: чистий відкритий PR без CI - needsAttention false', () => {
    const result = classifyPr(rawPr(), [], []);
    assert.equal(result.needsAttention, false);
    assert.equal(result.ciStatus, 'none');
});

test('classifyPr: DIRTY (конфлікт) - needsAttention true', () => {
    const result = classifyPr(rawPr({ mergeStateStatus: 'DIRTY' }), [], []);
    assert.equal(result.needsAttention, true);
});

test('classifyPr: CHANGES_REQUESTED - needsAttention true', () => {
    const result = classifyPr(rawPr({ reviewDecision: 'CHANGES_REQUESTED' }), [], []);
    assert.equal(result.needsAttention, true);
});

test('classifyPr: CI FAILURE - needsAttention true, ciStatus "failure"', () => {
    const result = classifyPr(
        rawPr({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }] }),
        [], []
    );
    assert.equal(result.ciStatus, 'failure');
    assert.equal(result.needsAttention, true);
});

test('classifyPr: CI IN_PROGRESS - ciStatus "pending", НЕ needsAttention сам по собі', () => {
    const result = classifyPr(
        rawPr({ statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] }),
        [], []
    );
    assert.equal(result.ciStatus, 'pending');
    assert.equal(result.needsAttention, false);
});

test('classifyPr: змерджений PR ніколи не needsAttention, навіть з DIRTY-рештками', () => {
    const result = classifyPr(rawPr({ state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', mergeStateStatus: 'DIRTY' }), [], []);
    assert.equal(result.needsAttention, false);
});

test('classifyPr: top-level і inline коментарі рахуються ОКРЕМО, не сумуються', () => {
    const issueComments = [
        { user: { login: 'a' }, created_at: '2026-01-01T00:00:00Z' },
        { user: { login: 'b' }, created_at: '2026-01-02T00:00:00Z' },
    ];
    const reviewComments = [
        { user: { login: 'c' }, created_at: '2026-01-03T00:00:00Z' },
    ];
    const result = classifyPr(rawPr(), issueComments, reviewComments);
    assert.equal(result.comments.total, 2);
    assert.equal(result.comments.last.author, 'b');
    assert.equal(result.reviewComments.total, 1);
    assert.equal(result.reviewComments.last.author, 'c');
});

test('classifyPr: без коментарів - last:null, не throw', () => {
    const result = classifyPr(rawPr(), [], []);
    assert.equal(result.comments.total, 0);
    assert.equal(result.comments.last, null);
});

// --- Живий тест проти РЕАЛЬНИХ, стабільних (MERGED) PR -----------------
// Обидва вибрані саме тому, що вже змерджені й більше не зміняться -
// mergedAt/title/state тут детерміновані назавжди, на відміну від
// коментарів на живому відкритому PR, які будь-хто може дописати в
// будь-який момент.

test('checkPrStatus: реальний PR (OpenSourceBikeShare #355, MERGED)', async () => {
    const result = await checkPrStatus({
        prs: [{ repo: 'cyklokoalicia/OpenSourceBikeShare', number: 355 }],
        only_attention: false,
    });
    assert.equal(result.checked, 1);
    const pr = result.prs[0];
    assert.equal(pr.state, 'MERGED');
    assert.equal(pr.mergedAt, '2026-08-30T07:16:34Z');
    assert.equal(pr.needsAttention, false);
});

test('checkPrStatus: реальний PR (php-sdk #465, MERGED) - інший репозиторій', async () => {
    const result = await checkPrStatus({
        prs: [{ repo: 'modelcontextprotocol/php-sdk', number: 465 }],
        only_attention: false,
    });
    assert.equal(result.checked, 1);
    assert.equal(result.prs[0].state, 'MERGED');
    assert.equal(result.prs[0].mergedAt, '2026-08-29T13:46:41Z');
});

test('checkPrStatus: декілька PR одним викликом, лише attention-варті лишаються при only_attention', async () => {
    const result = await checkPrStatus({
        prs: [
            { repo: 'cyklokoalicia/OpenSourceBikeShare', number: 355 },
            { repo: 'modelcontextprotocol/php-sdk', number: 465 },
        ],
        only_attention: true,
    });
    assert.equal(result.checked, 2);
    assert.equal(result.flagged, 0); // обидва MERGED, чисті - жоден не needsAttention
});

test('checkPrStatus: неіснуючий PR дає error у своєму записі, не валить увесь виклик', async () => {
    const result = await checkPrStatus({
        prs: [
            { repo: 'cyklokoalicia/OpenSourceBikeShare', number: 999999 },
            { repo: 'cyklokoalicia/OpenSourceBikeShare', number: 355 },
        ],
        only_attention: false,
    });
    assert.equal(result.checked, 2);
    const bad = result.prs.find((p) => p.number === 999999);
    assert.ok(bad.error);
    const good = result.prs.find((p) => p.number === 355);
    assert.equal(good.state, 'MERGED');
});

test('checkPrStatus: порожній prs кидає чітку помилку', async () => {
    await assert.rejects(() => checkPrStatus({ prs: [] }), /prs/);
});
