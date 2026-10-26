import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #4797: after the cold-load ledger re-stamp, every range acp_status
 * advertises must survive the compress submit gate — the production deadlock
 * was status suggesting refs the gate then refused forever.
 *
 * Root cause: restampRefsToLedger re-grants vacated numbers as NEW targets
 * (ref = seq+1 overlaps the old counter space), so "cited ref ∈ superseded"
 * was a false staleness test — most superseded numbers are live refs again
 * under a different owner. Two facets fixed:
 *   1. supersededRefRejection refuses only superseded numbers with NO current
 *      owner (genuinely stale); re-granted ones resolve to their current
 *      owner downstream and pass.
 *   2. the restamp registers vacated-and-unregranted numbers in
 *      state.deadRefs (existing #3302 discipline) so the suggestion side
 *      (excludeDeadRefRanges) stops advertising spans that cross them and
 *      acp_status names them in DEAD REFS.
 */
process.env.NODE_ENV = "test";
process.env.BILI_STORAGE_UNIFIED = "full";
const testRoot = mkdtempSync(join(tmpdir(), "bili-4797-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { supersededRefRejection } from "../src/stream.ts";
import { excludeDeadRefRanges } from "../src/acp-status.ts";
import { createCore, defaultConfig, type CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";
import type { LegacySessionLike } from "../src/storage/ingest.ts";

function msg(id: string, text = `${id}: ${"x".repeat(40_000)}`): CoreMessage {
    return { id, role: "user", contentType: "text", text };
}

function legacyLike(id: string, messages: CoreMessage[]): LegacySessionLike {
    return {
        id,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        meta: {},
        stats: {},
        metadata: {},
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
        lastMessages: messages,
    } as unknown as LegacySessionLike;
}

function refSession(superseded: Array<[string, string]>, byRaw: Record<string, string>): Session {
    const byRef: Record<string, string> = {};
    for (const [rawId, ref] of Object.entries(byRaw)) if (ref !== "BLOCKED") byRef[ref] = rawId;
    return { restampSuperseded: new Map(superseded), state: { messageRefs: { byRaw, byRef } } } as unknown as Session;
}

test("S-A: a superseded number re-granted to a CURRENT owner passes the guard (#4797 core)", () => {
    // Restamp moved d: m00003→m00004 and e: m00004→m00005. m00004/m00005 are
    // in the superseded map (they were e/d's OLD labels) yet d/e own them NOW.
    const s = refSession([["m00003", "d"], ["m00004", "e"]], { a: "m00001", b: "m00002", d: "m00004", e: "m00005" });
    assert.equal(supersededRefRejection([{ startRef: "m00004", endRef: "m00005" }], s), null, "re-granted live refs must pass");
});

test("S-B: a superseded number with NO current owner still refuses (guard not gutted)", () => {
    const s = refSession([["m00003", "d"], ["m00004", "e"]], { a: "m00001", b: "m00002", d: "m00004", e: "m00005" });
    const hit = supersededRefRejection([{ startRef: "m00003", endRef: "m00003" }], s);
    assert.ok(hit !== null, "ownerless superseded ref must refuse");
    assert.match(hit!, /m00003/);
});

test("S-C: mixed span — one ownerless cell vetoes the whole range, live cells alone pass", () => {
    const s = refSession([["m00003", "d"], ["m00004", "e"]], { a: "m00001", b: "m00002", d: "m00004", e: "m00005" });
    assert.ok(supersededRefRejection([{ startRef: "m00003", endRef: "m00004" }], s) !== null, "span crossing the dead hole vetoes");
    assert.equal(supersededRefRejection([{ startRef: "m00004", endRef: "m00005" }], s), null, "live span passes");
});

test("S-D: fresh session (never re-stamped) passes untouched", () => {
    assert.equal(supersededRefRejection([{ startRef: "m00001", endRef: "m00005" }], {} as Session), null);
});

test("S-E: cold-load restamp keeps every advertised range submittable (production deadlock shape)", async () => {
    const dir = join(testRoot, `se-${Math.random().toString(36).slice(2)}`);
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        // Two BLOCKED protected rows (seq 2 and 5) make the counter refs drift
        // ahead of seq+1 — the exact production precondition (kept/restamped split).
        const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
        const messages = ids.map((id) => msg(id));
        const legacy = legacyLike("i4797-se", messages);
        legacy.state.messageRefs = {
            byRaw: { a: "m00001", b: "m00002", c: "BLOCKED", d: "m00003", e: "m00004", f: "BLOCKED", g: "m00005", h: "m00006" },
            byRef: { m00001: "a", m00002: "b", m00003: "d", m00004: "e", m00005: "g", m00006: "h" },
        };
        const seedSession = {
            id: "i4797-se",
            createdAt: Date.now(),
            lastSeen: Date.now(),
            meta: { protocol: "anthropic" },
            stats: {},
            metadata: {},
            state: legacy.state,
            blockContents: new Map(),
            lastMessages: messages,
        } as never;
        assert.ok(store.flushSync(seedSession), "seed save committed");
        store.closeQuietly();

        // Cold load in a fresh instance fires the one-time alignment.
        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        _setStoreForTest(store2);
        const reloaded = store2.loadSync("i4797-se");
        assert.ok(reloaded, "session loads");
        const st = reloaded.state;
        assert.equal(st.messageRefs.byRaw.d, "m00004", "d re-stamped to seq3+1");
        assert.equal(st.messageRefs.byRaw.h, "m00008", "h re-stamped to seq7+1");
        assert.equal(reloaded.restampSuperseded?.get("m00003"), "d");
        assert.equal(reloaded.restampSuperseded?.get("m00006"), "h");

        // Facet 2: vacated-and-unregranted numbers are tombstoned as dead refs;
        // re-granted ones stay live (their current owner makes citations unambiguous).
        const dead = st.deadRefs ?? [];
        for (const r of ["m00003", "m00006"]) assert.ok(dead.includes(r), `${r} vacated without a re-grant → dead ref`);
        for (const r of ["m00004", "m00005", "m00007", "m00008"]) assert.ok(!dead.includes(r), `${r} re-granted → stays live`);

        // The suggestion side, exactly as acp-status computes it: the resent
        // view carries the six non-BLOCKED messages (protected rows absent).
        const core = createCore();
        const config = defaultConfig(200_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
        const view = () => messages.filter((m) => !["c", "f"].includes(m.id)).map((m) => ({ ...m }));
        const crossesDeadHole = (r: { startRef: string; endRef: string }): boolean => {
            const s = Number(r.startRef.replace(/\D/g, ""));
            const e = Number(r.endRef.replace(/\D/g, ""));
            return dead.some((d) => Number(d.replace(/\D/g, "")) > s && Number(d.replace(/\D/g, "")) < e);
        };
        const passesGate = (r: { startRef: string; endRef: string }): boolean =>
            supersededRefRejection([{ startRef: r.startRef, endRef: r.endRef }], reloaded) === null;

        // Pre-fix world (same view, no tombstones): the engine offers spans
        // that cross the vacated holes and EVERY one dies at the submit gate
        // — the production deadlock, reproduced in-process.
        const stPre = JSON.parse(JSON.stringify(st)) as typeof st;
        stPre.deadRefs = undefined;
        const rawPre = core.processTurn({ messages: view(), state: stPre, config, tokenCount: 190_000, renderTags: "none" }).nudge?.compressibleRanges ?? [];
        assert.ok(rawPre.length > 0, "pre-fix world advertises ranges");
        assert.ok(rawPre.some(crossesDeadHole), "pre-fix offer crosses a vacated hole");
        assert.ok(rawPre.every((r) => !passesGate(r)), "every pre-fix advertised span is refused by the gate (deadlock)");

        // Post-fix: the tombstones let the engine split at the holes, so no
        // advertised span crosses them and every span survives the gate.
        const raw = core.processTurn({ messages: view(), state: st, config, tokenCount: 190_000, renderTags: "none" }).nudge?.compressibleRanges ?? [];
        assert.ok(raw.length > 0, "nudge advertises ranges after the restart");
        assert.equal(raw.filter(crossesDeadHole).length, 0, "no advertised span crosses a vacated hole");
        assert.ok(raw.every(passesGate), "every advertised range is submittable");

        // THE INVARIANT (defense in depth, exactly what acp-status applies):
        // after the suggestion-side exclusion, every offered range must pass
        // the submit gate — status and compress agree on the ref space, no
        // matter how many times the model round-trips.
        const offered = excludeDeadRefRanges(raw, st.deadRefs);
        assert.ok(offered.length > 0, "some ranges remain advertisable");
        for (const r of offered) {
            assert.ok(passesGate(r), `advertised range ${r.startRef}–${r.endRef} must be submittable`);
        }
        store2.closeQuietly();
    } finally {
        _setStoreForTest({} as never);
        rmSync(dir, { recursive: true, force: true });
    }
});
