import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { callApiStream, getConfig, applyCitations, type OpenAIReasoningEffort } from "./api.ts";
import { getWebSearchModel, missingWebSearchConfigResult, errorResult, formatResult } from "./utils.ts";

export const WebSearchSchema = Type.Object({
    query: Type.String({ description: "The search query or question to answer" }),
    urls: Type.Optional(Type.Array(Type.String(), { 
        description: "Additional URLs to analyze along with search (up to 20)",
        maxItems: 20
    })),
    depth: Type.Optional(StringEnum(["quick", "standard", "deep"] as const, {
        description: "Research depth. quick is a simple lookup, standard is the default balanced search, and deep performs more thorough multi-source research.",
        default: "standard"
    })),
});
export type WebSearchInput = Static<typeof WebSearchSchema>;
export type SearchDepth = NonNullable<WebSearchInput["depth"]>;

export interface SearchDepthSettings {
    depth: SearchDepth;
    reasoningEffort: OpenAIReasoningEffort;
    instruction: string;
}

export function getSearchDepthSettings(depth: WebSearchInput["depth"]): SearchDepthSettings {
    switch (depth ?? "standard") {
        case "quick":
            return {
                depth: "quick",
                reasoningEffort: "none",
                instruction: "Perform a concise lookup using the minimum search needed to answer accurately. Prefer a primary source when available."
            };
        case "deep":
            return {
                depth: "deep",
                reasoningEffort: "medium",
                instruction: "Conduct thorough multi-source research. Prioritize primary sources, compare conflicting evidence, and clearly distinguish verified facts from uncertainty."
            };
        default:
            return {
                depth: "standard",
                reasoningEffort: "low",
                instruction: "Perform a balanced search using authoritative sources and verify important claims across sources when practical."
            };
    }
}

export async function webSearch(
    id: string, 
    params: WebSearchInput, 
    signal: AbortSignal, 
    onUpdate: AgentToolUpdateCallback | undefined, 
    ctx: ExtensionContext
) {
    const model = await getWebSearchModel(ctx);
    if (!model) return missingWebSearchConfigResult(ctx);

    const hasUrls = params.urls && params.urls.length > 0;
    const urlCount = hasUrls ? params.urls!.length : 0;
    const depthSettings = getSearchDepthSettings(params.depth);
    
    onUpdate?.({ 
        content: [{ 
            type: "text", 
            text: hasUrls 
                ? `Searching and analyzing ${urlCount} URL(s)...` 
                : `Searching for "${params.query}"...`
        }], 
        details: {} 
    });

    try {
        const config = getConfig(model);
        
        // Build prompt: include URLs if provided
        const request = hasUrls
            ? `${params.query}\n\nAlso analyze these URLs:\n${params.urls!.join("\n")}`
            : params.query;
        const prompt = `${request}\n\nResearch guidance: ${depthSettings.instruction}`;

        // Enable provider-native search tools. Google needs explicit Gemini tool names;
        // OpenAI/Anthropic are handled inside callApiStream based on the current model.
        const tools = config.kind === "google"
            ? (hasUrls
                ? [{ [config.searchTool!]: {} }, { [config.urlContextTool!]: {} }]
                : [{ [config.searchTool!]: {} }])
            : undefined;

        const result = await callApiStream(ctx, model, {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            ...(tools ? { tools } : {})
        }, onUpdate, signal, { reasoningEffort: depthSettings.reasoningEffort });

        const cited = applyCitations(result.text, result.groundingMetadata);
        const text = cited.text;
        const sources = result.sources?.length ? result.sources : cited.sources;
        const extraSearchResults = (result.searchResults || []).filter((item) => item.url && !sources.some((source) => source.url === item.url));

        // Handle URL context metadata
        const urlMeta = result.urlContextMetadata?.urlMetadata 
            || result.urlContextMetadata?.url_metadata || [];

        const retrieved = urlMeta
            .filter((m: any) => (m.urlRetrievalStatus || m.url_retrieval_status) === "URL_RETRIEVAL_STATUS_SUCCESS")
            .map((m: any) => m.retrievedUrl || m.retrieved_url || m.url);

        const failed = urlMeta
            .filter((m: any) => (m.urlRetrievalStatus || m.url_retrieval_status) !== "URL_RETRIEVAL_STATUS_SUCCESS")
            .map((m: any) => ({ 
                url: m.retrievedUrl || m.retrieved_url || m.url, 
                status: m.urlRetrievalStatus || m.url_retrieval_status 
            }));

        let summary = text;
        
        // Add URL status if there were failures
        if (failed.length > 0) {
            summary += `\n\n## URL Status\n✅ Retrieved: ${retrieved.length}\n❌ Failed: ${failed.length}`;
            failed.forEach((f: any) => { summary += `\n- ${f.url}: ${f.status}`; });
        }

        // Add sources
        if (sources.length > 0) {
            summary += `\n\n## Sources\n${sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}`;
        }

        if (extraSearchResults.length) {
            const visibleResults = extraSearchResults.slice(0, 8);
            summary += `\n\n## Additional Search Results\n${visibleResults.map((r, i) => {
                const label = r.title || r.url || `Result ${i + 1}`;
                const url = r.url ? ` - ${r.url}` : "";
                const meta = [r.source, r.type, r.status, r.query ? `query=${r.query}` : undefined].filter(Boolean).join(", ");
                return `${i + 1}. ${label}${url}${meta ? ` (${meta})` : ""}`;
            }).join("\n")}`;
            if (extraSearchResults.length > visibleResults.length) {
                summary += `\n... and ${extraSearchResults.length - visibleResults.length} more results in tool details.`;
            }
        }

        return formatResult(summary, {
            sources,
            providerKind: result.providerKind,
            nativeSearchUsed: result.nativeSearchUsed,
            nativeSearchEvents: result.nativeSearchEvents,
            nativeSearchCalls: result.nativeSearchCalls,
            searchQueries: result.searchQueries || result.groundingMetadata?.webSearchQueries,
            searchResults: result.searchResults,
            citations: result.citations,
            retrieved: retrieved.length > 0 ? retrieved : undefined,
            failed: failed.length > 0 ? failed : undefined,
            model: model.id,
            depth: depthSettings.depth,
            reasoningEffort: depthSettings.reasoningEffort,
            grounded: sources.length > 0 || (result.searchResults?.length || 0) > 0,
            resultCount: result.searchResults?.length || sources.length
        });
    } catch (e: any) {
        return errorResult(e);
    }
}
