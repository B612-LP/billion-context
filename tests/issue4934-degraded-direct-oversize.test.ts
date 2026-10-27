import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// #4934: field shape — WorkBuddy/deepseek 1M-window model rejected a degraded
// direct send with "prompt is too long: 1866803 tokens > 1048576 maximum". The
// proxy had just died (anti-orphan parent-gone), so the request rode the DEGRADED
// direct-send path in native-intercept.ts. That path measures the host's ORIGINAL
// request, which never carries x-bili-plugin-context-window (bili stamps that header
// only onto the PROXY-rewritten request), so the #4516 oversize guard disarmed and
// the ~1.87M-token raw history went straight to the provider. The fix exposes the
// lane's own resolved window (state.resolveContextWindow) as a secondary source so
// the guard arms there; unknown window keeps #4516's fail-open. Hermetic like
// issue4516-pi-direct-fallback.test.ts: XDG_STATE_HOME redirected so no event
// reaches a real log file.
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4934-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const UPSTREAM = "http://127.0.0.1:8199/v1/chat/completions";

function fakeFetch(sink: string[]) {
    return (async (input: string | URL | Request, _init?: RequestInit) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

function chatBody(textChars: number): string {
    return JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "x".repeat(textChars) }] });
}

interface Ctx {
    sink: string[];
    fetch: () => typeof fetch;
}

/** Drive a request through a freshly installed intercept whose proxy never comes
 *  up (respawn stub always fails), exercising the degraded direct-send path. */
async function withDegradedDirect<T>(
    fn: (ctx: Ctx & { resolveContextWindow: (v: number | undefined) => void }) => Promise<T>,
    resolveContextWindow: (() => number | undefined) | undefined = undefined,
): Promise<{ sink: string[]; result: T }> {
    const saved = globalThis.fetch;
    const sink: string[] = [];
    const state: import("../src/agent/native-intercept.js").NativeInterceptState = {
        origin: undefined,
        ready: Promise.resolve(undefined),
        respawn: async () => undefined,
    };
    if (resolveContextWindow !== undefined) state.resolveContextWindow = resolveContextWindow;
    const mod = await import("../src/agent/native-intercept.js");
    mod._resetForTest();
    globalThis.fetch = fakeFetch(sink);
    try {
        assert.equal(mod.installNativeFetchIntercept(state), true);
        const result = await fn({
            sink,
            fetch: () => globalThis.fetch,
            // Tests can override the resolver mid-run (the intercept reads it per request).
            resolveContextWindow: (v) => { state.resolveContextWindow = v === undefined ? undefined : () => v; },
        });
        return { sink, result };
    } finally {
        globalThis.fetch = saved;
        mod._resetForTest();
    }
}

test("#4934 lane-known window + headerless oversized body → local 422, upstream never hit", async () => {
    const { sink, result } = await withDegradedDirect(async ({ fetch }) => {
        const res = await fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(4_200_000) });
        const body = await res.json() as Record<string, unknown>;
        return { status: res.status, gate: res.headers.get("x-bili-gate"), body };
    }, () => 1_048_576);
    assert.equal(result.status, 422);
    assert.equal(result.gate, "oversize-refusal-fallback");
    assert.equal((result.body.error as { code: string }).code, "bili_gate_oversize_refusal_fallback");
    assert.equal((result.body.error as { retryable: boolean }).retryable, true);
    assert.deepEqual(sink, [], "the provider must never see an oversized direct send (#4934)");
});

test("#4934 lane-known window that FITS the body → still goes direct (no false refusal)", async () => {
    const { sink, result } = await withDegradedDirect(async ({ fetch }) => {
        const res = await fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(4_200_000) });
        return res.status;
    }, () => 2_000_000);
    assert.equal(result, 200);
    assert.deepEqual(sink, [UPSTREAM], "a body that fits the lane's known window keeps direct semantics");
});

test("#4934 no resolver AND no header → fail open to direct (#4516 principle preserved)", async () => {
    const { sink, result } = await withDegradedDirect(async ({ fetch }) => {
        const res = await fetch()(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: chatBody(4_200_000) });
        return res.status;
    });
    assert.equal(result, 200);
    assert.deepEqual(sink, [UPSTREAM]);
});

test("#4934 header wins over the lane resolver (a smaller declared bar still binds)", async () => {
    const { sink, result } = await withDegradedDirect(async ({ fetch }) => {
        const res = await fetch()(UPSTREAM, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-context-window": "500" },
            body: chatBody(4_200_000),
        });
        return res.status;
    }, () => 2_000_000);
    assert.equal(result, 422);
    assert.deepEqual(sink, [], "the request's own declared window takes precedence over the resolver");
});
