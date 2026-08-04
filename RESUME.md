# Dogfood 0.4.0 — resume point

**Paused:** 2026-08-04, credits low. Work stopped cleanly; nothing is half-applied.

**Branch:** `dogfood-0.4.0-remediation` (off `main` @ `6086965`)
**HEAD:** `e512b52`
**State:** `npm test` → **110/110 green**. Working tree clean except untracked `.claude/`.
**Nothing has been pushed, tagged, or published.**

---

## Start here when resuming

```bash
cd ~/projects/proofofworks/dogfood
git log --oneline -3          # expect e512b52, a7dfb9d, 6086965
npm test                      # expect 110/110
```

Then read **`.workflows/PLAN.md`** — the full approved plan, phase by phase. This file is only the bookmark.

The four remaining phases are **already written as runnable workflow scripts**, committed to the repo:

| Phase | Script |
|---|---|
| P1 (finish) | `.workflows/p1.js` |
| P1.5 | `.workflows/p15.js` |
| P2 | `.workflows/p2.js` |
| P3 | `.workflows/p3.js` |

Launch one with the `Workflow` tool: `{scriptPath: ".workflows/p15.js"}` (use the absolute path).

`.workflows/` is dev tooling only — it is not in `package.json`'s `files[]`, so it never ships in the npm tarball.

---

## Done

### P0 — `a7dfb9d` (14 agents, 66 min)

Closed bypasses that made the core product claim false:

- **`.tmp-` bypass** — `verify` exempted any unrecorded file whose *path* contained `.tmp-`. Now temps are tracked and swept before the manifest is taken, and the exemption is gone. Exemptions are **exact-name only** (`manifest.json`).
- **Symlink blindness** — a `readdirSync` Dirent for a symlink is neither `isFile()` nor `isDirectory()`, so symlinks were skipped by *both* `writeManifest` and `verify`. Replaced with lstat-based `listBundleEntries`; `writeManifest` fails closed via `BundleIntegrityError`.
- **Playwright stdout forgery** — the adapter parsed the command's *own stdout* as its report, so any command printing `{suites,stats}` passed. Rejected outright; the report path is now unlinked before the command runs, so "a report exists" proves *this* command wrote it.
- **Redaction off by default** — only active under `--policy`, while the shipped workflow uploads the bundle as a CI artifact. Now on by default and reaching metadata, adapter details, report bodies and evaluation JSON.
- **CI gate ambiguity** — two check runs were both named `dogfood / prove-it`, and the one with `fail-on-error: false` could never go red. Its `checks: write` also made **fork PRs permanently red**. Job deleted; JUnit renders to `$GITHUB_STEP_SUMMARY` with zero permissions.
- **`--baseline-ref` injection** — reached `git show` unsanitized (`--output=` is an arbitrary-file-write primitive). Leading dashes rejected, `--end-of-options` added, resolved OID passed instead of the user string.
- **`validate` clobbering `latest.json`** — so `report` showed the check, not the proof. Now writes `latest-validate.json`.
- **Dishonest self-gate** — `npm pack --dry-run` through the `exit-code` adapter, behind an oracle named `package-contents`, proved only that npm exited 0. Replaced with `scripts/check-package-contents.mjs`.

Tests **69 → 107**. `package.json`'s test list is now pinned by `test/meta.test.mjs`; CI invariants pinned by `test/workflow.test.mjs`.

**Independently verified** (my own probes, not agent reports): planted `.tmp-` file, symlink, empty directory, and trailing-space filename are all caught; a clean bundle still verifies exit 0.

### P1 correctness — `e512b52` (partial)

`A4`, `A6`, `A8b`, `A9a–A9e` all landed. Tests **107 → 110**. See the commit message for detail.

---

## Not done

### P1 remainder — **resume here**
Run `p1.js`. Its Correctness phase is already applied, so **either** delete that phase from the script first **or** let those agents re-run idempotently (they re-read files, so this is safe but wasteful).

Outstanding:
- **P1c** — 7 test files for modules at zero direct coverage: `test/files.test.mjs` (extend), `test/policy-paths.test.mjs`, `test/score-ac.test.mjs`, `test/report.test.mjs` (extend), `test/advisory.test.mjs`, `test/build.test.mjs`, `test/adapters.test.mjs` (extend).
  `src/files.mjs` matters most — the three commits before this work were consecutive fixes to its path handling with **no regression test**. `validateAdvisoryReceipt` is called by no test at all.
- **P1d** — CI: Playwright browser cache, `retention-days`, failure artifacts from the fixture job, node 22 + macOS in the matrix, de-drift `templates/ci/dogfood.yml` (it never runs the fixture despite naming a job "chromium").

### P1.5 — signing, JUnit adapter, publish prep
Run `p15.js`.

**The decision that shapes this phase:** I originally made "manifest stays v3, old bundles keep verifying" a hard constraint. **That was reversed** — it protected six regenerated directories in a gitignored folder while blocking the fix for `README.md`'s own admission that *"an attacker able to regenerate an unsigned manifest can regenerate its checksums."* 0.4.0 is the last moment the format break is free.

- **Manifest v4 + detached ed25519 signing** (`manifest.sig`, `node:crypto`, no new dependency). `dogfood keygen`, `run --sign`, `verify --key`.
  **The trust model is the whole feature.** A public key embedded in the manifest is worthless — whoever regenerates the manifest regenerates the keypair. Only `verify --key <externally trusted anchor>` proves provenance; bare `verify` must report *present-but-unverified* and never upgrade the verdict. Get this wrong and signing is strictly worse than none.
  **Also update the integrity notice** at `src/report.mjs:202` and `src/verify.mjs:7` — both still say *"signing is deferred"*, which becomes false.
- **JUnit-XML adapter** — binds an AC to a named testcase (`classname` + `name`), covering pytest/Vitest/Go. Additive enum member, contract stays v2. A selector matching nothing must **FAIL** — that's the `--grep`-matched-nothing false green. No stdout fallback.
- **Publish prep** — drop `private: true`, `docs/` into `files[]`, `publishConfig.access: public`, `prepublishOnly`, `action.yml`, `RELEASE.md`. **Prepare only.**

### P2 — docs
Run `p2.js`. Build `test/docs.test.mjs` **first**, then write prose against a live gate.

README goes 564 → ~150 lines; reference material moves to `docs/`. Known defects to fix: `--json` and `--contract` appear **nowhere** in the README; all 14 policy fields are undocumented; **two README contract examples fail the tool's own schema validation**; `AGENTS.md` lists 3 of 8 commands and omits `--policy` entirely.

P0's gate agent deferred two doc items here: `README.md:319` describes the removed `checks: write` JUnit job, and `templates/skill/SKILL.md` tells agents to read `latest.json` unconditionally.

### P3 — dedup and hygiene
Run `p3.js`. Behavior-preserving only; acceptance criterion is "`npm test` unchanged, coverage not decreased".

`sha256` ×4 (and `verify.mjs` imports it *from the report writer*), `safeSegment` ×2, `formatAjvError` ×2, two glob engines with different semantics for two fields in the same policy file, three path-containment implementations, four `spawnSync("git")` wrappers with the Windows workaround on only one. Then decompose `runDogfood` (~235 lines, 9 concerns) — **solo and last**.

### Cannot be automated
**Fork-PR CI validation.** After merge, open a PR from a fork and confirm exactly one check named `dogfood / prove-it`, that it goes red when a job fails, and that no job errors on missing `checks: write`. Then set branch protection to require it. `test/workflow.test.mjs` pins the invariants offline, but only a real fork PR proves the end-to-end behavior.

---

## Standing constraints

1. **No release.** No `npm publish`, `git push`, `git tag`, or `gh release`. Local commits only. `RELEASE.md` (P1.5) will hold the exact commands for the owner to run by hand.
2. **No new dependencies.** Runtime deps stay exactly `ajv`, `ajv-formats`, `yaml`.
3. **Contract stays v2, policy stays v1** — additive changes only. Manifest goes to v4 in P1.5.
4. **Never weaken an assertion to get green.** A failing test is either asserting deliberately-changed behavior (update it, and say which) or a genuine regression (fix the source).
5. **Both failure directions are fatal.** A false green breaks the product; a false red makes it unusable. Every fix needs a test in both directions.

## Notes for whoever resumes

- **Chromium is installed**, so `npm run test:playwright-fixture` runs locally.
- **`.claude/agents/` was rewritten.** `qa`, `security`, `reviewer`, `documenter`, `evaluator`, `git-ops` are now dogfood-specific and used via `agentType` in the workflow scripts. The rest are still written for an unrelated NestJS/Next.js project ("Borderly") and should not be used — P3 deletes or rewrites them. `.claude/` is untracked **and not gitignored**, which is a footgun; P3 decides whether to track it (dogfood's own `init` creates `.claude/skills/`, so it is semantically meaningful here).
- **Don't run probes against the working tree while a workflow holds it.** I hit a transient duplicate-declaration error mid-consolidation doing exactly that and briefly mistook it for a false positive.
- The **P0 gate agent overruled a verifier with evidence** — it declined to treat `nlink > 1` as non-regular in `verify` after finding all four pre-existing bundles were hardlink-copied (`nlink == 2`), which would have failed every one. It hard-fails in `writeManifest` (production time) and warns in `verify`. That reasoning is worth preserving if the topic resurfaces.
- Notifications go to `https://ntfy.sh/pow-done-x`.
