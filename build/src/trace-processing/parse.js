/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { PerformanceInsightFormatter } from '../../node_modules/chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceInsightFormatter.js';
import { PerformanceTraceFormatter } from '../../node_modules/chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceTraceFormatter.js';
import { AgentFocus } from '../../node_modules/chrome-devtools-frontend/front_end/models/ai_assistance/performance/AIContext.js';
import * as TraceEngine from '../../node_modules/chrome-devtools-frontend/front_end/models/trace/trace.js';
import { logger } from '../logger.js';
const engine = TraceEngine.TraceModel.Model.createWithAllHandlers();
export function traceResultIsSuccess(x) {
    return 'parsedTrace' in x;
}
export async function parseRawTraceBuffer(buffer) {
    engine.resetProcessor();
    if (!buffer) {
        return {
            error: 'No buffer was provided.',
        };
    }
    const asString = new TextDecoder().decode(buffer);
    if (!asString) {
        return {
            error: 'Decoding the trace buffer returned an empty string.',
        };
    }
    try {
        const data = JSON.parse(asString);
        const events = Array.isArray(data) ? data : data.traceEvents;
        await engine.parse(events);
        const parsedTrace = engine.parsedTrace();
        if (!parsedTrace) {
            return {
                error: 'No parsed trace was returned from the trace engine.',
            };
        }
        const insights = parsedTrace?.insights ?? null;
        return {
            parsedTrace,
            insights,
        };
    }
    catch (e) {
        const errorText = e instanceof Error ? e.message : JSON.stringify(e);
        logger(`Unexpected error parsing trace: ${errorText}`);
        return {
            error: errorText,
        };
    }
}
const extraFormatDescriptions = `Information on performance traces may contain main thread activity represented as call frames and network requests.

${PerformanceTraceFormatter.callFrameDataFormatDescription}

${PerformanceTraceFormatter.networkDataFormatDescription}`;
export function getTraceSummary(result) {
    const focus = AgentFocus.fromParsedTrace(result.parsedTrace);
    const formatter = new PerformanceTraceFormatter(focus);
    const summaryText = formatter.formatTraceSummary();
    return `## Summary of Performance trace findings:
${summaryText}

## Details on call tree & network request formats:
${extraFormatDescriptions}`;
}
export function getInsightOutput(result, insightName) {
    if (!result.insights) {
        return {
            error: 'No Performance insights are available for this trace.',
        };
    }
    // Currently, we do not support inspecting traces with multiple navigations. We either:
    // 1. Find Insights from the first navigation (common case: user records a trace with a page reload to test load performance)
    // 2. Fall back to finding Insights not associated with a navigation (common case: user tests an interaction without a page load).
    const mainNavigationId = result.parsedTrace.data.Meta.mainFrameNavigations.at(0)?.args.data
        ?.navigationId;
    const insightsForNav = result.insights.get(mainNavigationId ?? TraceEngine.Types.Events.NO_NAVIGATION);
    if (!insightsForNav) {
        return {
            error: 'No Performance Insights for this trace.',
        };
    }
    const matchingInsight = insightName in insightsForNav.model
        ? insightsForNav.model[insightName]
        : null;
    if (!matchingInsight) {
        return {
            error: `No Insight with the name ${insightName} found. Double check the name you provided is accurate and try again.`,
        };
    }
    const formatter = new PerformanceInsightFormatter(AgentFocus.fromParsedTrace(result.parsedTrace), matchingInsight);
    return { output: formatter.formatInsight() };
}
