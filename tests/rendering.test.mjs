import assert from "node:assert/strict";
import test from "node:test";
import registerExtension from "../src/index.ts";

function getWebSearchTool() {
    const tools = new Map();
    registerExtension({
        registerTool(tool) {
            tools.set(tool.name, tool);
        },
        getActiveTools() {
            return [];
        },
        setActiveTools() {},
        on() {},
    });
    return tools.get("web_search");
}

const theme = {
    fg(_color, text) {
        return text;
    },
    bold(text) {
        return text;
    },
};

test("web_search call shows the query and URL count", () => {
    const tool = getWebSearchTool();
    const component = tool.renderCall(
        { query: "latest pi release", urls: ["https://pi.dev", "https://github.com"] },
        theme,
    );

    assert.deepEqual(component.render(80).map((line) => line.trimEnd()), [
        "web_search latest pi release + 2 URLs",
    ]);
});

test("web_search hides successful output when collapsed", () => {
    const tool = getWebSearchTool();
    const component = tool.renderResult(
        { content: [{ type: "text", text: "search result" }], details: {} },
        { expanded: false, isPartial: false },
        theme,
    );

    assert.deepEqual(component.render(80), []);
});

test("web_search shows successful output when expanded", () => {
    const tool = getWebSearchTool();
    const component = tool.renderResult(
        { content: [{ type: "text", text: "search result" }], details: {} },
        { expanded: true, isPartial: false },
        theme,
    );

    assert.deepEqual(component.render(80).map((line) => line.trimEnd()), ["search result"]);
});

test("web_search keeps errors visible when collapsed", () => {
    const tool = getWebSearchTool();
    const component = tool.renderResult(
        { content: [{ type: "text", text: "Error: unavailable" }], details: { error: true } },
        { expanded: false, isPartial: false },
        theme,
    );

    assert.deepEqual(component.render(80).map((line) => line.trimEnd()), ["Error: unavailable"]);
});
