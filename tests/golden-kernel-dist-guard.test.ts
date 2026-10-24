/**
 * #3325: the storage-render golden drive must refuse to run on a stale kernel
 * dist — a stale node_modules/acp-kernel/dist stamps removed fields into
 * persisted state, so a regen from that workspace bakes digests no fresh build
 * can reproduce (CI then fails every leg carrying the golden file). These tests
 * pin the guard itself (kernelDistStale in golden-storage-drive.ts) using
 * synthetic trees — no real dist mtime is touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cache from "../scripts/ci-pretest-cache.mjs";
import { kernelDistStale } from "./golden-storage-drive.ts";

function makeTree(distAtSrc: boolean): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kdist-"));
    const srcDir = path.join(root, "kernel", "src", "filter");
    fs.mkdirSync(srcDir, { recursive: true });
    const distDir = path.join(root, "node_modules", "acp-kernel", "dist");
    fs.mkdirSync(distDir, { recursive: true });
    const now = Date.now();
    const oldMs = now - 10 * 60_000;
    fs.writeFileSync(path.join(srcDir, "index.ts"), "export {};");
    fs.writeFileSync(path.join(root, "kernel", "tsup.config.ts"), "export {};");
    // Both source files get the same stamp; dist either older (stale) or newer.
    const stamp = oldMs;
    const distStamp = distAtSrc ? now : stamp - 60_000;
    for (const f of [path.join(srcDir, "index.ts"), path.join(root, "kernel", "tsup.config.ts")]) fs.utimesSync(f, new Date(stamp), new Date(stamp));
    const distEntry = path.join(distDir, "index.js");
    fs.writeFileSync(distEntry, "export {};");
    fs.utimesSync(distEntry, new Date(distStamp), new Date(distStamp));
    return root;
}

test("kernelDistStale: dist older than kernel/src is reported stale with the newest source named", () => {
    const t = makeTree(false);
    try {
        const r = kernelDistStale(t);
        assert.equal(r.stale, true);
        assert.ok(r.newestSrc && r.newestSrc.length > 0);
    } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test("kernelDistStale: dist newer than kernel/src is not stale", () => {
    const t = makeTree(true);
    try {
        const r = kernelDistStale(t);
        assert.equal(r.stale, false);
    } finally { fs.rmSync(t, { recursive: true, force: true }); }
});

test("kernelDistStale: missing dist entry is not our error (tsx surfaces module-not-found)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kdist-"));
    try {
        const r = kernelDistStale(root);
        assert.equal(r.stale, false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// #4541 end-to-end pin: CI restores kernel/dist from actions/cache with
// archive-time mtimes newer-checkout sources; without the pretest hook's
// HIT-time mtime refresh this exact shape reads as stale and every cache-hit
// leg's golden shard goes red.
test("#4541: pretest-cache HIT over a restored dist leaves the guard not stale", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kdist-restore-"));
    try {
        const w = (rel: string): void => {
            fs.mkdirSync(path.join(root, rel, ".."), { recursive: true });
            fs.writeFileSync(path.join(root, rel), "x");
        };
        // The exact input surface hashComponent hashes for COMPONENTS[0].
        w("package-lock.json");
        w("kernel/src/index.ts");
        w("kernel/tsup.config.ts");
        w("kernel/tsconfig.json");
        w("kernel/package.json");
        w("kernel/package-lock.json");
        const kernel = cache.COMPONENTS[0];
        const distDir = path.join(root, kernel.dir, "dist");
        fs.mkdirSync(distDir, { recursive: true });
        fs.writeFileSync(path.join(distDir, "index.js"), "built");
        fs.writeFileSync(path.join(distDir, cache.MARKER_NAME), `${cache.hashComponent(root, kernel)}\n`);
        // Restore shape: dist carries archive-time mtimes, sources are newer
        // (checkout T0 > cache save T_prev — the CI order that broke #4541).
        const archiveTime = new Date(Date.now() - 3600_000);
        for (const f of [path.join(distDir, "index.js"), path.join(distDir, cache.MARKER_NAME)]) fs.utimesSync(f, archiveTime, archiveTime);
        // npm materializes the file: dep as a symlink (lockfile link:true) —
        // the guard stats through node_modules/acp-kernel/dist.
        fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
        fs.symlinkSync(path.join(root, "kernel"), path.join(root, "node_modules", "acp-kernel"), process.platform === "win32" ? "junction" : "dir");

        assert.equal(kernelDistStale(root).stale, true, "precondition: the bare restore is what the guard misreads as stale");
        cache.runPretestCache({
            root,
            components: [kernel],
            build: (): void => { throw new Error("no rebuild expected on a fresh-marker HIT"); },
            log: () => {},
        });
        assert.equal(kernelDistStale(root).stale, false, "#4541: a marker-verified restore must not read as stale");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
