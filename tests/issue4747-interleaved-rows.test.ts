import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStoredDecompositions, type DecompositionSource, type StoredRow } from "../src/fold-decomposition-lookup.ts";
import type { Session } from "../src/session.ts";
import type { FoldAnchor } from "../src/fold-reconcile.ts";

const mkSession = (anchorIds: string[]): Session => ({
    id: "s", meta: {}, stats: {}, metadata: {
        foldAnchors: Object.fromEntries(anchorIds.map((id) => [id, { r: "assistant" }])),
        foldStoredTried: {},
    },
    state: {} as never, createdAt: 1, lastSeen: 2, blockContents: new Map(), inFlight: 0,
    persisted: false, pendingRetrievals: [],
} as never);

test("#4747: interleaved rows (A1,B1,A2,B2) keep every id's LATEST row", () => {
    const rows: StoredRow[] = [
        { seq: 10, msgId: "A", content: JSON.stringify({ id: "A", role: "assistant", contentType: "text", text: "A-old" }) },
        { seq: 11, msgId: "B", content: JSON.stringify({ id: "B", role: "assistant", contentType: "text", text: "B-1" }) },
        { seq: 12, msgId: "A", content: JSON.stringify({ id: "A", role: "assistant", contentType: "text", text: "A-new" }) },
        { seq: 13, msgId: "B", content: JSON.stringify({ id: "B", role: "assistant", contentType: "text", text: "B-2" }) },
    ];
    const src: DecompositionSource = { rows: (_sid, ids) => (ids.includes("A") || ids.includes("B") ? rows : []) };
    const out = resolveStoredDecompositions(mkSession(["A", "B"]), "s", new Set(["wire-live"]), src);
    assert.ok(out !== undefined, "rows returned");
    const texts = out!.map((m) => (m as { text?: string }).text);
    assert.deepEqual(texts, ["A-new", "B-2"], "each id's LATEST row survives interleaving — old splice desync deleted A-new and duplicated B");
});
