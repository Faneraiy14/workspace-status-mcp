// docs.mjs — checkDocs() у контрольованому тимчасовому середовищі
// (не на реальній ~/Projects, як smoke.mjs для sweepStatus): нам треба
// точно відтворювані стани missing/stale/current/no-commits, які
// природний стан ~/Projects з часом дрейфує й ламав би тест.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocs } from '../src/docs.js';
import { writeDoc } from '../src/write-doc.js';

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
    await execFileAsync('git', args, { cwd });
}

// Друге й наступні звернення до того самого repoPath додають ще один
// коміт до вже наявного репо (потрібно для commit-tracking тесту нижче:
// writeDoc() зафіксовує HEAD, тоді робимо ще один коміт і перевіряємо,
// що checkDocs() бачить рівно 1 коміт дрейфу).
async function makeRepoWithCommit(repoPath, message = 'init') {
    const alreadyRepo = await stat(join(repoPath, '.git')).then(() => true).catch(() => false);
    if (!alreadyRepo) {
        await mkdir(repoPath, { recursive: true });
        await git(['init', '-q'], repoPath);
        await git(['config', 'user.email', 'test@test.local'], repoPath);
        await git(['config', 'user.name', 'Test'], repoPath);
    }
    await writeFile(join(repoPath, `${message}.txt`), message);
    await git(['add', '.'], repoPath);
    await git(['commit', '-q', '-m', message], repoPath);
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
    await assert.rejects(() => checkDocs({}), /projectsRoot або points обов'язковий/);
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

test('checkDocs: документ, записаний через writeDoc(), відстежується по комітах, не по mtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docs-test-'));
    const docsRoot = join(root, 'Architecture');

    try {
        await makeRepoWithCommit(join(root, 'proj'), 'init');
        await writeDoc({ projectsRoot: root, repo: 'proj', content: 'опис на момент запису', docsRoot });

        // Одразу після writeDoc() - жодного нового коміту ще нема.
        const fresh = await checkDocs({ projectsRoot: root, docsRoot, only_attention: false });
        const freshEntry = fresh.repos.find((r) => r.name === 'proj');
        assert.equal(freshEntry.status, 'current');
        assert.equal(freshEntry.trackingMethod, 'commit');
        assert.equal(freshEntry.commitsSinceWrite, 0);

        // mtime самого .txt навмисно НЕ чіпаємо - лише новий коміт у репо.
        // Якби трекінг досі був mtime-based, файл виглядав би "current",
        // хоча реально відстав на 1 коміт.
        await makeRepoWithCommit(join(root, 'proj'), 'ще одна зміна');

        const after = await checkDocs({ projectsRoot: root, docsRoot, only_attention: false });
        const afterEntry = after.repos.find((r) => r.name === 'proj');
        assert.equal(afterEntry.status, 'stale');
        assert.equal(afterEntry.trackingMethod, 'commit');
        assert.equal(afterEntry.commitsSinceWrite, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('checkDocs: points - кілька незалежних коренів проєктів+документації за один виклик', async () => {
    // Симулює реальний кейс: репо винесене з ~/Projects на робочий стіл,
    // документ лежить прямо там (docsRoot === сам робочий стіл), поки
    // решта репо й далі документуються в звичному ~/Projects/Architecture.
    const rootA = await mkdtemp(join(tmpdir(), 'points-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'points-b-'));
    const docsRootA = join(rootA, 'Architecture');
    await mkdir(docsRootA, { recursive: true });

    try {
        await makeRepoWithCommit(join(rootA, 'proj-a'));
        await writeFile(join(docsRootA, 'proj-a.txt'), 'документ А');

        // rootB: docsRoot - сам rootB (документ прямо поруч із репо, не
        // в підтеці Architecture) і документа немає взагалі - 'missing'.
        await makeRepoWithCommit(join(rootB, 'proj-b'));

        const result = await checkDocs({
            points: [
                { projectsRoot: rootA, docsRoot: docsRootA },
                { projectsRoot: rootB, docsRoot: rootB },
            ],
            only_attention: false,
        });

        assert.equal(result.scanned, 2);
        const byName = Object.fromEntries(result.repos.map((r) => [r.name, r]));
        assert.equal(byName['proj-a'].status, 'current');
        assert.equal(byName['proj-a'].projectsRoot, rootA);
        assert.equal(byName['proj-b'].status, 'missing');
        assert.equal(byName['proj-b'].projectsRoot, rootB);
        assert.equal(byName['proj-b'].docPath, join(rootB, 'proj-b.txt'));
    } finally {
        await rm(rootA, { recursive: true, force: true });
        await rm(rootB, { recursive: true, force: true });
    }
});

test('checkDocs: документ без .meta (написаний напряму, не через writeDoc) - відкат на mtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docs-test-'));
    const docsRoot = join(root, 'Architecture');
    await mkdir(docsRoot, { recursive: true });

    try {
        await makeRepoWithCommit(join(root, 'proj'));
        await writeFile(join(docsRoot, 'proj.txt'), 'написано напряму Write-тулом, без write_doc');

        const result = await checkDocs({ projectsRoot: root, docsRoot, only_attention: false });
        const entry = result.repos.find((r) => r.name === 'proj');
        assert.equal(entry.trackingMethod, 'mtime');
        assert.equal(entry.status, 'current');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
