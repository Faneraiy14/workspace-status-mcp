// arch.js — де лежить документація репо і з яких файлів вона складається.
//
// Дві схеми розміщення:
// - in-repo (типова): <projectsRoot>/<repo>/.arch/ - тека з кількома .txt
//   (README.txt - огляд, тематичні файли, changelog.txt - датовані записи)
//   і .arch/.meta.json поруч. Дока лежить у самому проєкті, під рукою, а
//   глобальний gitignore (".arch/") не пускає її в публічний репо.
// - central (стара, для сумісності): один <docsRoot>/<repo>.txt і
//   <docsRoot>/.meta/<repo>.json. Вмикається, лише якщо docsRoot передано
//   ЯВНО - хто вже користувався пакетом зі своєю Architecture-текою, нічого
//   не помітить.
//
// Обидві схеми віддають однаковий "вигляд" (список файлів + шлях мети), тож
// docs/read-doc/write-doc не розгалужуються на кожному кроці.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const ARCH_DIR = '.arch';
export const DEFAULT_FILE = 'README.txt';

// Ім'я файлу всередині .arch/: без "/" і "..", лише .txt - щоб write_doc
// не міг записати кудись поза теку документації.
export function checkFileName(file) {
    if (!/^[\w.\-]+\.txt$/.test(file) || file.startsWith('.')) {
        throw new Error(`file: лише ім'я .txt без шляху (напр. "changelog.txt"), отримано "${file}"`);
    }
    return file;
}

/**
 * @returns {{layout: 'in-repo'|'central', dir: string, metaFile: string, repoPath: string, centralFile?: string}}
 */
export function locate({ projectsRoot, docsRoot, repo }) {
    const repoPath = join(projectsRoot, repo);
    if (docsRoot) {
        return {
            layout: 'central',
            dir: docsRoot,
            metaFile: join(docsRoot, '.meta', `${repo}.json`),
            repoPath,
            centralFile: `${repo}.txt`,
        };
    }
    const dir = join(repoPath, ARCH_DIR);
    return { layout: 'in-repo', dir, metaFile: join(dir, '.meta.json'), repoPath };
}

// Порядок для показу: README першим, changelog останнім, решта за абеткою.
function rank(name) {
    if (name === DEFAULT_FILE) return 0;
    if (name === 'changelog.txt') return 2;
    return 1;
}

/** Файли документації: [{name, path, size, mtimeMs}]; [] якщо документації нема. */
export async function listDocFiles(loc) {
    if (loc.layout === 'central') {
        const path = join(loc.dir, loc.centralFile);
        const st = await stat(path).catch(() => null);
        return st && st.isFile() ? [{ name: loc.centralFile, path, size: st.size, mtimeMs: st.mtimeMs }] : [];
    }
    let entries;
    try {
        entries = await readdir(loc.dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const files = [];
    for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.txt') || e.name.startsWith('.')) continue;
        const path = join(loc.dir, e.name);
        const st = await stat(path);
        files.push({ name: e.name, path, size: st.size, mtimeMs: st.mtimeMs });
    }
    return files.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
