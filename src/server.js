#!/usr/bin/env node
// server.js — реєструє інструмент sweep_status в MCP SDK і піднімає stdio-транспорт.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sweepStatus } from './sweep.js';
import { checkDocs } from './docs.js';
import { checkReleaseDrift } from './release-drift.js';

const server = new McpServer({ name: 'workspace-status-mcp', version: '0.3.0' });

server.registerTool(
    'sweep_status',
    {
        title: 'Знімок стану всіх git-репозиторіїв у теці',
        description:
            'Сканує всі git-репозиторії під заданим коренем (типово ~/Projects) і одним викликом повертає, ' +
            'які з них "потребують уваги": незакомічені зміни, неопубліковані коміти, або невдалий/ще не ' +
            'завершений останній CI-запуск. Заміняє ручний цикл git status + gh run list по кожному репо окремо.',
        inputSchema: {
            root: z.string().describe('Абсолютний шлях до теки з репозиторіями (напр. "/home/sviat/Projects")'),
            repos: z.array(z.string()).optional()
                .describe('Обмежитись конкретними назвами тек замість повного сканування root'),
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
            'Звіряє час останнього коміту кожного git-репозиторія з часом останньої зміни його ' +
            '~/Projects/Architecture/<repo>.txt: "missing" (документації нема взагалі), "stale" (репо мав ' +
            'нові коміти після останнього оновлення документа), "current" (актуально), "no-commits" ' +
            '(репо ще без жодного коміту). НЕ генерує/переписує документацію сам - лише каже, куди дивитись, ' +
            'щоб AI-асистент (чи людина) писав/оновлював цілеспрямовано, а не перечитував усе підряд щосесії.',
        inputSchema: {
            projectsRoot: z.string().describe('Абсолютний шлях до теки з репозиторіями (напр. "/home/sviat/Projects")'),
            docsRoot: z.string().optional()
                .describe('Тека з .txt-документацією (типово "<projectsRoot>/Architecture")'),
            repos: z.array(z.string()).optional()
                .describe('Обмежитись конкретними назвами тек замість повного сканування projectsRoot'),
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

const transport = new StdioServerTransport();
await server.connect(transport);
