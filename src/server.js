#!/usr/bin/env node
// server.js — реєструє інструмент sweep_status в MCP SDK і піднімає stdio-транспорт.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sweepStatus } from './sweep.js';

const server = new McpServer({ name: 'workspace-status-mcp', version: '0.1.0' });

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

const transport = new StdioServerTransport();
await server.connect(transport);
