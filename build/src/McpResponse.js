import { formatConsoleEventShort, formatConsoleEventVerbose, } from './formatters/consoleFormatter.js';
import { getFormattedHeaderValue, getFormattedResponseBody, getFormattedRequestBody, getShortDescriptionForRequest, getStatusFromRequest, } from './formatters/networkFormatter.js';
import { formatA11ySnapshot } from './formatters/snapshotFormatter.js';
import { handleDialog } from './tools/pages.js';
import { paginate } from './utils/pagination.js';
export class McpResponse {
    #includePages = false;
    #includeSnapshot = false;
    #includeVerboseSnapshot = false;
    #attachedNetworkRequestId;
    #attachedConsoleMessageId;
    #textResponseLines = [];
    #images = [];
    #networkRequestsOptions;
    #consoleDataOptions;
    setIncludePages(value) {
        this.#includePages = value;
    }
    setIncludeSnapshot(value, verbose = false) {
        this.#includeSnapshot = value;
        this.#includeVerboseSnapshot = verbose;
    }
    setIncludeNetworkRequests(value, options) {
        if (!value) {
            this.#networkRequestsOptions = undefined;
            return;
        }
        this.#networkRequestsOptions = {
            include: value,
            pagination: options?.pageSize || options?.pageIdx
                ? {
                    pageSize: options.pageSize,
                    pageIdx: options.pageIdx,
                }
                : undefined,
            resourceTypes: options?.resourceTypes,
            includePreservedRequests: options?.includePreservedRequests,
        };
    }
    setIncludeConsoleData(value, options) {
        if (!value) {
            this.#consoleDataOptions = undefined;
            return;
        }
        this.#consoleDataOptions = {
            include: value,
            pagination: options?.pageSize || options?.pageIdx
                ? {
                    pageSize: options.pageSize,
                    pageIdx: options.pageIdx,
                }
                : undefined,
            types: options?.types,
            includePreservedMessages: options?.includePreservedMessages,
        };
    }
    attachNetworkRequest(reqid) {
        this.#attachedNetworkRequestId = reqid;
    }
    attachConsoleMessage(msgid) {
        this.#attachedConsoleMessageId = msgid;
    }
    get includePages() {
        return this.#includePages;
    }
    get includeNetworkRequests() {
        return this.#networkRequestsOptions?.include ?? false;
    }
    get includeConsoleData() {
        return this.#consoleDataOptions?.include ?? false;
    }
    get attachedNetworkRequestId() {
        return this.#attachedNetworkRequestId;
    }
    get networkRequestsPageIdx() {
        return this.#networkRequestsOptions?.pagination?.pageIdx;
    }
    get consoleMessagesPageIdx() {
        return this.#consoleDataOptions?.pagination?.pageIdx;
    }
    get consoleMessagesTypes() {
        return this.#consoleDataOptions?.types;
    }
    appendResponseLine(value) {
        this.#textResponseLines.push(value);
    }
    attachImage(value) {
        this.#images.push(value);
    }
    get responseLines() {
        return this.#textResponseLines;
    }
    get images() {
        return this.#images;
    }
    get includeSnapshot() {
        return this.#includeSnapshot;
    }
    get includeVersboseSnapshot() {
        return this.#includeVerboseSnapshot;
    }
    async handle(toolName, context) {
        if (this.#includePages) {
            await context.createPagesSnapshot();
        }
        if (this.#includeSnapshot) {
            await context.createTextSnapshot(this.#includeVerboseSnapshot);
        }
        const bodies = {};
        if (this.#attachedNetworkRequestId) {
            const request = context.getNetworkRequestById(this.#attachedNetworkRequestId);
            bodies.requestBody = await getFormattedRequestBody(request);
            const response = request.response();
            if (response) {
                bodies.responseBody = await getFormattedResponseBody(response);
            }
        }
        let consoleData;
        if (this.#attachedConsoleMessageId) {
            const message = context.getConsoleMessageById(this.#attachedConsoleMessageId);
            const consoleMessageStableId = this.#attachedConsoleMessageId;
            if ('args' in message) {
                const consoleMessage = message;
                consoleData = {
                    consoleMessageStableId,
                    type: consoleMessage.type(),
                    message: consoleMessage.text(),
                    args: await Promise.all(consoleMessage.args().map(async (arg) => {
                        const stringArg = await arg.jsonValue().catch(() => {
                            // Ignore errors.
                        });
                        return typeof stringArg === 'object'
                            ? JSON.stringify(stringArg)
                            : String(stringArg);
                    })),
                };
            }
            else {
                consoleData = {
                    consoleMessageStableId,
                    type: 'error',
                    message: message.message,
                    args: [],
                };
            }
        }
        let consoleListData;
        if (this.#consoleDataOptions?.include) {
            let messages = context.getConsoleData(this.#consoleDataOptions.includePreservedMessages);
            if (this.#consoleDataOptions.types?.length) {
                const normalizedTypes = new Set(this.#consoleDataOptions.types);
                messages = messages.filter(message => {
                    if ('type' in message) {
                        return normalizedTypes.has(message.type());
                    }
                    return normalizedTypes.has('error');
                });
            }
            consoleListData = await Promise.all(messages.map(async (item) => {
                const consoleMessageStableId = context.getConsoleMessageStableId(item);
                if ('args' in item) {
                    const consoleMessage = item;
                    return {
                        consoleMessageStableId,
                        type: consoleMessage.type(),
                        message: consoleMessage.text(),
                        args: await Promise.all(consoleMessage.args().map(async (arg) => {
                            const stringArg = await arg.jsonValue().catch(() => {
                                // Ignore errors.
                            });
                            return typeof stringArg === 'object'
                                ? JSON.stringify(stringArg)
                                : String(stringArg);
                        })),
                    };
                }
                return {
                    consoleMessageStableId,
                    type: 'error',
                    message: item.message,
                    args: [],
                };
            }));
        }
        return this.format(toolName, context, {
            bodies,
            consoleData,
            consoleListData,
        });
    }
    format(toolName, context, data) {
        const response = [`# ${toolName} response`];
        for (const line of this.#textResponseLines) {
            response.push(line);
        }
        const networkConditions = context.getNetworkConditions();
        if (networkConditions) {
            response.push(`## Network emulation`);
            response.push(`Emulating: ${networkConditions}`);
            response.push(`Default navigation timeout set to ${context.getNavigationTimeout()} ms`);
        }
        const cpuThrottlingRate = context.getCpuThrottlingRate();
        if (cpuThrottlingRate > 1) {
            response.push(`## CPU emulation`);
            response.push(`Emulating: ${cpuThrottlingRate}x slowdown`);
        }
        const dialog = context.getDialog();
        if (dialog) {
            const defaultValueIfNeeded = dialog.type() === 'prompt'
                ? ` (default value: "${dialog.defaultValue()}")`
                : '';
            response.push(`# Open dialog
${dialog.type()}: ${dialog.message()}${defaultValueIfNeeded}.
Call ${handleDialog.name} to handle it before continuing.`);
        }
        if (this.#includePages) {
            const parts = [`## Pages`];
            let idx = 0;
            for (const page of context.getPages()) {
                parts.push(`${idx}: ${page.url()}${idx === context.getSelectedPageIdx() ? ' [selected]' : ''}`);
                idx++;
            }
            response.push(...parts);
        }
        if (this.#includeSnapshot) {
            const snapshot = context.getTextSnapshot();
            if (snapshot) {
                const formattedSnapshot = formatA11ySnapshot(snapshot.root);
                response.push('## Page content');
                response.push(formattedSnapshot);
            }
        }
        response.push(...this.#formatNetworkRequestData(context, data.bodies));
        response.push(...this.#formatConsoleData(data.consoleData));
        if (this.#networkRequestsOptions?.include) {
            let requests = context.getNetworkRequests(this.#networkRequestsOptions?.includePreservedRequests);
            // Apply resource type filtering if specified
            if (this.#networkRequestsOptions.resourceTypes?.length) {
                const normalizedTypes = new Set(this.#networkRequestsOptions.resourceTypes);
                requests = requests.filter(request => {
                    const type = request.resourceType();
                    return normalizedTypes.has(type);
                });
            }
            response.push('## Network requests');
            if (requests.length) {
                const data = this.#dataWithPagination(requests, this.#networkRequestsOptions.pagination);
                response.push(...data.info);
                for (const request of data.items) {
                    response.push(getShortDescriptionForRequest(request, context.getNetworkRequestStableId(request)));
                }
            }
            else {
                response.push('No requests found.');
            }
        }
        if (this.#consoleDataOptions?.include) {
            const messages = data.consoleListData ?? [];
            response.push('## Console messages');
            if (messages.length) {
                const data = this.#dataWithPagination(messages, this.#consoleDataOptions.pagination);
                response.push(...data.info);
                response.push(...data.items.map(message => formatConsoleEventShort(message)));
            }
            else {
                response.push('<no console messages found>');
            }
        }
        // Guard against truly empty responses
        const responseText = response.join('\n');
        if (!responseText.trim() && this.#images.length === 0) {
            response.push('(No output produced)');
        }

        const text = {
            type: 'text',
            text: response.join('\n'),
        };
        const images = this.#images.map(imageData => {
            return {
                type: 'image',
                ...imageData,
            };
        });
        return [text, ...images];
    }
    #dataWithPagination(data, pagination) {
        const response = [];
        const paginationResult = paginate(data, pagination);
        if (paginationResult.invalidPage) {
            response.push('Invalid page number provided. Showing first page.');
        }
        const { startIndex, endIndex, currentPage, totalPages } = paginationResult;
        response.push(`Showing ${startIndex + 1}-${endIndex} of ${data.length} (Page ${currentPage + 1} of ${totalPages}).`);
        if (pagination) {
            if (paginationResult.hasNextPage) {
                response.push(`Next page: ${currentPage + 1}`);
            }
            if (paginationResult.hasPreviousPage) {
                response.push(`Previous page: ${currentPage - 1}`);
            }
        }
        return {
            info: response,
            items: paginationResult.items,
        };
    }
    #formatConsoleData(data) {
        const response = [];
        if (!data) {
            return response;
        }
        response.push(formatConsoleEventVerbose(data));
        return response;
    }
    #formatNetworkRequestData(context, data) {
        const response = [];
        const id = this.#attachedNetworkRequestId;
        if (!id) {
            return response;
        }
        const httpRequest = context.getNetworkRequestById(id);
        response.push(`## Request ${httpRequest.url()}`);
        response.push(`Status:  ${getStatusFromRequest(httpRequest)}`);
        response.push(`### Request Headers`);
        for (const line of getFormattedHeaderValue(httpRequest.headers())) {
            response.push(line);
        }
        if (data.requestBody) {
            response.push(`### Request Body`);
            response.push(data.requestBody);
        }
        const httpResponse = httpRequest.response();
        if (httpResponse) {
            response.push(`### Response Headers`);
            for (const line of getFormattedHeaderValue(httpResponse.headers())) {
                response.push(line);
            }
        }
        if (data.responseBody) {
            response.push(`### Response Body`);
            response.push(data.responseBody);
        }
        const httpFailure = httpRequest.failure();
        if (httpFailure) {
            response.push(`### Request failed with`);
            response.push(httpFailure.errorText);
        }
        const redirectChain = httpRequest.redirectChain();
        if (redirectChain.length) {
            response.push(`### Redirect chain`);
            let indent = 0;
            for (const request of redirectChain.reverse()) {
                response.push(`${'  '.repeat(indent)}${getShortDescriptionForRequest(request, context.getNetworkRequestStableId(request))}`);
                indent++;
            }
        }
        return response;
    }
    resetResponseLineForTesting() {
        this.#textResponseLines = [];
    }
}
