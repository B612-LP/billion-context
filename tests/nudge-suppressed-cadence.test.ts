import assert from "node:assert/strict";
import test from "node:test";
import { createCore, createInitialState, defaultConfig, type CoreMessage, type ProcessTurnResult } from "acp-kernel";
import { restoreSuppressedNudgeCadence } from "../src/server/prepare-responses.ts";

const core = createCore();
const config = { ...defaultConfig(872_000), preserveRecentMessages: 0, preserveRecentTokens: 0 };
const messages: CoreMessage[] = Array.from({ length: 40 }, (_, i) => ({
    id: `msg${i}`, role: i % 2 ? "assistant" : "user", contentType: "text", text: `message ${i} `.repeat(4000),
}));

test("suppressed kernel nudge does not delay the threshold crossing", () => {
    let state = createInitialState();
    state = core.processTurn({ messages, state, config, tokenCount: 100_000 }).state;
    const prior = structuredClone(state.nudge);
    const silent = core.processTurn({ messages, state, config, tokenCount: 200_000 });
    assert.equal(silent.nudge?.shouldInject, true);
    const suppressed = restoreSuppressedNudgeCadence(silent, prior, 200_000);
    assert.equal(prior.lastNudgeShownTokens, 0);
    assert.equal(suppressed.nudge.lastNudgeShownTokens, prior.lastNudgeShownTokens);
    const crossed = core.processTurn({ messages, state: suppressed, config, tokenCount: 250_000 });
    assert.equal(crossed.nudge?.shouldInject, true);
    assert.equal(restoreSuppressedNudgeCadence(crossed, suppressed.nudge, 250_000), crossed.state);
});

test("restores only suppressed tier with low water and leaves inputs untouched", () => {
    const state = createInitialState();
    const base = core.processTurn({ messages, state, config, tokenCount: 200_000 });
    assert.ok(base.nudge);
    const notInjected = { ...base, nudge: { ...base.nudge, shouldInject: false } };
    assert.equal(restoreSuppressedNudgeCadence(notInjected, state.nudge, 200_000), notInjected.state);
    for (const tier of [1, 2, 3] as const) {
        for (const exists of [false, true]) {
            const prior = { ...state.nudge, lastNudgeShownTokens: 300_000, lastShownByTier: { 1: 310_000, 2: 50_000, 3: 400_000 } };
            if (!exists) delete prior.lastShownByTier[tier];
            const lowered = Object.fromEntries(Object.entries(prior.lastShownByTier).map(([k, v]) => [k, Math.min(v, 200_000)]));
            const turn: ProcessTurnResult = { ...base, nudge: { ...base.nudge, shouldInject: true, tier }, state: { ...base.state, nudge: { ...base.state.nudge, lastNudgeShownTokens: 200_000, lastShownByTier: { ...lowered, [tier]: 200_000 } } } };
            const before = structuredClone({ prior, turn });
            const restored = restoreSuppressedNudgeCadence(turn, prior, 200_000);
            assert.equal(restored.nudge.lastNudgeShownTokens, 200_000);
            assert.deepEqual(restored.nudge.lastShownByTier, lowered);
            assert.equal(restored.nudge.lastPerMessageNudgeTokens, turn.state.nudge.lastPerMessageNudgeTokens);
            assert.deepEqual({ prior, turn }, before);
            assert.notEqual(restored.nudge.lastShownByTier, turn.state.nudge.lastShownByTier);
        }
    }
});
