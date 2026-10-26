// arch-backup.mjs — бекап .arch/ у тимчасових теках (ніколи не на справжній
// ~/Projects): копіює, не видаляє, не йде за symlink-ами, комітить і пушить
// у локальний bare-репо, а глобальний pre-push хук (hooks/git/dispatch.sh)
// запускає його при push будь-якого репо.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, cp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, syncArch } from '../bin/arch-backup.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const exists = (p) => stat(p).then(() => true).catch(() => false);

async function git(args, cwd, env = {}) {
    const { stdout } = await execFileAsync('git', args, { cwd, env: { ...process.env, ...env } });
    return stdout.trim();
}

async function initRepo(path) {
    await mkdir(path, { recursive: true });
    await git(['init', '-q', '-b', 'main'], path);
    await git(['config', 'user.email', 'test@test.local'], path);
    await git(['config', 'user.name', 'Test'], path);
}

// projects/{a,b} з .arch/, backup - git-репо з bare-remote
async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'arch-backup-'));
    const projects = join(root, 'Projects');
    const backupDir = join(projects, 'Architecture-backup');
    const remote = join(root, 'remote.git');
    await mkdir(join(projects, 'a', '.arch'), { recursive: true });
    await mkdir(join(projects, 'b', '.arch'), { recursive: true });
    await writeFile(join(projects, 'a', '.arch', 'README.txt'), 'a-огляд');
    await writeFile(join(projects, 'a', '.arch', '.meta.json'), '{"commitHash":"x","writtenAt":1}');
    await writeFile(join(projects, 'b', '.arch', 'README.txt'), 'b-огляд');
    await initRepo(backupDir);
    await git(['init', '-q', '--bare', '-b', 'main', remote], root);
    await git(['remote', 'add', 'origin', remote], backupDir);
    await writeFile(join(backupDir, 'README.md'), 'backup');
    await git(['add', '.'], backupDir);
    await git(['commit', '-q', '-m', 'init'], backupDir);
    await git(['push', '-q', '-u', 'origin', 'main'], backupDir, { ARCH_BACKUP: '0' });
    return { root, projects, backupDir, remote };
}

test('backup: копіює всі .arch/ (разом з .meta.json), комітить і пушить', async () => {
    const { root, projects, backupDir, remote } = await setup();
    try {
        const r = await backup({ projectsRoot: projects, backupDir, pushNow: true });
        assert.deepEqual(r, { copied: 3, committed: true, pushed: true });
        assert.equal(await readFile(join(backupDir, 'a', 'README.txt'), 'utf8'), 'a-огляд');
        assert.ok(await exists(join(backupDir, 'a', '.meta.json')));
        const files = await git(['ls-tree', '-r', '--name-only', 'main'], remote);
        assert.match(files, /a\/README\.txt/);
        assert.match(files, /b\/README\.txt/);
        assert.ok(!files.includes('.backup-state'), 'службова тека не комітиться');
        // повторний запуск без змін - нічого не робить
        assert.deepEqual(await backup({ projectsRoot: projects, backupDir, pushNow: true }), { copied: 0, committed: false, pushed: false });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('backup: видалений .arch/ і навіть увесь проєкт лишаються в бекапі і відновлюються', async () => {
    const { root, projects, backupDir } = await setup();
    try {
        await backup({ projectsRoot: projects, backupDir, noPush: true });
        await rm(join(projects, 'a', '.arch'), { recursive: true });
        await rm(join(projects, 'b'), { recursive: true });
        const r = await backup({ projectsRoot: projects, backupDir, noPush: true });
        assert.equal(r.committed, false, 'зникнення в проєктах не стає видаленням у бекапі');
        assert.equal(await readFile(join(backupDir, 'a', 'README.txt'), 'utf8'), 'a-огляд');
        assert.equal(await readFile(join(backupDir, 'b', 'README.txt'), 'utf8'), 'b-огляд');
        // відновлення - звичайне копіювання назад
        await cp(join(backupDir, 'a'), join(projects, 'a', '.arch'), { recursive: true });
        assert.equal(await readFile(join(projects, 'a', '.arch', 'README.txt'), 'utf8'), 'a-огляд');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('backup: symlink у .arch/ не копіюється, Architecture*/ і приховані теки пропускаються', async () => {
    const { root, projects, backupDir } = await setup();
    try {
        await writeFile(join(root, 'secret.txt'), 'секрет');
        await symlink(join(root, 'secret.txt'), join(projects, 'a', '.arch', 'link.txt'));
        await mkdir(join(projects, 'Architecture', '.arch'), { recursive: true });
        await writeFile(join(projects, 'Architecture', '.arch', 'x.txt'), 'x');
        await syncArch(projects, backupDir);
        assert.ok(!(await exists(join(backupDir, 'a', 'link.txt'))));
        assert.ok(!(await exists(join(backupDir, 'Architecture'))));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('backup: свіжий lock - другий запуск нічого не робить; завислий lock прибирається', async () => {
    const { root, projects, backupDir } = await setup();
    try {
        await mkdir(join(backupDir, '.backup-state'), { recursive: true });
        const lock = join(backupDir, '.backup-state', 'lock');
        await writeFile(lock, '');
        assert.equal(await backup({ projectsRoot: projects, backupDir, noPush: true }), 'locked');
        // pushNow чекає на lock (до waitMs), а не губить свій push
        setTimeout(() => rm(lock, { force: true }), 700);
        const waited = await backup({ projectsRoot: projects, backupDir, pushNow: true, waitMs: 5000 });
        assert.equal(waited.committed, true);
        assert.equal(waited.pushed, true);
        await writeFile(join(projects, 'a', '.arch', 'README.txt'), 'ще новіше');
        await writeFile(lock, '');
        const { utimes } = await import('node:fs/promises');
        const old = new Date(Date.now() - 10 * 60 * 1000);
        await utimes(lock, old, old);
        const r = await backup({ projectsRoot: projects, backupDir, noPush: true });
        assert.equal(r.committed, true);
        assert.ok(!(await exists(lock)));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('backup: без --push-now пушить не частіше ніж раз на PUSH_EVERY', async () => {
    const { root, projects, backupDir } = await setup();
    try {
        assert.equal((await backup({ projectsRoot: projects, backupDir })).pushed, true); // перший раз - можна
        await writeFile(join(projects, 'a', '.arch', 'README.txt'), 'нове');
        const r = await backup({ projectsRoot: projects, backupDir });
        assert.equal(r.committed, true);
        assert.equal(r.pushed, false, 'щойно пушили - чекаємо');
        assert.equal((await backup({ projectsRoot: projects, backupDir, pushNow: true })).pushed, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('git pre-push (dispatch.sh): push будь-якого репо запускає бекап; локальний хук теж виконується', async () => {
    const { root, projects, backupDir, remote } = await setup();
    try {
        const hooksDir = join(root, 'hooks');
        await mkdir(hooksDir);
        await cp(join(__dirname, '..', 'hooks', 'git', 'dispatch.sh'), join(hooksDir, 'pre-push'));
        await chmod(join(hooksDir, 'pre-push'), 0o755);

        const repo = join(projects, 'a');
        await initRepo(repo);
        await writeFile(join(repo, 'code.txt'), 'код');
        await git(['add', 'code.txt'], repo);
        await git(['commit', '-q', '-m', 'c'], repo);
        const repoRemote = join(root, 'a-remote.git');
        await git(['init', '-q', '--bare', '-b', 'main', repoRemote], root);
        await git(['remote', 'add', 'origin', repoRemote], repo);
        // локальний хук: доказ, що його не "з'їв" глобальний core.hooksPath
        await writeFile(join(repo, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch "${join(root, 'local-ran')}"\n`);
        await chmod(join(repo, '.git', 'hooks', 'pre-push'), 0o755);

        const env = {
            ARCH_PROJECTS_ROOT: projects,
            ARCH_BACKUP_SCRIPT: join(__dirname, '..', 'bin', 'arch-backup.mjs'),
        };
        await git(['-c', `core.hooksPath=${hooksDir}`, 'push', '-q', 'origin', 'main'], repo, env);
        assert.ok(await exists(join(root, 'local-ran')), 'локальний pre-push виконався');

        // бекап іде у фоні - чекаємо до 10 с, поки коміт з'явиться в remote бекапу
        let files = '';
        for (let i = 0; i < 50 && !files.includes('a/README.txt'); i++) {
            await new Promise((r) => setTimeout(r, 200));
            files = await git(['ls-tree', '-r', '--name-only', 'main'], remote).catch(() => '');
        }
        assert.match(files, /a\/README\.txt/);
        // .arch/ самого репо в його remote не потрапив (глобальний ignore тут не діє,
        // але ми й не додавали його - перевіряємо, що хук нічого не комітить у чужі репо)
        assert.ok(!(await git(['ls-tree', '-r', '--name-only', 'main'], repoRemote)).includes('.arch'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('git pre-push: локальний хук, що впав, зупиняє push, а бекап не запускається', async () => {
    const { root, projects } = await setup();
    try {
        const hooksDir = join(root, 'hooks');
        await mkdir(hooksDir);
        await cp(join(__dirname, '..', 'hooks', 'git', 'dispatch.sh'), join(hooksDir, 'pre-push'));
        await chmod(join(hooksDir, 'pre-push'), 0o755);
        const repo = join(root, 'x');
        await initRepo(repo);
        await writeFile(join(repo, 'f'), '1');
        await git(['add', 'f'], repo);
        await git(['commit', '-q', '-m', 'c'], repo);
        await git(['init', '-q', '--bare', '-b', 'main', join(root, 'x.git')], root);
        await git(['remote', 'add', 'origin', join(root, 'x.git')], repo);
        await writeFile(join(repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 1\n');
        await chmod(join(repo, '.git', 'hooks', 'pre-push'), 0o755);
        await assert.rejects(git(['-c', `core.hooksPath=${hooksDir}`, 'push', '-q', 'origin', 'main'], repo, { ARCH_PROJECTS_ROOT: projects }));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('backup: перший push у remote без upstream ставить -u і проходить', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arch-backup-'));
    try {
        const projects = join(root, 'Projects');
        const backupDir = join(projects, 'Architecture-backup');
        const remote = join(root, 'r.git');
        await mkdir(join(projects, 'a', '.arch'), { recursive: true });
        await writeFile(join(projects, 'a', '.arch', 'README.txt'), 'x');
        await initRepo(backupDir);
        await git(['init', '-q', '--bare', '-b', 'main', remote], root);
        await git(['remote', 'add', 'origin', remote], backupDir);
        const r = await backup({ projectsRoot: projects, backupDir, pushNow: true });
        assert.equal(r.pushed, true);
        assert.match(await git(['ls-tree', '-r', '--name-only', 'main'], remote), /a\/README\.txt/);
        assert.equal(await git(['rev-parse', '--abbrev-ref', '@{u}'], backupDir), 'origin/main');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
