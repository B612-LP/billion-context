import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

process.env.NODE_ENV = "test";

const model = "threshold-test";
const windowSize = 872_000;
type Wire = "anthropic" | "openai" | "responses" | "google";

function messages() {
    return Array.from({ length: 41 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `Working turn ${i}: ` + `distinct work item ${i} and its results. `.repeat(300),
    }));
}

function request(wire: Wire) {
    const history = messages();
    if (wire === "anthropic") return { model, max_tokens: 1024, stream: true, system: "You are a coding agent.", messages: history };
    if (wire === "openai") return { model, max_tokens: 1024, messages: history };
    if (wire === "responses") return { model, stream: true, instructions: "You are a coding agent.", input: history.map(m => ({ type: "message", ...m })) };
    return { systemInstruction: { parts: [{ text: "You are a coding agent." }] }, contents: history.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })) };
}

function reply(wire: Wire, tokens: number): { type: string; body: string } {
    if (wire === "anthropic") {
        const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        return { type: "text/event-stream", body: [
            event("message_start", { type: "message_start", message: { id: "msg_test", role: "assistant", usage: { input_tokens: tokens } } }),
            event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
            event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ack" } }),
            event("content_block_stop", { type: "content_block_stop", index: 0 }),
            event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
            event("message_stop", { type: "message_stop" }),
        ].join("") };
    }
    if (wire === "responses") return { type: "text/event-stream", body: `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", output: [], usage: { input_tokens: tokens, output_tokens: 3, total_tokens: tokens + 3 } } })}\n\n` };
    if (wire === "google") return { type: "application/json", body: JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ack" }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: tokens, candidatesTokenCount: 3, totalTokenCount: tokens + 3 } }) };
    return { type: "application/json", body: JSON.stringify({ id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ack" }, finish_reason: "stop" }], usage: { prompt_tokens: tokens, completion_tokens: 3, total_tokens: tokens + 3 } }) };
}

for (const wire of ["anthropic", "openai", "responses", "google"] as const) {
    for (const mode of ["proxy", "plugin"] as const) {
        test(`${wire} ${mode}: suppressed 249999 does not consume cadence before 250000`, async () => {
            const captured: string[] = [];
            const samples = [20_000, 100_000, 200_000, 249_999, 250_000, 250_000];
            const upstream = http.createServer((req, res) => {
                const chunks: Buffer[] = [];
                req.on("data", (chunk: Buffer) => chunks.push(chunk));
                req.on("end", () => {
                    captured.push(Buffer.concat(chunks).toString("utf8"));
                    const r = reply(wire, samples[captured.length - 1] ?? 250_000);
                    res.writeHead(200, { "content-type": r.type });
                    res.end(r.body);
                });
            });
            upstream.listen(0, "127.0.0.1");
            await once(upstream, "listening");
            const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
            _setStoreForTest(new SessionStore({ enabled: false }));
            setRegistryForTest({});
            const config = defaultConfig(windowSize);
            const proxy = await startServer({
                port: 0, host: "127.0.0.1", upstream: upstreamUrl,
                routes: { [upstreamUrl]: { models: { [model]: { context: windowSize } } } },
                modelContextLimit: windowSize,
                kernelConfig: { ...config, nudge: { ...config.nudge, minPressureBenefitTokens: 0 } },
                compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" },
                sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false,
                autoUpdate: false, advisoryCheck: false, releaseNotesCheck: false,
                mitm: { enabled: false, domains: [] }, compat: { roles: {} },
                streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest",
            } as ProxyOptions);
            await once(proxy, "listening");
            const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
            const path = wire === "anthropic" ? "/v1/messages" : wire === "openai" ? "/v1/chat/completions" : wire === "responses" ? "/v1/responses" : `/v1beta/models/${model}:generateContent`;
            try {
                for (let i = 0; i < samples.length; i++) {
                    const response = await fetch(`${origin}/bili/${upstreamUrl}${path}`, {
                        method: "POST",
                        headers: { "content-type": "application/json", "x-acp-session": `threshold-${wire}-${mode}`, ...(mode === "plugin" ? { "x-bili-plugin": "omp" } : {}) },
                        body: JSON.stringify(request(wire)),
                    });
                    assert.equal(response.status, 200, `turn ${i + 1}: ${await response.text()}`);
                }
                assert.equal(captured.length, samples.length);
                const count = (body: string): number => {
                    const parsed = JSON.parse(body) as { messages?: unknown[]; input?: unknown[]; contents?: unknown[] };
                    if (wire === "google") {
                        const contents = parsed.contents as Array<{ parts?: unknown[] }>;
                        return contents.reduce((sum, item) => sum + (item.parts?.length ?? 0), 0);
                    }
                    return (parsed.messages ?? parsed.input ?? []).length;
                };
                const baseline = count(captured[0]!);
                for (let i = 0; i < 5; i++) {
                    assert.ok(captured[i]!.includes("proactively compress suitable completed ranges"), `turn ${i + 1} retains standing prompt`);
                    assert.equal(count(captured[i]!), baseline, `turn ${i + 1} has no dynamic nudge`);
                }
                assert.equal(count(captured[5]!), baseline + 1, "250000 must fire immediately after the suppressed 249999 turn");
            } finally {
                proxy.close(); proxy.closeIdleConnections?.(); await once(proxy, "close");
                upstream.close(); upstream.closeIdleConnections?.(); await once(upstream, "close");
            }
        });
    }
}
