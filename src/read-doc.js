// read-doc.js — читання документації репо ЧАСТКАМИ, щоб не вантажити в контекст
// 100+ КБ документа заради одного абзацу. Документація - тека <repo>/.arch/ з кількома
// .txt (README.txt, теми, changelog.txt), або старий один <docsRoot>/<repo>.txt (arch.js).
//
// Режими:
//   - без section/query -> перелік файлів .arch/ + ЗМІСТ README.txt (чи file) з діапазонами рядків;
//   - section (номер зі змісту або фрагмент заголовка) -> текст цього розділу файлу file (типово README.txt);
//   - query (слова) -> лише збіг-рядки з контекстом ±1 і назвою розділу; без file - по всіх файлах.
// Заголовок у цих документах бува різний (їх писали різні сесії), тому розпізнаємо 4 види:
//   1) рядок, під яким рядок із ----/====;   2) "## Заголовок" (markdown);
//   3) рядок ВЕЛИКИМИ ЛІТЕРАМИ;              4) початок датованого запису "ДД.ММ.РРРР ..." / "ДОДАНО ...";
//   5) рамка запису "--- Назва ---" / "=== Назва ===" / "== Назва ==" чи "[РРРР-ММ-ДД] Назва".

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { locate, listDocFiles, checkFileName, DEFAULT_FILE } from './arch.js';

const UNDERLINE = /^\s*([-=])\1{3,}\s*$/;
const MD_HEAD = /^#{1,4}\s+\S/;
const CAPS_HEAD = /^[A-ZА-ЯІЇЄҐ][A-ZА-ЯІЇЄҐ0-9 ,.:()/«»"'—–+-]{5,}$/;
const ENTRY_HEAD = /^(?:(?:---|===|==) \S|\[\d{4}-\d{2}-\d{2}\] \S)/;
const DATED_HEAD = /^(?:\d{2}\.\d{2}\.\d{4}(?:\s*[(:—–-]|\s+\S)|ДОДАНО(?![А-Яа-яІіЇїЄєҐґ]))/;

// "--- Назва\n    (дата) ---" -> "Назва (дата)": рамка буває на два рядки.
function entryTitle(line, next) {
    let t = line.replace(/^(?:---|===|==) /, '').trim();
    if (/^(?:---|===) /.test(line) && !/(?:---|===)\s*$/.test(t) && next && /(?:---|===)\s*$/.test(next)) t += ' ' + next.trim();
    return t.replace(/\s*(?:---|===|==)$/, '');
}

/** Розбиває текст на розділи. Повертає [{index, title, start, end, kind}], start/end — 0-based рядки, end не включно. */
export function parseOutline(text) {
    const lines = text.split('\n');
    const heads = [];
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim() || UNDERLINE.test(l)) continue;
        let kind = null;
        if (i + 1 < lines.length && UNDERLINE.test(lines[i + 1]) && l.trim().length > 1) kind = 'underline';
        else if (MD_HEAD.test(l)) kind = 'markdown';
        else if (CAPS_HEAD.test(l.trim()) && l.trim().length <= 80) kind = 'caps';
        else if (DATED_HEAD.test(l)) kind = 'dated';
        else if (ENTRY_HEAD.test(l)) kind = 'entry';
        if (kind) heads.push({ start: i, title: kind === 'entry' ? entryTitle(l, lines[i + 1]) : l.replace(/^#+\s*/, '').trim(), kind });
    }
    // заголовок "==== / Назва / ====" (рамка): перший underline-заголовок вже взято, не дублюємо
    const sections = [];
    if (heads.length === 0 || heads[0].start > 0) {
        sections.push({ title: '(початок документа)', start: 0, end: heads[0] ? heads[0].start : lines.length, kind: 'preamble' });
    }
    heads.forEach((h, k) => sections.push({ title: h.title, start: h.start, end: k + 1 < heads.length ? heads[k + 1].start : lines.length, kind: h.kind }));
    return sections.filter(s => s.end > s.start).map((s, i) => ({ index: i + 1, ...s }));
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} КБ` : `${n} Б`);

function outlineText(lines, sections, name) {
    const total = lines.join('\n').length;
    const out = [`${name} — ${lines.length} рядків, ${total} символів, ${sections.length} розділів.`,
        'Прочитати розділ: section=<номер або фрагмент заголовка>. Шукати слова: query="...".', ''];
    for (const s of sections) {
        const size = lines.slice(s.start, s.end).join('\n').length;
        out.push(`${String(s.index).padStart(3)}. [${s.start + 1}-${s.end}, ~${size} симв.] ${clip(s.title, 90)}`);
    }
    return out.join('\n');
}

// Збіги у ОДНОМУ файлі: [{block}] з назвою розділу; label - префікс для пошуку по кількох файлах.
function findHits(text, words, label) {
    const lines = text.split('\n');
    const sections = parseOutline(text);
    const secOf = (ln) => sections.find(s => ln >= s.start && ln < s.end);
    const blocks = [];
    let lastEnd = -1;
    for (let i = 0; i < lines.length; i++) {
        if (i <= lastEnd) continue;
        const low = lines[i].toLowerCase();
        if (!words.every(w => low.includes(w))) continue;
        const a = Math.max(0, i - 1), b = Math.min(lines.length - 1, i + 1);
        const sec = secOf(i);
        blocks.push(`— ${label}розділ ${sec ? sec.index : '?'} «${clip(sec ? sec.title : '', 50)}», рядки ${a + 1}-${b + 1}:\n${lines.slice(a, b + 1).join('\n')}`);
        lastEnd = b;
    }
    return blocks;
}

/**
 * @param {object} o
 * @param {string} [o.projectsRoot] типово ~/Projects
 * @param {string} o.repo
 * @param {string} [o.file] файл у <repo>/.arch/ (типово README.txt; для query без file - усі файли)
 * @param {string} [o.docsRoot] стара центральна тека з <repo>.txt; якщо не задано - <repo>/.arch/
 * @param {string|number} [o.section] номер зі змісту або фрагмент заголовка
 * @param {string} [o.query] слова для пошуку (всі мають бути в рядку; без урахування регістру)
 * @param {number} [o.max_chars=6000] ліміт відповіді
 * @param {number} [o.offset=0] з якого символу продовжити (для довгого розділу, що був обрізаний)
 */
export async function readDoc(o) {
    const projectsRoot = o.projectsRoot || join(homedir(), 'Projects');
    if (!/^[\w.\-`]+$/.test(o.repo || '') || o.repo.startsWith('.')) throw new Error('repo: лише літери/цифри/._-');
    const maxChars = Math.max(500, Math.min(o.max_chars ?? 6000, 40000));
    const loc = locate({ projectsRoot, docsRoot: o.docsRoot, repo: o.repo });
    const files = await listDocFiles(loc);
    if (!files.length) return { ok: false, text: `Документації ${o.repo} нема в ${loc.layout === 'central' ? join(loc.dir, loc.centralFile) : loc.dir}` };

    let target = null; // явно вибраний файл
    if (o.file) {
        const name = checkFileName(o.file);
        target = files.find(f => f.name === name);
        if (!target) return { ok: false, text: `Файлу ${name} нема. Є: ${files.map(f => f.name).join(', ')}` };
    }
    const label = (f) => `${o.repo}/${loc.layout === 'central' ? '' : '.arch/'}${f.name}`;

    if (o.query && String(o.query).trim()) {
        const words = String(o.query).toLowerCase().split(/\s+/).filter(Boolean);
        const scope = target ? [target] : files;
        const hits = [];
        for (const f of scope) {
            const prefix = scope.length > 1 ? `${f.name}, ` : '';
            hits.push(...findHits(await readFile(f.path, 'utf8'), words, prefix));
        }
        const where = scope.length > 1 ? `${o.repo} (${scope.length} файлів)` : label(scope[0]);
        if (!hits.length) return { ok: true, text: `Нічого не знайдено за «${o.query}» у ${where}` };
        const out = [`${hits.length} збігів за «${o.query}» у ${where}:`];
        let size = out[0].length, shown = 0;
        for (const block of hits) {
            if (size + block.length > maxChars && shown > 0) { out.push(`… ще ${hits.length - shown} збігів не вміщено (звузь query або збільш max_chars)`); break; }
            out.push(block); size += block.length; shown++;
        }
        return { ok: true, text: out.join('\n\n') };
    }

    const f = target || files.find(x => x.name === DEFAULT_FILE) || files[0];
    const text = await readFile(f.path, 'utf8');
    const lines = text.split('\n');
    const sections = parseOutline(text);

    if (o.section === undefined || o.section === null || o.section === '') {
        const toc = outlineText(lines, sections, label(f));
        if (files.length === 1 || target) return { ok: true, text: toc };
        const list = [`${o.repo}/.arch/ — ${files.length} файлів. Інший файл: file="<назва>". Пошук по всіх: query="...".`];
        for (const x of files) list.push(`  ${x.name}  (${kb(x.size)})`);
        return { ok: true, text: list.join('\n') + '\n\n' + toc };
    }

    let picked = [];
    const sec = String(o.section).trim();
    if (/^\d+$/.test(sec)) picked = sections.filter(s => s.index === Number(sec));
    else picked = sections.filter(s => s.title.toLowerCase().includes(sec.toLowerCase()));
    if (!picked.length) return { ok: false, text: `Розділу «${sec}» нема. Зміст:\n` + outlineText(lines, sections, label(f)) };
    if (picked.length > 1) {
        return { ok: true, text: `«${sec}» збігається з ${picked.length} розділами — уточни номер:\n` + picked.map(s => `${String(s.index).padStart(3)}. [${s.start + 1}-${s.end}] ${clip(s.title, 90)}`).join('\n') };
    }
    const s = picked[0];
    const body = lines.slice(s.start, s.end).join('\n');
    const off = Math.max(0, o.offset || 0);
    const piece = body.slice(off, off + maxChars);
    const rest = body.length - off - piece.length;
    const hdr = `[${label(f)}, розділ ${s.index}/${sections.length}, рядки ${s.start + 1}-${s.end}]\n`;
    return { ok: true, text: hdr + piece + (rest > 0 ? `\n… обрізано, лишилось ${rest} символів: повтори з offset=${off + piece.length}` : '') };
}
