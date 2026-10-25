import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #4733 stakes — the one-time ledger restamp (#4316 PR3/3) re-keys
 * messageRefs but must move the CCR content store's frozen ref→rawId
 * aliases in the same operation, and range decompress must never serve a
 * store entry whose frozen alias names a different raw than the coverage
 * pair certifies.
 *
 * S16a: cold load re-stamps drifted counter refs AND re-keys the CCR store
 *      onto the stamped refs (entries follow their rawId; superseded keys
 *      vanish); the forkSnapshot alias invariant holds afterwards; the
 *      re-keyed state persists and is stable across a second cold load.
 * S16b: zero-drift sessions (refs already seq+1) never touch the store —
 *      no re-key pass, no dirty flag (gate negative direction).
 * S16c: range decompress with a store hit whose frozen alias names a
 *      DIFFERENT raw than the coverage pair → treated as not-found, view
 *      fallback serves the right message (no cross-message misattribution);
 *      a matching alias still hits the store (gate positive direction).
 */
process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
const testRoot = mkdtempSync(join(tmpdir(), "bili-4733-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

import { createContentStore, createCore, defaultConfig, retrieveByRef, storeOriginal, type Config, type CoreMessage, type MessageContentStore } from "acp-kernel";
import type { LegacySessionLike } from "../src/storage/ingest.ts";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { storeEffectiveCcr } from "../src/store.ts";
import { getSession } from "../src/session.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges } from "../src/stream.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";

function msg(id: string): CoreMessage {
    return { id, role: "user", contentType: "text", text: `content for ${id} ${"x".repeat(120)}` };
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

function seedStore(entries: Array<[ref: string, rawId: string, text: string]>): MessageContentStore {
    let store = createContentStore();
    for (const [ref, rawId, text] of entries) {
        store = storeOriginal(store, { ref, rawId, text, kind: "shell output", tokens: 10, head: text.slice(0, 8) });
    }
    return store;
}

test("S16a: cold-load restamp re-keys the CCR content store onto the stamped refs", async () => {
    // Same drift shape as S15 (BLOCKED skip: d=m3, e=m4 while rows are
    // 0..4 → cold load stamps d→m4, e→m5), plus CCR entries keyed by the
    // PRE-stamp refs. The stamp moves the numbers; the entries must follow.
    const dir = join(testRoot, `s16a-${Math.random().toString(36).slice(2)}`);
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        const messages = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];
        const legacy = legacyLike("i4733-restamp", messages);
        legacy.state.messageRefs = {
            byRaw: { a: "m00001", b: "m00002", c: "BLOCKED", d: "m00003", e: "m00004" },
            byRef: { m00001: "a", m00002: "b", m00003: "d", m00004: "e" },
        };
        const seedSession = {
            id: "i4733-restamp",
            createdAt: Date.now(),
            lastSeen: Date.now(),
            meta: { protocol: "anthropic" },
            stats: {},
            metadata: {},
            state: legacy.state,
            blockContents: new Map(),
            lastMessages: messages,
            contentStore: seedStore([["m00001", "a", "ORIGINAL-A"], ["m00003", "d", "ORIGINAL-D"], ["m00004", "e", "ORIGINAL-E"]]),
            contentStoreDirty: true,
        } as never;
        store.scheduleSave(seedSession as never);
        assert.ok(store.flushSync(seedSession as never), "seed save committed");

        store.closeQuietly();
        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        _setStoreForTest(store2);
        const reloaded = store2.loadSync("i4733-restamp");
        assert.ok(reloaded, "session loads");
        const refs = reloaded.state.messageRefs;
        assert.equal(refs.byRaw.d, "m00004", "d re-stamped to seq3+1");
        assert.equal(refs.byRaw.e, "m00005", "e re-stamped to seq4+1");

        // #4733: the CCR store's frozen aliases moved WITH the numbers.
        const st = reloaded.contentStore;
        assert.ok(st, "content store materialized on cold load");
        assert.deepEqual(Object.keys(st!.byRef).sort(), ["m00001", "m00004", "m00005"], "entries followed their rawIds into the stamped map");
        assert.equal(st!.byRef["m00004"]!.rawId, "d");
        assert.equal(st!.byRef["m00005"]!.rawId, "e");
        const rd = retrieveByRef(st!, "m00004");
        assert.ok(rd.ok && rd.text === "ORIGINAL-D", "stamped key retrieves d's original");
        assert.equal((retrieveByRef(st!, "m00003") as { ok: boolean }).ok, false, "superseded key is gone");
        // scheduleSave runs saveContentStore SYNCHRONOUSLY inside loadSync, so
        // the in-memory flag is already legitimately cleared here — the
        // observable contract is that BOTH persist routes hold the re-keyed
        // aliases (disk round-trip below + second cold load).
        // The exact forkSnapshot alias invariant (src/plugin.ts forkSnapshot):
        // without it every fork of this session 409s forever after restart.
        for (const [ref, entry] of Object.entries(st!.byRef)) {
            assert.equal(typeof st!.byHash[entry.hash], "string", "hash payload present for " + ref);
            assert.equal(refs.byRaw[entry.rawId], ref, "byRaw[entry.rawId] === ref");
            assert.equal(refs.byRef[ref], entry.rawId, "byRef[ref] === entry.rawId");
        }
        assert.ok(store2.flushSync(reloaded), "aligned + re-keyed state committed");

        // Second cold load: stable (kept only), no double re-key, dirty cleared.
        store2.closeQuietly();
        const store3 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        _setStoreForTest(store3);
        const again = store3.loadSync("i4733-restamp");
        assert.ok(again);
        assert.deepEqual(Object.keys(again.contentStore!.byRef).sort(), ["m00001", "m00004", "m00005"], "store keys stable across reloads");
        assert.ok(!again.contentStoreDirty, "dirty flag cleared after the aligned flush");
        assert.equal((again.state as { refLedgerAligned?: boolean }).refLedgerAligned, true);
        assert.equal(again.restampSuperseded, undefined);
        // Sidecar-route round-trip: the file on disk carries the re-keyed keys.
        const fromDisk = store3.loadContentStore({ id: "i4733-restamp", meta: { protocol: "anthropic" } } as never);
        assert.ok(fromDisk, "sidecar present after the aligned flush");
        assert.deepEqual(Object.keys(fromDisk.byRef).sort(), ["m00001", "m00004", "m00005"], "sidecar carries the re-keyed aliases");
        store3.closeQuietly();
    } finally {
        // Restore a properly disabled singleton ({} would break later
        // getSession() reloads in other test files sharing this process).
        _setStoreForTest(new SessionStore({ enabled: false }));
    }
    rmSync(dir, { recursive: true, force: true });
});

test("S16b: zero-drift sessions never touch the CCR store during alignment", async () => {
    // Refs already equal seq+1 (no BLOCKED skip): the stamp keeps everything
    // and must NOT run the re-key pass at all — no object replacement, no
    // dirty flag (the gate's negative direction).
    const dir = join(testRoot, `s16b-${Math.random().toString(36).slice(2)}`);
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        const messages = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];
        const legacy = legacyLike("i4733-nodrift", messages);
        legacy.state.messageRefs = {
            byRaw: { a: "m00001", b: "m00002", c: "m00003", d: "m00004", e: "m00005" },
            byRef: { m00001: "a", m00002: "b", m00003: "c", m00004: "d", m00005: "e" },
        };
        const seedSession = {
            id: "i4733-nodrift",
            createdAt: Date.now(),
            lastSeen: Date.now(),
            meta: { protocol: "anthropic" },
            stats: {},
            metadata: {},
            state: legacy.state,
            blockContents: new Map(),
            lastMessages: messages,
            contentStore: seedStore([["m00002", "b", "ORIGINAL-B"]]),
            contentStoreDirty: true,
        } as never;
        store.scheduleSave(seedSession as never);
        assert.ok(store.flushSync(seedSession as never), "seed save committed");

        store.closeQuietly();
        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        _setStoreForTest(store2);
        const reloaded = store2.loadSync("i4733-nodrift");
        assert.ok(reloaded, "session loads");
        assert.equal((reloaded.state as { refLedgerAligned?: boolean }).refLedgerAligned, true);
        assert.equal(reloaded.restampSuperseded, undefined, "nothing was superseded");
        const st = reloaded.contentStore;
        assert.ok(st, "content store materialized");
        assert.deepEqual(Object.keys(st!.byRef), ["m00002"], "store untouched");
        const rb = retrieveByRef(st!, "m00002");
        assert.ok(rb.ok && rb.text === "ORIGINAL-B");
        assert.ok(!reloaded.contentStoreDirty, "alignment did not mark the store dirty");
        store2.closeQuietly();
    } finally {
        // Restore a properly disabled singleton ({} would break later
        // getSession() reloads in other test files sharing this process).
        _setStoreForTest(new SessionStore({ enabled: false }));
    }
    rmSync(dir, { recursive: true, force: true });
});

// --- S16c: range-decompress rawId cross-check ------------------------------

function foldCcr() {
    const core = createCore();
    const config = applyCompressSettings(
        defaultConfig(200_000),
        200_000,
        { ccr: { enabled: true, minToolTokens: 50 } },
    ) as Config;
    const session = getSession(`i4733-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 20; i++) {
        msgs.push({ id: `h_${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: `\x3cacp tokens="2K" type="text"\x3em${String(i + 1).padStart(5, "0")}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(2000)}` });
    }
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "The first seven messages of this session are covered by this early-history summary.", topic: "Early history" }] }), ctx);
    const block = [...session.state.blocks].find((b) => b.active);
    assert.ok(block, "a block was created");
    if (!session.contentStore) session.contentStore = createContentStore();
    return { core, config, session, ctx, blockId: block.blockId };
}

test("S16c: store hit whose frozen alias names another raw is refused, view fallback serves the right message", () => {
    const f = foldCcr();
    // Coverage certifies m00003 ↔ h_2. Forge the post-drift state: the
    // store's m00003 entry is frozen to a DIFFERENT raw (h_4) — exactly what
    // an un-rekeyed/re-homed number looks like.
    // The fold stored real originals under EVERY covered ref (first write wins);
    // drop m00003's entry to simulate the post-restamp drift state — the frozen
    // alias no longer owns the number — then forge an alias naming a DIFFERENT
    // raw under it (what a stale store looks like when another message took the
    // number over).
    delete f.session.contentStore!.byRef.m00003;
    f.session.contentStore = storeOriginal(f.session.contentStore!, { ref: "m00003", rawId: "h_4", text: "STORED-UNDER-WRONG-RAW-MARKER", kind: "shell output", tokens: 10, head: "STORED" });
    const viewMsg: CoreMessage = { id: "h_2", role: "user", contentType: "text", text: "VIEW-H2-TEXT" };
    // The restored body rides as an ephemeral injection queued on the session
    // (resolveDecompressRange #1207); .text is only the toolOk receipt.
    const res = resolveDecompress({ blockId: f.blockId, startId: "m00003", endId: "m00003" }, { ...f.ctx, messages: [viewMsg] });
    assert.doesNotMatch(res.text, /FAILED/, `must not fail outright: ${res.text.slice(0, 160)}`);
    const injected = f.session.pendingRetrievals[f.session.pendingRetrievals.length - 1]?.injection?.text ?? "";
    assert.match(injected, /VIEW-H2-TEXT/, "view fallback keyed by the stable raw id");
    assert.doesNotMatch(injected, /STORED-UNDER-WRONG-RAW-MARKER/, "never serve another message's original");
    // Honest degradation: no view fallback either → explicit failure receipt,
    // still not the wrong original.
    const res2 = resolveDecompress({ blockId: f.blockId, startId: "m00003", endId: "m00003" }, { ...f.ctx, messages: [] });
    assert.match(res2.text, /FAILED/);
    assert.doesNotMatch(res2.text, /STORED-UNDER-WRONG-RAW-MARKER/);
});

test("S16c negative control: a matching alias still hits the store", () => {
    const f = foldCcr();
    delete f.session.contentStore!.byRef.m00003; // same drift-state surgery as the positive test (fold stored every covered ref)
    f.session.contentStore = storeOriginal(f.session.contentStore!, { ref: "m00003", rawId: "h_2", text: "STORED-H2-CORRECT-MARKER", kind: "shell output", tokens: 10, head: "STORED" });
    const res = resolveDecompress({ blockId: f.blockId, startId: "m00003", endId: "m00003" }, { ...f.ctx, messages: [{ id: "h_2", role: "user", contentType: "text", text: "VIEW-H2-TEXT" }] });
    assert.doesNotMatch(res.text, /FAILED/, `matching alias must hit the store: ${res.text.slice(0, 160)}`);
    const injected = f.session.pendingRetrievals[f.session.pendingRetrievals.length - 1]?.injection?.text ?? "";
    assert.match(injected, /STORED-H2-CORRECT-MARKER/);
    assert.match(injected, /• stored/);
});
