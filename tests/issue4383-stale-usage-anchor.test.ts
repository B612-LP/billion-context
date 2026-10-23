import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { effectiveTokenCount } from "../src/server.ts";
import { statusInputBaseline, usageAnchorCycleStale, gradeAnchorCycleStale, type Session } from "../src/session.ts";
import { noteOutboundContextEstimates, settleUsageReport } from "../src/cache-ledger.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `i4383-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

/** Raw-view messages large enough that effectiveTokenCount's raw estimate
 *  always exceeds the localInputEstimate under test, so the min() branch
 *  resolves to the per-send estimate and assertions are exact. */
function bigMsgs(): CoreMessage[] {
    return [{ id: "m1", role: "user", contentType: "text", text: "x".repeat(4_000_000) }];
}

test("#4383 writer contract: relay stamp writes the full per-send evidence set", () => {
    const session = makeSession();
    noteOutboundContextEstimates(session, { upperBound: 303_092, scaledText: 150_000, imageTokens: 2_000, calibrated: true });
    assert.equal(session.stats.localInputEstimate, 303_092);
    assert.equal(session.stats.contextTokens, 303_092);
    assert.equal(session.stats.contextTokensSource, "estimate");
    assert.equal(session.stats.contextEstimateTokens, 152_000);
    assert.equal(session.stats.contextEstimateCalibrated, true);
});

test("healthy cycle: a settled usage report outranks the send estimate (no false stale)", () => {
    const session = makeSession();
    // cycle N: relay stamp, then the response settles a real report
    noteOutboundContextEstimates(session, { upperBound: 300_000, scaledText: 290_000, imageTokens: 0, calibrated: false });
    settleUsageReport(session, { total: 305_000, reportedCached: 0 });
    assert.equal(session.stats.contextTokensSource, "usage");
    assert.equal(usageAnchorCycleStale(session.stats), false);
    assert.deepEqual(effectiveTokenCount(session, bigMsgs()), { tokens: 305_000, source: "usage" });
    assert.equal(statusInputBaseline(session), 305_000);
});

test("#4383 frozen shape: last cycle ended without a settle → per-send estimate outranks the stale anchor", () => {
    const session = makeSession();
    // early cycle: a small real report lands (reporter saw 4733)
    settleUsageReport(session, { total: 4_733, reportedCached: 0 });
    // many later cycles: every send stamps fresh estimates, no usage ever settles
    noteOutboundContextEstimates(session, { upperBound: 303_092, scaledText: 150_000, imageTokens: 0, calibrated: false });
    assert.equal(usageAnchorCycleStale(session.stats), true);
    // pre-fix: { tokens: 4733, source: "usage" } — growth read 0, nudge idle 154 turns
    const sizing = effectiveTokenCount(session, bigMsgs());
    assert.equal(sizing.source, "estimate");
    assert.equal(sizing.tokens, 303_092);
    assert.equal(statusInputBaseline(session), 303_092);
});

test("#4383 recovery: a fresh usage settle re-anchors and clears the stale state", () => {
    const session = makeSession();
    settleUsageReport(session, { total: 4_733, reportedCached: 0 });
    noteOutboundContextEstimates(session, { upperBound: 303_092, scaledText: 150_000, imageTokens: 0, calibrated: false });
    assert.equal(usageAnchorCycleStale(session.stats), true);
    settleUsageReport(session, { total: 310_000, reportedCached: 0 });
    assert.equal(usageAnchorCycleStale(session.stats), false);
    assert.deepEqual(effectiveTokenCount(session, bigMsgs()), { tokens: 310_000, source: "usage" });
});

test("overflow-arm stays authoritative even when a send estimate postdates it (#1839)", () => {
    const session = makeSession();
    session.stats.lastInputTokens = 740_000;
    session.stats.lastInputTokensSource = "overflow-arm";
    noteOutboundContextEstimates(session, { upperBound: 600_000, scaledText: 590_000, imageTokens: 0, calibrated: false });
    assert.equal(usageAnchorCycleStale(session.stats), false);
    assert.deepEqual(effectiveTokenCount(session, bigMsgs()), { tokens: 740_000, source: "usage" });
});

test("#4383 grade branch is bypassed too: a drained anchor's stale grade must not re-freeze sizing", () => {
    const session = makeSession();
    // credit-adjusted drain: lastInputTokens hit 0 but the grade anchor remains
    session.stats.lastInputTokens = 0;
    session.stats.lastInputTokensSource = "usage";
    session.stats.lastUsageGradeTokens = 4_733;
    noteOutboundContextEstimates(session, { upperBound: 303_092, scaledText: 150_000, imageTokens: 0, calibrated: false });
    // pre-fix: branch 3 returned the frozen grade 4733
    const sizing = effectiveTokenCount(session, bigMsgs());
    assert.equal(sizing.source, "estimate");
    assert.equal(sizing.tokens, 303_092);
    assert.equal(statusInputBaseline(session), 303_092);
});

test("stale without per-send evidence: the anchor stays the last real measurement", () => {
    const session = makeSession();
    settleUsageReport(session, { total: 4_733, reportedCached: 0 });
    // cold-restore edge: freshness mark says estimate, but no live estimate exists
    session.stats.contextTokens = 300_000;
    session.stats.contextTokensSource = "estimate";
    delete session.stats.localInputEstimate;
    assert.equal(usageAnchorCycleStale(session.stats), false);
    assert.deepEqual(effectiveTokenCount(session, bigMsgs()), { tokens: 4_733, source: "usage" });
});

test("#728 never-reporting lane unchanged: no usage anchor at all still rides the estimate bound", () => {
    const session = makeSession();
    noteOutboundContextEstimates(session, { upperBound: 100_000, scaledText: 90_000, imageTokens: 0, calibrated: false });
    const sizing = effectiveTokenCount(session, bigMsgs());
    assert.equal(sizing.source, "estimate");
    assert.equal(sizing.tokens, 100_000);
});

// #4383 second egress (arm-swallow): an upstream failure arms the per-send
// estimate into lastInputTokens (source "estimate"), moving the primary anchor
// OFF the usage slot. usageAnchorCycleStale then stops matching (it requires
// source === "usage"), so without gradeAnchorCycleStale the frozen early sidecar
// grade resurrects through branch 3 and re-blinds every reader after the first
// failed turn — the exact reporter environment (relay that never reports usage,
// plus occasional upstream failures). The demotion keys on CYCLE DEPTH
// (sendsSinceUsageSettle ≥ 2): one silent cycle keeps its anchor (#1839 G1),
// two prove the usage flow is dead.

const SEND = { upperBound: 303_092, scaledText: 150_000, imageTokens: 0, calibrated: false };

test("arm-swallow: two silent cycles + a failed turn must not resurrect the stale grade through branch 3", () => {
    const session = makeSession();
    // early sidecar report lands (the 4733 sample)
    settleUsageReport(session, { total: 4_733, reportedCached: 0 });
    // later main-lane sends stamp fresh estimates, no usage ever settles
    noteOutboundContextEstimates(session, SEND);
    noteOutboundContextEstimates(session, SEND);
    // upstream failure arms the per-send estimate into the primary anchor slot
    session.stats.lastInputTokens = 1_108_494;
    session.stats.lastInputTokensSource = "estimate";
    session.stats.emergencyShrinkAt = Date.now();
    assert.equal(usageAnchorCycleStale(session.stats), false);
    assert.equal(gradeAnchorCycleStale(session.stats), true);
    // pre-fix: branch 3 returned the frozen grade { tokens: 4733, source: "usage" }
    const sizing = effectiveTokenCount(session, bigMsgs());
    assert.equal(sizing.source, "estimate");
    assert.equal(sizing.tokens, 303_092);
    assert.equal(statusInputBaseline(session), 303_092);
});

test("arm-swallow recovery: the next real usage settle clears both predicates and re-anchors", () => {
    const session = makeSession();
    settleUsageReport(session, { total: 4_733, reportedCached: 0 });
    noteOutboundContextEstimates(session, SEND);
    noteOutboundContextEstimates(session, SEND);
    session.stats.lastInputTokens = 1_108_494;
    session.stats.lastInputTokensSource = "estimate";
    assert.equal(gradeAnchorCycleStale(session.stats), true);
    // next cycle finally reports real usage
    settleUsageReport(session, { total: 252_154, reportedCached: 0 });
    assert.equal(usageAnchorCycleStale(session.stats), false);
    assert.equal(gradeAnchorCycleStale(session.stats), false);
    assert.deepEqual(effectiveTokenCount(session, bigMsgs()), { tokens: 252_154, source: "usage" });
    assert.equal(statusInputBaseline(session), 252_154);
});

test("arm-swallow negative: ONE silent cycle keeps the measured anchor authoritative (#1839 G1 shape)", () => {
    const session = makeSession();
    // the last cycle measured a real payload and settled it
    settleUsageReport(session, { total: 143_419, reportedCached: 0 });
    // next send stamps the per-send bound, then fails and arms — exactly one silent cycle
    noteOutboundContextEstimates(session, { upperBound: 400_000, scaledText: 390_000, imageTokens: 0, calibrated: false });
    session.stats.lastInputTokens = 1_108_494;
    session.stats.lastInputTokensSource = "estimate";
    // cycle depth 1 < 2 — the fresh measurement outranks any re-derived view (#1839)
    assert.equal(gradeAnchorCycleStale(session.stats), false);
    assert.deepEqual(effectiveTokenCount(session, bigMsgs()), { tokens: 143_419, source: "usage" });
    assert.equal(statusInputBaseline(session), 143_419);
});

test("arm-swallow negative: overflow-arm primary anchor keeps #1839 authority over a stale grade", () => {
    const session = makeSession();
    // a stale grade lingers from an early sidecar sample
    session.stats.lastUsageGradeTokens = 4_733;
    // but the live primary anchor is an overflow arm (per-send, window-bounded)
    session.stats.lastInputTokens = 740_000;
    session.stats.lastInputTokensSource = "overflow-arm";
    noteOutboundContextEstimates(session, { upperBound: 600_000, scaledText: 590_000, imageTokens: 0, calibrated: false });
    assert.equal(usageAnchorCycleStale(session.stats), false);
    assert.equal(gradeAnchorCycleStale(session.stats), false);
    assert.deepEqual(effectiveTokenCount(session, bigMsgs()), { tokens: 740_000, source: "usage" });
    assert.equal(statusInputBaseline(session), 740_000);
});
