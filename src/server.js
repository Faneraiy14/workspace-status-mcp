#!/usr/bin/env node
// server.js — реєструє інструмент sweep_status в MCP SDK і піднімає stdio-транспорт.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sweepStatus } from './sweep.js';
import { checkDocs } from './docs.js';
import { checkReleaseDrift } from './release-drift.js';
import { writeDoc } from './write-doc.js';

const server = new McpServer({ name: 'workspace-status-mcp', version: '0.5.0' });

server.registerTool(
    'sweep_status',
    {
        title: 'Знімок стану всіх git-репозиторіїв у теці',
        description:
            'Сканує всі git-репозиторії під заданим коренем (типово ~/Projects) і одним викликом повертає, ' +
            'які з них "потребують уваги": незакомічені зміни, неопубліковані коміти, або невдалий/ще не ' +
            'завершений останній CI-запуск. Заміняє ручний цикл git status + gh run list по кожному репо окремо. ' +
            'Репо розкидані між кількома коренями (напр. частина в ~/Projects, частина деінде)? Передай roots ' +
            'замість root - скановуються всі разом, одним викликом.',
        inputSchema: {
            root: z.string().optional().describe('Абсолютний шлях до теки з репозиторіями (напр. "/home/sviat/Projects"). Не потрібен, якщо задано roots'),
            roots: z.array(z.string()).optional()
                .describe('Кілька коренів за один виклик замість одного root - результати об\'єднуються'),
            repos: z.array(z.string()).optional()
                .describe('Обмежитись конкретними назвами тек замість повного сканування (шукає серед репо з усіх коренів)'),
            check_ci: z.boolean().optional()
                .describe('Опитувати GitHub Actions для кожного репо (типово true; false - швидший, чисто локальний знімок без мережі)'),
            only_attention: z.boolean().optional()
                .describe('Показати лише репо, що потребують уваги (типово true; false - повний список, включно з чистими)'),
        },
    },
    async (args) => {
        const result = await sweepStatus(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
);

server.registerTool(
    'check_docs',
    {
        title: 'Детектор застарілої/відсутньої архітектурної документації',
        description:
            'Перевіряє актуальність ~/Projects/Architecture/<repo>.txt кожного git-репозиторія: "missing" ' +
            '(документації нема взагалі), "stale" (репо мав нові зміни після документа), "current" ' +
            '(актуально), "no-commits" (репо ще без жодного коміту). Для документів, записаних через ' +
            'write_doc, рахує ТОЧНУ кількість комітів з моменту запису (trackingMethod: "commit"); для решти ' +
            '- грубший запасний варіант за mtime файлу (trackingMethod: "mtime"). НЕ генерує/переписує ' +
            'документацію сам - лише каже, куди дивитись, щоб AI-асистент (чи людина) писав/оновлював ' +
            'цілеспрямовано, а не перечитував усе підряд щосесії. Документація розкидана між кількома ' +
            'незалежними парами корінь+Architecture-тека (напр. репо, винесене з ~/Projects, з документом ' +
            'прямо поруч на новому місці)? Передай points замість projectsRoot/docsRoot.',
        inputSchema: {
            projectsRoot: z.string().optional().describe('Абсолютний шлях до теки з репозиторіями (напр. "/home/sviat/Projects"). Не потрібен, якщо задано points'),
            docsRoot: z.string().optional()
                .describe('Тека з .txt-документацією для projectsRoot (типово "<projectsRoot>/Architecture")'),
            points: z.array(z.object({
                projectsRoot: z.string().describe('Корінь із репозиторіями цієї точки'),
                docsRoot: z.string().optional().describe('Тека з .txt-документацією цієї точки (типово "<projectsRoot>/Architecture")'),
            })).optional()
                .describe('Кілька незалежних пар корінь+документація за один виклик замість одної projectsRoot/docsRoot'),
            repos: z.array(z.string()).optional()
                .describe('Обмежитись конкретними назвами тек замість повного сканування (застосовується в межах кожної точки окремо)'),
            only_attention: z.boolean().optional()
                .describe('Показати лише missing/stale (типово true; false - повний список, включно з current)'),
        },
    },
    async (args) => {
        const result = await checkDocs(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
);

server.registerTool(
    'check_release_drift',
    {
        title: 'Детектор "реліз відстав від джерела"',
        description:
            'Для явних пар (репо з вихідним кодом, репо, що з нього тегує релізи) рахує, скільки комітів ' +
            'з\'явилось у джерелі відколи реліз востаннє тегувався, і наскільки давно найстарший із них. ' +
            'Зв\'язок джерело->реліз не вгадується автоматично зі структури тек - передавай пари явно ' +
            '(напр. {source:"NyxilumLang", release:"NyxilumNode"}).',
        inputSchema: {
            projectsRoot: z.string().describe('Абсолютний шлях до теки з репозиторіями (напр. "/home/sviat/Projects")'),
            pairs: z.array(z.object({
                source: z.string().describe('Назва теки репо з вихідним кодом'),
                release: z.string().describe('Назва теки репо, що тегує релізи з нього'),
            })).describe('Явний список пар для перевірки'),
            only_attention: z.boolean().optional()
                .describe('Показати лише пари з реальним дрейфом (типово true; false - усе, включно з current)'),
        },
    },
    async (args) => {
        const result = await checkReleaseDrift(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
);

server.registerTool(
    'write_doc',
    {
        title: 'Записати архітектурну документацію репо з прив\'язкою до коміту',
        description:
            'Записує ~/Projects/Architecture/<repo>.txt і поруч фіксує commit-хеш репозиторія на момент запису. ' +
            'Після цього check_docs може рахувати РЕАЛЬНУ кількість комітів з моменту запису (git rev-list --count) ' +
            'замість грубого порівняння за mtime файлу. Текст документації інструмент не генерує - лише зберігає ' +
            'вже готовий текст (розуміння коду для документування лишається завданням AI/людини).',
        inputSchema: {
            projectsRoot: z.string().describe('Абсолютний шлях до теки з репозиторіями (напр. "/home/sviat/Projects")'),
            repo: z.string().describe('Назва теки репозиторія (напр. "anylint")'),
            content: z.string().describe('Повний текст документації для запису в <repo>.txt'),
            docsRoot: z.string().optional()
                .describe('Тека з .txt-документацією (типово "<projectsRoot>/Architecture")'),
        },
    },
    async (args) => {
        const result = await writeDoc(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
