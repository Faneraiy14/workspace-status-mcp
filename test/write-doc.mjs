// write-doc.mjs — writeDoc() у тимчасовому git-репозиторії: перевіряє,
// що записаний .txt і .meta/<repo>.json відповідають вмісту й HEAD.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDoc } from '../src/write-doc.js';

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
}

async function makeRepoWithCommit(repoPath) {
    await mkdir(repoPath, { recursive: true });
    await git(['init', '-q'], repoPath);
    await git(['config', 'user.email', 'test@test.local'], repoPath);
    await git(['config', 'user.name', 'Test'], repoPath);
    await writeFile(join(repoPath, 'file.txt'), 'hello');
    await git(['add', '.'], repoPath);
    await git(['commit', '-q', '-m', 'init'], repoPath);
    return git(['rev-parse', 'HEAD'], repoPath);
}

test('writeDoc: пише .txt і .meta/<repo>.json з поточним HEAD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'write-doc-test-'));
    try {
        const headSha = await makeRepoWithCommit(join(root, 'proj'));
        const docsRoot = join(root, 'Architecture');

        const result = await writeDoc({ projectsRoot: root, repo: 'proj', content: 'опис архітектури', docsRoot });

        assert.equal(result.commitHash, headSha);
        assert.equal(await readFile(result.docPath, 'utf8'), 'опис архітектури');

        const meta = JSON.parse(await readFile(result.metaPath, 'utf8'));
        assert.equal(meta.commitHash, headSha);
        assert.ok(Number.isFinite(meta.writtenAt));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('writeDoc: створює Architecture/ і Architecture/.meta/, якщо їх ще нема', async () => {
    const root = await mkdtemp(join(tmpdir(), 'write-doc-test-'));
    try {
        await makeRepoWithCommit(join(root, 'proj'));
        const result = await writeDoc({ projectsRoot: root, repo: 'proj', content: 'x' });
        assert.equal(result.docPath, join(root, 'Architecture', 'proj.txt'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('writeDoc: порожній content відхиляється', async () => {
    const root = await mkdtemp(join(tmpdir(), 'write-doc-test-'));
    try {
        await makeRepoWithCommit(join(root, 'proj'));
        await assert.rejects(
            () => writeDoc({ projectsRoot: root, repo: 'proj', content: '   ' }),
            /content не може бути порожнім/
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('writeDoc: без repo кидає зрозумілу помилку', async () => {
    await assert.rejects(() => writeDoc({ projectsRoot: '/tmp', content: 'x' }), /repo обов'язковий/);
});

test('writeDoc mode:"append" - на порожньому місці поводиться як replace (без зайвого порожнього рядка)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'write-doc-test-'));
    try {
        await makeRepoWithCommit(join(root, 'proj'));
        const result = await writeDoc({ projectsRoot: root, repo: 'proj', content: 'перший запис', mode: 'append' });
        assert.equal(await readFile(result.docPath, 'utf8'), 'перший запис');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('writeDoc mode:"append" - дописує з ОДНИМ порожнім рядком-роздільником, не чіпаючи старий текст', async () => {
    const root = await mkdtemp(join(tmpdir(), 'write-doc-test-'));
    try {
        await makeRepoWithCommit(join(root, 'proj'));
        const docsRoot = join(root, 'Architecture');
        await writeDoc({ projectsRoot: root, repo: 'proj', content: 'старий запис', docsRoot });
        const result = await writeDoc({ projectsRoot: root, repo: 'proj', content: 'новий запис', docsRoot, mode: 'append' });
        assert.equal(await readFile(result.docPath, 'utf8'), 'старий запис\n\nновий запис');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('writeDoc mode:"append" - зайві завершальні переноси рядків у старому вмісті не накопичуються', async () => {
    const root = await mkdtemp(join(tmpdir(), 'write-doc-test-'));
    try {
        await makeRepoWithCommit(join(root, 'proj'));
        const docsRoot = join(root, 'Architecture');
        await writeDoc({ projectsRoot: root, repo: 'proj', content: 'старий запис\n\n\n', docsRoot });
        const result = await writeDoc({ projectsRoot: root, repo: 'proj', content: 'новий запис', docsRoot, mode: 'append' });
        assert.equal(await readFile(result.docPath, 'utf8'), 'старий запис\n\nновий запис');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('writeDoc: невідомий mode кидає зрозумілу помилку', async () => {
    const root = await mkdtemp(join(tmpdir(), 'write-doc-test-'));
    try {
        await makeRepoWithCommit(join(root, 'proj'));
        await assert.rejects(
            () => writeDoc({ projectsRoot: root, repo: 'proj', content: 'x', mode: 'wat' }),
            /mode має бути "replace" чи "append"/
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
