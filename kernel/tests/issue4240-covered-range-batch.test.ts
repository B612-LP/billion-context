// #4240: a compress batch whose ranges were ALREADY folded (refs still alive
// on full-log hosts, so they classify "ok") used to die at apply time inside
// the atomic batch contract (#3939): the livelock guard threw, the WHOLE batch
// was rejected, and sibling ranges that carried genuinely new content never
// landed — "Batch rejected before folding any range", the loop the reporter
// saw on every compression attempt. A zero-new projection is an
// order-independent NO-OP, so the kernel now pre-screens such ranges (same
// projectUnit judgment the apply lane throws by, #3236/#3371) and skips them
// per-range with a warning; only genuine fatals (protected zone / turn
// integrity) still poison the batch, and an ALL-no-op batch still gets a hard
// rejection naming the covering blocks (never a silent zero-fold success —
// dog/billion-context-pi#199).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { indexToRef } from "../src/refs.js";
import { markBlockRestoredInline } from "../src/decompress.js";
import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
  Config,
} from "../src/types.js";

const OLD_SUMMARY = "OLD SUMMARY";
const NEW_SUMMARY = "NEW SUMMARY carrying the re-folded details verbatim.";

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 6000,
      growthCap: 50000,
      minGrowthFloor: 5000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    compress: {
      minCompressRange: 500,
      maxSummaryLength: 20000,
      minSummaryLength: 10,
    },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

/** ~91 chars each — ten of them clear minCompressRange 500 on their own. */
function longMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i + 1}`,
    role: "assistant",
    contentType: "text",
    text: `content ${i + 1} ${"x".repeat(80)}`,
  }));
}

function shortMsg(id: string, text: string): CoreMessage {
  return { id, role: "assistant", contentType: "text", text };
}

function makeBlock(
  overrides: Partial<CompressionBlock> &
    Pick<CompressionBlock, "blockId" | "effectiveMessageIds">,
): CompressionBlock {
  return {
    runId: "r1",
    tier: 1,
    summary: OLD_SUMMARY,
    directMessageIds: overrides.effectiveMessageIds,
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: 1758800000000,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

/** Full-history fixture: refs assigned across ALL messages and the caller
 *  passes the UNPRUNED view, so covered spans RESOLVE (status ok) instead of
 *  classifying consumed — the exact shape #4240 reports. */
function makeState(
  messages: CoreMessage[],
  blocks: CompressionBlock[],
): CompressionState {
  const state = createInitialState();
  state.blocks.push(...blocks);
  messages.forEach((message, i) => {
    const ref = indexToRef(i + 1);
    state.messageRefs.byRaw[message.id] = ref;
    state.messageRefs.byRef[ref] = message.id;
  });
  state.nextBlockId = Math.max(
    state.nextBlockId,
    ...blocks.map((block) => Number(block.blockId.slice(1)) + 1),
  );
  return state;
}

test("#4240: stale covered ranges warn-skip while the fresh sibling lands (incident shape)", () => {
  const core = createCore();
  const messages = longMessages(30);
  const state = makeState(messages, [
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.slice(0, 10).map((m) => m.id),
    }),
    makeBlock({
      blockId: "b2",
      effectiveMessageIds: messages.slice(10, 20).map((m) => m.id),
    }),
  ]);

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY },
      { startRef: "m00011", endRef: "m00020", summary: NEW_SUMMARY },
      { startRef: "m00021", endRef: "m00030", summary: NEW_SUMMARY },
    ],
    messages,
    state,
    config: config(),
  });

  assert.deepEqual(result.result.errors, [], "no range may poison the batch");
  assert.equal(result.result.blocksCreated, 1, "only the fresh range folds");
  const joined = result.result.warnings.join("\n");
  assert.match(
    joined,
    /Skipped range \(m00001\.\.m00010\) — contains no new compressible messages — every message in it is already covered by active block\(s\) b1/,
  );
  assert.match(
    joined,
    /Skipped range \(m00011\.\.m00020\) — contains no new compressible messages — every message in it is already covered by active block\(s\) b2/,
  );
  assert.match(joined, /In-place refold unavailable: blocked by b1 \(not restored\)/);
  const fresh = result.state.blocks.find((b) => b.blockId !== "b1" && b.blockId !== "b2");
  assert.ok(fresh, "the fresh range produced a new block");
  assert.deepEqual(
    fresh!.effectiveMessageIds,
    messages.slice(20).map((m) => m.id),
  );
  for (const id of ["b1", "b2"]) {
    const block = result.state.blocks.find((b) => b.blockId === id)!;
    assert.equal(block.active, true, `${id} stays active`);
    assert.equal(block.summary, OLD_SUMMARY, `${id} untouched`);
  }
  assert.equal(result.state.nextBlockId, 4, "exactly one new id allocated");
});

test("#4240: an all-no-op batch keeps the hard rejection naming the covering blocks", () => {
  const core = createCore();
  const messages = longMessages(10);
  const state = makeState(messages, [
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.map((m) => m.id),
    }),
  ]);

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.errors.length, 1, "never a silent zero-fold success");
  assert.match(result.result.errors[0]!, /Requested range\(s\) already compressed/);
  assert.match(
    result.result.errors[0]!,
    /Range m00001\.\.m00010 contains no new compressible messages — every message in it is already covered by active block\(s\) b1/,
  );
  assert.match(result.result.errors[0]!, /reference them by block ID \(b1\.\.b1\)/);
  assert.match(result.result.errors[0]!, /blocked by b1 \(not restored\)/);
  assert.match(result.result.errors[0]!, /decompress with inline:true/);
  assert.match(
    result.result.errors[0]!,
    /Continue the task, or run acp_status and target one of the CURRENT compressible ranges it reports/,
  );
  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.state.blocks.length, 1, "nothing applied");
  assert.equal(result.state.blocks[0]!.summary, OLD_SUMMARY);
  assert.equal(result.state.nextBlockId, 2, "no run id allocated (#2370)");
});

test("#4240: a stale range plus a genuine protected-zone fatal still rejects the whole batch", () => {
  const core = createCore();
  const messages = longMessages(16);
  const state = makeState(messages, [
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.slice(0, 10).map((m) => m.id),
    }),
  ]);

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY },
      { startRef: "m00011", endRef: "m00016", summary: NEW_SUMMARY },
    ],
    messages,
    state,
    config: config(),
    protectedMessageIds: new Set([
      "m00011",
      "m00012",
      "m00013",
      "m00014",
      "m00015",
      "m00016",
    ]),
  });

  // Content-class fatals keep the #3939 atomic contract: nothing lands.
  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.state.blocks.length, 1, "the fresh fold must NOT land");
  assert.equal(result.state.blocks[0]!.summary, OLD_SUMMARY);
  assert.match(
    result.result.errors[0]!,
    /Batch rejected before folding any range.*entirely within the protected zone/s,
  );
});

test("#4240: an oversized summary on a stale range no longer kills a salvageable batch", () => {
  const core = createCore();
  const messages = longMessages(20);
  const state = makeState(messages, [
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.slice(0, 10).map((m) => m.id),
    }),
  ]);

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00010",
        summary: "x".repeat(40), // exceeds maxSummaryLength 20
      },
      { startRef: "m00011", endRef: "m00020", summary: "ok tail" },
    ],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 500, maxSummaryLength: 20, minSummaryLength: 0 },
    }),
  });

  // Pre-#4240 the length pre-check validated the stale range's summary and
  // rejected the whole batch; its summary stores nowhere, so it is exempt now.
  assert.deepEqual(result.result.errors, [], "no length failure may surface");
  assert.equal(result.result.blocksCreated, 1, "the fresh sibling lands");
  assert.match(
    result.result.warnings.join("\n"),
    /Skipped range \(m00001\.\.m00010\) — contains no new compressible messages/,
  );
  assert.doesNotMatch(
    JSON.stringify(result.result),
    /Summary too long/,
    "the oversized stale summary is never validated",
  );
});

test("#4240: a refoldable covered range still refolds in place inside a mixed batch", () => {
  const core = createCore();
  const messages = longMessages(20);
  const { state: marked } = markBlockRestoredInline(
    makeState(messages, [
      makeBlock({
        blockId: "b1",
        effectiveMessageIds: messages.slice(0, 10).map((m) => m.id),
      }),
    ]),
    "b1",
  );

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY },
      { startRef: "m00011", endRef: "m00020", summary: NEW_SUMMARY },
    ],
    messages,
    state: marked,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 2, "refold + fresh fold");
  const b1 = result.state.blocks.find((block) => block.blockId === "b1")!;
  assert.equal(b1.summary, NEW_SUMMARY, "updated in place (#398)");
  assert.equal(b1.restoredInline, false);
  const fresh = result.state.blocks.filter((block) => block.blockId !== "b1");
  assert.equal(fresh.length, 1);
  assert.deepEqual(
    fresh[0]!.effectiveMessageIds,
    messages.slice(10).map((m) => m.id),
  );
  assert.equal(result.state.nextBlockId, 3, "exactly one new id allocated");
});

test("#4240: stale text no longer inflates the size gate — sub-threshold fresh part gets the honest too-small verdict", () => {
  const core = createCore();
  const messages = [
    ...longMessages(10),
    shortMsg("short-a", "alpha"),
    shortMsg("short-b", "beta"),
  ];
  const state = makeState(messages, [
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.slice(0, 10).map((m) => m.id),
    }),
  ]);

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY },
      { startRef: "m00011", endRef: "m00012", summary: NEW_SUMMARY },
    ],
    messages,
    state,
    config: config(),
  });

  // Only the ~10 chars of the fresh part count; the covered part's ~900
  // characters must not push the batch over minCompressRange 500.
  assert.equal(result.result.blocksCreated, 0);
  assert.match(result.result.errors[0]!, /Total compressible content too small/);
  assert.match(result.result.errors[0]!, /blocked by b1 \(not restored\)/);
  assert.doesNotMatch(result.result.errors[0]!, /already compressed/);
  assert.equal(result.state.blocks.length, 1);
});

test("#4240: minCompressRange 0 — an all-no-op batch still hard-rejects via the post-loop safety net", () => {
  const core = createCore();
  const messages = longMessages(10);
  const state = makeState(messages, [
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.map((m) => m.id),
    }),
  ]);

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY }],
    messages,
    state,
    config: config({ compress: { minCompressRange: 0, maxSummaryLength: 20000, minSummaryLength: 10 } }),
  });

  // The size gate is disabled at 0; without the safety net this batch would
  // return a SUCCESS receipt with zero folds (dog/billion-context-pi#199).
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /Requested range\(s\) already compressed/);
  assert.match(
    result.result.errors[0]!,
    /contains no new compressible messages — every message in it is already covered by active block\(s\) b1/,
  );
  assert.equal(result.result.blocksCreated, 0);
  assert.deepEqual(result.result.warnings, [], "skip warnings do not leak into a rejection");
  assert.equal(result.state.blocks[0]!.summary, OLD_SUMMARY);
});
