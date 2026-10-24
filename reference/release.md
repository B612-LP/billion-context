# Release Workflow Reference

> **Not auto-loaded.** On-demand mechanics pulled out of `AGENTS.md` §5 to keep the
> auto-loaded spec lean. The hard rules (never manual publish, version-only-on-release-branch,
> kernel changes are human-gated, updater changes need a no-op release first) stay in
> [`AGENTS.md` §5](../AGENTS.md#5-release-workflow); this file holds the exact steps,
> the one-click workflow internals, and the no-op validation protocol.

Releases are **fully automated via CI** (`.github/workflows/release.yml`; kernel
releases use `.github/workflows/release-kernel.yml`). The Agent prepares a release PR;
merging it triggers CI which builds, tests, publishes to npm, creates a git tag, and
creates a GitHub Release. For routine patch releases there is also a one-click fast
path below.

## Branch Naming

Release branches: `YYYY-MM-DD_release-v{VERSION}` (e.g., `2026-08-08_release-v0.1.17`)

Kernel release branches: `YYYY-MM-DD_release-kernel-v{VERSION}` (e.g. `2026-11-01_release-kernel-v0.0.102`) — see "Kernel releases" below.

## Process (exact steps)

The Agent does steps 1–6, the human does step 7 (merge).

1. **Sync master**:
   ```bash
   git checkout master && git pull --ff-only origin master
   ```
2. **Create the release branch** from master:
   ```bash
   git checkout -b $(date +%Y-%m-%d)_release-v{VERSION}
   ```
3. **Bump version** — edit ONLY the `"version"` field in `package.json`:
   ```diff
   -    "version": "0.1.16",
   +    "version": "0.1.17",
   ```
   Then regenerate the lock so its root + `file:`-link version fields track the
   bump — editing `package.json` alone does NOT touch `package-lock.json` (#2704):
   ```bash
   npm install --package-lock-only --ignore-scripts --no-fund --no-audit
   git diff --exit-code -- package-lock.json   # must be clean before you commit
   ```
    CI enforces this with the `lock-sync` guard (`ci.yml`).
 3.5. **Sync plugin manifest versions (#4449)** — run on the release branch,
    AFTER the bump commit, and commit the result as its own commit:
    ```bash
    node scripts/sync-codex-plugin-version.mjs
    git add .agents .claude-plugin plugins/codex
    git commit -m "chore: sync plugin manifests to v{VERSION}"
    ```
    Why: the four plugin manifests (`.agents/plugins/marketplace.json`,
    `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json`,
    `plugins/codex/.codex-plugin/plugin.json`) carry their own `version` fields —
    Codex/Claude marketplaces detect updates by comparing that declared version
    against the installed cache, so a stale manifest means "no update available"
    forever for that lane. `package.json` is the single source of truth; the
    script copies it into all four (idempotent — if nothing drifted the commit is
    empty and you skip it). All three publish workflows run `--check` BEFORE
    tag/publish (`release.yml` fails fast before any CI dispatch; `release-manual.yml`
    syncs inside CI as part of its own release commit; `release-bugfix.yml` checks
    the frozen carve-out head) — drift = red release, nothing shipped. A bugfix
    carve-out PR head MUST therefore already carry the synced manifests (see the
    carve-out process below).
 4. **Add the release-notes entry — ONLY for severe releases (#1870, opt-in
   since 2026-10-04)** — ordinary releases skip this step entirely and ship
   with NO entry. When a release IS severe, add the entry in the SAME release
   PR, as its own commit (never bundled into the release commit): prepend an
   entry to the `releases` array in `release-notes/package.json`:
   ```json
   {
     "version": "0.1.17",
     "date": "2026-08-08",
     "tier": "recommended",
     "summary": "what changes FOR THE USER, one line, issue/PR refs"
   }
   ```
   - `tier`: `routine` (default) | `recommended` (restart-soon record —
     correctness/cache/self-heal fixes; NOT user-visible, marketing is NEVER
     recommended) | `critical` (a serious defect users must act on — the only
     tier that ever surfaces to users, #1977; use sparingly, when the fix
     matters more than the silence). Force-upgradeable defects go to
     `advisories/`, never here.
   - The summary is model-written, ≤400 chars, newest-first order, cap 20
     entries. NEVER hand-edit the companion package's own `"version"` field —
     CI bumps it on publish.
   - Full rules: `release-notes/README.md`. Enforcement: the gates in
     `release.yml` / `release-manual.yml` / `release-bugfix.yml` pass with a
     notice when the entry is absent (silent release, the default) and
     validate it when present.
5. **Local pre-flight** — run the same checks CI runs:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
5.5. **Local real-model release gate** (operator machines with live models —
    the regression lane GitHub CI can never run). After `npm run build`:
   ```bash
   npm run gate:local
   # or against an already-built tarball:
   node scripts/release-gate-local.mjs --tarball /path/to/billion-context-X.Y.Z.tgz
   ```
   This freezes the manual v0.1.196 review pass (PR #2962) into one command.
   Lanes: **A** compression — real dsh session at a small-window route forces
   a mid-turn fold (`nudge INJECT` → preflight → `acp-compress-obs`), then the
   SAME session keeps answering from folded context with cache recovered
   (≥50% on a stable-prefix follow-up); **B** model switch — same session
   resumed on a DIFFERENT model / upstream (same lineage — a dsh
   resume-replay fork that ADOPTS the parent's folded blocks counts as pass,
   an orphaned pfa does not —, folded state survives a proxy restart,
   cross-upstream baseline demoted to untrusted, cache cold→hot); **U**
   (`--with-update`, needs verdaccio + `GATE_VERDACCIO_NPMRC`) — the profile
   proxy recognizes its dsh-managed install and reads `latest` from the
   configured update registry. Everything is hermetic (own `DSH_HOME`,
   `BILI_CONFIG_FILE`, sessions/XDG dirs, ports); it never touches `~/.dsh` or
   running proxies. Prerequisites are probed and missing lanes are skipped
   with a warning — see the header of `scripts/release-gate-local.mjs` for all
   `GATE_*` knobs. Windows-specific update lanes (global installer,
   desktop-profile in-place swap, doctor) stay on the Win10 VM checklist below.
6. **Commit, push, open PR** — release-commit convention:
   - Message: `release v{VERSION}`
   - The commit changes ONLY `package.json` (+ `package-lock.json` if it drifts).
     Never bundle other changes into a release commit.
   - PR title: `release v{VERSION}`; body lists changes since last tag.
7. **Human merges the PR** (Agent MUST NOT merge).
8. **CI publishes automatically** — no manual `npm publish`:
    - On merge, `release.yml` detects the `*_release-v*` branch name +
      `release v{VERSION}` commit message.
    - It runs `npm ci` + `typecheck` + `build`, plus the full test suite UNLESS a
      reuse probe proves it redundant: every required CI lane already green at the
      PR head AND master did not move since the PR head (#3539 — the full suite is
      then paid for exactly once per chain; human-cut PRs with core lanes only never
      skip). The full-CI gate still blocks publish until every lane is green at the
      publish sha (fresh or reused). Then `npm publish --tag latest` (using the
      `NPM_TOKEN` repo secret), git tag `v{VERSION}`, GitHub Release.
9. **Verify** the published version is live:
   ```bash
   npm view billion-context version
   ```

## One-click manual release (fast path)

For routine patch releases, skip the branch/PR dance: **Actions → "Release
(one-click)" → Run workflow** (`.github/workflows/release-manual.yml`). The `version`
input is optional — blank means auto next-patch over the npm latest; type a full
semver for minor/major/prerelease bumps.

**Severe-release prerequisite (#1870):** if the version being released is
severe, its release-notes entry must ALREADY be merged to master
(`release-notes/package.json`, same shape as step 4 above) — the workflow
checks at dispatch time and logs the entry when found. Ordinary releases
need NO entry: a missing entry is a notice, not an abort. Prereleases (dev
channel) are exempt.
The workflow then:

1. **Drift guard**: master's `package.json` version must equal the npm latest, else it
   aborts (never release off a drifted tree). It also rejects a target version that is
   already published. A separate dispatch-time step then logs the
   release-notes entry for the target version when present (#1870) — see the
   prerequisite above.
2. Bumps ONLY `package.json` + `package-lock.json` and commits `release v{VERSION}` —
   the same one-version-one-commit discipline as `AGENTS.md` Version Bumps.
3. Runs the fast pre-flight gate (`npm ci` + typecheck + build). The FULL test suite
   deliberately does NOT run here anymore (#3539): it runs exactly once, as the sharded
   CI lanes dispatched at the exact publish sha in the next steps, and the full-CI gate
   blocks publish until they are all green — same coverage, parallel shards instead of
   ~30-40 min serial on one shared runner.
4. Pushes the release commit directly to `master` (GITHUB_TOKEN, fast-forward only).
   On success the run dispatches every missing CI lane at the release commit — refusing
   first if master's head has moved past it — and blocks until all lanes are green
   before publishing.
   If branch protection blocks direct pushes, the release lands on a release branch
   instead and the run tries to open the release PR itself (best-effort — if the account
   forbids Actions-created PRs the run still finishes green with a one-click "open the
   release PR" link in the job summary). The fallback PR body carries a generated
   changelog (`git log` since the last release tag); the same notes appear in the job
   summary as a paste-ready block for opening the PR manually. Merging that PR
   publishes via the standard flow; red is reserved for real failures (guard trips,
   gate failures, or a failed branch push). GitHub suppresses push-event delivery for
   ref updates made with GITHUB_TOKEN, so the push trigger never fires on the fallback
    branch; instead the run invokes `scripts/release-ci-gate.mjs --dispatch` with
    `CI_FULL_DISPATCH=1`, which fires the COMPLETE lane set at the branch head in one
    pass — `ci.yml` in FULL matrix scope plus every e2e lane (each requires the
    `workflow_dispatch` trigger the workflows declare for exactly this purpose). Those
    check runs land on the same head sha — once green, required checks pass and the
    auto-PR is mergeable without approving its `action_required` pull_request runs
    (bot-authored PRs are gated there) (#772, #1744). Because the full set goes green
    at the PR head, `release.yml` reuses every run at merge time instead of re-running
    the suites (#3539: one full pass per chain). The dispatch refuses to fire if the
    branch head no longer matches the release commit, cancels stale in-flight runs from
    the attempt, and a follow-up track-head wait step certifies "PR ready": if master
    gets merged into the release branch mid-wait, stale runs at the old head are
    cancelled and missing lanes re-dispatched at the new head instead of burning
    runners on a superseded sha (the v0.1.198 queue stomp, #3539/#3534). If the dispatch
    fails (transient API error), the fallback PR stays gated until someone approves
    those runs manually. (Push-triggered CI on release branches still works for branches
    pushed with a real account token — e.g. agent-driven standard-flow release branches.)
5. Publishes to npm (`latest`, or `dev` for prerelease), tags `v{VERSION}`, and creates
   the GitHub Release with notes generated from `git log` since the last tag.

A successful one-click run does NOT double-trigger `release.yml`: its check only
matches release-branch merges / date-prefixed commits, never a plain `release v{VERSION}`
commit. The standard branch/PR flow above remains the canonical path for anything
non-trivial (updater changes, cross-repo bumps, or whenever a human wants the review
gate).

## Bugfix carve-out channel (release-bugfix.yml)

Emergency hotfix path (#2011, first used for v0.1.182), **PR-gated since #2851**:
publish a version cut from a **non-master ref** — today the live patch cycle
(see Dual-lane releases below), or a hand-cut tag+one-fix branch — STRICTLY
excluding the unreleased work that has since accumulated on master. It goes through
a PR exactly like a normal release (human reviews and merges; CI publishes); the
ONLY difference is the published tree: the PRE-MERGE PR-head tree (last tag + the
fixes + the version bump), never the post-merge master.

`release.yml` cannot do this: it builds the post-merge MASTER tree on push-to-master,
so it can never exclude commits already on master. This channel checks out and
publishes the carve-out PR's head tree instead — the artifact is exactly that tree,
nothing else.

**Process:**

1. Cut the hotfix branch from the last released TAG (not master), apply ONLY the fix
   plus the version bump (regenerate `package-lock.json` as in step 3 above; sync the
   plugin manifests as in step 3.5 above — the publish gate's `--check` runs against
   this frozen head, so drift fails the whole lane; plus the release-notes entry ONLY
   if the hotfix is severe — step 4 above), then push and open a PR against master:
   ```bash
   git checkout -b bugfix-release/v{VERSION}-{slug} v{LAST-RELEASED-TAG}
   ```
   This is the LEGACY one-off form. The primary patch path is the live
   `patch/v*` cycle (Dual-lane releases below): fixes land there as ordinary
   PRs and the one-click ship adds the bump — no hand-crafted release branch.
   The `bugfix-release/` name prefix is the carve-out MARKER, not a trigger: pushing
   such a branch no longer auto-publishes (#2851 removed the silent-push path). It is
   what `release.yml`'s detection deliberately does NOT match, so merging the PR
   cannot double-publish the post-merge master through the normal channel.
   Guard-compatibility requirement: the ci.yml `version-guard` MUST whitelist this
   prefix in parallel with `*_release-v*` — a carve-out PR legally carries exactly
   one isolated release-bump commit. #2858 was exactly this divergence: #2853
   updated release-bugfix.yml / AGENTS.md / this doc but not ci.yml, so every
   carve-out PR went red on version-guard and the fail-closed full-CI gate blocked
   every merge-time publish until the guard was fixed on master.
2. **Human reviews and merges the PR** — the same review gate as a normal release
   PR. While it is open, the standard lane set already runs on the head sha
   (path-filtered `pull_request` triggers), which the publish gate reuses.
3. On merge, `release-bugfix.yml` (`pull_request` closed trigger) validates
   (merged, same-repo head, head branch = `patch/v*` — the live cycle's ship
   PR — or a legacy `bugfix-release/*` one-off), checks out the PRE-MERGE PR
   head tree, reads the target version from its `package.json` (before any gate) and
   enforces fail-closed guards:
   - strictly newer than npm latest (base-semver compare — never holds or downgrades
     `latest`; conservative edge: a stable `X` is refused while npm latest is `X-dev`);
   - not already published (`npm view billion-context@$VER`);
   - no sub-0.1.0 lines (#1385);
   - severe stable versions need a release-notes entry ON THE REF (#1870;
     ordinary releases ship with none; prereleases exempt).
4. Full pre-flight gate before publish: `npm ci` + typecheck + test + build
   (`ACP_TEST_CLAUDE_NATIVE=1`, #1248), plus the full-CI gate at the publish sha
   (reusing the PR's own green lane runs where they exist).
5. Publishes `--tag latest` (`dev` for prereleases), pushes tag `v{VERSION}`, creates
   the GitHub Release with notes generated from `git log` between the nearest ancestor
   tag other than the one just made and HEAD — for a tag+one-fix carve-out that list
   is exactly the fix (deliberately NOT `generate_release_notes:true`, which would span
   into unreleased master work).

**Emergency fallback:** a manual `workflow_dispatch` run against an explicitly chosen
ref (picked in the Actions UI) still works and runs every guard above — for when the
PR dance is slower than the fire.

**Master interaction:** merging the carve-out PR brings the version bump INTO master
(master then equals npm latest, so the one-click fast path's drift guard sees a clean
tree again). Master advances independently on its next normal release, which MUST be
higher than the carve-out version (after v0.1.182 was cut off v0.1.181, the next
normal release must be ≥ 0.1.183).

## Dual-lane releases: patch cycles with dual-PR forwarding

Operationalizes the carve-out channel into **patch cycles** — one short-lived
branch per released version — so small fixes ship fast WITHOUT blocking (or
being blocked by) master's feature stream. Approved by the owner 2026-10-24 in
its final form ("every PR opens two at once": the fix PR + its master twin,
opened automatically); it replaced the same-day fixed-`bugfix`-branch design
because every patch release moves the base anyway — per-cycle branches make
that move automatic and self-describing (the branch name IS its base tag),
and they replace the 2026-10-24 patch-train experiment: label-bot
cherry-picking had a structural blind spot — a conflicted backport was only a
PR comment, and nothing at ship time could prove every labeled fix was
actually on the train, #4474. In the dual-PR model a fix is on the cycle the
moment its fix PR merges; there is nothing to miss.

**The model:** master stays the single source of truth (features + big fixes
merge there as always, nothing is frozen). In parallel, a short-lived cycle
branch `patch/v{LAST-RELEASED-TAG}` receives small fixes as ordinary PRs.
A patch release ships the current cycle (its base tag + that batch of fixes,
strictly no unreleased features) via the carve-out channel; merging the ship
PR brings the fixes and the version bump back into master, and the ship's
closeout immediately cuts the NEXT cycle (`patch/v{JUST-PUBLISHED}`) from the
fresh tag — so there is always exactly ONE live cycle. Version numbers stay
one strictly-increasing stream (0.1.206 cycle, 0.1.207 feature, 0.1.208
cycle … all legal). If a regular master release ships while a cycle is still
accumulating, the next one-click ship auto-recuts from the newer tag and
replays whatever the old cycle carried that master lacks (recut-replay).

**Every fix PR opens TWO PRs at once.** Cut the fix branch from the live
cycle tip, open the PR against it (the fast lane), and `fix-dual-pr.yml`
automatically cherry-picks the same commits onto master and opens the **master
twin PR** (`twin/<fix-branch>`, base=master) with CORE CI dispatched on it.
You merge BOTH: the fix PR ships it fast at the next cycle ship; the twin PR
keeps master from regressing it. Neither merge is automatic — both are human
decisions.

**Which lane a fix takes**: a fix belongs on the cycle if it applies cleanly
onto the tag-based cycle and stands alone there (small, user-visible,
independent of unreleased master work). If the fix PR itself conflicts with
the cycle, the fix is not small — re-target the PR at master only. New
features never take the cycle.

**Mechanics:**

1. **Route a fix onto the cycle**: cut the fix branch from the live
   `patch/v*` tip, push, open the PR with that branch as base. If the base
   predates the newest released tag (a cycle got superseded while your PR was
   open), the bot comments a warning — nothing is lost (recut-replay carries
   merged fixes at the next ship), but re-targeting at the fresh cycle is
   cleaner. `fix-dual-pr.yml` then:
   - cherry-picks the PR's own commits (range `origin/<cycle>..PR head`) onto
     `origin/master`, pushes `twin/<fix-branch>`, opens the twin PR
     (base=master) with the picked-commit list, dispatches CORE CI on the twin
     ref (#772: bot-authored PRs' own runs sit in action_required), and
     comments the twin link on the fix PR;
   - rebuilds the twin from scratch on every synchronize push, so the twin is
     always exactly master + this PR's commits;
   - closes the twin and deletes its branch if the fix PR closes unmerged;
     nudges it ("now the only thing keeping master from regressing the fix")
     if the fix PR merges first;
   - refuses (with a how-to comment) if the PR carries >20 commits vs the
     cycle — that is a master-based branch accidentally targeting the cycle,
     and replaying it would leak master's unreleased delta.
   A twin cherry-pick conflict means master moved under the fix: the comment
   on the fix PR carries the manual repair command (pick the commits by hand
   onto a branch off master). Only MERGE-COMMIT merges into the cycle are
   conventional; keep fix PRs linear.
2. **Ship the cycle** (the one owner decision — releases are owner-gated,
   #2910): **Actions → "Release (one-click)" → Run workflow → tick `bugfix`**
   (the input keeps its legacy name). That does the whole dance:
   resolves the LIVE CYCLE — finds `patch/v<latest-tag>`, and if it does not
   exist yet (or the newest tag moved) cuts it from the newest tag, replaying
   every previously-merged fix not yet on master (`git cherry` vs origin/
   master, skipping `release v*` bumps; a replay conflict aborts the ship
   loudly — resolve manually), drift-guards (cycle version must equal npm
   latest), adds the isolated `release v{NEXT}` commit (package.json + lock
   only), pushes it to the cycle, dispatches the FULL CI set at the cycle
   head, audits forward coverage (below), and opens the ship PR against
   master with a generated changelog. You merge the PR; `release-bugfix.yml`
   then publishes the PRE-MERGE head tree (tag + fixes) and cuts the NEXT
   cycle from the fresh tag right away. Superseded cycle branches are left in
   place for inspection (delete them yourself once convinced); open fix PRs
   still targeting one must be re-targeted manually — nothing is auto-closed.
   ⚠ Severe fixes riding a cycle ship: include the release-notes entry (#1870)
   in the fix PR itself, so it is on the cycle with the fix — the publish-time
   gate checks the entry ON THE REF.

   **Ship-time forward audit**: before opening the ship PR, the one-click run
   lists every cycle commit since the cycle's base tag that has no
   patch-equivalent on master (patch-id via `git cherry`) — i.e. fixes whose
   twin PRs are still open. Rendered as a prominent ⚠️ section at the top of
   the ship PR body. It never fails the run (master catching up on its own
   schedule is legitimate), but you will see the backlog before you merge —
   and note recut-replay only carries fixes MERGED into a superseded cycle;
   an unmerged fix whose PR dies is lost unless re-landed.

**Cycle hygiene:**

- **Never merge master into a cycle branch.** It ships wholesale; one master
  merge ships every unreleased feature. `patch-leak-guard.yml` inspects every
  merge commit on a pushed `patch/v*` branch and alarms when any second
  parent is master-side history. Recovery: discard the poisoned cycle (its
  unmerged fixes get re-landed on the fresh cycle) — cycles are cheap to
  throw away because recut-replay exists.
- **No manual re-cutting in normal operation.** Closeout cuts the next cycle
  automatically after every patch ship; a mid-cycle master release just makes
  the next ship's resolve step recut+replay automatically. Manual force-pushes
  exist only as recovery tools:
  ```bash
  # emergency: reset the live cycle to the newest tag (drop whatever it had):
  git push origin --force-with-lease $(git tag --list 'v[0-9]*' --sort=-v:refname | head -1):refs/heads/patch/v{TAG}
  ```
  (Force-push needs a temporary ruleset bypass — `patch/*` is protected
  against force-push/deletion.)
- **Cutting the very first cycle** happened once at model migration:
  `git push origin <train-tip>:refs/heads/patch/v{LAST}`.

**Why cherry-picked twins instead of merging the fix branch into both:** the
fix branch is based on the cycle; a git merge into master would carry the
cycle's whole post-tag delta over the merge-base. The re-picked twin is the
price of leak safety on both directions.

**CI wiring**: pushes to `patch/v*` and PRs into them run the CORE matrix
(ci.yml trigger filters include the glob); the FULL matrix at ship time comes
from the one-click cycle run's all-lanes dispatch. Twin PRs are bot-authored:
their own pull_request runs sit in action_required, so fix-dual-pr dispatches
CORE CI on the twin ref (#772/#1744 pattern); the plan job scopes twin/**
heads to CORE even though a bot authors them. Branch protection for `patch/*`
(no force-push, no deletion) keeps cycles from being rewritten; required
checks mirror master's.

## CI publish mechanism (what release.yml does)

- **Trigger**: push to `master` where the merge commit or branch name matches
  `*_release-v*`.
- **Prerelease handling**: if the version contains `-` (e.g. `0.1.17-beta.1`), publishes
  with `--tag dev` instead of `--tag latest`.
- **No publish step for the Agent**: the Agent never runs `npm publish`. The only manual
  fallback (if CI is down) is a human running `npm publish`.

## Kernel releases (standalone `acp-kernel` artifact, #2092)

The kernel source lives in-repo under `kernel/` and is consumed via
`"acp-kernel": "file:./kernel"`, so every billion-context release bundles the in-tree
kernel — there is NO registry ordering to manage anymore (the old "acp-kernel MUST
ship first" rule is obsolete).

When accumulated kernel changes warrant a standalone npm release of `acp-kernel`
(downstream consumers such as the legacy billion-context-pi pick it up as usual):

1. Branch `YYYY-MM-DD_release-kernel-v{VERSION}` off master.
2. ONE commit `release kernel v{VERSION}` changing ONLY the version in
   `kernel/package.json` (then regenerate the root `package-lock.json` so
   `packages.kernel.version` tracks it — same command as step 3 above; enforced by
   the `lock-sync` guard, #2704).
3. Open a PR (its body serves as the release notes; no release-notes entry required).
   HUMAN merges.
4. `.github/workflows/release-kernel.yml` runs on the merge: full bili gate
   (typecheck + test + build) plus the kernel suite against its TS source, then
   publishes `acp-kernel` from `kernel/`, tags `kernel-v{VERSION}`, creates a GitHub
   Release.

Cross-trigger safety: `*_release-kernel-v*` and `*_release-v*` are mutually exclusive
in every matching direction (release.yml's merge-branch regex, direct commit messages
`release v*` vs `release kernel v*`, the version-guard job, the kernel-guard job), and
the tag namespaces never collide (`v*` vs `kernel-v*`).

## Auto-update testing

To test that a running older version auto-updates to a newer registry version:

```bash
# 1. Install older version from registry
npm install -g billion-context@0.1.16

# 2. Merge the newer release PR (HUMAN merges) — CI publishes 0.1.17 to npm.

# 3. Start the older version
bili start --port 19195
# Within ~10s (startup check) it detects 0.1.17 and installs it, logging:
#   ✔ billion-context auto-updated 0.1.16 → 0.1.17. Restart bili to finish.
```

## ⚠ Releasing changes to the auto-update mechanism itself

**The auto-update code (`src/update.ts`) is load-bearing for every future upgrade.** If
a release ships a broken auto-update, users who install it become **permanently stuck**
— they can never auto-update again (the broken thing is the updater itself), and many
will never notice to manually reinstall. This is strictly worse than a normal bug: a
normal bug affects one feature; a broken updater silently bricks the upgrade path for
everyone who hits it.

**Therefore: any change to `src/update.ts` (the download / extract / install /
version-check logic) MUST be validated with a no-op release BEFORE shipping the change.**
The sequence is:

1. **Ship a no-op release first** (pure version bump, zero code changes) — this proves
   the *existing* upgrade path is healthy end-to-end: the currently-installed version
   auto-updates to the no-op release using the *old* code.
   - Branch: `YYYY-MM-DD_release-v{VERSION}` (same naming convention).
   - Commit: `release v{VERSION}` (version bump only).
   - PR body MUST state it is a no-op and why (validation release).
2. **Only after the no-op release is confirmed on npm** (`npm view billion-context
   version` returns it) AND a real upgrade has been observed succeeding (the log shows
   `auto-updated OLD → NEW`), ship the actual change as a separate subsequent release.
3. If the no-op release's upgrade **fails**, STOP. Do not ship the updater change.
   Investigate the existing-path failure first — the existing code is the only known-good
   upgrade path, and shipping a change on top of an already-broken path compounds the
   problem.

**Why the indirection?** Because if the change-to-the-updater is itself buggy, anyone who
upgrades to it is bricked. The no-op release isolates the test: it exercises the upgrade
path using code we already trust, so a success confirms the *plumbing* (registry,
tarball, file copy, restart) works, independent of the new code. Only then do we trust
the new code to run on the next hop.

**Concrete example (v0.1.22):** the Windows auto-update fix (replacing
`execFile("tar"/"cp")` with the `tar` npm package + `fs.cp`) was staged in PR#44 but NOT
shipped directly. A no-op v0.1.22 (PR#46, version bump only) was released first to
confirm the running v0.1.21 could self-upgrade. Only after that succeeded was the
Windows fix shipped in a follow-up release.

## Local real-model gate on the Win10 VM (manual checklist)

`npm run gate:local` covers the Linux lanes. The Windows-only update lanes are
NOT automatable from the host yet; before a release that touched
`src/update.ts`, `src/dsh-channel.ts` or the installer, run this checklist on
the Win10 VM (per the operator's VM runbook; all commands in cmd.exe):

1. Baseline: pin global + the 4 dsh profiles (acp/headless/desktop/web) to the
   PREVIOUS release from the local verdaccio registry; `bili --version` must
   report it.
2. Set `"update": {"registry": "http://<verdaccio-LAN-IP>:4873"}` in the VM's
   billion-context.json; publish the candidate tarball to verdaccio first.
3. `bili update` → expect: global bump, `refreshed … dsh profile bundle(s)`,
   desktop in-place swap, and (when upgrading FROM a version that already has
   #2894) `[update] dsh desktop profile manifest spec now declares vX.Y.Z`
   with the profile package.json spec converged (`^old` → `^new`).
4. `bili doctor` → 0 stale / 0 frozen lanes.
5. Restart the fixed 8787 instance (run-bili3.bat) and re-run the dsh
   compression / model-switch / cache checks (Lane A/B equivalents).
