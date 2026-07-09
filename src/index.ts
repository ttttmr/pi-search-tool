import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getProviderKind } from "./api.ts";
import { webSearch, WebSearchSchema } from "./web_search.ts";
import { urlContext, UrlContextSchema } from "./url_context.ts";

const WEB_SEARCH_TOOL = "web_search";
const URL_CONTEXT_TOOL = "url_context";

function supportsUrlContext(model: Model<Api> | undefined) {
    return !!model && getProviderKind(model) === "google";
}

function setEquals<T>(a: Set<T>, b: Set<T>) {
    if (a.size !== b.size) return false;
    for (const value of a) {
        if (!b.has(value)) return false;
    }
    return true;
}

export function createModelScopedToolManager(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">) {
    let preferredActiveTools: Set<string> | undefined;
    let lastAppliedActiveTools: Set<string> | undefined;
    let suppressedTools = new Set<string>();

    const sync = (model: Model<Api> | undefined) => {
        const currentActiveTools = new Set(pi.getActiveTools());

        if (!preferredActiveTools) {
            preferredActiveTools = new Set(currentActiveTools);
        } else if (lastAppliedActiveTools) {
            for (const tool of currentActiveTools) {
                if (!lastAppliedActiveTools.has(tool)) preferredActiveTools.add(tool);
            }
            for (const tool of lastAppliedActiveTools) {
                if (!currentActiveTools.has(tool) && !suppressedTools.has(tool)) {
                    preferredActiveTools.delete(tool);
                }
            }
        }

        const desiredActiveTools = new Set(preferredActiveTools);
        suppressedTools = new Set<string>();
        if (!supportsUrlContext(model)) {
            desiredActiveTools.delete(URL_CONTEXT_TOOL);
            if (preferredActiveTools.has(URL_CONTEXT_TOOL)) {
                suppressedTools.add(URL_CONTEXT_TOOL);
            }
        }

        if (!setEquals(currentActiveTools, desiredActiveTools)) {
            pi.setActiveTools(Array.from(desiredActiveTools));
        }
        lastAppliedActiveTools = new Set(desiredActiveTools);
    };

    return { sync };
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: WEB_SEARCH_TOOL,
        label: "Web Search",
        description: "Search the web using the current supported provider (Google Gemini, OpenAI, or Anthropic). Optionally include URLs to analyze alongside search results.",
        parameters: WebSearchSchema,
        execute: webSearch
    });

    pi.registerTool({
        name: URL_CONTEXT_TOOL,
        label: "URL Context",
        description: "Analyze the content of up to 20 public URLs using Gemini URL Context. Supports web pages, documents, images, and YouTube videos.",
        parameters: UrlContextSchema,
        execute: urlContext
    });

    const toolManager = createModelScopedToolManager(pi);
    pi.on("session_start", (_event, ctx) => toolManager.sync(ctx.model));
    pi.on("session_tree", (_event, ctx) => toolManager.sync(ctx.model));
    pi.on("model_select", (event) => toolManager.sync(event.model));
}
