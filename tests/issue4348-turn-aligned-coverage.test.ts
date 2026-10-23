import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { enforceTurnAlignedCoverage, reconcileFoldCoverage, type ReconcileOptions } from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

// #4348: a re-anchor can strand a coverage island whose boundary lands MID-TURN —
// a block covers a tool-call while its tool-result (or vice versa) stays uncovered,
// and the kernel's turn-integrity gate then makes the orphan half permanently
// unfoldable ("Range would split N turns"). These pin the host-side repair that
// restores the creation-time invariant: each block covers BOTH halves of a pair or
// NEITHER (fix = drop the covered half, turning the pair into a complete unfolded
// pair the next fold absorbs turn-aligned).

function core(id: string, role: string, contentType: string, text: string, toolCallId?: string): CoreMessage {
    return { id, role, contentType, text, ...(toolCallId !== undefined ? { toolCallId } : {}) } as CoreMessage;
}
const call = (id: string, tcid: string, text = "call"): CoreMessage => core(id, "assistant", "tool-call", text, tcid);
const result = (id: string, tcid: string, text = "result"): CoreMessage => core(id, "tool", "tool-result", text, tcid);
const text_ = (id: string, t: string): CoreMessage => core(id, "user", "text", t);

interface Blk { blockId: string; active?: boolean; effectiveMessageIds?: string[]; directMessageIds?: string[] }

describe("enforceTurnAlignedCoverage (#4348)", () => {
    test("drops the covered CALL when its result is present-but-uncovered (mid-turn island)", () => {
        const c1 = call("c1", "T1"), r1 = result("r1", "T1");
        const blocks: Blk[] = [{ blockId: "b1", active: true, effectiveMessageIds: ["c1"] }];
        const dropped = enforceTurnAlignedCoverage(blocks, [c1, r1]);
        assert.equal(dropped, 1);
        assert.deepEqual(blocks[0].effectiveMessageIds, []);
        assert.equal(blocks[0].active, false, "an emptied island is deactivated so surfaces stop treating it as live");
    });

    test("drops the covered RESULT when its call is present-but-uncovered (vice versa)", () => {
        const c1 = call("c1", "T1"), r1 = result("r1", "T1");
        const blocks: Blk[] = [{ blockId: "b1", active: true, effectiveMessageIds: ["r1"] }];
        const dropped = enforceTurnAlignedCoverage(blocks, [c1, r1]);
        assert.equal(dropped, 1);
        assert.deepEqual(blocks[0].effectiveMessageIds, []);
    });

    test("leaves an aligned pair untouched when the SAME block covers both halves", () => {
        const c1 = call("c1", "T1"), r1 = result("r1", "T1");
        const blocks: Blk[] = [{ blockId: "b1", active: true, effectiveMessageIds: ["c1", "r1"] }];
        const dropped = enforceTurnAlignedCoverage(blocks, [c1, r1]);
        assert.equal(dropped, 0);
        assert.deepEqual(blocks[0].effectiveMessageIds, ["c1", "r1"]);
        assert.notEqual(blocks[0].active, false);
    });

    test("leaves both halves alone when each is covered by a DIFFERENT block (no orphan debris)", () => {
        const c1 = call("c1", "T1"), r1 = result("r1", "T1");
        const blocks: Blk[] = [
            { blockId: "b1", active: true, effectiveMessageIds: ["c1"] },
            { blockId: "b2", active: true, effectiveMessageIds: ["r1"] },
        ];
        const dropped = enforceTurnAlignedCoverage(blocks, [c1, r1]);
        assert.equal(dropped, 0);
        assert.deepEqual(blocks[0].effectiveMessageIds, ["c1"]);
        assert.deepEqual(blocks[1].effectiveMessageIds, ["r1"]);
    });

    test("leaves a lone result (call absent this pass) untouched — not an orphan", () => {
        const r1 = result("r1", "T1");
        const blocks: Blk[] = [{ blockId: "b1", active: true, effectiveMessageIds: ["r1"] }];
        const dropped = enforceTurnAlignedCoverage(blocks, [r1]);
        assert.equal(dropped, 0);
        assert.deepEqual(blocks[0].effectiveMessageIds, ["r1"]);
    });

    test("keeps unrelated coverage and drops only the split half among many ids", () => {
        const c1 = call("c1", "T1"), r1 = result("r1", "T1");
        const c2 = call("c2", "T2"), r2 = result("r2", "T2");
        // b1 covers the aligned T1 pair plus the T2 call whose result r2 is uncovered.
        const blocks: Blk[] = [{ blockId: "b1", active: true, effectiveMessageIds: ["c1", "r1", "c2"] }];
        const dropped = enforceTurnAlignedCoverage(blocks, [c1, r1, c2, r2]);
        assert.equal(dropped, 1);
        assert.deepEqual(blocks[0].effectiveMessageIds, ["c1", "r1"]);
    });

    test("cleans up directMessageIds alongside effectiveMessageIds", () => {
        const c1 = call("c1", "T1"), r1 = result("r1", "T1");
        const blocks: Blk[] = [{ blockId: "b1", active: true, effectiveMessageIds: ["c1", "x"], directMessageIds: ["c1", "x"] }];
        enforceTurnAlignedCoverage(blocks, [c1, r1]);
        assert.deepEqual(blocks[0].effectiveMessageIds, ["x"]);
        assert.deepEqual(blocks[0].directMessageIds, ["x"]);
    });

    test("is a no-op when the covered ids are not a split tool pair", () => {
        const c1 = call("c1", "T1"), r1 = result("r1", "T1");
        const blocks: Blk[] = [{ blockId: "b1", active: true, effectiveMessageIds: ["x"] }];
        const dropped = enforceTurnAlignedCoverage(blocks, [c1, r1]);
        assert.equal(dropped, 0);
        assert.deepEqual(blocks[0].effectiveMessageIds, ["x"]);
    });
});

describe("reconcileFoldCoverage turn-alignment wiring (#4348)", () => {
    function fakeSession(): Session {
        return { state: { blocks: [] }, metadata: {} } as unknown as Session;
    }
    const opts = (mode: "repair" | "warn"): ReconcileOptions => ({ mode, sessionId: "s1", log: () => {} });
    // >=10 msgs clears the auxiliary side-request guard inside reconcileFoldCoverage.
    const filler = Array.from({ length: 9 }, (_, i) => text_(`f${i}`, `filler context words ${i}`));

    // Inject a stranded mid-turn island left by a PRIOR re-anchor: the block covers
    // the (re-anchored) call while the result stayed uncovered, and the old result
    // id is a dead ref. Returns the block so the caller can assert on it.
    function plantIsland(session: Session): Blk {
        const island: Blk = { blockId: "bX", active: true, effectiveMessageIds: ["c1", "r1-old"] };
        (session.state as { blocks: Blk[] }).blocks.push(island);
        return island;
    }

    test("proxy mode heals an EXISTING mid-turn island on a later pass (no fresh churn needed)", () => {
        const c1 = call("c1", "T1"), r1 = result("r1", "T1");
        const session = fakeSession();
        plantIsland(session);
        const logs: string[] = [];
        reconcileFoldCoverage(session, [...filler, c1, r1], { mode: "repair", sessionId: "s1", log: (_l: string, m: string) => { logs.push(m); } });
        const bx = (session.state as { blocks: Blk[] }).blocks.find((b) => b.blockId === "bX");
        assert.ok(!bx!.effectiveMessageIds!.includes("c1"), "split call half dropped from coverage so the pair folds whole");
        assert.ok(logs.some((l) => l.includes("#4348")), "the drop is logged for observability");
    });

    test("plugin mode leaves the island untouched (the agent owns compression there)", () => {
        const c1 = call("c1", "T1"), r1 = result("r1", "T1");
        const session = fakeSession();
        plantIsland(session);
        session.metadata.pluginAgent = "dsh";
        reconcileFoldCoverage(session, [...filler, c1, r1], opts("repair"));
        const bx = (session.state as { blocks: Blk[] }).blocks.find((b) => b.blockId === "bX");
        assert.ok(bx!.effectiveMessageIds!.includes("c1"), "plugin mode: no host-side drop");
    });

    test("warn mode observes but does not rewrite", () => {
        const c1 = call("c1", "T1"), r1 = result("r1", "T1");
        const session = fakeSession();
        plantIsland(session);
        reconcileFoldCoverage(session, [...filler, c1, r1], opts("warn"));
        const bx = (session.state as { blocks: Blk[] }).blocks.find((b) => b.blockId === "bX");
        assert.ok(bx!.effectiveMessageIds!.includes("c1"), "warn mode: no rewrite");
    });
});
