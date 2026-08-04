# Dogfood 0.4.0 — full remediation

## Context

`~/projects/proofofworks/dogfood` (symlink → `thinktank/concepts/testo`) is `@proofofwork-agency/dogfood` v0.3.0: a Node 20+ ESM CLI that acts as an *evidence gate*. You declare acceptance criteria in `.dogfood/dogfood.contract.yaml`, bind each to an **oracle** (an exact shell command or an exact Playwright test tag), and it runs them and emits a tamper-evident bundle under `artifacts/dogfood/<runId>/`. `dogfood verify` re-checks that bundle offline. `--policy` turns on an *authoritative* profile adding a criteria floor, git-mutation detection, baseline regression blocking, and log redaction.

An audit of all 57 tracked files was run and **every finding below was verified against source**. The headline: the architecture is genuinely good — the strict tag binding, the double contract snapshot (raw bytes + normalized re-serialization), the fail-closed doctrine that a deterministic criterion without an oracle is a FAIL, and the honesty at `src/report.mjs:162` about what checksums do and don't prove. The problem is that **the bundle does not fully deliver the integrity guarantee it claims**, CI cannot reliably gate, and the docs describe a different product than the code implements.

### The good
Fail-closed validation (`src/validate.mjs:105-141`), strict Playwright tag evaluation that rejects retries and flakes (`src/adapters.mjs:179-251`), a real concurrency race test (`test/verify.test.mjs:63-73`), a 10.6 MB maxBuffer regression test (`test/runtime.test.mjs:26-48`), every CI action pinned to a full commit SHA, least-privilege `permissions:` on every job, and a clean git tree — `artifacts/`, `.contextrelay/`, and the stale dated markdown are all correctly gitignored.

### The bad
Verdict-affecting bugs, a CI gate that can be satisfied without running, and a self-gate containing the exact anti-pattern its own README warns against.

### The ugly
`sha256` implemented 4× (and `verify.mjs` imports it *from the report writer*), two different glob engines with different semantics for policy authors, three path-containment implementations, four `spawnSync("git")` wrappers with the Windows workaround applied to only one, and a 235-line `runDogfood` interleaving 9 concerns.

### Decisions taken
- **Scope**: everything, P0 → P3.
- **Docs**: split into `docs/`, README drops to ~150 lines.
- **Blast radius**: dogfood gates only this repo. Verdict-flipping fixes ship straight as **0.4.0** — no migration shim, no deprecation window.

### Constraint, revised after the competitive assessment
**Originally** I made "manifest stays v3, every existing v3 bundle still verifies" a hard constraint across all four phases. **That was wrong and is now reversed.** The compatibility promise protected six local directories in a *gitignored* folder that are regenerated on every run — `private: true`, unpublished, zero external consumers. It bought nothing and blocked the one gap that most undercuts a product named *proof*: `README.md:538` concedes "an attacker able to regenerate an unsigned manifest can regenerate its checksums."

**0.4.0 is the last moment where breaking the manifest format is free.** After npm publish it is a migration burden — exactly the bill `src/verify.mjs:22-24` already pays for v2→v3 ("rerun with Dogfood v0.3"). So:

- **Manifest → v4** in 0.4.0, with detached signing (P1.5 below).
- **Contract stays v2** — the JUnit adapter is an additive enum member.
- **Policy stays v1** — `logs.capture: "full"` and `signing.required` are additive.
- Old v3 bundles are **not** preserved. They are disposable local artifacts; `verify` rejects them with the same rerun guidance v2 gets.

P0 was already written against the v3 constraint and is running. Nothing in P0 needs to change — it simply stops being a ceiling from P1.5 onward.

---

## P0 — the gate must be true, and must be able to gate

### A1 · Kill the `.tmp-` bypass in bundle verification
`src/verify.mjs:53` exempts any unrecorded file whose *relative path* contains `.tmp-`, so `evidence/.tmp-x/payload.json` can be planted in a bundle that still verifies. The exemption exists to tolerate temps leaked by `atomicWriteFile` (`src/files.mjs:16`).

**It is nearly dead weight**: `writeManifest` (`src/report.mjs:128-134`) iterates `listFiles` and checksums *everything* except `manifest.json`, so any temp present at manifest time is already `recorded`. Only a temp leaked *after* the manifest write trips the check — and such a bundle has no valid manifest anyway. Delete it.

- `src/files.mjs:14-29` — module-level `const pendingTemps = new Set()`. `atomicWriteFile` adds `temporary` before `openSync`, removes it after `renameSync` and after the catch-block `rmSync`. Export `sweepPendingTemps(root)` that `rmSync`s still-pending temps inside `root` (reuse `isPathInside`, `src/files.mjs:68`) and returns the swept list.
- `src/report.mjs:128` — `writeManifest` calls `sweepPendingTemps(artifactDir)` first, before `listFiles`. A non-empty sweep is a latent writer bug; log it on stderr under `DOGFOOD_DEBUG`.
- `src/verify.mjs:53` — drop `&& !name.includes(".tmp-")`.

*Rejected*: temps outside the bundle (`atomicWriteFile` is generic — `src/run.mjs:309,315` use it for `.claude/skills/**`; a global temp dir reintroduces cross-device `renameSync` EXDEV), and recording temp names in a verifier-known set (institutionalizes "unrecorded files are sometimes OK", which is the invariant being defended).

**Pins**: new `test/verify.test.mjs` case planting both `evidence/.tmp-x/payload.json` and `summary.json.tmp-1-abc`; new `test/files.test.mjs` asserting no `.tmp-` residue on success or on forced failure.

### A2 · Make symlinks visible to manifest and verify
`src/report.mjs:294-301` — `readdirSync(withFileTypes)` reports a symlink as neither `isDirectory()` nor `isFile()`, so `listFiles` skips it in **both** `writeManifest` (never checksummed) and verify's unrecorded-file walk (never flagged). A symlink pointing outside the bundle survives in a `VERIFIED` bundle. The guard at `src/verify.mjs:44` only covers paths already in `checksums`.

- `src/report.mjs:294-302` — replace with `listBundleEntries(root)` → `{ path, kind }`, `kind ∈ "file" | "symlink" | "other"`. Recurse only on `entry.isDirectory()` (Dirent is lstat-based, so symlink-to-dir already reports false — no traversal escape today, preserve that). Drop the redundant `statSync(path).isFile()` at `:299` (TOCTOU: throws if the file vanishes between readdir and stat). Keep `listFiles` as a thin filter wrapper.
- `src/report.mjs:128` — `writeManifest` throws a new typed `BundleIntegrityError` on any non-regular entry. **Fail closed**: emit no manifest rather than one that silently omits an entity.
- `src/verify.mjs:51-56` — walk entries; `kind !== "file"` → `bundle contains a non-regular file: <name>`.
- `bin/dogfood.mjs:188-200` — map `BundleIntegrityError` → exit 2, before the generic branch.

**Pins**: `test/verify.test.mjs` symlink case (`{ skip: process.platform === "win32" }`, mirroring `test/cli.test.mjs:44`); `test/report.test.mjs` unit on `listBundleEntries` over file / nested dir / symlink-to-file / symlink-to-dir.

### A3 · Playwright stdout fallback is attacker-controlled evidence
`src/adapters.mjs:131-147` — with no report file at `PLAYWRIGHT_JSON_OUTPUT_FILE`, dogfood parses the **command's own stdout** as the Playwright report and writes it into the bundle as evidence. Any command printing a fabricated `{suites, stats}` blob passes tag evaluation. `reportSource` is read nowhere outside `test/adapters.test.mjs:104` — never in summary, junit, manifest, or verify.

**Demote it from evidence to diagnostic.** `examples/playwright/playwright.config.mjs` sets no `reporter` and relies on `--reporter=json` + the env var, so Playwright writes the **file** — the fixture and the repo's own gate are unaffected.

- `src/adapters.mjs:131-147` — keep the parse, write it to `<name>.stdout-diagnostic.json` (not `reportPath`), always return `status: "fail"` with `reportSource: "stdout-fallback"`, `accepted: false`, and a detail explaining stdout is not acceptable evidence.
- `src/adapters.mjs:144` — stop interpolating `JSON.parse`'s `error.message` (Node ≥20 embeds a source snippet → raw stdout leaks into evidence, summary, and junit **even under `logs.capture: metadata-only`**). Replace with a fixed classification + `error.name`, capped ~120 chars, through the redactor.
- `src/adapters.mjs:99-105` — add `accepted` beside `reportSource`.
- `src/run-commands.mjs:199` — surface `reportSource` / `reportAccepted` on `evidence`. `summarizeCommand` (`src/report.mjs:168-189`) passes `evidence` through, so it reaches `summary.json` with **no manifest change**.

*Rejected*: surfacing `reportSource` and letting policy reject it (needs a new policy field → policy v2, and leaves the hole open by default in standard mode); marking the AC "unproven" (no such state — `src/score-ac.mjs` has pass/fail/blocked/advisory/excluded/not-run).

**Pins**: rewrite `test/adapters.test.mjs:92-110` to assert rejection; new `test/integration.test.mjs` e2e with `node -e "console.log(JSON.stringify({suites:[],stats:{}}))"` → FAIL. `npm run test:playwright-fixture` is the positive guard.

### A5 · `init --authoritative` writes a policy that `run` then ignores
`src/policy.mjs:18` returns `{policy:null, path:null}` when `explicitPath` is falsy, so `.dogfood/dogfood.policy.yaml` is never auto-discovered. `defaultPolicyPath()` (`src/policy.mjs:59`) is exported and re-exported (`src/run.mjs:15,354`) but **never called**. Users who `init --authoritative` then `run` silently get the weaker standard profile.

**Warn — don't auto-discover, don't hard-error.** `test/integration.test.mjs:23` deliberately plants an *invalid* policy file to prove non-loading, and `templates/skill/SKILL.md:10` already tells agents to pass `--policy` when the file exists. Explicit opt-in is a deliberate product decision. Auto-discovery would silently flip PASS→FAIL for anyone deliberately running standard mode; hard-erroring breaks every plain `run` in a repo that ever ran `init --authoritative`.

- `src/run.mjs:39` — when `!options.policy` and the default path exists, push a `validation.warnings` entry: `a policy exists at .dogfood/dogfood.policy.yaml but --policy was not supplied; this run used the standard profile`. First real call of `defaultPolicyPath`.
- `src/run.mjs:354` — delete the dead `export { defaultPolicyPath }`.
- `bin/dogfood.mjs:128-136` — after `init`, print the next command verbatim. Replace the hardcoded `Dogfood v0.3` at `:130` with `packageInfo.version`.

**Pins**: extend `test/integration.test.mjs:23` — keep `profile === "standard"` and `PASS`, add the warning assertion.

### A7 · `--baseline-ref` is an unsanitized git argument
`src/baseline.mjs:27,32` interpolate `ref` into `git rev-parse --verify ${ref}^{commit}` and `git show ${ref}:${rel}` with no `--` separator and no leading-dash rejection. `git show --output=<file>` is an arbitrary-file-write primitive, blocked today only by the accidental ordering of the two calls.

- `bin/dogfood.mjs:94-100` — reject a `--baseline-ref` starting with `-` as `CliUsageError` (`:81` currently only rejects `--` prefixes).
- `src/baseline.mjs:27` — add `--end-of-options`.
- `src/baseline.mjs:32` — **use the resolved 40-hex OID from `rev-parse`, never the user string**, asserting `/^[0-9a-f]{40}$/` first. An OID can never parse as an option, removing the primitive regardless of call ordering. Expose `result.resolvedRef` (report-only; `verify` doesn't inspect `baseline`).

**Pins**: `test/cli.test.mjs` on `-x` and `--output=/tmp/pwn`; `test/baseline.test.mjs` asserting `resolvedRef` is 40 hex when given a branch name.

### A8a · Redaction is off by default
`src/run-commands.mjs:251` — `if (!logs) return String(value||"")`; `logs` is null unless `--policy` was passed. A plain `dogfood run` writes **full unredacted stdout/stderr** into the bundle — which `.github/workflows/dogfood.yml:87-93` then uploads as a GitHub artifact **with no `retention-days`**. That is a live secret-exposure path in the shipped happy path.

- New `src/redact.mjs` — `createRedactor(logs)` and `DEFAULT_LOG_POLICY` (identical to `templates/dogfood.policy.yaml`: `full-redacted` + the six wildcard patterns).
- `src/run-commands.mjs:250-262` — move `redactLog` in. **Add a value guard: only redact when the env value is ≥8 chars and not purely numeric/boolean.** This is a live bug in authoritative mode today — a matching var with value `1` turns every `1` in the logs into `[REDACTED]`.
- `src/run.mjs:116` — `logs: policyDocument.policy?.logs || DEFAULT_LOG_POLICY`.
- `schemas/policy.schema.json:61` — add `"full"` to the `logs.capture` enum as a documented, discouraged opt-out. Purely additive, so **policy stays v1**.

**Pins**: `test/policy.test.mjs` — no-policy run with an 18-char `DOGFOOD_TEST_TOKEN` redacted in `commands/proof/stdout.log`; guard case with `DOGFOOD_TEST_KEY=1` leaving literal `1`s intact; existing redaction test unchanged.

### D3-code · `validate` clobbers the proof pointer
`src/run.mjs:42-50` creates the run dir unconditionally (`validateOnly` is never consulted) and `:254-263` overwrites `latest.json`. Two of the four bundles on disk right now are `mode=validate`. `dogfood report` after `dogfood validate` prints the *validation* summary in place of the proof.

Keep the validate bundle — it's useful, and `verify` already accepts `mode: "validate"` manifests (`src/verify.mjs:117-122`). The defect is only the shared pointer.

- `src/run.mjs:254-263` — write `latest.json` only when `mode === "run"`; write `latest-validate.json` (same shape) for validate. `bin/dogfood.mjs:203-233` keeps reading `latest.json` only. `.dogfood/dogfood.policy.yaml:19`'s `artifacts/dogfood/**` allowlist already covers it.

**Pins**: `test/integration.test.mjs` — `run` then `validate`, assert `latest.json.runId` is still the run's.

### C3 · The self-gate contains the anti-pattern its README warns against
`.dogfood/dogfood.contract.yaml:21-24` maps `npm pack --dry-run --json` through the **exit-code** adapter to an oracle named `package-contents`, AC *"The private package can be assembled without publishing it."* It never reads the JSON. If `files[]` dropped `src/` or started shipping `.contextrelay/`, it still exits 0 and still passes. `README.md:134` explicitly warns against exactly this.

- New `scripts/check-package-contents.mjs` — a **pure** `checkPackFiles(files, {required, forbidden})` plus a CLI entry that runs `npm pack --dry-run --json` and parses `[0].files[].path`. Required: `bin/`, `src/`, `schemas/`, `templates/`, `docs/`, `README.md`, `LICENSE`. Forbidden: `test/`, `artifacts/`, `.contextrelay/`, `node_modules/`, `scripts/`, `.github/`.
- `.dogfood/dogfood.contract.yaml:22` — `run: node scripts/check-package-contents.mjs`; rewrite the AC text at `:59-63` to claim what is actually proven.

**Pins**: `test/package-contents.test.mjs` unit-tests the pure function against a synthetic payload missing `src/` and another containing `.contextrelay/state/token`.

### B1 + B2 + B7 · One CI change fixes four defects
`.github/workflows/dogfood.yml:111` names the `dorny/test-reporter` check `dogfood / prove-it`; `:117` names the aggregation job **the same thing** — and the reporter one has `fail-on-error: "false"` (`:114`) so it structurally cannot fail. `README.md:323` tells owners to require exactly that name. Separately, the `junit` job needs `checks: write` (`:101`), which a fork `pull_request` token can never have → `junit` fails → `prove-it` requires `JUNIT = success` (`:130`) → **no fork PR can ever pass**.

**Delete the `junit` job; render the JUnit summary into `$GITHUB_STEP_SUMMARY` from inside `authoritative`.** That removes the name collision, the impossible permission, a pointless `actions/checkout` (`:104`), and a billed runner in one edit.

- Delete `:95-114`; `:119` → `needs: [unit, playwright-fixture, authoritative]`; drop `JUNIT` from `:129-130`.
- After `:86`, add an `if: always()` step parsing `artifacts/dogfood/*/junit.xml` into a Markdown table on `$GITHUB_STEP_SUMMARY`. Zero permissions, works on forks.
- **B7** `:81-84` — stop splicing `${{ steps.baseline.outputs.args }}` into `run:`. Output the bare SHA, pass via `env: BASE_REF`, branch in shell on `-n "$BASE_REF"`. Pairs with A7 so a hostile base ref fails loudly.
- Mirror all of it in `templates/ci/dogfood.yml:63-64, 75-94, 96-109`.

---

## P1 — correctness, robustness, and the tests that protect P0

### P1a · Test infrastructure — do this first
- **C1** `test/helpers.mjs:65-86` — `createProject()` never removes its `mkdtempSync` dir. ~35 temp git repos leak per `npm test`, on every matrix leg. Add a module-level roots array + `process.on("exit")` / `SIGINT` cleanup. node:test runs each file in its own process, so an exit hook suffices; the 6 existing try/finally sites become redundant, not wrong. **Must land before P1c or you add ~50 more leaks.**
- **C6** `package.json:41` hardcodes the 8-file test list, so a new `test/*.test.mjs` silently never runs. Keep the explicit list (Node 20 has no glob args to `--test`; shell globs don't expand under Windows `cmd`) and add `test/meta.test.mjs` asserting the list equals `readdirSync("test").filter(f => f.endsWith(".test.mjs"))`.
- **C6** `test/cli.test.mjs:35,41,54` hardcode `"0.3.0"` — read from `package.json`. **Must land before the 0.4.0 bump.**
- **C6** convert `test/playwright-fixture.mjs` to `node:test` so one failure doesn't abort the rest. Keep it out of `npm test` (needs browsers).
- **C4** `test/runtime.test.mjs:68-82` can pass without exercising process-tree kill if the parent dies before spawning the grandchild. Replace the race with a marker-file handshake (`ready.txt` after spawn, `late.txt` at +5s, `timeoutMs: 3000`, assert `ready.txt` exists **and** `late.txt` never appears). Same for `test/integration.test.mjs:104,139`.
- **C5** `test/playwright-fixture.mjs:39-46` copies `junit.xml` to `examples/playwright/artifacts/dogfood/` with a comment claiming CI consumes it. **No CI job reads that path.** Delete the copy and the comment.

### P1b · Correctness
- **A4** — mutation detection currently string-matches a human message: `src/run-commands.mjs:167` does `!m.includes("started with tracked changes")` against a literal duplicated at `src/repository.mjs:75` and `:96`. Reword it and every authoritative command in a dirty repo silently becomes "mutating" → universal FAIL. Return `{code, message}` from `authoritativeRepositoryProblems` / `authoritativeInitialProblems` with codes (`initial-tracked-dirty`, `tracked-state-changed`, `untracked-created|removed|content-changed`, `initial-untracked-outside-allowlist`); dedupe the literal into one constant; `:167` becomes `p.code !== "initial-tracked-dirty"`. Update `src/run.mjs:105-107,190-196` and `src/run-commands.mjs:190`. `verify` doesn't inspect the commands array, so **old v3 bundles keep verifying**. Keep message strings byte-identical so `test/runtime.test.mjs:150` still passes; assert on `code` beside it.
- **A6** — `README.md:500` says advisory evidence never changes the hard verdict, but `src/run.mjs:155-159` folds `collectAdvisoryEvidence` errors into `runtimeProblems` → `src/report.mjs:31-34` → FAIL. Two different claims are being conflated. (i) Gate the call on `!validateOnly` — this eliminates at the source the incoherent state at `src/report.mjs:64` where a validate report has non-empty `hardFails` but verdict `VALID` / exit 0. (ii) Reclassify as `kind: "advisory-input"`, message prefixed `--evidence input rejected:`. **The code stays failing and the README changes**: an advisory *assessment* never moves the verdict (true, enforced at `src/score-ac.mjs:29-37`), but a malformed `--evidence` argument is a usage failure that must not be silently dropped. Add a `nextSteps` branch at `src/report.mjs:191-204`.
- **A8b** — thread the redactor into `runNamedCommands` and `evaluateAdapter` and apply it to `src/run-commands.mjs:224` (`metadata.json.command`), `src/report.mjs:171` (`summarizeCommand.run`), the Playwright report body before `atomicWriteJson` at `src/adapters.mjs:122,135` (reports embed test stdout/stderr and stacks), and every adapter `detail`.
- **A9** — the long tail:
  - **`summarizeRepository` ×2 → 1.** `src/run.mjs:333-350` maps root through `portableRelative(root, root)` → always `"."`, so verify's "repository identity" cross-check (`src/verify.mjs:72`) compares `"."` to `"."`; meanwhile `src/run-commands.mjs:289-305` writes the **raw absolute path** into `commands/*/metadata.json`. One exported function in `repository.mjs` emitting `portableRelative(cwd, repository.root)` fixes both the meaningless field and the path leak.
  - **Exit codes.** `src/run.mjs:35,48` throw bare `Error` for ordinary conditions and land in `bin/dogfood.mjs`'s generic branch → **exit 4** ("unexpected internal error"). New `RunSetupError` → exit 1.
  - `src/files.mjs:19-23` — `fsyncSync` before `closeSync`; drop `0o600` so artifacts get default umask (CI artifact collectors running as another user currently can't read `summary.md`).
  - **Unborn HEAD** — `src/repository.mjs:16,20` need `HEAD`, so a fresh `git init` repo can *never* PASS. Fall back to the empty-tree OID `4b825dc642cb6eb9a060e54bf8d69288fbee4904` with `headState: "unborn"`.
  - **Untracked hashing** runs twice per command with no cap (`src/repository.mjs:29-44` × `src/run-commands.mjs:152,162`). Memoize by `path + size + mtimeNs` for the run; above a size cap record `digest: null, digestSkipped: true` (existence and size changes still detected).

### P1c · Coverage for modules with zero direct tests
New files, each closing a verified gap:
- `test/files.test.mjs` — `isPathInside`, `normalizeGitPath`, `portableRelative`, `atomicWriteFile`. **The three commits immediately before HEAD (`8d77955`, `d8b0860`, `d8bd6b5`) are consecutive fixes to exactly this code, with no regression test.**
- `test/policy-paths.test.mjs` — `validateProtectedPaths` (`src/policy.mjs:63`), the symlink / out-of-tree trust boundary: contract symlinked outside the repo, contract that is a directory, contract outside the Git root.
- `test/score-ac.test.mjs` — the verdict engine: all six verdicts, `collectCommandsToRun` union semantics, `expectedPlaywrightTags` dedup.
- `test/report.test.mjs` — `buildReport` verdict matrix, `classifyVerdict`, `listBundleEntries`, JUnit counters.
- `test/advisory.test.mjs` — failure branches; **`validateAdvisoryReceipt` is called by no test at all today**.
- `test/build.test.mjs` — `inspectBuildSubject`'s 5 rejection branches (2 covered today).
- `test/adapters.test.mjs` — add `prepareAdapter`, `evaluateAdapter`, `evaluateExitCode`.

### P1d · CI hardening
- **B3** — `timeout-minutes` on all jobs (unit 15, playwright-fixture 20, authoritative 25, prove-it 5); top-level `concurrency` keyed on `github.ref` with `cancel-in-progress` **only for `pull_request`** (never cancel `merge_group` or `push: main`); `actions/cache` on `~/.cache/ms-playwright` keyed on the resolved `@playwright/test` version, covering both install sites (`:49`, `:66` — 3 full Chromium downloads per run today); `retention-days: 30` on the evidence upload; upload traces / `test-results` on failure from `playwright-fixture`, which currently uploads nothing.
- **B4** — matrix → node `[20, 22, 24]` (`engines` claims `>=20`; 22 LTS is untested) and add macOS with excludes so macOS runs node 24 only.
- **B5** — `templates/ci/dogfood.yml` has drifted: it collapses to one `tests` job and **never runs the Playwright fixture**, despite naming its job "authoritative bundle / chromium" and installing Chromium. Drop the misleading name and the unconditional install; replace with a commented conditional block.
- **B6** — nightly `schedule` runs leave `PR_BASE`/`MERGE_BASE` empty → `args=""` → all baseline regression rules silently don't apply. Add `::notice::` in the `else` branch and document it in `docs/ci.md`.
- **New `test/workflow.test.mjs`** — parse both workflow YAMLs with the existing `yaml` dep and pin permanently: every `jobs.*.name` unique **and** no job name collides with any step's `with.name` (**this is B1**); no job requests `checks: write` (**B2**); every job has `timeout-minutes`; a top-level `concurrency` exists; `prove-it.needs` is a superset of every other job id; **no `run:` string contains `${{`** (**B7**); the two files' job sets match a declared expectation (**B5 drift**). Offline, deterministic, in `npm test`.

---

## P1.5 — signing, JUnit adapter, publish prep

Added after the competitive assessment. Rationale: the category has ~20 independent implementations and no incumbent, so it is winnable, but distribution is the binding constraint and the two real differentiators (tag-level Playwright oracles, `--baseline-ref` contract-regression blocking) are invisible to anyone evaluating on the README.

### Manifest v4 + detached signing
`src/verify.mjs:105-109` (closed `allowed` set, `version !== 3` reject) becomes the v4 gate.

- **Detached signature.** A signature cannot live inside the bytes it signs. `run --sign <key>` writes `manifest.sig` beside `manifest.json`. `manifest.sig` joins `manifest.json` as the second name exempt from the unrecorded-file walk that P0/A1 just tightened — **exempt by exact name only, never by substring** (that was the A1 bug).
- **Manifest v4 adds a `signing` block** — `{ algorithm, keyId, publicKey, signatureFile }` — inside the signed payload. Nothing else changes shape.
- **ed25519 via `node:crypto`**, no new dependency: `generateKeyPairSync("ed25519")`, `sign(null, bytes, key)`, `verify(null, bytes, key, sig)`. Dependency count stays at 3.
- **The trust-model caveat is the whole point.** A key embedded in the manifest is worthless — an attacker who regenerates the manifest regenerates the keypair too. So `dogfood verify <bundle> --key <public-key>` verifies against an **external anchor** and is the only mode that proves provenance; bare `verify` reports the signature as *present but unverified* and must not upgrade the verdict. `README.md:538`'s honesty becomes: *signed manifests prove provenance only against a key you trust independently.* Getting this wrong makes signing theater — worse than no signing.
- **`dogfood keygen`** writes an ed25519 pair with the private key at mode 0600.
- **Policy `signing.required: true`** (additive, policy stays v1) makes an unsigned authoritative run a FAIL.
- Sigstore keyless is a **documented future path**, not 0.4.0 — it needs `@sigstore/sign`, network, and OIDC.

### JUnit-XML adapter
`schemas/contract.schema.json:123` `["exit-code","playwright-json"]` gains `"junit-xml"` — additive, contract stays v2.

This is the tag-level-oracle idea generalized, not a reach play: JUnit XML carries `classname` + `name`, so an AC binds to **a specific testcase**, not a suite exit code. Covers pytest, Vitest, Go (gotestsum), Maven/Gradle.

- New oracle `kind: junit` with a `testcase` selector (`classname` + `name`).
- **Env injection does not generalize** here the way `PLAYWRIGHT_JSON_OUTPUT_FILE` does — pytest takes `--junitxml=`, Vitest `--reporter=junit --outputFile=`, gotestsum `--junitfile=`. So the contract declares a `reportPath` relative to cwd and the adapter reads it after the command, applying the existing workspace-containment checks.
- **Mirror Playwright's strictness**: the named testcase must exist, must have no `<failure>`/`<error>`, and must not be `<skipped>`. A selector matching nothing is a FAIL, never a pass — that is the `--grep`-matches-nothing false-green this tool exists to kill.
- Reuse `prepareAdapter` / `evaluateAdapter` / `ADAPTER_VERSIONS`. Parse without a new dependency.
- New `examples/junit/` fixture (a tiny Node runner emitting JUnit XML — no Python/Go toolchain needed in CI).

### Publish prep
Code and docs only. **I will not run `npm publish` or create the Marketplace listing** — those stay with you.

- Drop `private: true`. `files[]` becomes load-bearing for the first time, which is exactly what P0's `scripts/check-package-contents.mjs` now proves; add `docs/` to both.
- Install instructions that work against a published package, replacing the Git-SHA path (`README.md:86-95`).
- A thin **GitHub Action wrapper** (`action.yml` + `templates/ci/`) so the Marketplace listing has something to point at.
- P2 docs written for **external readers**, not just contributors.

---

## P2 — docs (after all code lands)

Several fixes change what the docs must say (A3, A5, A6, A8a, D3), so prose comes last. **Exception: draft CHANGELOG entries per-PR as fixes land**, don't reconstruct at the end.

### Build the gate before the prose
`test/docs.test.mjs`, written **first**, kills the whole D-class permanently:
- extract every fenced ```yaml block starting `version: 2` from `README.md` + `docs/contract.md`, run `validateContract` on each → **D4 can never recur**;
- same for policy blocks against `schemas/policy.schema.json`;
- assert every key of `OPTION_SPECS` (`bin/dogfood.mjs:11-23`) and every member of `COMMANDS` (`:10`) appears in `docs/cli.md` → **D1/D2 can never recur**;
- assert every property in `schemas/contract.schema.json` appears in `docs/contract.md` and every property in `schemas/policy.schema.json` in `docs/policy.md` → **D5/D10 can never recur**.

### Target structure
Add `"docs/"` to `package.json` `files[]` so the tarball stays self-contained.

| File | Content | Source |
|---|---|---|
| `README.md` (~150 ln) | What it is, **one** diagram, what PASS means, quickstart, CLI table, links | keep `:1-27` (mermaid only), `:37-52`, `:72-82`, `:84-122`, `:223-233`, `:380-410`; **delete duplicate diagrams `:53-58` and `:215-219`** |
| `docs/cli.md` | Every command and flag — **`--json` and `--contract` have 0 README hits today**; also `--cwd`, `--force`, `--timeout-ms`, repeatable `--evidence`, the `pow-dogfood` alias, `DOGFOOD_DEBUG`, the `DOGFOOD=1` env injection (`src/run-commands.mjs:25`), the 6-path contract auto-discovery incl. `.json` (`src/load-contract.mjs:19-26`), the 5 MB capture truncation (`src/run-commands.mjs:12`), exit codes incl. the two exit-1 paths the table omits | expand `:386-410` |
| `docs/contract.md` | Field-by-field incl. all 10 undocumented fields (`description`, `build.identityCommand`, `build.timeoutMs`, `text`, `reason`, `issue`, `kind: advisory` **with YAML**, the name pattern, the tag pattern, `timeoutMs` max); **Examples A and B rewritten as complete valid documents** (both are schema-invalid today — `:158-177`, `:189-207` omit required `version`/`project`/`gates` yet read as complete files); the 5 warning classes and the fact that warnings never affect the verdict | move `:123-221`, `:411-459` |
| `docs/policy.md` | **All 14 policy v1 fields — each has 0 README hits today**; profile semantics + the A5 warning; mutation boundary; baseline rules; redaction with the new defaults, the `full` opt-out, and the unified glob syntax; the `minimumDeterministic: 4` ↔ contract sync caveat | expand `:461-474`, absorb `:542-552` |
| `docs/artifacts.md` | Bundle layout, manifest v3, `verify` semantics, `latest.json` **and the new `latest-validate.json`** | move `:516-540` |
| `docs/ci.md` | Actions setup post-B, branch protection on `dogfood / prove-it`, fork behavior, **the nightly empty-baseline caveat**, `.dogfood/CODEOWNERS.fragment` (created at `src/run.mjs:289`, 0 README hits, yet `:323` and `:467` both depend on code-owner review) | move `:311-379` |
| `docs/agents.md` | Claude/Codex/skills/automation | **move `:235-310`, `:345-379` verbatim** |
| `docs/examples.md` | `examples/minimal`, `minimal-broken`, `playwright` — **all three ship in the tarball with 0 README mentions** — plus new `examples/authoritative` and `examples/advisory` | new |
| `docs/playwright.md` | Evidence contract; **fix D8** (`:477` says `PLAYWRIGHT_JSON_OUTPUT_FILE` is a *directory*; `src/adapters.mjs:16-20` sets a *file path*); the A3 change | move `:475-496` |
| `docs/advisory.md` | Receipts, `--evidence`, corrected A6 wording, the `acId`-must-exist rule (`src/advisory.mjs:37-40`) | move `:498-514` |

### AGENTS.md — rewrite to ~25 lines
It's the first thing an agent reads and the most stale doc in the repo: 3 of 8 commands, no `verify`/`report`/`migrate`, **no `--policy` at all** (the headline v0.3 feature), no `latest.json`, org-specific framing that contradicts `README.md:70`, and hard coupling to ContextRelay `record_artifact`/`propose_final` plus a "Headless experimental council" that appears nowhere in README or `src/`. Reduce to: 8 commands, 5 exit codes, 4 hard rules, and *"`templates/skill/SKILL.md` is the normative agent contract; see `docs/`."* `SKILL.md` is materially more accurate and becomes the source of truth.

### New root docs
- **`CHANGELOG.md`** — mandatory. Four independent version numbers (package 0.4.0, contract v2, policy v1, manifest v3), and `src/verify.mjs:22-24` rejects v2 bundles pointing at no upgrade document. The 0.4.0 entry lists every behavior change below.
- **`CONTRIBUTING.md`** — `README.md:554-564` lists 3 npm scripts and explains none. Must state that `npx playwright install --with-deps chromium` is required (only the workflow knows this today), that the repo gates itself with `.dogfood/`, and that `minimumDeterministic: 4` must stay in sync with the contract's exactly-4 deterministic criteria.
- **`SECURITY.md`** — warranted by `README.md:544` (contracts are trusted executable code), `:538` (manifests unsigned), the redaction feature, and A7.
- **Later**: `docs/troubleshooting.md` (error-message index), `docs/architecture.md` (module map — pairs with the P3 refactor), `docs/migration-v1-v2.md` (the v1 shape plus `migrate`'s real semantics: oracle-kind mapping, auto-generated `oracle-<AC-id>` names, auto-created `gates.verification`, default `timeoutMs: 120000`, default severity `major`, `.v1-backup-<ISO>` naming — 2 lines of docs today for a 211-line transformation).

---

## P3 — code quality, dedup, hygiene

Behavior-preserving only. `npm test` must pass unchanged and coverage must not decrease — that is what "refactor" means here.

- **`sha256` ×4** (`src/run.mjs:352`, `src/report.mjs:306`, `src/repository.mjs:203`, `src/build.mjs:72`) → new `src/hash.mjs`. **`src/verify.mjs:6` stops importing it from the report writer** — a layering inversion.
- **`safeSegment` ×2** (`src/run-commands.mjs:307`, `src/adapters.mjs:277`) → `files.mjs`. They must stay in sync or evidence filenames and log dir names diverge.
- **`formatAjvError` ×2** (`src/validate.mjs:194`, `src/policy.mjs:93`) → `src/ajv-errors.mjs`.
- **Two glob engines** → `src/glob.mjs`. `globToRegExp` (`src/repository.mjs:111`, supports `**`/`*`/`?`) serves `mutation.allowUntracked`; `wildcard` (`src/run-commands.mjs:311`, only `*`) serves `logs.redactEnv` — policy authors get different semantics for two fields in the same file, undocumented. Unify on `globToRegExp`; safe because env names contain no `/`, so `[^/]*` and `.*` are identical for them.
- **Three containment impls** (`src/files.mjs:68`, `src/verify.mjs:189`, `bin/dogfood.mjs:304`) → all on `isPathInside`.
- **Four `spawnSync("git")` wrappers** (`src/repository.mjs:136`, `src/baseline.mjs:143`, `src/policy.mjs:64`, `src/build.mjs:60`) → `src/git.mjs` that **always** sets `MSYS_NO_PATHCONV: 1` (only `policy.mjs:67` does today), plus one `cleanGitError(stderr, fallback)` replacing the divergent cleanups at `src/repository.mjs:199` (`.pop()`/`""`) and `src/baseline.mjs:147` (`.at(-1)`/`"Git command failed"`).
- **Dead exports** (all verified zero-importer): `src/run.mjs:353` `portablePath`, `src/load-contract.mjs:61` `parseYaml`, `src/report.mjs:304` `portableRelative`.
- **Dead code**: `src/files.mjs:94` (`const expanded` never read), `src/files.mjs:91,101` (unreachable — `pathRelation` already settled it), `src/policy.mjs:71-75` (try/catch is dead; `tryRealpath` never throws, `src/files.mjs:53-60`).
- **`src/run-commands.mjs:284-286`** — `catch (e) { if (e?.code !== "ESRCH") return; }` swallows exactly what it meant to surface. It runs in a `setTimeout`, so rethrowing means an unhandled rejection; capture into `result.terminationError` instead.
- **Windows perf**: `src/files.mjs:109-122` `expandWindowsShortPath` spawns **PowerShell** whenever a path contains `~`, on a path hit once per untracked file *before and after every command* (`src/repository.mjs:32` × `src/run-commands.mjs:152,162`) and once per bundle file (`src/report.mjs:131`, `src/verify.mjs:52`) → O(files × commands) spawns. Two-line fix: gate on `/~\d/` (8.3 names are `NAME~1`) and memoize in a process-lifetime `Map`.
- **Oversized functions** — `runDogfood` (`src/run.mjs:31-265`, **235 lines**, 9 concerns, 5 mutable accumulators), `migrateContractV1` (168), `validateContract` (163), `runNamedCommands` (116). Split `runDogfood` into `resolveInputs` → `prepareBundle` → `validateAll` → `executeProof` → `finalizeBundle`. **Do this last and solo**; during P0/P1 make only the minimal in-place edits each fix needs.

### Hygiene
- Delete local `artifacts/` and `.contextrelay/` (working-tree only, ~530 KB, zero repo effect — the audit's larger figure was stale). **If `.contextrelay/state/{token,proxy-token,viewer-token}` ever held real credentials, rotate them — deleting files is not rotation.**
- Delete `DOGFOOD-E2E-PANEL-2026-07-31.md` and the `.gitignore:7` wildcard. It claims "v0.1.0 shipped" (actual 0.4.0), proposes two skills that don't exist, a `.dogfood/{architecture,journeys,judgments}/` tree `init` never creates, and an `ADVISORY_CONCERNS` verdict that doesn't exist. Salvage anything still true into `docs/architecture.md`.
- Delete `.npmignore` — dead config. `files[]` takes precedence; lines 1-3 duplicate the allowlist, lines 4-5 can never match (no artifacts path is in `files[]`), line 6 pins a literal dated filename while `.gitignore:7` uses a glob.
- Delete `examples/minimal/checks/fail.mjs` — referenced by no contract anywhere; its own comment says so.
- **Keep** `templates/integration/implement-batch-hook.snippet.js` but reference it from `docs/cli.md` and `docs/agents.md` — it is the only working `--json` demonstration in the repo.
- Leave `private: true`. The C3 checker is now the real validation of `files[]`.

---

## Breaking changes → 0.4.0

| Change | Effect |
|---|---|
| A3 | Playwright commands relying on stdout: **PASS → FAIL** |
| A2 | Bundle containing a symlink: `run` **PASS → INFRA_ERROR**, `verify` **VERIFIED → INVALID** |
| A1 | `verify` now flags `.tmp-`-named injected files: **VERIFIED → INVALID** |
| A7 | `--baseline-ref` starting with `-`: **exit 3** |
| A8a | Standard-mode logs now contain `[REDACTED]` (content only) |
| D3 | `dogfood report` after `validate` shows the run (corrects wrong output) |
| A9 | `src/run.mjs:35,48` errors: **exit 4 → exit 1** |
| A4 / A9 / A3 / A5 | `report.commands[].mutationProblems` → `{code,message}`; `report.repository.*.root` becomes meaningful and `commands/*/metadata.json` root becomes relative; `evidence` gains `reportSource`/`reportAccepted`; one new `validation.warnings` entry |

**Versions**: manifest stays **3**, contract stays **v2**, policy stays **v1** (the only schema edit is an additive `logs.capture: "full"` enum member). Package → **0.4.0**.

**Do existing v3 bundles still verify?** Yes, with two intentional exceptions. Dropping the `.tmp-` exemption changes nothing for legitimate bundles (any temp present at manifest time was already checksummed *into* the manifest by `writeManifest`). Symlink detection now fails old bundles containing symlinks — that is the fix, not a regression. Old 0.3.0 `verify` also still reads new 0.4.0 bundles, since no manifest field was added.

**Companion edits**: `src/verify.mjs:23` message → "v0.3 or newer"; `bin/dogfood.mjs:130` → `packageInfo.version`; `test/cli.test.mjs` de-hardcoded **before** the bump; `README.md:552` → v0.4.

---

## Verification

**Per phase**
- **P0** — the new/rewritten cases named under each fix, then end-to-end in order: `npm test` → `npm run test:self` → `npm run test:playwright-fixture` → `node bin/dogfood.mjs run --policy .dogfood/dogfood.policy.yaml` → `node bin/dogfood.mjs verify artifacts/dogfood/<runId>`. The last two are the real proof: **the tool's own authoritative bundle must still verify after the integrity changes.**
- **P1** — `npm test` (now with `test/meta.test.mjs` guaranteeing new files actually run) plus `node --test --experimental-test-coverage`. Success criterion: `files.mjs`, `policy.mjs`, `score-ac.mjs`, `build.mjs`, `advisory.mjs` go from zero direct coverage to covered.
- **P2** — `test/docs.test.mjs` is the gate; write it before the prose.
- **P3** — no new tests; `npm test` unchanged and coverage not decreased.

**CI (B1/B2) without merging blind** — the workflow can't run locally, so three layers:
1. `test/workflow.test.mjs` (above) pins B1/B2/B3/B5/B7 offline and permanently. Highest value.
2. `actionlint` as a step in the `unit` job for expression/schema errors the parser can't catch.
3. **One empirical validation PR after merge** — open a PR from a fork, confirm the checks list shows exactly one `dogfood / prove-it`, that it goes red when a job fails, and that no job errors on missing `checks: write`. Then set branch protection to require `dogfood / prove-it`, now unambiguous. This is the only step that cannot be front-loaded — schedule it explicitly, don't assume it.

---

## Sequencing

| Phase | Size | Parallel tracks |
|---|---|---|
| **P0** | M (~2-3 d) | (1) bundle integrity A1+A2 — one owner, both touch `listFiles`/the verify walk · (2) adapters+redaction A3+A8a — both touch `adapters.mjs` · (3) independent: A5, A7, D3, C3, B1/B2/B7 |
| **P1** | L (~4-6 d) | P1a (test infra) **gates** P1c · P1b, P1c, P1d otherwise independent |
| **P2** | L (~3-4 d) | `test/docs.test.mjs` first, then prose (serial, one author) |
| **P3** | M (~2-3 d) | all dedup parallel-safe; `runDogfood` decomposition solo and last |

**Hard ordering**
1. C6's de-hardcoded version **before** the 0.4.0 bump.
2. P1a (temp cleanup) **before** P1c (new tests).
3. `test/docs.test.mjs` **before** the P2 prose.
4. `test/workflow.test.mjs` **with** the B1/B2 edit, not after.
5. All code **before** all docs.

**Git**: branch off `main` (`git status` is clean at `6086965`). One PR per phase, or per track within P0.

---

## Execution: ultracode

Per your instruction, this runs as **sequenced multi-agent workflows — one per phase**, so you stay in the loop between phases and each phase's gate has to pass before the next starts.

1. **P0 workflow** — three parallel implementation tracks (integrity A1+A2 · adapters+redaction A3+A8a · independent A5/A7/D3/C3/B1+B2+B7), each in an isolated git worktree since they touch overlapping files, then a merge-and-reconcile stage, then adversarial verification of every claimed fix, then the end-to-end gate (`npm test` → `test:self` → `test:playwright-fixture` → authoritative self-run → self-verify).
2. **P1 workflow** — P1a lands first (it gates P1c), then P1b / P1c / P1d fan out in parallel, then coverage check + full gate. Version bumps to 0.4.0 at the end.
3. **P2 workflow** — `test/docs.test.mjs` built first, then the ten `docs/` files written in parallel against that live gate, then README/AGENTS.md rewrite, then the doc gate.
4. **P3 workflow** — dedup items in parallel, `runDogfood` decomposition solo and last, with "`npm test` unchanged and coverage not decreased" as the only acceptance criterion.

I'll report back after each phase with what landed, what the gate said, and anything that turned out different from this plan. The one item that **cannot** be automated is the empirical CI validation (§Verification, layer 3) — it needs a real fork PR after merge, and I'll flag it as an explicit open task rather than claim it done.
