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
// WATCH POINTS - not everything necessarily lives under one root (a repo
// can get moved out of ~/Projects onto the Desktop, say, with its doc
// sitting right next to it there instead of in a central Architecture/
// folder). Points are resolved in this priority order:
//   1. CLI args argv[3]/argv[4] - one-off single-point override (mainly
//      for tests/quick overrides), projectsRoot then optional docsRoot.
//   2. The watch-points config file (default
//      ~/.claude/workspace-status-points.json, overridable via
//      WATCH_POINTS_FILE) - the normal, PERSISTENT way to manage this:
//      {"points":[{"projectsRoot":"...","docsRoot":"..."},...]}. Add a
//      point, remove one (or all), or redirect an existing one just by
//      editing this file - no code change, no re-registering the hook.
//   3. PROJECTS_ROOT/DOCS_ROOT env vars - single-point fallback for
//      anyone registering the hook through a shell command instead of
//      the args-array exec form.
//   4. Default: a single point at <home>/Projects.
// Each point is tried in array order; the first one whose projectsRoot
// contains the current repo wins - so more specific/preferred points
// should come first if points ever overlap.
//
// Opt-in gate: if a point's docsRoot doesn't exist on disk AT ALL, that
// point stays fully silent - someone who's never used the Architecture-
// doc convention (e.g. a colleague trying these tools for the first
// time) would otherwise get nagged about EVERY repo being "missing"
// forever. Once the folder exists (even empty - created manually, or
// automatically by write_doc() writing its first doc), per-repo
// missing/stale reminders start firing normally for that point.

import { checkDocs } from '../src/docs.js';
import { homedir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { stat, readFile } from 'node:fs/promises';

const MAX_WALK_UP = 6;

// path.dirname() ніколи не повертає кінцевий роздільник (окрім самого
// кореня файлової системи), тож findRepoUnderProjects() порівнює його
// напряму з рядком - projectsRoot із зайвим кінцевим "/" чи "\"
// (легка людська помилка при ручному редагуванні конфіг-файлу) робив
// би === завжди false, і точка тихо ніколи б не спрацьовувала, без
// жодної помилки чи попередження. Перевірено живим відтворенням.
function stripTrailingSep(p) {
    return p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
}

function normalizePoint(point) {
    return {
        projectsRoot: stripTrailingSep(point.projectsRoot),
        docsRoot: point.docsRoot ? stripTrailingSep(point.docsRoot) : point.docsRoot,
    };
}

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

async function loadPointsFromFile(filePath) {
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        const points = Array.isArray(parsed.points) ? parsed.points : null;
        if (!points || points.length === 0) return null;
        return points.filter((p) => p && typeof p.projectsRoot === 'string');
    } catch {
        return null; // нема файлу, пошкоджений JSON, чи points порожній/відсутній
    }
}

async function resolvePoints() {
    if (process.argv[3]) {
        return [{ projectsRoot: process.argv[3], docsRoot: process.argv[4] || undefined }];
    }

    const configPath = process.env.WATCH_POINTS_FILE || join(homedir(), '.claude', 'workspace-status-points.json');
    const fromFile = await loadPointsFromFile(configPath);
    if (fromFile) return fromFile;

    if (process.env.PROJECTS_ROOT) {
        return [{ projectsRoot: process.env.PROJECTS_ROOT, docsRoot: process.env.DOCS_ROOT || undefined }];
    }

    return [{ projectsRoot: join(homedir(), 'Projects') }];
}

async function main() {
    const hookEventName = process.argv[2] || 'SessionStart';
    const points = (await resolvePoints()).map(normalizePoint);

    let matchedPoint = null;
    let repo = null;
    for (const point of points) {
        repo = await findRepoUnderProjects(process.cwd(), point.projectsRoot);
        if (repo) {
            matchedPoint = point;
            break;
        }
    }
    if (!matchedPoint) return; // жодна точка не покриває поточну робочу теку - тихо виходимо

    const docsRoot = matchedPoint.docsRoot || join(matchedPoint.projectsRoot, 'Architecture');
    const docsRootExists = await stat(docsRoot).then(() => true).catch(() => false);
    if (!docsRootExists) return; // ніхто ще не почав користуватись конвенцією для цієї точки

    let result;
    try {
        result = await checkDocs({ projectsRoot: matchedPoint.projectsRoot, docsRoot, repos: [repo], only_attention: true });
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
