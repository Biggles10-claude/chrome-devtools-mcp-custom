/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { ConnectionTransport as DevToolsConnectionTransport } from '../node_modules/chrome-devtools-frontend/front_end/core/protocol_client/ConnectionTransport.js';
/**
 * Allows a puppeteer {@link ConnectionTransport} to act like a DevTools {@link Connection}.
 */
export class DevToolsConnectionAdapter extends DevToolsConnectionTransport {
    #transport;
    #onDisconnect = null;
    constructor(transport) {
        super();
        this.#transport = transport;
        this.#transport.onclose = () => this.#onDisconnect?.('');
        this.#transport.onmessage = msg => this.onMessage?.(msg);
    }
    setOnMessage(onMessage) {
        this.onMessage = onMessage;
    }
    setOnDisconnect(onDisconnect) {
        this.#onDisconnect = onDisconnect;
    }
    sendRawMessage(message) {
        this.#transport?.send(message);
    }
    async disconnect() {
        this.#transport?.close();
        this.#transport = null;
    }
}
