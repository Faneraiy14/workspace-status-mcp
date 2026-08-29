#!/usr/bin/env node
// check-docs-reminder.mjs — Claude Code hook (SessionStart + Stop) that
// closes the gap write_doc/check_docs alone can't: nothing forced Claude
// to actually CALL check_docs, so a stale Architecture/<repo>.txt could
// go unnoticed for an entire session. This runs checkDocs() itself
// (the same function workspace-status-mcp's check_docs tool wraps) and,
// only when the CURRENT repo's doc is missing/stale, injects a reminder
// into Claude's context via hookSpecificOutput.additionalContext.
//
// Deliberately non-blocking (no decision:"block") - a stale doc isn't a
// safety issue worth halting a turn over, just something Claude should
// remember to fix. SessionStart covers "forgot last session"; Stop
// (which fires each time Claude's turn ends, not only at true session
// end) covers "forgot within THIS session" - it re-checks every turn,
// but is cheap (a few local git commands) and self-quiets the moment
// write_doc actually gets called, since the doc stops being stale.
//
// Not tied to any one person's folder layout: optional PROJECTS_ROOT/
// DOCS_ROOT CLI args (argv[3]/argv[4]) or env vars of the same name
// override the ~/Projects default - anyone can point this at their own
// layout, and repoint it later just by editing that one line, no code
// change. CLI args (not env-var shell syntax like FOO=bar cmd) are the
// registration form the README recommends, since "VAR=val command" only
// works in a POSIX shell - Windows' PowerShell/cmd don't parse it that
// way, and this hook needs to register identically on both.
//
// Opt-in gate: if docsRoot doesn't exist on disk AT ALL, this stays fully
// silent - someone who's never used the Architecture-doc convention (e.g.
// a colleague trying these tools for the first time) would otherwise get
// nagged about EVERY repo being "missing" forever. Once the folder exists
// (even empty - created manually, or automatically by write_doc() writing
// its first doc), per-repo missing/stale reminders start firing normally.

import { checkDocs } from '../src/docs.js';
import { homedir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { stat } from 'node:fs/promises';

const MAX_WALK_UP = 6;

async function findRepoUnderProjects(startDir, projectsRoot) {
    let dir = startDir;
    for (let i = 0; i < MAX_WALK_UP; i++) {
        const hasGit = await stat(join(dir, '.git')).then(() => true).catch(() => false);
        if (hasGit && dirname(dir) === projectsRoot) {
            return basename(dir);
        }
        const parent = dirname(dir);
        if (parent === dir) break; // корінь файлової системи
        dir = parent;
    }
    return null;
}

async function main() {
    const hookEventName = process.argv[2] || 'SessionStart';
    const projectsRoot = process.argv[3] || process.env.PROJECTS_ROOT || join(homedir(), 'Projects');
    const docsRoot = process.argv[4] || process.env.DOCS_ROOT || join(projectsRoot, 'Architecture');

    const docsRootExists = await stat(docsRoot).then(() => true).catch(() => false);
    if (!docsRootExists) return; // ніхто ще не почав користуватись конвенцією на цій машині

    const repo = await findRepoUnderProjects(process.cwd(), projectsRoot);
    if (!repo) return; // не в межах <projectsRoot>/<repo> - не наш кейс, тихо виходимо

    let result;
    try {
        result = await checkDocs({ projectsRoot, docsRoot, repos: [repo], only_attention: true });
    } catch {
        return; // check_docs сам не повинен зривати сесію користувача
    }

    const entry = result.repos[0];
    if (!entry) return; // 'current' чи 'no-commits' - only_attention їх уже відфільтрував

    const detail = entry.trackingMethod === 'commit'
        ? `${entry.commitsSinceWrite} комітів з моменту останнього write_doc`
        : entry.status === 'missing' ? 'документа ще не існує' : `застарів за mtime (${entry.docPath})`;

    // join(), не рядкова конкатенація з "/" - на Windows роздільник інший.
    const message = `[Нагадування Architecture-документації] ${join(docsRoot, repo + '.txt')}: ` +
        `${entry.status} - ${detail}. Якщо в цій сесії було реальне дослідження/зміни в ${repo}, ` +
        `виклич workspace-status write_doc перед завершенням роботи над ним - не покладайся на пам'ять.`;

    console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName, additionalContext: message },
    }));
}

// Хук ніколи не повинен зривати сесію користувача через власну помилку -
// раніше за це відповідав "|| true" у bash-команді реєстрації, але той
// синтаксис не кросплатформний (не працює як env-присвоєння в
// PowerShell/cmd), тож тепер про це подбано напряму в скрипті.
main().catch(() => {});
