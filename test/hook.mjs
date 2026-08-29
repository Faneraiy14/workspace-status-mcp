// hook.mjs — check-docs-reminder.mjs (Claude Code SessionStart/Stop hook)
// проти тимчасового фіктивного дерева, що імітує ~/Projects/<repo>: сам
// скрипт - не бібліотечна функція, а CLI-точка входу, тож перевіряємо
// його як реальний підпроцес (cwd + stdin), а не імпортом.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDoc } from '../src/write-doc.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = join(__dirname, '..', 'hooks', 'check-docs-reminder.mjs');

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

async function runHook(cwd, event = 'SessionStart') {
    try {
        const { stdout } = await execFileAsync('node', [HOOK_SCRIPT, event], { cwd, env: { ...process.env } });
        return stdout.trim();
    } catch (err) {
        return { error: err };
    }
}

test('check-docs-reminder: мовчить поза текою з проєктами', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'not-projects-'));
    try {
        const out = await runHook(outside);
        assert.equal(out, '');
    } finally {
        await rm(outside, { recursive: true, force: true });
    }
});

test('check-docs-reminder: мовчить для чистого (up-to-date) репо', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projects-'));
    const projectsRoot = join(root, 'Projects');
    const repoPath = join(projectsRoot, 'proj');
    try {
        await makeRepoWithCommit(repoPath);
        await writeDoc({ projectsRoot, repo: 'proj', content: 'опис', docsRoot: join(projectsRoot, 'Architecture') });

        const out = await runHookWithHome(repoPath, root);
        assert.equal(out, '');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('check-docs-reminder: нагадує для застарілого (missing) документа й спрацьовує з підтеки репо', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projects-'));
    const projectsRoot = join(root, 'Projects');
    const repoPath = join(projectsRoot, 'proj');
    const subDir = join(repoPath, 'src', 'nested');
    try {
        await makeRepoWithCommit(repoPath);
        await mkdir(subDir, { recursive: true });
        // Architecture/ вже існує (конвенція в цьому "домі" вже в
        // користуванні) - лише для ЦЬОГО репо документа ще нема.
        await mkdir(join(projectsRoot, 'Architecture'), { recursive: true });

        const out = await runHookWithHome(subDir, root, 'Stop');
        assert.notEqual(out, '');
        const parsed = JSON.parse(out);
        assert.equal(parsed.hookSpecificOutput.hookEventName, 'Stop');
        assert.match(parsed.hookSpecificOutput.additionalContext, /proj\.txt/);
        assert.match(parsed.hookSpecificOutput.additionalContext, /missing/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

// HOME підмінюємо, бо findRepoUnderProjects() шукає homedir()/Projects,
// а фіктивний "projectsRoot" у тесті - тимчасова тека, не справжня ~/Projects.
async function runHookWithHome(cwd, fakeHome, event = 'SessionStart') {
    const { stdout } = await execFileAsync('node', [HOOK_SCRIPT, event], {
        cwd,
        env: { ...process.env, HOME: fakeHome },
    });
    return stdout.trim();
}

test('check-docs-reminder: мовчить, якщо теки Architecture взагалі не існує (ніхто ще не почав користуватись конвенцією)', async () => {
    // Симулює дядю Вову - реальний репо, реальні коміти, але жодного
    // разу write_doc не викликаний і Architecture-теку ніхто не створював
    // вручну. Без цієї перевірки check_docs повернув би 'missing' для
    // КОЖНОГО репо, і хук нагадував би про це щосесії/щоходу - шум для
    // людини, яка ще навіть не бачила цю конвенцію.
    const root = await mkdtemp(join(tmpdir(), 'projects-'));
    const projectsRoot = join(root, 'Projects');
    const repoPath = join(projectsRoot, 'proj');
    try {
        await makeRepoWithCommit(repoPath);
        // Architecture/ навмисно НЕ створюємо.

        const out = await runHookWithHome(repoPath, root);
        assert.equal(out, '');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('check-docs-reminder: env-змінні PROJECTS_ROOT/DOCS_ROOT дозволяють вказати довільну теку, не лише ~/Projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'custom-layout-'));
    const projectsRoot = join(root, 'dev'); // навмисно НЕ "Projects"
    const docsRoot = join(root, 'docs', 'arch'); // навмисно НЕ "<projectsRoot>/Architecture"
    const repoPath = join(projectsRoot, 'proj');
    try {
        await makeRepoWithCommit(repoPath);
        await writeDoc({ projectsRoot, repo: 'proj', content: 'опис', docsRoot });

        // Фіктивний HOME - інакше на реальній машині пріоритетним джерелом
        // стане РЕАЛЬНИЙ ~/.claude/workspace-status-points.json (якщо він
        // існує), а не ці env-змінні; тут цілять саме в них.
        const { stdout } = await execFileAsync('node', [HOOK_SCRIPT, 'SessionStart'], {
            cwd: repoPath,
            env: { ...process.env, HOME: root, PROJECTS_ROOT: projectsRoot, DOCS_ROOT: docsRoot },
        });
        assert.equal(stdout.trim(), '', 'щойно записаний write_doc-документ - актуальний, тиша');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('check-docs-reminder: конфіг-файл watch-points (WATCH_POINTS_FILE) підтримує кілька незалежних точок', async () => {
    // Саме той сценарій, заради якого зроблено конфіг-файл: репо на
    // "робочому столі" (точка 2) поруч із документом прямо там, і решта
    // репо в "Projects" (точка 1) - обидві перевіряються одним хуком, і
    // можна прибрати/додати/перенаправити точку простою зміною JSON, без
    // зміни коду чи перереєстрації хука.
    const root = await mkdtemp(join(tmpdir(), 'watch-points-'));
    const projectsRoot = join(root, 'Projects');
    const desktopRoot = join(root, 'Desktop');
    const configPath = join(root, 'points.json');

    try {
        await makeRepoWithCommit(join(projectsRoot, 'proj-a'));
        await mkdir(join(projectsRoot, 'Architecture'), { recursive: true }); // конвенція в цій точці вже "в користуванні"

        await makeRepoWithCommit(join(desktopRoot, 'proj-b'));
        // desktopRoot і так існує (тільки-но створений makeRepoWithCommit) - opt-in gate для точки 2 задовольняється docsRoot === desktopRoot самим.

        await writeFile(configPath, JSON.stringify({
            points: [
                { projectsRoot },
                { projectsRoot: desktopRoot, docsRoot: desktopRoot },
            ],
        }));

        const outA = await execFileAsync('node', [HOOK_SCRIPT, 'SessionStart'], {
            cwd: join(projectsRoot, 'proj-a'),
            env: { ...process.env, WATCH_POINTS_FILE: configPath },
        }).then((r) => r.stdout.trim());
        assert.notEqual(outA, '');
        assert.match(JSON.parse(outA).hookSpecificOutput.additionalContext, /missing/);

        const outB = await execFileAsync('node', [HOOK_SCRIPT, 'SessionStart'], {
            cwd: join(desktopRoot, 'proj-b'),
            env: { ...process.env, WATCH_POINTS_FILE: configPath },
        }).then((r) => r.stdout.trim());
        assert.notEqual(outB, '');
        assert.match(JSON.parse(outB).hookSpecificOutput.additionalContext, new RegExp(`${desktopRoot.replace(/[/\\]/g, '.')}.*proj-b\\.txt`));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('check-docs-reminder: конфіг-файл з порожнім/відсутнім points - відкат на PROJECTS_ROOT/дефолт', async () => {
    const root = await mkdtemp(join(tmpdir(), 'watch-points-empty-'));
    const configPath = join(root, 'empty-points.json');
    try {
        await writeFile(configPath, JSON.stringify({ points: [] }));

        const outsideRoot = join(root, 'nowhere');
        await mkdir(outsideRoot, { recursive: true });
        const out = await execFileAsync('node', [HOOK_SCRIPT, 'SessionStart'], {
            cwd: outsideRoot,
            env: { ...process.env, HOME: root, WATCH_POINTS_FILE: configPath },
        }).then((r) => r.stdout.trim());
        assert.equal(out, '', 'порожній points у файлі - як відсутній файл, тихий відкат далі по ланцюжку');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('check-docs-reminder: CLI-аргументи (рекомендована, кросплатформна форма реєстрації) дають той самий результат', async () => {
    // Реєстрація в settings.json навмисно НЕ використовує bash-синтаксис
    // "VAR=val команда" (не парситься так у PowerShell/cmd на Windows) -
    // тека передається позиційними аргументами, обробленими "exec form"
    // (args-масив, без будь-якого шелу взагалі), тож цей шлях мусить
    // працювати ідентично env-змінним.
    const root = await mkdtemp(join(tmpdir(), 'custom-layout-args-'));
    const projectsRoot = join(root, 'dev');
    const docsRoot = join(root, 'docs', 'arch');
    const repoPath = join(projectsRoot, 'proj');
    try {
        await makeRepoWithCommit(repoPath);
        // Документа НЕ пишемо - очікуємо 'missing' через аргументи.
        await mkdir(docsRoot, { recursive: true }); // конвенція вже "в користуванні"

        const { stdout } = await execFileAsync(
            'node',
            [HOOK_SCRIPT, 'SessionStart', projectsRoot, docsRoot],
            { cwd: repoPath, env: process.env }
        );
        const out = stdout.trim();
        assert.notEqual(out, '');
        const parsed = JSON.parse(out);
        assert.match(parsed.hookSpecificOutput.additionalContext, /missing/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
