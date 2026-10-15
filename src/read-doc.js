// read-doc.js — читання Architecture/<repo>.txt ЧАСТКАМИ, щоб не вантажити в контекст
// 100+ КБ документа заради одного абзацу (NyxilumLang.txt ~147 КБ, NyxOS.txt ~137 КБ).
//
// Три режими:
//   - без section/query -> ЗМІСТ: нумеровані розділи з діапазоном рядків і розміром;
//   - section (номер зі змісту або фрагмент заголовка) -> текст цього розділу;
//   - query (слова) -> лише збіг-рядки з контекстом ±1 і назвою розділу.
// Заголовок у цих документах бува різний (їх писали різні сесії), тому розпізнаємо 4 види:
//   1) рядок, під яким рядок із ----/====;   2) "## Заголовок" (markdown);
//   3) рядок ВЕЛИКИМИ ЛІТЕРАМИ;              4) початок датованого запису "ДД.ММ.РРРР ..." / "ДОДАНО ...".

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const UNDERLINE = /^\s*([-=])\1{3,}\s*$/;
const MD_HEAD = /^#{1,4}\s+\S/;
const CAPS_HEAD = /^[A-ZА-ЯІЇЄҐ][A-ZА-ЯІЇЄҐ0-9 ,.:()/«»"'—–+-]{5,}$/;
const DATED_HEAD = /^(?:\d{2}\.\d{2}\.\d{4}(?:\s*[(:—–-]|\s+\S)|ДОДАНО(?![А-Яа-яІіЇїЄєҐґ]))/;

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
        if (kind) heads.push({ start: i, title: l.replace(/^#+\s*/, '').trim(), kind });
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

function outlineText(lines, sections, repo) {
    const total = lines.join('\n').length;
    const out = [`${repo}.txt — ${lines.length} рядків, ${total} символів, ${sections.length} розділів.`,
        'Прочитати розділ: section=<номер або фрагмент заголовка>. Шукати слова: query="...".', ''];
    for (const s of sections) {
        const size = lines.slice(s.start, s.end).join('\n').length;
        out.push(`${String(s.index).padStart(3)}. [${s.start + 1}-${s.end}, ~${size} симв.] ${clip(s.title, 90)}`);
    }
    return out.join('\n');
}

/**
 * @param {object} o
 * @param {string} [o.projectsRoot] типово ~/Projects
 * @param {string} o.repo
 * @param {string} [o.docsRoot] типово <projectsRoot>/Architecture
 * @param {string|number} [o.section] номер зі змісту або фрагмент заголовка
 * @param {string} [o.query] слова для пошуку (всі мають бути в рядку; без урахування регістру)
 * @param {number} [o.max_chars=6000] ліміт відповіді
 * @param {number} [o.offset=0] з якого символу продовжити (для довгого розділу, що був обрізаний)
 */
export async function readDoc(o) {
    const projectsRoot = o.projectsRoot || join(homedir(), 'Projects');
    const docsRoot = o.docsRoot || join(projectsRoot, 'Architecture');
    if (!/^[\w.\-]+$/.test(o.repo || '')) throw new Error('repo: лише літери/цифри/._-');
    const maxChars = Math.max(500, Math.min(o.max_chars ?? 6000, 40000));
    let text;
    try {
        text = await readFile(join(docsRoot, `${o.repo}.txt`), 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return { ok: false, text: `Документа ${o.repo}.txt нема в ${docsRoot}` };
        throw e;
    }
    const lines = text.split('\n');
    const sections = parseOutline(text);

    if (o.query && String(o.query).trim()) {
        const words = String(o.query).toLowerCase().split(/\s+/).filter(Boolean);
        const hits = [];
        const secOf = (ln) => sections.find(s => ln >= s.start && ln < s.end);
        for (let i = 0; i < lines.length; i++) {
            const low = lines[i].toLowerCase();
            if (words.every(w => low.includes(w))) hits.push(i);
        }
        if (!hits.length) return { ok: true, text: `Нічого не знайдено за «${o.query}» у ${o.repo}.txt` };
        const out = [`${hits.length} збігів за «${o.query}» у ${o.repo}.txt:`];
        let size = out[0].length, shown = 0, lastEnd = -1;
        for (const i of hits) {
            if (i <= lastEnd) continue;
            const a = Math.max(0, i - 1), b = Math.min(lines.length - 1, i + 1);
            const sec = secOf(i);
            const block = `— розділ ${sec ? sec.index : '?'} «${clip(sec ? sec.title : '', 50)}», рядки ${a + 1}-${b + 1}:\n${lines.slice(a, b + 1).join('\n')}`;
            if (size + block.length > maxChars && shown > 0) { out.push(`… ще ${hits.length - shown} збігів не вміщено (звузь query або збільш max_chars)`); break; }
            out.push(block); size += block.length; shown++; lastEnd = b;
        }
        return { ok: true, text: out.join('\n\n') };
    }

    if (o.section === undefined || o.section === null || o.section === '') {
        return { ok: true, text: outlineText(lines, sections, o.repo) };
    }

    let picked = [];
    const sec = String(o.section).trim();
    if (/^\d+$/.test(sec)) picked = sections.filter(s => s.index === Number(sec));
    else picked = sections.filter(s => s.title.toLowerCase().includes(sec.toLowerCase()));
    if (!picked.length) return { ok: false, text: `Розділу «${sec}» нема. Зміст:\n` + outlineText(lines, sections, o.repo) };
    if (picked.length > 1) {
        return { ok: true, text: `«${sec}» збігається з ${picked.length} розділами — уточни номер:\n` + picked.map(s => `${String(s.index).padStart(3)}. [${s.start + 1}-${s.end}] ${clip(s.title, 90)}`).join('\n') };
    }
    const s = picked[0];
    const body = lines.slice(s.start, s.end).join('\n');
    const off = Math.max(0, o.offset || 0);
    const piece = body.slice(off, off + maxChars);
    const rest = body.length - off - piece.length;
    const head = `[${o.repo}.txt, розділ ${s.index}/${sections.length}, рядки ${s.start + 1}-${s.end}]\n`;
    return { ok: true, text: head + piece + (rest > 0 ? `\n… обрізано, лишилось ${rest} символів: повтори з offset=${off + piece.length}` : '') };
}
