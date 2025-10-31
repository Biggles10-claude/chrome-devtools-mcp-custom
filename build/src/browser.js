/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { puppeteer } from './third_party/index.js';
import { execSync } from 'node:child_process';
import { URL as NodeURL } from 'node:url';
let browser;

async function fetchJsonWithTimeout(url, timeoutMs = 3000) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return res.json();
}

function rewriteWsEndpoint(originalWsUrl, viaBrowserURL) {
    try {
        const wsUrl = new NodeURL(originalWsUrl);
        const isLoopback = wsUrl.hostname === '127.0.0.1' || wsUrl.hostname === 'localhost' || wsUrl.hostname === '::1';
        const via = new NodeURL(viaBrowserURL);
        if (!isLoopback && wsUrl.port === via.port) {
            return originalWsUrl;
        }
        wsUrl.hostname = via.hostname;
        wsUrl.port = via.port;
        return wsUrl.toString();
    } catch {
        return originalWsUrl;
    }
}

async function resolveWsFromBrowserURL(browserURL, timeoutMs = 3000) {
    const version = await fetchJsonWithTimeout(`${browserURL}/json/version`, timeoutMs);
    const original = version.webSocketDebuggerUrl || version.webSocketDebuggerUrlLegacy;
    if (!original) {
        throw new Error(`No webSocketDebuggerUrl in ${browserURL}/json/version`);
    }
    return rewriteWsEndpoint(original, browserURL);
}

async function connectWithTimeout(connectOptions, timeoutMs = 8000) {
    return await Promise.race([
        puppeteer.connect(connectOptions),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out connecting to Chrome after ${timeoutMs}ms`)), timeoutMs)
        ),
    ]);
}

async function sendWithTimeout(client, method, params, timeoutMs = 1500) {
    return await Promise.race([
        client.send(method, params),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)),
    ]);
}

// Auto-discovery: Try to find a running webtop container with Chrome DevTools
async function discoverWebtopBrowser() {
    const candidates = ['webtop1', 'webtop2', 'webtop3'];
    const dockerCmd = '/usr/bin/docker';

    for (const container of candidates) {
        try {
            // Check if container exists and is running
            const running = execSync(`${dockerCmd} inspect -f '{{.State.Running}}' ${container}`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            }).trim();

            if (running !== 'true') continue;

            // Get container IP
            const ip = execSync(`${dockerCmd} inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${container}`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            }).trim();

            if (!ip) continue;

            // Try port 9999 (socat forwarder) first, then 9222 (direct Chrome)
            for (const port of [9999, 9222]) {
                try {
                    const browserURL = `http://${ip}:${port}`;
                    const wsEndpoint = await resolveWsFromBrowserURL(browserURL, 2000);
                    return { browserURL, wsEndpoint, container, ip, port };
                } catch {
                    // Try next port
                }
            }
        } catch (error) {
            // Container doesn't exist or not running, try next
            continue;
        }
    }
    return null;
}
function makeTargetFilter(devtools) {
    const ignoredPrefixes = new Set([
        'chrome://',
        'chrome-extension://',
        'chrome-untrusted://',
    ]);
    if (!devtools) {
        ignoredPrefixes.add('devtools://');
    }
    return function targetFilter(target) {
        if (target.url() === 'chrome://newtab/') {
            return true;
        }
        for (const prefix of ignoredPrefixes) {
            if (target.url().startsWith(prefix)) {
                return false;
            }
        }
        return true;
    };
}
export async function ensureBrowserConnected(options) {
    if (browser?.connected) {
        return browser;
    }

    let connectionTarget = null;
    let browserURL = options.browserURL;
    let wsEndpoint = options.wsEndpoint;

    // Auto-discovery if no connection details provided
    if (!browserURL && !wsEndpoint) {
        const discovered = await discoverWebtopBrowser();
        if (discovered) {
            wsEndpoint = discovered.wsEndpoint;
            connectionTarget = `${discovered.container} (${discovered.ip}:${discovered.port})`;
        } else {
            throw new Error('No browserURL or wsEndpoint provided, and auto-discovery found no running webtop containers with Chrome DevTools');
        }
    } else {
        connectionTarget = browserURL || wsEndpoint;
    }

    const connectOptions = {
        defaultViewport: null,
        protocolTimeout: 15000,
    };
    if (wsEndpoint) {
        connectOptions.browserWSEndpoint = wsEndpoint;
        if (options.wsHeaders) {
            connectOptions.headers = options.wsHeaders;
        }
    } else if (browserURL) {
        const resolved = await resolveWsFromBrowserURL(browserURL, 3000);
        connectOptions.browserWSEndpoint = resolved;
    }

    try {
        browser = await connectWithTimeout(connectOptions, 8000);

        // Preflight warm-up: gently wake page sessions without blocking
        try {
            const pages = await browser.pages();
            const page = pages[0];
            if (page) {
                const client = await page.createCDPSession();
                await sendWithTimeout(client, 'Runtime.enable', {}, 1000).catch(() => {});
                await sendWithTimeout(client, 'Page.enable', {}, 1000).catch(() => {});
            }
        } catch {
            // Preflight is best-effort, ignore failures
        }

        return browser;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to connect to Chrome DevTools at ${connectionTarget}: ${message}`, {
            cause: error
        });
    }
}
export async function launch(options) {
    const { channel, executablePath, headless, isolated } = options;
    const profileDirName = channel && channel !== 'stable'
        ? `chrome-profile-${channel}`
        : 'chrome-profile';
    let userDataDir = options.userDataDir;
    if (!isolated && !userDataDir) {
        userDataDir = path.join(os.homedir(), '.cache', 'chrome-devtools-mcp', profileDirName);
        await fs.promises.mkdir(userDataDir, {
            recursive: true,
        });
    }
    const args = [
        ...(options.args ?? []),
        '--hide-crash-restore-bubble',
    ];
    if (headless) {
        args.push('--screen-info={3840x2160}');
    }
    let puppeteerChannel;
    if (options.devtools) {
        args.push('--auto-open-devtools-for-tabs');
    }
    if (!executablePath) {
        puppeteerChannel =
            channel && channel !== 'stable'
                ? `chrome-${channel}`
                : 'chrome';
    }
    try {
        const browser = await puppeteer.launch({
            channel: puppeteerChannel,
            targetFilter: makeTargetFilter(options.devtools),
            executablePath,
            defaultViewport: null,
            userDataDir,
            pipe: true,
            headless,
            args,
            acceptInsecureCerts: options.acceptInsecureCerts,
            handleDevToolsAsPage: options.devtools,
        });
        if (options.logFile) {
            // FIXME: we are probably subscribing too late to catch startup logs. We
            // should expose the process earlier or expose the getRecentLogs() getter.
            browser.process()?.stderr?.pipe(options.logFile);
            browser.process()?.stdout?.pipe(options.logFile);
        }
        if (options.viewport) {
            const [page] = await browser.pages();
            // @ts-expect-error internal API for now.
            await page?.resize({
                contentWidth: options.viewport.width,
                contentHeight: options.viewport.height,
            });
        }
        return browser;
    }
    catch (error) {
        if (userDataDir &&
            error.message.includes('The browser is already running')) {
            throw new Error(`The browser is already running for ${userDataDir}. Use --isolated to run multiple browser instances.`, {
                cause: error,
            });
        }
        throw error;
    }
}
export async function ensureBrowserLaunched(options) {
    if (browser?.connected) {
        return browser;
    }
    browser = await launch(options);
    return browser;
}
