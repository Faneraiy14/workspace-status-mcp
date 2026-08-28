// release-drift.js — детектор "реліз відстав від джерела": для пари
// (репо з вихідним кодом, репо, що з нього тегує релізи) каже, скільки
// комітів у джерелі з'явилось відколи реліз востаннє тегувався, і
// наскільки давно найстарший із них. Мотивуючий приклад цієї ж сесії:
// NyxilumNode (реліз-репозиторій) відстав від NyxilumLang (джерело) на
// ~3 тижні - formatDate/parseDate, apostrophe-фікс лексера й купа іншого
// додалось у мову, а тег для нового білда ніхто не запушив, бо "коли
// згадаю" - типова ручна дія, яку легко забути.
//
// На відміну від sweep_status/check_docs, зв'язок "джерело -> реліз" НЕ
// вгадується автоматично зі структури тек (немає загального правила
// "тека X випускає теку Y") - викликач передає пари явно.

import { run } from './sweep.js';
import { join } from 'node:path';

async function latestTag(releasePath) {
    // --sort=-creatordate, не -v:refname: семверу може бракувати
    // (v1.10 сортувався б ПЕРЕД v1.9 як рядок), а нам треба саме
    // "останній за часом", не "найбільший номер".
    const result = await run(
        'git',
        ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)|%(creatordate:unix)', 'refs/tags'],
        releasePath,
    );
    if (!result.ok || !result.stdout) return null;
    const [firstLine] = result.stdout.split('\n');
    const [tag, ts] = firstLine.split('|');
    const tagTs = parseInt(ts, 10);
    if (!tag || !Number.isFinite(tagTs)) return null;
    return { tag, tagTs };
}

// Коміти джерела ПІСЛЯ вказаного unix-timestamp - лише кількість і
// таймстемп НАЙСТАРІШОГО з них (для "скільки днів це вже висить").
async function commitsAfter(sourcePath, sinceTs) {
    const result = await run(
        'git',
        ['log', `--since=@${sinceTs}`, '--format=%ct'],
        sourcePath,
    );
    if (!result.ok || !result.stdout) return { count: 0, oldestTs: null };
    const timestamps = result.stdout.split('\n').map((l) => parseInt(l, 10)).filter(Number.isFinite);
    if (timestamps.length === 0) return { count: 0, oldestTs: null };
    return { count: timestamps.length, oldestTs: Math.min(...timestamps) };
}

/**
 * @param {object} opts
 * @param {string} opts.projectsRoot - корінь із репозиторіями (типово ~/Projects)
 * @param {{source: string, release: string}[]} opts.pairs - пари назв тек:
 *   source - репо з вихідним кодом, release - репо, що з нього тегує релізи
 * @param {boolean} [opts.only_attention] - показати лише пари з реальним дрейфом (типово true)
 */
export async function checkReleaseDrift({ projectsRoot, pairs, only_attention = true } = {}) {
    if (!projectsRoot) throw new Error('projectsRoot обов\'язковий (напр. "/home/sviat/Projects")');
    if (!pairs || pairs.length === 0) {
        throw new Error('pairs обов\'язковий - явний список [{source, release}], автовизначення тут неможливе');
    }

    const results = [];
    for (const { source, release } of pairs) {
        const sourcePath = join(projectsRoot, source);
        const releasePath = join(projectsRoot, release);

        const tagInfo = await latestTag(releasePath);
        if (tagInfo === null) {
            results.push({ source, release, status: 'no-tags', message: `У ${release} ще немає жодного тегу` });
            continue;
        }

        const { count, oldestTs } = await commitsAfter(sourcePath, tagInfo.tagTs);
        if (count === 0) {
            results.push({
                source, release, status: 'current',
                latestTag: tagInfo.tag,
                tagCreatedAt: new Date(tagInfo.tagTs * 1000).toISOString(),
                commitsSinceTag: 0,
            });
            continue;
        }

        const oldestUnreleasedAgeDays = Math.floor((Date.now() / 1000 - oldestTs) / 86400);
        results.push({
            source, release, status: 'drifted',
            latestTag: tagInfo.tag,
            tagCreatedAt: new Date(tagInfo.tagTs * 1000).toISOString(),
            commitsSinceTag: count,
            oldestUnreleasedCommitAt: new Date(oldestTs * 1000).toISOString(),
            oldestUnreleasedAgeDays,
        });
    }

    const filtered = only_attention ? results.filter((r) => r.status !== 'current') : results;
    return {
        checked: results.length,
        drifted: results.filter((r) => r.status === 'drifted').length,
        pairs: filtered,
    };
}
