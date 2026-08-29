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
