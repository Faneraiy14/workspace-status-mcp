// docs.mjs — checkDocs() у контрольованому тимчасовому середовищі
// (не на реальній ~/Projects, як smoke.mjs для sweepStatus): нам треба
// точно відтворювані стани missing/stale/current/no-commits, які
// природний стан ~/Projects з часом дрейфує й ламав би тест.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocs } from '../src/docs.js';

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
    await execFileAsync('git', args, { cwd });
}

async function makeRepoWithCommit(repoPath) {
    await mkdir(repoPath, { recursive: true });
    await git(['init', '-q'], repoPath);
    await git(['config', 'user.email', 'test@test.local'], repoPath);
    await git(['config', 'user.name', 'Test'], repoPath);
    await writeFile(join(repoPath, 'file.txt'), 'hello');
    await git(['add', '.'], repoPath);
    await git(['commit', '-q', '-m', 'init'], repoPath);
}

test('checkDocs: 4 стани - missing/stale/current/no-commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docs-test-'));
    const docsRoot = join(root, 'Architecture');
    await mkdir(docsRoot, { recursive: true });

    try {
        // missing: репо з комітом, документа взагалі нема
        await makeRepoWithCommit(join(root, 'proj-missing'));

        // no-commits: репо без жодного коміту
        await mkdir(join(root, 'proj-empty'), { recursive: true });
        await git(['init', '-q'], join(root, 'proj-empty'));

        // stale: документ ІСНУЄ, але старший за останній коміт репо
        await makeRepoWithCommit(join(root, 'proj-stale'));
        const staleDoc = join(docsRoot, 'proj-stale.txt');
        await writeFile(staleDoc, 'стара документація');
        const past = new Date(Date.now() - 60 * 60 * 1000); // годину тому
        await utimes(staleDoc, past, past);

        // current: документ новіший за коміт репо (записуємо ПІСЛЯ коміту)
        await makeRepoWithCommit(join(root, 'proj-current'));
        await writeFile(join(docsRoot, 'proj-current.txt'), 'свіжа документація');

        const result = await checkDocs({ projectsRoot: root, docsRoot, only_attention: false });

        const byName = Object.fromEntries(result.repos.map((r) => [r.name, r]));
        assert.equal(byName['proj-missing'].status, 'missing');
        assert.equal(byName['proj-empty'].status, 'no-commits');
        assert.equal(byName['proj-stale'].status, 'stale');
        assert.equal(byName['proj-current'].status, 'current');

        assert.equal(result.missing, 1);
        assert.equal(result.stale, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('checkDocs: only_attention=true (типово) приховує "current"', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docs-test-'));
    const docsRoot = join(root, 'Architecture');
    await mkdir(docsRoot, { recursive: true });

    try {
        await makeRepoWithCommit(join(root, 'proj-current'));
        await writeFile(join(docsRoot, 'proj-current.txt'), 'свіжа документація');

        const result = await checkDocs({ projectsRoot: root, docsRoot });
        assert.equal(result.repos.length, 0, 'current-репо не має бути в списку за замовчуванням');
        assert.equal(result.scanned, 1, 'але scanned все одно рахує його');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('checkDocs: без projectsRoot кидає зрозумілу помилку', async () => {
    await assert.rejects(() => checkDocs({}), /projectsRoot обов'язковий/);
});

test('checkDocs: docsRoot за замовчуванням - "<projectsRoot>/Architecture"', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docs-test-'));
    try {
        await makeRepoWithCommit(join(root, 'proj'));
        const result = await checkDocs({ projectsRoot: root });
        assert.equal(result.repos[0].docPath, join(root, 'Architecture', 'proj.txt'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
