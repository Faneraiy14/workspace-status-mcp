#!/usr/bin/env node
// arch-backup.mjs — копіює <projectsRoot>/*/.arch/ у git-репо бекапу
// (<backupDir>/<repo>/...), комітить і пушить.
//
// Навіщо: .arch/ у глобальному gitignore (не потрапляє в публічні репо),
// тож без цього скрипта в нього не було б жодної копії поза диском.
//
// Правила, на яких усе тримається:
// - лише КОПІЮВАННЯ з проєктів у бекап, ніколи навпаки, і ніколи не
//   видаляє: зник .arch/ у проєкті (чи весь проєкт) - у бекапі все лишилось;
// - спершу підтягнути бекап з remote (pull --rebase); не вдалось - нічого не
//   копіювати й не комітити (22.11 і 23.11 без цього двічі затерло свіжі записи);
// - застарілу локальну копію не копіювати: файл у проєкті старіший за останній
//   коміт цього файлу в бекапі (напр. його оновила хмарна сесія) - пропуск і
//   запис у лог; щоб оновити .arch - скопіювати з бекапу назад вручну;
// - копіюються лише звичайні файли (не symlink-и, не теки глибше .arch/);
// - lock-файл: два одночасні запуски (Stop-хук + pre-push) не б'ються;
// - push не частіше ніж раз на PUSH_EVERY_MS, якщо не передано --push-now
//   (pre-push хук передає - "при кожному пуші");
// - усі помилки - у <backupDir>/.backup-state/log.txt, код виходу завжди 0
//   (запускається у фоні, ламати нічого не повинен).
//
// Запуск: node arch-backup.mjs <projectsRoot> <backupDir> [--push-now] [--no-push]

import { readdir, stat, readFile, writeFile, copyFile, mkdir, open, unlink, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ARCH_DIR = '.arch';
const PUSH_EVERY_MS = Number(process.env.ARCH_BACKUP_PUSH_EVERY_MS) || 30 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;

async function git(args, cwd) {
    // ARCH_BACKUP=0 - щоб глобальний pre-push хук не запустив бекап знову
    // з push-у самого бекапу (інакше нескінченне коло).
    const { stdout } = await execFileAsync('git', args, { cwd, env: { ...process.env, ARCH_BACKUP: '0' }, timeout: 120000 });
    return stdout.trim();
}

/** Час (мс) останнього коміту файлу в бекапі; null - файл не в git (чи бекап не git-репо). */
async function lastCommitMs(backupDir, relPath) {
    const ct = await git(['log', '-1', '--format=%ct', '--', relPath], backupDir).catch(() => '');
    return ct ? Number(ct) * 1000 : null;
}

/** Скопіювати нові/змінені файли; повертає кількість скопійованих. Нічого не видаляє.
 *  stale (масив) - сюди потрапляють пропущені застарілі локальні копії. */
export async function syncArch(projectsRoot, backupDir, stale = []) {
    let copied = 0;
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('Architecture')) continue;
        const src = join(projectsRoot, e.name, ARCH_DIR);
        let files;
        try {
            if (!(await stat(src)).isDirectory()) continue;
            files = await readdir(src, { withFileTypes: true });
        } catch {
            continue; // у проєкту нема .arch/
        }
        for (const f of files) {
            if (!f.isFile()) continue; // isFile() false і для symlink - не йдемо за посиланнями
            const from = join(src, f.name);
            const destDir = join(backupDir, e.name);
            const to = join(destDir, f.name);
            const [a, b] = await Promise.all([readFile(from), readFile(to).catch(() => null)]);
            if (b && a.equals(b)) continue;
            if (b) {
                const committed = await lastCommitMs(backupDir, `${e.name}/${f.name}`);
                if (committed !== null && (await stat(from)).mtimeMs < committed) {
                    stale.push(`${e.name}/${f.name}`);
                    continue;
                }
            }
            await mkdir(destDir, { recursive: true });
            await copyFile(from, to);
            copied++;
        }
    }
    return copied;
}

// waitMs > 0 - чекати, поки інший запуск звільнить lock (pre-push з --push-now
// не повинен загубити свій push лише тому, що саме тоді йшов бекап зі Stop-хука).
async function withLock(stateDir, fn, waitMs = 0) {
    const lockFile = join(stateDir, 'lock');
    const deadline = Date.now() + waitMs;
    let handle;
    for (;;) {
        try {
            handle = await open(lockFile, 'wx');
            break;
        } catch {
            const st = await stat(lockFile).catch(() => null);
            if (st && Date.now() - st.mtimeMs >= LOCK_STALE_MS) {
                await unlink(lockFile).catch(() => {}); // завислий lock від упалого запуску
                continue;
            }
            if (Date.now() >= deadline) return 'locked';
            await new Promise((r) => setTimeout(r, 300));
        }
    }
    try {
        return await fn();
    } finally {
        await handle.close();
        await unlink(lockFile).catch(() => {});
    }
}

export async function backup({ projectsRoot, backupDir, pushNow = false, noPush = false, waitMs = pushNow ? 90000 : 0 }) {
    const stateDir = join(backupDir, '.backup-state');
    await mkdir(stateDir, { recursive: true });
    // службова тека (lock, лог, час пушу) - не частина бекапу
    const ignoreFile = join(backupDir, '.gitignore');
    if (!(await readFile(ignoreFile, 'utf8').catch(() => '')).includes('.backup-state/')) {
        await appendFile(ignoreFile, '.backup-state/\n');
    }
    return withLock(stateDir, async () => {
        // спершу свіже з remote; помилка тут летить у main() -> лог, нічого не закомічено
        if (!noPush && (await git(['remote'], backupDir)) !== '') {
            const up = await git(['rev-parse', '--abbrev-ref', '@{u}'], backupDir).catch(() => null);
            if (up) {
                await git(['fetch', '-q'], backupDir);
                if ((await git(['rev-list', '--count', 'HEAD..@{u}'], backupDir)) !== '0') {
                    await git(['pull', '-q', '--rebase', '--autostash'], backupDir);
                }
            }
        }
        const stale = [];
        const copied = await syncArch(projectsRoot, backupDir, stale);
        if (stale.length) {
            await appendFile(join(stateDir, 'log.txt'), `${new Date().toISOString()} stale (не скопійовано, в бекапі новіше): ${stale.join(', ')}\n`);
        }
        let committed = false;
        if (await git(['status', '--porcelain', '--untracked-files=all'], backupDir)) {
            await git(['add', '-A'], backupDir);
            const stamp = new Date().toLocaleString('sv-SE').slice(0, 16); // місцевий час, 2026-10-27 14:05
            await git(['commit', '-q', '-m', `backup ${stamp}`], backupDir);
            committed = true;
        }
        let pushed = false;
        if (!noPush) {
            const hasRemote = (await git(['remote'], backupDir)) !== '';
            const stampFile = join(stateDir, 'last-push');
            const last = Number(await readFile(stampFile, 'utf8').catch(() => '0')) || 0;
            // нема upstream (перший push у новий remote) - рахуємо як "є що пушити" і ставимо -u
            const upstream = hasRemote ? await git(['rev-parse', '--abbrev-ref', '@{u}'], backupDir).catch(() => null) : null;
            const ahead = !hasRemote ? '0' : upstream ? await git(['rev-list', '--count', '@{u}..HEAD'], backupDir) : '1';
            if (ahead !== '0' && (pushNow || Date.now() - last >= PUSH_EVERY_MS)) {
                const remote = (await git(['remote'], backupDir)).split('\n')[0];
                await git(upstream ? ['push', '-q'] : ['push', '-q', '-u', remote, 'HEAD'], backupDir);
                await writeFile(stampFile, String(Date.now()));
                pushed = true;
            }
        }
        return { copied, committed, pushed };
    }, waitMs);
}

async function main() {
    const [projectsRoot, backupDir, ...flags] = process.argv.slice(2);
    if (!projectsRoot || !backupDir) {
        console.error('usage: arch-backup.mjs <projectsRoot> <backupDir> [--push-now] [--no-push]');
        return;
    }
    const logFile = join(backupDir, '.backup-state', 'log.txt');
    try {
        const r = await backup({ projectsRoot, backupDir, pushNow: flags.includes('--push-now'), noPush: flags.includes('--no-push') });
        if (process.stdout.isTTY) console.log(JSON.stringify(r));
        if (r !== 'locked' && (r.committed || r.pushed)) await appendFile(logFile, `${new Date().toISOString()} ok ${JSON.stringify(r)}\n`);
    } catch (e) {
        await appendFile(logFile, `${new Date().toISOString()} ERROR ${e.message}\n`).catch(() => {});
    }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
