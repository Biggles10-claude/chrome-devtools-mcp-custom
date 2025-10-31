/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
function createIdGenerator() {
    let i = 1;
    return () => {
        if (i === Number.MAX_SAFE_INTEGER) {
            i = 0;
        }
        return i++;
    };
}
export const stableIdSymbol = Symbol('stableIdSymbol');
export class PageCollector {
    #browser;
    #listenersInitializer;
    #listeners = new WeakMap();
    #maxNavigationSaved = 3;
    /**
     * This maps a Page to a list of navigations with a sub-list
     * of all collected resources.
     * The newer navigations come first.
     */
    storage = new WeakMap();
    constructor(browser, listeners) {
        this.#browser = browser;
        this.#listenersInitializer = listeners;
    }
    async init() {
        const pages = await this.#browser.pages();
        for (const page of pages) {
            this.#initializePage(page);
        }
        this.#browser.on('targetcreated', async (target) => {
            const page = await target.page();
            if (!page) {
                return;
            }
            this.#initializePage(page);
        });
        this.#browser.on('targetdestroyed', async (target) => {
            const page = await target.page();
            if (!page) {
                return;
            }
            this.#cleanupPageDestroyed(page);
        });
    }
    addPage(page) {
        this.#initializePage(page);
    }
    #initializePage(page) {
        if (this.storage.has(page)) {
            return;
        }
        const idGenerator = createIdGenerator();
        const storedLists = [[]];
        this.storage.set(page, storedLists);
        const listeners = this.#listenersInitializer(value => {
            const withId = value;
            withId[stableIdSymbol] = idGenerator();
            const navigations = this.storage.get(page) ?? [[]];
            navigations[0].push(withId);
        });
        listeners['framenavigated'] = (frame) => {
            // Only split the storage on main frame navigation
            if (frame !== page.mainFrame()) {
                return;
            }
            this.splitAfterNavigation(page);
        };
        for (const [name, listener] of Object.entries(listeners)) {
            page.on(name, listener);
        }
        this.#listeners.set(page, listeners);
    }
    splitAfterNavigation(page) {
        const navigations = this.storage.get(page);
        if (!navigations) {
            return;
        }
        // Add the latest navigation first
        navigations.unshift([]);
        navigations.splice(this.#maxNavigationSaved);
    }
    #cleanupPageDestroyed(page) {
        const listeners = this.#listeners.get(page);
        if (listeners) {
            for (const [name, listener] of Object.entries(listeners)) {
                page.off(name, listener);
            }
        }
        this.storage.delete(page);
    }
    getData(page, includePreservedData) {
        const navigations = this.storage.get(page);
        if (!navigations) {
            return [];
        }
        if (!includePreservedData) {
            return navigations[0];
        }
        const data = [];
        for (let index = this.#maxNavigationSaved; index >= 0; index--) {
            if (navigations[index]) {
                data.push(...navigations[index]);
            }
        }
        return data;
    }
    getIdForResource(resource) {
        return resource[stableIdSymbol] ?? -1;
    }
    getById(page, stableId) {
        const navigations = this.storage.get(page);
        if (!navigations) {
            throw new Error('No requests found for selected page');
        }
        for (const navigation of navigations) {
            for (const collected of navigation) {
                if (collected[stableIdSymbol] === stableId) {
                    return collected;
                }
            }
        }
        throw new Error('Request not found for selected page');
    }
}
export class NetworkCollector extends PageCollector {
    constructor(browser, listeners = collect => {
        return {
            request: req => {
                collect(req);
            },
        };
    }) {
        super(browser, listeners);
    }
    splitAfterNavigation(page) {
        const navigations = this.storage.get(page) ?? [];
        if (!navigations) {
            return;
        }
        const requests = navigations[0];
        const lastRequestIdx = requests.findLastIndex(request => {
            return request.frame() === page.mainFrame()
                ? request.isNavigationRequest()
                : false;
        });
        // Keep all requests since the last navigation request including that
        // navigation request itself.
        // Keep the reference
        if (lastRequestIdx !== -1) {
            const fromCurrentNavigation = requests.splice(lastRequestIdx);
            navigations.unshift(fromCurrentNavigation);
        }
        else {
            navigations.unshift([]);
        }
    }
}
