// #4466: gateways that emit `tool_calls: []` on every chunk (Tencent CodeBuddy /
// copilot.tencent.com) previously routed all text into the tool-call absorb path.
// The chunk was buffered for settle-time raw replay, but settle bailed early
// (pending stayed empty) and round-1 text without raw forwards nothing → empty
// stream. Empty tool_calls must be treated as absent, matching filterRealToolFragments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter, type ParsedStreamEvent } from "../src/loop/index.ts";

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) controller.enqueue(Buffer.from(events[i++], "utf8"));
            else controller.close();
        },
    });
}

const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

// Client-visible bytes for a round-1 non-textProtocol turn, mirroring core.ts:
// a text/reasoning event forwards its `raw` when present (NOTHING otherwise on
// round 1); a meta event forwards its chunk. Pre-fix this yields an empty buffer
// for a pure-text response whose chunks all carry tool_calls: [].
async function clientBytes(adapter: ReturnType<typeof createOpenaiAdapter>, events: string[]): Promise<{ bytes: string; kinds: string[] }> {
    const out: Buffer[] = [];
    const kinds: string[] = [];
    for await (const ev of adapter.parseStream(streamOf(events), 1)) {
        kinds.push(ev.kind);
        if (ev.kind === "meta") out.push(ev.chunk);
        else if ((ev.kind === "text" || ev.kind === "reasoning") && ev.raw) out.push(ev.raw);
    }
    return { bytes: Buffer.concat(out).toString("utf8"), kinds };
}

test("#4466: pure-text response with tool_calls:[] on every chunk reaches the client", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const role = { id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] };
    // Every content chunk carries an EMPTY tool_calls array — the exact trigger.
    const t1 = { id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "HELLO ", tool_calls: [] }, finish_reason: "" }] };
    const t2 = { id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "WORLD", tool_calls: [] }, finish_reason: "" }] };
    const fin = { id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    const { bytes } = await clientBytes(adapter, [chunk(role), chunk(t1), chunk(t2), chunk(fin), "data: [DONE]\n\n"]);
    assert.ok(bytes.includes("HELLO "), `client stream lost the first text chunk: ${JSON.stringify(bytes)}`);
    assert.ok(bytes.includes("WORLD"), `client stream lost the second text chunk: ${JSON.stringify(bytes)}`);
});

test("#4466: single chunk with content + empty tool_calls passes through intact", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const c = { id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "HELLO", tool_calls: [] }, finish_reason: "" }] };
    const fin = { id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    const { bytes } = await clientBytes(adapter, [chunk(c), chunk(fin), "data: [DONE]\n\n"]);
    assert.ok(bytes.includes("HELLO"), `minimal repro still drops content: ${JSON.stringify(bytes)}`);
});

test("#4466 negative control: a REAL non-empty tool_call is still absorbed and replayed", async () => {
    const adapter = createOpenaiAdapter({ model: "m" });
    const role = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] };
    const tc = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] } }] };
    const args = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"SF"}' } }] } }] };
    const fin = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
    const { bytes, kinds } = await clientBytes(adapter, [chunk(role), chunk(tc), chunk(args), chunk(fin), "data: [DONE]\n\n"]);
    assert.ok(kinds.includes("tool_call"), `real tool call no longer emitted: ${kinds.join(",")}`);
    assert.ok(bytes.includes("get_weather"), `real tool call raw frame not replayed to client: ${JSON.stringify(bytes)}`);
    // The arguments ride as an escaped JSON string inside the raw frame.
    assert.ok(bytes.includes("SF") && bytes.includes("city"), `tool arguments lost: ${JSON.stringify(bytes)}`);
});
