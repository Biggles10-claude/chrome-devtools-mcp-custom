/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { ensureBrowserConnected } from '../browser.js';
import { logger } from '../logger.js';
import { McpContext } from '../McpContext.js';
import { zod } from '../third_party/index.js';
import { ToolCategory } from './categories.js';
import { defineTool } from './ToolDefinition.js';
import dns from 'node:dns/promises';

// Store the original connection options
let currentBrowserUrl = null;
let currentWsEndpoint = null;

// Helper functions for robust browser switching
function isIp(host) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

async function resolveHostToIp(host) {
    try {
        const { address } = await dns.lookup(host);
        return address;
    } catch {
        return null;
    }
}

async function fetchJsonVersion(httpBaseUrl, timeoutMs = 2000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const u = new URL(httpBaseUrl);
        const base = `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`;
        const res = await fetch(`${base}/json/version`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function tryCandidatesAndConnect(candidates, ensureBrowserConnected, logger) {
    const errors = [];
    for (const candidate of candidates) {
        try {
            // Get ws endpoint via /json/version
            const data = await fetchJsonVersion(candidate);
            const ws = data.webSocketDebuggerUrl;
            if (!ws) throw new Error('No webSocketDebuggerUrl in /json/version');
            logger(`Resolved ${candidate} -> ${ws}`);
            const newBrowser = await ensureBrowserConnected({ wsEndpoint: ws, devtools: false });
            return { newBrowser, resolvedHttpUrl: candidate, wsEndpoint: ws };
        } catch (e) {
            errors.push(`${candidate}: ${e.message || String(e)}`);
            logger(`Failed candidate ${candidate}: ${e.message || String(e)}`);
        }
    }
    const detail = errors.map(e => `- ${e}`).join('\n');
    throw new Error(`Could not connect to any candidate endpoint:\n${detail}`);
}

export const switchBrowser = defineTool({
    name: 'switch_browser',
    description: `Switch to a different Chrome browser instance. Provide one of: container (webtop1|webtop2|webtop3), browserUrl (HTTP), or wsEndpoint (WebSocket). Hostnames are resolved to IPs to satisfy Chrome Host header rules. The tool auto-falls back to the socat forwarder port (9999).`,
    annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: false,
    },
    schema: {
        container: zod.string().optional().describe('Docker container name (e.g., "webtop1"). Will be resolved to IP and port 9999 by default.'),
        port: zod.number().optional().describe('Port to use with container (default 9999).'),
        browserUrl: zod.string().optional().describe('HTTP URL for CDP (e.g., http://172.17.0.2:9999). Hostnames will be resolved to IP.'),
        wsEndpoint: zod.string().optional().describe('WebSocket endpoint (e.g., ws://172.17.0.2:9999/devtools/browser/...).'),
    },
    handler: async (request, response, context) => {
        const { container, port, browserUrl, wsEndpoint } = request.params;

        if (!container && !browserUrl && !wsEndpoint) {
            throw new Error('Provide one of: container, browserUrl, or wsEndpoint');
        }

        // Disconnect current browser if connected
        if (context.browser && context.browser.connected) {
            logger('Disconnecting from current browser');
            await context.browser.disconnect();
        }

        let newBrowser;
        let resolvedHttpUrl = null;
        let resolvedWs = null;

        // Direct WebSocket path
        if (wsEndpoint) {
            logger(`Connecting via provided WebSocket endpoint: ${wsEndpoint}`);
            newBrowser = await ensureBrowserConnected({ wsEndpoint, devtools: false });
            resolvedWs = wsEndpoint;
        } else {
            // Build candidate HTTP URLs to fetch /json/version from
            const candidates = [];

            const pushCandidatesForHostPort = (hostOrIp, p) => {
                // Normalize host to IP to avoid Host header rejection
                candidates.push(`http://${hostOrIp}:${p}`);
                // Always try the forwarder port 9999 as primary/secondary
                if (p !== 9999) candidates.push(`http://${hostOrIp}:9999`);
                // Also try 9222 as a last resort if not already tried
                if (p !== 9222) candidates.push(`http://${hostOrIp}:9222`);
            };

            if (container) {
                logger(`Resolving container name "${container}" to IP`);
                const ip = await resolveHostToIp(container);
                if (!ip) throw new Error(`Unable to resolve container "${container}" to an IP address`);
                const p = port || 9999;
                logger(`Container "${container}" resolved to ${ip}. Trying ports [${p}, 9999, 9222]`);
                pushCandidatesForHostPort(ip, p);
            } else if (browserUrl) {
                const u = new URL(browserUrl);
                let hostIp = u.hostname;
                if (!isIp(hostIp)) {
                    logger(`Resolving hostname "${u.hostname}" to IP`);
                    const resolved = await resolveHostToIp(u.hostname);
                    if (!resolved) throw new Error(`Unable to resolve hostname "${u.hostname}" to an IP address`);
                    hostIp = resolved;
                }
                const p = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
                logger(`Normalized browserUrl to IP ${hostIp}:${p}`);
                pushCandidatesForHostPort(hostIp, p);
            }

            // Try candidates and connect via resolved WebSocket endpoint
            const result = await tryCandidatesAndConnect(candidates, ensureBrowserConnected, logger);
            newBrowser = result.newBrowser;
            resolvedHttpUrl = result.resolvedHttpUrl;
            resolvedWs = result.wsEndpoint;
        }

        // Create new MCP context with the new browser
        const newContext = await McpContext.from(newBrowser, logger);
        Object.assign(context, newContext);

        // Track connection details for info tools
        currentBrowserUrl = resolvedHttpUrl;
        currentWsEndpoint = resolvedWs;

        const target = wsEndpoint || resolvedWs || resolvedHttpUrl || browserUrl || container;
        response.appendResponseLine(`Successfully switched to browser at ${target}`);
        response.setIncludePages(true);
    },
});

export const listBrowsers = defineTool({
    name: 'list_browsers',
    description: `List known Chrome browser instances available in Docker containers. This scans the Docker environment for containers with Chrome instances and their DevTools Protocol endpoints.`,
    annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
    },
    schema: {},
    handler: async (_request, response) => {
        const knownBrowsers = [
            {
                name: 'webtop1',
                container: 'webtop1',
                url: 'http://172.17.0.2:9999',
                network: '172.17.0.2 (bridge)',
                description: 'LinuxServer.io webtop with KDE desktop - Instance 1',
            },
            {
                name: 'webtop2',
                container: 'webtop2',
                url: 'http://172.17.0.5:9999',
                network: '172.17.0.5 (bridge)',
                description: 'LinuxServer.io webtop with KDE desktop - Instance 2',
            },
            {
                name: 'webtop3',
                container: 'webtop3',
                url: 'http://172.17.0.6:9999',
                network: '172.17.0.6 (bridge)',
                description: 'LinuxServer.io webtop with KDE desktop - Instance 3',
            },
        ];

        let text = '# Available Chrome Browsers\n\n';

        if (currentBrowserUrl || currentWsEndpoint) {
            text += `**Current Connection:** ${currentBrowserUrl || currentWsEndpoint}\n\n`;
        } else {
            text += `**Current Connection:** Not connected via switch_browser (using default from config)\n\n`;
        }

        text += '## Known Browser Instances:\n\n';
        for (const browser of knownBrowsers) {
            text += `### ${browser.name}\n`;
            text += `- **Container:** ${browser.container}\n`;
            text += `- **URL:** ${browser.url}\n`;
            text += `- **Network:** ${browser.network}\n`;
            text += `- **Description:** ${browser.description}\n`;
            text += `\nTo switch: \`switch_browser({ container: "${browser.name}" })\`\n`;
            text += `Or: \`switch_browser({ browserUrl: "${browser.url}" })\`\n\n`;
        }

        text += '## Notes:\n';
        text += '- Use `switch_browser` with the browserUrl to connect to any of these instances\n';
        text += '- After switching, all subsequent browser operations will use the new connection\n';
        text += '- To verify connection, use `list_pages` after switching\n';

        response.appendResponseLine(text);
    },
});

export const getCurrentBrowser = defineTool({
    name: 'get_current_browser',
    description: `Get information about the currently connected browser instance.`,
    annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
    },
    schema: {},
    handler: async (_request, response, context) => {
        let text = '# Current Browser Connection\n\n';

        if (currentBrowserUrl || currentWsEndpoint) {
            text += `**Connected to:** ${currentBrowserUrl || currentWsEndpoint}\n`;
        } else {
            text += `**Connected to:** Default browser from configuration\n`;
        }

        if (context.browser && context.browser.connected) {
            const version = await context.browser.version();
            text += `**Browser Version:** ${version}\n`;
            text += `**Connection Status:** Connected\n`;

            const pages = context.browser.pages();
            text += `**Open Pages:** ${pages.length}\n`;
        } else {
            text += `**Connection Status:** Disconnected\n`;
        }

        response.appendResponseLine(text);
        response.setIncludePages(true);
    },
});
