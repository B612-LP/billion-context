import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import { createSession, markDirty } from "../src/session.ts";
import type { SummaryWork } from "../src/external-summary.ts";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.ts";
import { parseExternalSummaryChain, expandExternalSummaryChainTolerant, parseExternalSummarySettings } from "../src/external-summary-settings.ts";
import type { ResolvedKernelConfig } from "../src/compress-settings.ts";
import { parsePhaseDecision, phaseEvidence, PHASE_JUDGE_INSTRUCTIONS, runTaskPhase } from "../src/task-phase.ts";
import type { Prepared } from "../src/server.ts";

const candidates = [{ id: "c0", startRef: "m00001", endRef: "m00002", tokens: 1000 }];
for (const decision of ["yes", "no", "busy"] as const) test(`phase decision accepts ${decision}`, () => {
    const ranges = decision === "yes" ? ["c0"] : [];
    assert.deepEqual(parsePhaseDecision(JSON.stringify({ decision, ranges }), candidates), { decision, ranges });
});
for (const value of ["not json", '{"decision":"yes","ranges":[]}', '{"decision":"no","ranges":["c0"]}', '{"decision":"yes","ranges":["unknown"]}', '{"decision":"yes","ranges":["c0","c0"]}', '{"decision":"yes","ranges":["c0"],"summary":"do work"}']) test(`phase decision rejects ${value}`, () => {
    assert.equal(parsePhaseDecision(value, candidates), undefined);
});

function fixture(size = 12_000) {
    const core = createCore();
    const config: ResolvedKernelConfig = { ...defaultConfig(1_000_000), preserveRecentMessages: 1, preserveRecentTokens: 0,
        externalSummary: { enabled: true, taskPhase: true, taskPhaseMinTokens: 8192, hardThresholdTokens: 20_000, autoFoldTargetTokens: 8192,
            targets: [{ name: "glm", protocol: "openai", url: "https://example.invalid/v1/chat/completions", model: "glm-5.3-flash", apiKey: "fixture", contextWindow: 1_000_000, outputTokens: 8192, stream: false }],
            budget: { totalTimeoutMs: 1000, targetTimeoutMs: 1000, maxSummaryBytes: 65_536 } } };
    config.compress.minCompressRange = 100;
    config.nudge.growthFloor = 5000;
    config.nudge.growthCap = 5000;
    const session = createSession("task-phase-fixture");
    const originalMessages: CoreMessage[] = [
        { id: "past-request", role: "user", contentType: "text", text: "Prior task: inspect src/demo.ts." },
        { id: "past", role: "assistant", contentType: "text", text: "Completed historical task with file src/demo.ts and error E_DEMO. ".repeat(300) },
        { id: "current", role: "user", contentType: "text", text: "Current unfinished task: retain exact current user requirement." },
    ];
    const turn = core.processTurn({ messages: originalMessages, state: session.state, config, tokenCount: size, renderTags: "none" });
    session.state = turn.state;
    const prepared: Prepared = { session, originalMessages, processedMessages: turn.messages, body: "{}", protocol: "openai", stream: false, compressInjected: false, nudge: turn.nudge };
    let rebuilds = 0;
    const ctx = { prepared, core, config, size, measure: () => 1000,
        rebuild: async () => { rebuilds++; return { ...prepared }; }, log: () => {} };
    return { ctx, session, config, prepared, rebuilds: () => rebuilds };
}
const summary = "Completed historical task. Preserve src/demo.ts and E_DEMO. The current user requirement remains active and is not summarized away.";

for (const decision of ["no", "busy", "invalid", "failed"] as const) test(`below hard ${decision} judge is permissive and growth bounded`, async (t) => {
    const f = fixture();
    let calls = 0;
    t.mock.method(ConfiguredSummaryPlan.prototype, "summarize", async () => {
        calls++;
        return { status: "finished", results: decision === "failed" ? [{ status: "failed", reason: "exhausted", attempts: [] }] : [{ status: "success", summary: decision === "invalid" ? "garbage" : JSON.stringify({ decision, ranges: [] }), targetIndex: 0, attempts: [] }] };
    });
    const state = JSON.stringify(f.session.state);
    assert.equal(await runTaskPhase(f.ctx), f.prepared);
    assert.equal(await runTaskPhase(f.ctx), f.prepared);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(f.session.state), state);
    assert.equal(f.rebuilds(), 0);
    await runTaskPhase({ ...f.ctx, size: 17_000 });
    assert.equal(calls, 2);
});

test("below minimum does not call any external or conversation model", async (t) => {
    const f = fixture(8000);
    t.mock.method(ConfiguredSummaryPlan.prototype, "summarize", async () => assert.fail("must not call"));
    assert.equal(await runTaskPhase(f.ctx), f.prepared);
});

test("semantic yes calls external summary directly with full read-only context and selective source", async (t) => {
    const f = fixture();
    const calls: string[] = [];
    t.mock.method(ConfiguredSummaryPlan.prototype, "summarize", async (work: readonly SummaryWork[]) => {
        const judge = work[0].instructions === PHASE_JUDGE_INSTRUCTIONS;
        calls.push(judge ? "judge" : "summary");
        if (judge) {
            const input = JSON.parse(work[0].content);
            assert.ok(input.conversation.some((message: { text: string }) => message.text.includes("Current unfinished task")));
            return { status: "finished", results: [{ status: "success", summary: JSON.stringify({ decision: "yes", ranges: [input.candidates[0].id] }), targetIndex: 0, attempts: [] }] };
        }
        assert.match(work[0].content, /src\/demo.ts/);
        assert.match(work[0].reference ?? "", /Current unfinished task/);
        return { status: "finished", results: work.map(() => ({ status: "success", summary, targetIndex: 0, attempts: [] })) };
    });
    const result = await runTaskPhase(f.ctx);
    assert.ok(!("failFast" in result));
    assert.deepEqual(calls, ["judge", "summary"]);
    assert.ok(f.session.state.blocks.some((block) => block.active && block.summary === summary));
    assert.equal(f.rebuilds(), 1);
});

test("above hard overrides cadence, backoff and failure: explicit no forward with source unchanged", async (t) => {
    const f = fixture(20_000);
    f.session.metadata.taskPhaseLastCheckTokens = 99_000;
    f.session.metadata.autoFoldBackoffUntil = Date.now() + 999_999;
    const before = JSON.stringify(f.session.state);
    let summaries = 0;
    t.mock.method(ConfiguredSummaryPlan.prototype, "summarize", async (work: readonly SummaryWork[]) => {
        if (work[0].instructions === PHASE_JUDGE_INSTRUCTIONS) return { status: "finished", results: [{ status: "success", summary: '{"decision":"yes","ranges":["c0"]}', targetIndex: 0, attempts: [] }] };
        summaries++;
        return { status: "finished", results: [{ status: "failed", reason: "exhausted", attempts: [] }] };
    });
    const result = await runTaskPhase(f.ctx);
    assert.ok("failFast" in result);
    if ("failFast" in result) assert.match(result.message, /NOT forwarded/);
    assert.equal(summaries, 1);
    assert.equal(JSON.stringify(f.session.state), before);
    assert.equal(f.rebuilds(), 0);
});

test("above hard successful summary must actually rebuild below threshold", async (t) => {
    const f = fixture(20_000);
    t.mock.method(ConfiguredSummaryPlan.prototype, "summarize", async (work: readonly SummaryWork[]) => ({ status: "finished", results: work.map(() => ({ status: "success", summary: work[0].instructions === PHASE_JUDGE_INSTRUCTIONS ? '{"decision":"yes","ranges":["c0"]}' : summary, targetIndex: 0, attempts: [] })) }));
    const result = await runTaskPhase({ ...f.ctx, measure: () => 20_000 });
    assert.ok("failFast" in result);
    assert.ok(f.session.state.blocks.some((block) => block.active));
    assert.equal(f.rebuilds(), 1);
});

test("external transaction refuses stale revision without mutation", async (t) => {
    const f = fixture(20_000);
    const before = JSON.stringify(f.session.state);
    t.mock.method(ConfiguredSummaryPlan.prototype, "summarize", async (work: readonly SummaryWork[]) => {
        const judge = work[0].instructions === PHASE_JUDGE_INSTRUCTIONS;
        if (!judge) markDirty(f.session);
        return { status: "finished", results: work.map(() => ({ status: "success", summary: judge ? '{"decision":"yes","ranges":["c0"]}' : summary, targetIndex: 0, attempts: [] })) };
    });
    assert.ok("failFast" in await runTaskPhase(f.ctx));
    assert.equal(JSON.stringify(f.session.state), before);
});

test("deterministic emergency truncation cannot authorize forwarding", async () => {
    const f = fixture(8000);
    f.config.externalSummary = { ...f.config.externalSummary!, enabled: false };
    f.session.state.emergencyTruncateLatch = [{ ref: "m00001", text: "clipped" }];
    assert.ok("failFast" in await runTaskPhase(f.ctx));
});

test("judge evidence uses current projection without resurrecting huge folded originals", () => {
    const f = fixture();
    const refs = f.session.state.messageRefs.byRaw;
    const folded = f.ctx.core.applyCompression({ messages: f.prepared.originalMessages, state: f.session.state, config: f.config,
        ranges: [{ startRef: refs["past-request"], endRef: refs.past, summary }] });
    assert.equal(folded.result.blocksCreated, 1);
    f.session.state = folded.state;
    const eligible: CoreMessage = { id: "eligible", role: "assistant", contentType: "text", text: "Eligible completed source needs exact src/next.ts evidence." };
    const absent: CoreMessage = { id: "source-only", role: "assistant", contentType: "text", text: "Eligible source omitted from the rendered projection." };
    f.prepared.originalMessages.splice(2, 0, eligible, absent);
    refs.eligible = "m00010";
    refs["source-only"] = "m00011";
    f.session.state.messageRefs.byRaw = refs;
    const rendered = f.ctx.core.processTurn({ messages: f.prepared.originalMessages, state: f.session.state, config: f.config, tokenCount: 12_000, renderTags: "none" });
    f.prepared.processedMessages = rendered.messages.filter((message) => message.id !== absent.id).map((message) => message.id === eligible.id ? { ...message, text: "transformed projection" } : message);
    f.prepared.originalMessages.find((message) => message.id === "past")!.text = `HUGE_FOLDED_SOURCE_DO_NOT_RESEND ${"x".repeat(4_100_000)}`;
    const input = phaseEvidence(f.prepared, [{ id: "c0", startRef: refs.eligible, endRef: refs["source-only"], tokens: 100 }]);
    const text = JSON.stringify(input);
    assert.ok(!text.includes("HUGE_FOLDED_SOURCE_DO_NOT_RESEND"));
    assert.ok(text.length < 10_000);
    assert.ok(text.includes(summary), "current summary carrier remains available");
    assert.equal(input.filter((message) => message.id === eligible.id).length, 1, "no duplicate projected/raw source");
    assert.equal(input.find((message) => message.id === eligible.id)?.text, eligible.text);
    assert.equal(input.find((message) => message.id === absent.id)?.text, absent.text);
    assert.ok(input.some((message) => message.id === "current" && message.text?.includes("Current unfinished task")));
});

test("policy fields survive disabled and unresolvable chains, targets validate below hard", () => {
    const chain = parseExternalSummaryChain({ enabled: true, taskPhase: true, taskPhaseMinTokens: 250_000, hardThresholdTokens: 350_000, autoFoldTargetTokens: 250_000, targets: ["missing/glm"] });
    const disabled = expandExternalSummaryChainTolerant(chain, {});
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.taskPhase, true);
    assert.equal(disabled.hardThresholdTokens, 350_000);
    assert.equal(parseExternalSummarySettings({ enabled: false, hardThresholdTokens: 350_000 }).hardThresholdTokens, 350_000);
    assert.throws(() => parseExternalSummaryChain({ ...chain, autoFoldTargetTokens: 350_000 }), /below/);
});
