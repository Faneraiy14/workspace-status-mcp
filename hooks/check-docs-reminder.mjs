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
// Walks up from cwd to find the nearest ancestor directory that is both
// a git repo AND a direct child of ~/Projects - covers Claude having cd'd
// into a subdirectory of the repo, not just the repo root itself.

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
    const projectsRoot = join(homedir(), 'Projects');
    const repo = await findRepoUnderProjects(process.cwd(), projectsRoot);
    if (!repo) return; // не в межах ~/Projects/<repo> - не наш кейс, тихо виходимо

    let result;
    try {
        result = await checkDocs({ projectsRoot, repos: [repo], only_attention: true });
    } catch {
        return; // check_docs сам не повинен зривати сесію користувача
    }

    const entry = result.repos[0];
    if (!entry) return; // 'current' чи 'no-commits' - only_attention їх уже відфільтрував

    const detail = entry.trackingMethod === 'commit'
        ? `${entry.commitsSinceWrite} комітів з моменту останнього write_doc`
        : entry.status === 'missing' ? 'документа ще не існує' : `застарів за mtime (${entry.docPath})`;

    const message = `[Нагадування Architecture-документації] ~/Projects/Architecture/${repo}.txt: ` +
        `${entry.status} - ${detail}. Якщо в цій сесії було реальне дослідження/зміни в ${repo}, ` +
        `виклич workspace-status write_doc перед завершенням роботи над ним - не покладайся на пам'ять.`;

    console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName, additionalContext: message },
    }));
}

main();
