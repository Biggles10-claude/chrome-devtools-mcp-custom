/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import './polyfill.js';
import { ensureBrowserConnected, ensureBrowserLaunched } from './browser.js';
import { parseArguments } from './cli.js';
import { logger, saveLogsToFile } from './logger.js';
import { McpContext } from './McpContext.js';
import { McpResponse } from './McpResponse.js';
import { Mutex } from './Mutex.js';
import { McpServer, StdioServerTransport, SetLevelRequestSchema, } from './third_party/index.js';
import { ToolCategory } from './tools/categories.js';
import * as browserManagementTools from './tools/browser-management.js';
import * as consoleTools from './tools/console.js';
import * as emulationTools from './tools/emulation.js';
import * as inputTools from './tools/input.js';
import * as networkTools from './tools/network.js';
import * as pagesTools from './tools/pages.js';
import * as performanceTools from './tools/performance.js';
import * as screenshotTools from './tools/screenshot.js';
import * as scriptTools from './tools/script.js';
import * as snapshotTools from './tools/snapshot.js';
// If moved update release-please config
// x-release-please-start-version
const VERSION = '0.9.0';
// x-release-please-end
export const args = parseArguments(VERSION);
const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;

async function withTimeout(promise, ms, label = 'operation') {
    return await Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
}
logger(`Starting Chrome DevTools MCP Server v${VERSION}`);
const server = new McpServer({
    name: 'chrome_devtools',
    title: 'Chrome DevTools MCP server',
    version: VERSION,
}, { capabilities: { logging: {} } });
server.server.setRequestHandler(SetLevelRequestSchema, () => {
    return {};
});
let context;
async function getContext() {
    const extraArgs = (args.chromeArg ?? []).map(String);
    if (args.proxyServer) {
        extraArgs.push(`--proxy-server=${args.proxyServer}`);
    }
    const devtools = args.experimentalDevtools ?? false;

    let browser;
    // Always try to connect first (supports auto-discovery), fall back to launch
    try {
        browser = await withTimeout(ensureBrowserConnected({
            browserURL: args.browserUrl,
            wsEndpoint: args.wsEndpoint,
            wsHeaders: args.wsHeaders,
            devtools,
        }), 12000, 'connect to Chrome');
    } catch (connectError) {
        // If connection failed and no explicit connection args were provided,
        // fall back to launching Chrome locally
        if (!args.browserUrl && !args.wsEndpoint) {
            browser = await ensureBrowserLaunched({
                headless: args.headless,
                executablePath: args.executablePath,
                channel: args.channel,
                isolated: args.isolated,
                logFile,
                viewport: args.viewport,
                args: extraArgs,
                acceptInsecureCerts: args.acceptInsecureCerts,
                devtools,
            });
        } else {
            // If explicit connection args were provided, don't fall back - rethrow
            throw connectError;
        }
    }

    if (context?.browser !== browser) {
        context = await McpContext.from(browser, logger);
    }
    return context;
}
const logDisclaimers = () => {
    console.error(`chrome-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.`);
};
const toolMutex = new Mutex();
function registerTool(tool) {
    if (tool.annotations.category === ToolCategory.EMULATION &&
        args.categoryEmulation === false) {
        return;
    }
    if (tool.annotations.category === ToolCategory.PERFORMANCE &&
        args.categoryPerformance === false) {
        return;
    }
    if (tool.annotations.category === ToolCategory.NETWORK &&
        args.categoryNetwork === false) {
        return;
    }
    server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.schema,
        annotations: tool.annotations,
    }, async (params) => {
        const guard = await toolMutex.acquire();
        try {
            logger(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
            const context = await getContext();
            const response = new McpResponse();
            await tool.handler({
                params,
            }, response, context);
            try {
                const content = await response.handle(tool.name, context);
                return {
                    content,
                };
            }
            catch (error) {
                const errorText = error instanceof Error ? error.message : String(error);
                return {
                    content: [
                        {
                            type: 'text',
                            text: errorText,
                        },
                    ],
                    isError: true,
                };
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger(`${tool.name} error: ${message}`);
            // Never rethrow: always return an actionable error payload
            return {
                content: [
                    { type: 'text', text: `[${tool.name}] Error: ${message}` },
                ],
                isError: true,
            };
        }
        finally {
            guard.dispose();
        }
    });
}
const tools = [
    ...Object.values(browserManagementTools),
    ...Object.values(consoleTools),
    ...Object.values(emulationTools),
    ...Object.values(inputTools),
    ...Object.values(networkTools),
    ...Object.values(pagesTools),
    ...Object.values(performanceTools),
    ...Object.values(screenshotTools),
    ...Object.values(scriptTools),
    ...Object.values(snapshotTools),
];
tools.sort((a, b) => {
    return a.name.localeCompare(b.name);
});
for (const tool of tools) {
    registerTool(tool);
}
const transport = new StdioServerTransport();
await server.connect(transport);
logger('Chrome DevTools MCP Server connected');
logDisclaimers();
