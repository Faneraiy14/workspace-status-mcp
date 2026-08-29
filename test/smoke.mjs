// smoke.mjs — перевіряє sweepStatus() на реальних локальних репозиторіях
// (~/Projects), а не на штучних фікстурах: вони вже мають відомий,
// живий стан (чисті/брудні/з CI), тож не треба готувати окреме тестове
// git-дерево.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStatus } from '../src/sweep.js';

const ROOT = '/home/sviat/Projects';

test('sweepStatus: без root кидає зрозумілу помилку', async () => {
    await assert.rejects(() => sweepStatus({}), /root або roots обов'язковий/);
});

test('sweepStatus: конкретний чистий репо (secretscan) без атрибутів уваги, only_attention=true -> порожній список', async () => {
    const result = await sweepStatus({ root: ROOT, repos: ['secretscan'], only_attention: true, check_ci: false });
    assert.equal(result.scanned, 1);
    // Без незакомічених змін і без неопублікованих комітів secretscan не
    // мав би "потребувати уваги" в чисто локальному (без CI) знімку.
    assert.equal(result.flagged, 0);
});

test('sweepStatus: only_attention=false повертає репо навіть якщо він чистий', async () => {
    const result = await sweepStatus({ root: ROOT, repos: ['secretscan'], only_attention: false, check_ci: false });
    assert.equal(result.repos.length, 1);
    assert.equal(result.repos[0].name, 'secretscan');
    assert.ok('branch' in result.repos[0]);
    assert.ok('uncommittedFiles' in result.repos[0]);
});

test('sweepStatus: репозиторій без upstream (projects, порожній) не падає, hasUpstream=false', async () => {
    const result = await sweepStatus({ root: ROOT, repos: ['projects'], only_attention: false, check_ci: false });
    assert.equal(result.repos[0].hasUpstream, false);
    assert.equal(result.repos[0].ahead, null);
});

test('sweepStatus: check_ci=true додає поле ci (успішний прогін у secretscan)', async () => {
    const result = await sweepStatus({ root: ROOT, repos: ['secretscan'], only_attention: false, check_ci: true });
    const repo = result.repos[0];
    assert.ok('ci' in repo);
    assert.ok(repo.ci === null || typeof repo.ci.conclusion === 'string');
});

test('sweepStatus: roots (кілька коренів) знаходить репо з обох, і repos-фільтр працює незалежно від того, під яким коренем репо', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'sweep-empty-root-'));
    try {
        const result = await sweepStatus({
            roots: [ROOT, emptyRoot],
            repos: ['secretscan'],
            only_attention: false,
            check_ci: false,
        });
        assert.equal(result.repos.length, 1);
        assert.equal(result.repos[0].name, 'secretscan');
    } finally {
        await rm(emptyRoot, { recursive: true, force: true });
    }
});

test('sweepStatus: реальне сканування всієї ~/Projects знаходить принаймні кілька репо', async () => {
    const result = await sweepStatus({ root: ROOT, only_attention: false, check_ci: false });
    assert.ok(result.scanned > 30, `очікував >30 репо, отримав ${result.scanned}`);
});
