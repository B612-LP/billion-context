import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { defaultConfig, createCore, type CoreMessage } from "acp-kernel";
import { startServer, preflightCompressIfNeeded, type Prepared } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { createSession } from "../src/session.ts";
import type { ResolvedKernelConfig } from "../src/compress-settings.ts";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.ts";

const cleanup: http.Server[] = [];
let fixtureId = 0;
beforeEach(() => { _setStoreForTest(new SessionStore({ enabled: false })); setRegistryForTest({}); });
afterEach(async () => {
    for (const server of cleanup.splice(0).reverse()) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    _setStoreForTest(new SessionStore({ enabled: false }));
});
async function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
    const server = http.createServer(handler);
    cleanup.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
function conversation(pairs: number): unknown[] {
    const messages: unknown[] = [];
    for (let i = 0; i < pairs; i++) {
        messages.push({ role: "user", content: `Completed request ${i}: ${"0123456789abcdef".repeat(280)}` });
        messages.push({ role: "assistant", content: `Completed phase ${i}, src/phase-${i}.ts verified.` });
    }
    messages.push({ role: "user", content: "CURRENT_USER_TAIL: do not deploy, retain this unfinished objective exactly." });
    return messages;
}
async function fixture(decision: "yes" | "no" | "busy" | "invalid" | "failure", hard = 20_000) {
    const id = ++fixtureId;
    const mainBodies: Record<string, unknown>[] = [];
    const summaryBodies: Record<string, unknown>[] = [];
    const main = await listen((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => { mainBodies.push(JSON.parse(Buffer.concat(chunks).toString())); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "main", type: "message", role: "assistant", content: [{ type: "text", text: "Work response" }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 2 } })); });
    });
    const summary = await listen((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            summaryBodies.push(body);
            const text = JSON.stringify(body);
            const judge = text.includes("read-only task-phase judge");
            let reply: string;
            if (judge) {
                if (decision === "failure") { res.writeHead(401); res.end("unavailable"); return; }
                const messages = body.messages as { content: string }[];
                const payload = JSON.parse(JSON.parse(messages.at(-1)!.content).content);
                reply = decision === "invalid" ? "invalid" : JSON.stringify({ decision, ranges: decision === "yes" ? payload.candidates.map((candidate: { id: string }) => candidate.id) : [] });
            } else reply = "Completed historical phases and verification. Preserve source paths, current constraints and all unresolved objectives. User explicitly prohibits deployment. Source originals remain available for retrieval.";
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: "stop" }] }));
        });
    });
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: main.url,
        routes: { [main.url]: { models: { "work-model": { context: 1_000_000 } } } }, modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, { preserveRecentMessages: 1, preserveRecentTokens: 0, compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 50 } }),
        compress: { injectTool: true, injectNudge: true, nudgeModelDecided: true,
            externalSummary: { enabled: true, targets: ["summary/glm-5.3-flash"], taskPhase: true, taskPhaseMinTokens: 8192, autoFoldTargetTokens: 8192, hardThresholdTokens: hard,
                budget: { totalTimeoutMs: 1000, targetTimeoutMs: 1000, maxSummaryBytes: 65_536 } } },
        namedProviders: { summary: { baseUrl: summary.url, api: "openai", apiKeyEnv: "BILI_TEST_PHASE_KEY", models: { "glm-5.3-flash": { contextWindow: 1_000_000 } } } },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, passthroughSource: null,
        autoUpdate: false, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false, compat: { roles: {} }, streamErrorShape: "protocol", mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    cleanup.push(proxy);
    await once(proxy, "listening");
    process.env.BILI_TEST_PHASE_KEY = "fixture";
    const post = async (pairs: number, plugin = false) => {
        const response = await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/bili/${main.url}/v1/messages`, {
            method: "POST", headers: { "content-type": "application/json", "x-api-key": "fixture", "x-acp-session": `phase-${id}-${plugin ? "plugin" : "proxy"}`, ...(plugin ? { "x-bili-plugin": "dsh", "user-agent": "deepseek-harness" } : {}) },
            body: JSON.stringify({ model: "work-model", max_tokens: 1000, stream: false, messages: conversation(pairs) }),
        });
        return { status: response.status, body: await response.text() };
    };
    return { post, mainBodies, summaryBodies };
}

for (const plugin of [false, true]) test(`semantic external compression works in ${plugin ? "DSH plugin" : "proxy"} mode with no main planning`, async () => {
    const f = await fixture("yes");
    const response = await f.post(12, plugin);
    assert.equal(response.status, 200, response.body);
    assert.equal(f.mainBodies.length, 1, "only actual work reaches conversation model");
    assert.ok(f.summaryBodies.length >= 2, "judge and authoritative summary are external");
    const body = JSON.stringify(f.mainBodies[0]);
    assert.ok(body.includes("CURRENT_USER_TAIL"));
    assert.ok(body.includes("Completed historical phases"), "external summary carrier survives plugin/proxy render");
    assert.ok(!body.includes("Context breakdown:"));
    assert.ok(!body.includes("conversation model selects consumed ranges"));
    assert.ok(body.includes("Do not judge task phases"));
});

for (const decision of ["no", "busy", "invalid", "failure"] as const) test(`above hard external ${decision} never forwards work`, async () => {
    const f = await fixture(decision);
    const response = await f.post(24);
    assert.equal(response.status, 413, response.body);
    assert.match(response.body, /NOT forwarded/);
    assert.equal(f.mainBodies.length, 0);
});

test("below phase minimum does not call summary or main model side-calls", async () => {
    const f = await fixture("yes");
    const response = await f.post(2);
    assert.equal(response.status, 200, response.body);
    assert.equal(f.summaryBodies.length, 0);
    assert.equal(f.mainBodies.length, 1);
});

test("below hard external failure forwards only work, no main-model fallback", async () => {
    const f = await fixture("failure");
    const response = await f.post(12);
    assert.equal(response.status, 200, response.body);
    assert.equal(f.mainBodies.length, 1);
    assert.equal(f.summaryBodies.length, 1);
});

for (const source of ["usage", "overflow-arm", "anonymous"] as const) test(`preflight hard policy honors authoritative ${source} floor before any bypass`, async (t) => {
    const core = createCore();
    const config: ResolvedKernelConfig = { ...defaultConfig(1_000_000), externalSummary: { enabled: false, targets: [], budget: { totalTimeoutMs: 100, targetTimeoutMs: 100, maxSummaryBytes: 4096 }, taskPhase: true, taskPhaseMinTokens: 250_000, hardThresholdTokens: 350_000 } };
    const session = createSession(`floor-${source}`);
    session.stats.lastInputTokens = source === "anonymous" ? 0 : 360_000;
    if (source !== "anonymous") session.stats.lastInputTokensSource = source;
    session.stats.lastInputTokensOrigin = "https://upstream.example";
    const messages: CoreMessage[] = [{ id: "floor-source", role: "user", contentType: "text", text: source === "anonymous" ? "x".repeat(360_000) : "small local estimate" }];
    const prepared: Prepared = { session, originalMessages: messages, processedMessages: messages, body: "{}", protocol: "openai", stream: false, compressInjected: false };
    const req = new http.IncomingMessage(new (await import("node:net")).Socket());
    req.url = "/v1/chat/completions";
    const res = new http.ServerResponse(req);
    const opts = { routes: {}, compress: { injectTool: true, injectNudge: true }, compat: { roles: {} } } as ProxyOptions;
    t.mock.method(ConfiguredSummaryPlan.prototype, "summarize", async () => assert.fail("disabled chain must refuse, not dispatch"));
    const result = await preflightCompressIfNeeded(prepared, async () => assert.fail("must not rebuild"), req, Buffer.from("{}"), res, opts, core, config, 1_000_000, "work-model", 1_000_000, undefined,
        { upstream: "https://upstream.example", rewrittenUrl: "https://upstream.example/v1/chat/completions" }, undefined, source === "anonymous", () => {}, "fixture");
    assert.ok("failFast" in result);
    if ("failFast" in result) assert.match(result.message, /NOT forwarded/);
    res.destroy();
});
