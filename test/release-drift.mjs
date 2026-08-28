// release-drift.mjs — checkReleaseDrift() у контрольованому тимчасовому
// середовищі: два "репо" - source (кілька комітів) і release (один
// коміт + тег) - з детермінованим порядком дій, а не залежність від
// реального стану NyxilumLang/NyxilumNode, який дрейфує сам по собі.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReleaseDrift } from '../src/release-drift.js';

const execFileAsync = promisify(execFile);

async function git(args, cwd, env) {
    await execFileAsync('git', args, { cwd, env: env ? { ...process.env, ...env } : process.env });
}

// epochSeconds ЯВНО задає час коміту (GIT_AUTHOR_DATE/GIT_COMMITTER_DATE)
// замість покладатись на реальний годинник - тести інакше могли б стати
// нестабільними, якщо кілька комітів у тесті трапляються в межах тієї
// самої секунди реального часу (git log --since має секундну точність).
async function commit(repoPath, fileContent, message, epochSeconds) {
    await writeFile(join(repoPath, 'file.txt'), fileContent);
    await git(['add', '.'], repoPath);
    const dateEnv = { GIT_AUTHOR_DATE: `${epochSeconds} +0000`, GIT_COMMITTER_DATE: `${epochSeconds} +0000` };
    await git(['commit', '-q', '-m', message], repoPath, dateEnv);
}

async function initRepo(repoPath) {
    await mkdir(repoPath, { recursive: true });
    await git(['init', '-q'], repoPath);
    await git(['config', 'user.email', 'test@test.local'], repoPath);
    await git(['config', 'user.name', 'Test'], repoPath);
}

const BASE = 1_735_000_000; // довільна фіксована точка відліку, не "зараз"

test('checkReleaseDrift: реліз без жодного тегу - no-tags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-test-'));
    try {
        const source = join(root, 'source');
        const release = join(root, 'release');
        await initRepo(source);
        await commit(source, 'a', 'init', BASE);
        await initRepo(release);
        await commit(release, 'a', 'init', BASE); // без тегу

        const result = await checkReleaseDrift({
            projectsRoot: root,
            pairs: [{ source: 'source', release: 'release' }],
            only_attention: false,
        });
        assert.equal(result.pairs[0].status, 'no-tags');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('checkReleaseDrift: тег є, нових комітів у джерелі нема - current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-test-'));
    try {
        const source = join(root, 'source');
        const release = join(root, 'release');
        await initRepo(source);
        await commit(source, 'a', 'init', BASE);
        await initRepo(release);
        await commit(release, 'a', 'init', BASE + 100);
        await git(['tag', 'v1.0.0'], release);

        const result = await checkReleaseDrift({
            projectsRoot: root,
            pairs: [{ source: 'source', release: 'release' }],
            only_attention: true, // current не мав би пройти фільтр
        });
        assert.equal(result.pairs.length, 0);
        assert.equal(result.drifted, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('checkReleaseDrift: тег є, у джерелі є новіші коміти - drifted, з правильним count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'drift-test-'));
    try {
        const source = join(root, 'source');
        const release = join(root, 'release');
        await initRepo(release);
        await commit(release, 'a', 'init', BASE);
        await git(['tag', 'v1.0.0'], release);

        // Три коміти в source, усі ЯВНО після BASE (часу тегу) - без
        // залежності від того, скільки реального часу забрало виконання.
        await initRepo(source);
        await commit(source, 'a', 'init', BASE - 1000); // до тегу - не рахується
        await commit(source, 'b', 'feature 1', BASE + 1000);
        await commit(source, 'c', 'feature 2', BASE + 2000);

        const result = await checkReleaseDrift({
            projectsRoot: root,
            pairs: [{ source: 'source', release: 'release' }],
            only_attention: false,
        });
        const pair = result.pairs[0];
        assert.equal(pair.status, 'drifted');
        // Лише 2, не 3 - коміт "a" (BASE - 1000, ДО тегу) не мав би рахуватись.
        assert.equal(pair.commitsSinceTag, 2);
        assert.ok(typeof pair.oldestUnreleasedAgeDays === 'number');
        assert.equal(result.drifted, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('checkReleaseDrift: без projectsRoot чи pairs кидає зрозумілу помилку', async () => {
    await assert.rejects(() => checkReleaseDrift({}), /projectsRoot обов'язковий/);
    await assert.rejects(
        () => checkReleaseDrift({ projectsRoot: '/tmp' }),
        /pairs обов'язковий/,
    );
});

test('checkReleaseDrift: реальна пара NyxilumLang -> NyxilumNode не падає', async () => {
    const result = await checkReleaseDrift({
        projectsRoot: '/home/sviat/Projects',
        pairs: [{ source: 'NyxilumLang', release: 'NyxilumNode' }],
        only_attention: false,
    });
    assert.equal(result.checked, 1);
    assert.ok(['current', 'drifted', 'no-tags'].includes(result.pairs[0].status));
});
