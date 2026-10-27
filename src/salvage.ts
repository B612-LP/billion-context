// #4889: public repair entry for layers that sit BETWEEN the model and bili's
// tool execution — provider plugins / gateways that assemble tool_call
// arguments and hand them to a host doing ONE strict JSON.parse per call.
// They hold the complete argument bytes before any parse; running them through
// salvageCompressArgs there recovers bad-shape-A compress args (#2580) on the
// lanes where bili's own wire rewrite never sees them (third-party providers,
// non-Anthropic protocols). Same implementation as the plugin relay's rewrite
// (plugin-compress-salvage.ts) — no second regex copy.
// #1039 boundary inherited from the ladder: strict-JSON input returns null
// (leave it byte-identical), unrecoverable input returns null too (the host
// rejects it as today); non-null is always strict JSON ready to parse.

import { salvageCompressArgs } from "./plugin-compress-salvage.js";

export function repairCompressArgs(raw: string, callId?: string): string | null {
    const s = salvageCompressArgs(raw, callId ?? "external-salvage");
    return s.action === "canonicalized" || s.action === "wrapped" ? s.out : null;
}
