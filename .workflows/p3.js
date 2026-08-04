export const meta = {
  name: 'dogfood-p3',
  description: 'Dogfood 0.4.0 P3: dedup, dead code, refactor, hygiene',
  phases: [
    { title: 'Consolidate', detail: 'one implementation of each duplicated helper' },
    { title: 'Decompose', detail: 'runDogfood split, solo and last' },
    { title: 'Prove', detail: 'behavior-preserving check + final evaluation' },
  ],
}

const REPO = '/Users/danillofelanso/projects/proofofworks/thinktank/concepts/testo'

const COMMON = `
Repo: ${REPO} (branch dogfood-0.4.0-remediation, Node v22.13.0, Chromium installed).
"@proofofwork-agency/dogfood" — a Node >=20 ESM CLI evidence gate. P0, P1, P1.5 and P2 have landed.

THIS PHASE IS BEHAVIOR-PRESERVING. The single acceptance criterion is:
  npm test stays fully green AND coverage does not decrease.
If a refactor requires changing a test's expectation, you have changed behavior — stop and report it
instead. The ONLY exception is a test that asserts an implementation detail you are legitimately
moving (e.g. importing a helper from a new module path); say so explicitly when you do that.

Run npm test BEFORE you start and record the number. Run it after every consolidation.

STYLE: ESM, node: prefixed builtins, 2-space indent, double quotes, semicolons, terse one-line
helpers at file bottom, sparse comments. NO NEW DEPENDENCIES — runtime deps are exactly ajv,
ajv-formats, yaml.

RULES: only touch your assigned files. No git commands. No commits. Never publish.
Report: files changed, what consolidated into what, the npm test count before and after.
`

phase('Consolidate')
const consolidated = await parallel([
  () => agent(`${COMMON}
TASK: consolidate hashing, git invocation, and error formatting.
You own: src/hash.mjs (create), src/git.mjs (create), src/ajv-errors.mjs (create),
src/repository.mjs, src/baseline.mjs, src/policy.mjs, src/build.mjs, src/validate.mjs,
src/report.mjs, src/run.mjs, src/verify.mjs

1. sha256 is implemented FOUR times, identically: src/run.mjs, src/report.mjs, src/repository.mjs,
   src/build.mjs. Only report.mjs exports it — and src/verify.mjs imports it FROM THE REPORT WRITER,
   a layering inversion (a verifier depending on a report generator). Create src/hash.mjs exporting
   sha256(value) and sha256File(path) (the streaming one currently in repository.mjs). Point every
   consumer at it. verify.mjs must no longer import anything from report.mjs except what is
   genuinely report-related — check what remains and note it.

2. FOUR separate spawnSync("git", ...) wrappers exist: src/repository.mjs, src/baseline.mjs,
   src/policy.mjs, src/build.mjs. Only ONE of them sets MSYS_NO_PATHCONV=1, so the Windows path
   workaround is applied inconsistently — a real latent bug. Create src/git.mjs with a single
   wrapper that ALWAYS sets it, plus cleanGitError(stderr, fallback) replacing the two divergent
   stderr cleanups (one uses .pop() defaulting to "", the other .at(-1) defaulting to
   "Git command failed" — pick the more informative behavior and use it everywhere).
   CAUTION: src/repository.mjs also has genuinely ASYNC git usage (parallel spawn + streamed
   hashing). Keep the async path async; the shared wrapper is for the sync callers. Do not make
   repository.mjs synchronous.

3. formatAjvError is implemented twice, near-identically, differing only in the default root label:
   src/validate.mjs and src/policy.mjs. Extract to src/ajv-errors.mjs taking the label as a
   parameter.

After each of the three, run npm test and confirm the count is unchanged.
`, { label: 'hash+git+ajv', phase: 'Consolidate' }),

  () => agent(`${COMMON}
TASK: consolidate globs and path containment, and remove dead code.
You own: src/glob.mjs (create), src/files.mjs, src/run-commands.mjs, src/adapters.mjs,
src/verify.mjs, bin/dogfood.mjs, src/load-contract.mjs, src/policy.mjs, src/run.mjs

1. TWO DIFFERENT GLOB ENGINES give policy authors different semantics for two fields in the SAME
   policy file: globToRegExp in src/repository.mjs (supports **, *, ?) serves
   mutation.allowUntracked, while a simpler wildcard() in src/run-commands.mjs (only *) serves
   logs.redactEnv. This difference is undocumented. Create src/glob.mjs exporting the fuller
   globToRegExp and use it for BOTH. This is safe: env var names contain no "/", so [^/]* and .*
   behave identically for them — verify that claim with a quick probe before you rely on it, and
   confirm the existing redaction tests still pass.
   NOTE: src/repository.mjs is owned by the other agent in this phase for its git usage. Coordinate:
   MOVE globToRegExp out of repository.mjs into glob.mjs and leave the rest of that file alone.
   Re-read the file immediately before editing it.

2. safeSegment is byte-identical in src/run-commands.mjs and src/adapters.mjs. They MUST stay in
   sync or evidence filenames and command log directory names diverge. Move one copy into
   src/files.mjs and import it in both.

3. THREE path-containment implementations, three different techniques: isPathInside in
   src/files.mjs (realpath comparison), safeBundlePath in src/verify.mjs (relative() prefix test),
   and a local inside() in bin/dogfood.mjs (string prefix). Reimplement the latter two on top of
   isPathInside. Be careful: safeBundlePath must keep rejecting absolute paths and ".." segments in
   manifest checksum keys — that is a security control, so add a test if one does not exist.

4. DEAD CODE, all verified zero-importer — remove:
   - src/run.mjs: the portablePath one-line passthrough export
   - src/load-contract.mjs: the parseYaml re-export
   - src/report.mjs: the portableRelative re-export
   - src/files.mjs: an assigned-but-never-read local in portableRelative, and the unreachable
     branches after pathRelation has already decided the answer
   - src/policy.mjs: a try/catch around tryRealpath that can never fire, because tryRealpath catches
     internally and falls back rather than throwing
   Grep to confirm zero importers before deleting each one, and say so in your report.

5. src/run-commands.mjs has a catch block that swallows exactly what it meant to surface:
   \`catch (e) { if (e?.code !== "ESRCH") return; }\` — both branches do nothing. It runs inside a
   setTimeout so rethrowing would be an unhandled rejection. Capture the error onto the result
   object (e.g. result.terminationError) and continue.

6. WINDOWS PERF: expandWindowsShortPath in src/files.mjs spawns a PowerShell process whenever a path
   contains "~". It sits on a hot path called once per untracked file BEFORE AND AFTER every command
   and once per bundle file, so it is O(files x commands) PowerShell spawns on a Windows runner.
   Two-line fix: gate on /~\\d/ instead of includes("~") (8.3 short names are NAME~1; a literal "~"
   in a normal path is not one) and memoize results in a process-lifetime Map.

Run npm test after each item.
`, { label: 'glob+paths+deadcode', phase: 'Consolidate' }),

  () => agent(`${COMMON}
TASK: repository hygiene. You own: .gitignore, .npmignore, DOGFOOD-E2E-PANEL-2026-07-31.md,
examples/minimal/checks/fail.mjs, .claude/agents/*.md, and any other stale file you can PROVE is
unreferenced.

Before deleting anything: grep the entire repo for references and paste the (empty) result into your
report. Do not delete on suspicion.

1. .npmignore is DEAD CONFIG — npm ignores it entirely when package.json has a files[] allowlist,
   which this package does. Its lines duplicate the allowlist, two can never match (they reference
   paths not in files[]), and one pins a literal dated filename while .gitignore uses a glob for the
   same thing. Delete the file. Confirm with \`npm pack --dry-run --json\` that the shipped file list
   is IDENTICAL before and after — paste both counts.

2. examples/minimal/checks/fail.mjs is referenced by NO contract anywhere (its own comment says it
   is unused) yet it ships in the tarball. Verify with grep across examples/, .dogfood/, templates/,
   test/, src/, bin/, docs/ then delete it.

3. DOGFOOD-E2E-PANEL-2026-07-31.md is stale design research: it claims v0.1.0 shipped (actual is
   0.4.0), proposes two slash-command skills that do not exist, a .dogfood/{architecture,journeys,
   judgments}/ directory tree that init never creates, artifact subdirectories that do not match the
   real layout, and an ADVISORY_CONCERNS verdict that does not exist in the verdict model. It is
   already gitignored and untracked. Delete it AND remove the DOGFOOD-E2E-PANEL-*.md wildcard from
   .gitignore — a shipped package should not need a wildcard ignore for research notes. If anything
   in it is still true and not captured elsewhere, salvage it into docs/architecture.md first.

4. .claude/ is UNTRACKED AND NOT GITIGNORED — a footgun, since any \`git add .\` commits it. It also
   still contains agent definitions written for an unrelated project ("Borderly", a NestJS/Next.js
   customs platform): developer.md, architect.md, auditor.md, debugger.md, mcp-expert.md,
   nextjs-architecture-expert.md, performance-profiler.md, prompt-engineer.md, ui-ux-designer.md.
   Several others (qa, security, reviewer, documenter, evaluator, git-ops) have already been
   rewritten for dogfood and are worth keeping.
   Do: delete the ones that are unambiguously about a different stack (nextjs-architecture-expert,
   ui-ux-designer, developer, mcp-expert), REWRITE architect/auditor/debugger/performance-profiler
   for this project if they are cheap to make useful, and make a deliberate decision about tracking:
   dogfood's own \`init\` command creates .claude/skills/, so .claude/ IS semantically meaningful
   here. Recommend either tracking the dogfood-specific agents or gitignoring the directory, and
   implement your recommendation. Explain the choice in your report.
   Whatever you choose, .claude/ must NOT reach the npm tarball — confirm via npm pack --dry-run.

5. Create docs/architecture.md: a one-page module map. bin/dogfood.mjs -> src/run.mjs orchestrator
   -> load-contract / policy / validate / baseline / run-commands / adapters / score-ac / report,
   with verify as an independent consumer of the bundle. One diagram, a table of module
   responsibilities, and the data flow of a single run. Read the actual imports to build it — do not
   guess the graph.
`, { label: 'hygiene', phase: 'Consolidate' }),
])

phase('Decompose')
const decomposed = await agent(`${COMMON}
TASK: decompose runDogfood. This is done SOLO and LAST because every other agent is finished and
this touches the file they all depended on. Re-read src/run.mjs in full first.

runDogfood is a single ~235+ line function interleaving nine distinct concerns with five mutable
accumulators: run-id generation, contract/policy loading, bundle directory creation, document
snapshotting and digesting, validation (contract + policy + protected paths + baseline), git state
capture, build identity, advisory ingestion, command execution, AC scoring, post-run mutation
comparison, and report/manifest/pointer writing.

Split it into named steps in the same file (do NOT scatter across new modules — the orchestration
reads better in one place):
  resolveInputs   -> cwd, runId, contract, policy, authoritative, validateOnly, paths
  prepareBundle   -> artifact dir creation, snapshots, digests
  validateAll     -> contract + policy + protected paths + baseline, deduped
  executeProof    -> git before, build identity, advisory, commands, scoring, git after
  finalizeBundle  -> report, manifest, pointer files
runDogfood becomes a short, readable sequence of these calls.

CONSTRAINTS:
- The exported signature and the returned object shape must not change AT ALL. Callers include
  bin/dogfood.mjs and the whole test suite.
- The order of side effects must not change: the bundle directory is still created before anything
  is written into it, git state is still captured before and after each command, and the pointer
  file is still written last.
- Errors must keep their current types and therefore their exit codes.
- Do NOT change any message string — tests assert on several of them.

Then do the same for the two other oversized functions IF AND ONLY IF it is low-risk:
migrateContractV1 in src/migrate.mjs (~168 lines, but it is a long list of explicit refuse-to-guess
bail-outs and may be clearer as-is — use judgement and say what you decided and why) and
validateContract in src/validate.mjs (~163 lines; the schema check and the semantic cross-reference
rules are cleanly separable).

Run npm test after EACH extraction, not just at the end. If the count changes, revert that step.
`, { label: 'decompose', phase: 'Decompose' })

phase('Prove')
const evaluation = await agent(`
Repo: ${REPO} (branch dogfood-0.4.0-remediation).

You are the final evaluator for "@proofofwork-agency/dogfood" v0.4.0 — a Node ESM CLI evidence gate
about to be handed to its owner for release. Four phases of work have landed: P0 (integrity and CI
fixes), P1 (correctness hardening and coverage), P1.5 (manifest signing, JUnit adapter, publish
prep), P2 (documentation), P3 (refactor and hygiene).

Score it, with EXECUTED evidence. Do not score from reading.

Run all of this and record actual output:
  npm test
  node --test --experimental-test-coverage (report per-file numbers)
  npm run test:self
  npm run test:playwright-fixture
  node bin/dogfood.mjs validate
  node bin/dogfood.mjs run --policy .dogfood/dogfood.policy.yaml   (then verify that bundle)
  node bin/dogfood.mjs keygen + run --sign + verify with and without --key + verify with a WRONG key
  node scripts/check-package-contents.mjs
  npm pack --dry-run --json   (inspect the actual shipped file list)
  node --test test/docs.test.mjs
  the examples/ directories
  cd examples/minimal-broken && node ../../bin/dogfood.mjs validate   (must exit 1)

Then attack it in a temp repo: plant an unrecorded file, a .tmp--named file, a symlink, an empty
directory; fabricate Playwright stdout evidence; pass a dash-prefixed --baseline-ref; re-sign a
bundle with an attacker key and verify against the original public key. Every one must be caught.
Also confirm NO false positives: a legitimate fresh bundle must still verify cleanly.

Then grep for regressions of the consolidation work: \`function sha256\`, \`function summarizeRepository\`,
\`function safeSegment\`, \`function formatAjvError\`, \`spawnSync("git"\` — each should have exactly one
definition now.

You MUST NOT modify any file in ${REPO}. Read-only. Probes go in
/private/tmp/claude-501/-Users-danillofelanso-projects-proofofworks-thinktank-concepts-testo/67ddd512-2138-42e8-958c-a0459b147b90/scratchpad

Be blunt and accurate. This tool's entire purpose is refusing to inflate a verdict; an evaluation
that inflates its own would be self-refuting. If something is not ready, say so.
`, { label: 'final-evaluation', phase: 'Prove', agentType: 'evaluator' })

return { consolidated, decomposed, evaluation }
