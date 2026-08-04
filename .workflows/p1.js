export const meta = {
  name: 'dogfood-p1',
  description: 'Dogfood 0.4.0 P1: correctness hardening, zero-coverage tests, CI hardening',
  phases: [
    { title: 'Correctness', detail: 'A4 mutation codes, A6 advisory, A8b redaction reach, A9 long tail' },
    { title: 'Coverage', detail: 'seven test files for modules with zero direct tests' },
    { title: 'Verify', detail: 'adversarial skeptics' },
    { title: 'Gate', detail: 'full suite + self-gate + playwright fixture' },
  ],
}

const REPO = '/Users/danillofelanso/projects/proofofworks/thinktank/concepts/testo'

const COMMON = `
You are working in the repo at ${REPO} (branch dogfood-0.4.0-remediation, Node v22.13.0).
"@proofofwork-agency/dogfood" is an ESM CLI evidence gate: a contract maps acceptance criteria to
oracles (exact shell commands or exact Playwright test tags); "dogfood run" executes them and emits
a checksummed bundle under artifacts/dogfood/<runId>/; "dogfood verify" re-checks it offline.
--policy enables an "authoritative" profile.

P0 ALREADY LANDED (commit a7dfb9d) and npm test is 107/107 green. src/files.mjs, src/report.mjs,
src/verify.mjs, src/adapters.mjs, src/run-commands.mjs, src/run.mjs, src/advisory.mjs,
src/baseline.mjs, bin/dogfood.mjs and many tests changed; src/redact.mjs and
scripts/check-package-contents.mjs are new. READ files before editing; do not trust remembered
line numbers.

P0 highlights you must not regress: listBundleEntries is lstat-based and writeManifest fails closed
via BundleIntegrityError on non-regular entries; verify has NO substring exemptions (exact names
only); the Playwright adapter rejects stdout as evidence and unlinks the report path before running;
redaction is on by default via src/redact.mjs; validate writes latest-validate.json not latest.json.

YOU MUST LEAVE npm test GREEN. If you break a test, fix it before reporting done.

CONSTRAINTS:
1. Contract schema stays v2. Policy schema stays v1 (additive members only).
2. The manifest v3->v4 bump and signing happen in a LATER phase. Do not touch manifest shape here.
3. DO NOT edit package.json. A later stage owns it. Create test files; do not register them.
4. Match surrounding style: ESM, node: builtins, 2-space indent, double quotes, semicolons.
5. Run your own tests directly (node --test test/x.test.mjs). Chromium IS installed, so
   \`npm run test:playwright-fixture\` works if you need it.
6. Only touch files assigned to you. Other agents work concurrently.
7. No git commands. No commits.

Report tersely: files changed, what changed, tests added, test output observed.
`

phase('Correctness')
const correctness = await parallel([
  () => agent(`${COMMON}
TASK: A4 + A6 — structured mutation codes and advisory reclassification.
You own: src/repository.mjs, src/run-commands.mjs, src/run.mjs, src/report.mjs, src/advisory.mjs,
test/runtime.test.mjs

=== A4: mutation detection string-matches a human-readable message ===
src/run-commands.mjs (search for "started with tracked changes") does:
  authoritativeProblems.some((message) => !message.includes("started with tracked changes"))
The producing literal lives in src/repository.mjs TWICE (two separate push sites, byte-identical).
Reword that sentence and EVERY authoritative command in an already-dirty repo silently becomes
"mutating" -> universal FAIL. There is no shared constant and no test pinning the coupling.

FIX: make authoritativeRepositoryProblems and authoritativeInitialProblems return
{ code, message } objects instead of bare strings. Codes:
  initial-tracked-dirty, tracked-state-changed, untracked-created, untracked-removed,
  untracked-content-changed, initial-untracked-outside-allowlist
Dedupe the duplicated literal into one exported constant. The run-commands predicate becomes
  problems.some((p) => p.code !== "initial-tracked-dirty")
Update every consumer: src/run.mjs (initial problems -> runtimeProblems, and the after-run
comparison), src/run-commands.mjs, src/report.mjs if it renders them.
report.commands[].mutationProblems now carries {code,message} objects.
KEEP THE MESSAGE STRINGS BYTE-IDENTICAL so existing assertions still pass; add code assertions
beside them in test/runtime.test.mjs.

=== A6: advisory receipts contradict the documented contract ===
README.md says advisory evidence "never changes the hard verdict", but src/run.mjs folds
collectAdvisoryEvidence errors into runtimeProblems (category "product") -> report.mjs folds
runtimeProblems into hardFails -> FAIL. Notably src/advisory.mjs fails the whole run when a
receipt's acId does not match a declared criterion id.

There are TWO different claims being conflated, and the resolution is:
(i) An advisory ASSESSMENT never moves the verdict. That is true and enforced in src/score-ac.mjs.
(ii) A malformed --evidence ARGUMENT is a usage failure and MUST NOT be silently dropped.
So the code stays failing, but is reclassified honestly:
  - src/run.mjs: gate the collectAdvisoryEvidence call on !validateOnly. This eliminates at the
    SOURCE an incoherent state where a validate-mode report has a non-empty hardFails array but
    verdict VALID and exit 0 (reachable through the exported runDogfood API).
  - src/run.mjs: change the problem kind from "advisory-evidence" to "advisory-input" and prefix
    the message with "--evidence input rejected: ".
  - src/report.mjs: add a nextSteps branch for "advisory-input" telling the user to fix the receipt
    rather than the product code.
  - src/report.mjs buildReport: add a defensive invariant — when validateOnly, the deduplicated
    hardFails must contain only kind "contract" entries. Throw or record a runtime problem if not.

TESTS (test/runtime.test.mjs): assert both message AND code on the dirty-repo case; add a case
proving a command that mutates a tracked file yields code "tracked-state-changed" while an
initially-dirty repo yields "initial-tracked-dirty" and does NOT mark commands as mutating.
`, { label: 'A4+A6', phase: 'Correctness' }),

  () => agent(`${COMMON}
TASK: A8b + A9 — redaction reach and the correctness long tail.
You own: src/files.mjs, src/repository.mjs (summarizeRepository only — another agent owns the
mutation-problem functions in the same file, so ONLY touch summarizeRepository and the git/hash
helpers), src/build.mjs, src/adapters.mjs, src/run-commands.mjs (metadata writing only)

COORDINATE: another agent is editing src/repository.mjs's authoritativeRepositoryProblems /
authoritativeInitialProblems and src/run-commands.mjs's mutation predicate RIGHT NOW. Keep your
edits surgical and in different functions. Re-read the file immediately before each edit.

=== A8b: redaction covers logs only, not derived text ===
P0 created src/redact.mjs and made redaction default-on. But redaction is applied ONLY to
result.stdout/result.stderr. These paths still write unredacted text into the bundle:
  - src/run-commands.mjs: commands/<name>/metadata.json persists the raw command string; a secret
    embedded in a "run:" line survives.
  - src/adapters.mjs: the whole Playwright JSON report is written with no redaction pass. Playwright
    reports embed test stdout/stderr, error stacks and attachment paths.
  - src/adapters.mjs: adapter "detail" strings.
Thread the redactor (createRedactor from src/redact.mjs) into these paths and apply it. For the
Playwright report, redact the serialized JSON string before writing, not the object graph.

=== A9a: summarizeRepository is implemented TWICE with divergent privacy behavior ===
src/run.mjs has one that maps root through portableRelative(root, root) — since both args are
identical this ALWAYS returns the literal ".", so report.repository.*.root is meaningless and
verify's "repository identity" cross-check compares "." to ".". src/run-commands.mjs has another
that writes the RAW ABSOLUTE PATH into commands/*/metadata.json — an information leak.
Consolidate into ONE exported summarizeRepository(repository, { cwd }) in src/repository.mjs that
emits root: portableRelative(cwd, repository.root). Delete both copies. Report and manifest must
still derive from the same object so verify's cross-check stays consistent.

=== A9b: atomicWriteFile durability and permissions ===
src/files.mjs atomicWriteFile opens with mode 0o600, writes, closes, renames — with NO fsync, so
"atomic" holds only against concurrent readers, not a crash. And 0600 survives the rename, so every
artifact including summary.md and junit.xml is owner-read-only, which breaks CI artifact collectors
running as a different user. Add fsyncSync(descriptor) before closeSync, and drop the explicit mode
so files get the default umask.

=== A9c: repos with an unborn HEAD can never PASS ===
src/repository.mjs runs "rev-parse HEAD" and "diff --binary HEAD"; both fail in a repo with no
commits, so captureRepositoryState returns unavailable -> infra problem -> INFRA_ERROR. A freshly
git-init'd repo can never produce a PASS. When rev-parse HEAD fails but rev-parse --git-dir
succeeds, use the empty-tree OID 4b825dc642cb6eb9a060e54bf8d69288fbee4904 for the diff and record
head: null, headState: "unborn".

=== A9d: untracked hashing is O(files) twice per command with no cap ===
captureRepositoryState computes a full sha256 for EVERY non-ignored untracked file, and it is called
before AND after every command. In authoritative mode the scope is the whole git root. Memoize by
path+size+mtimeNs for the lifetime of a run, and above a size cap (use 8 MiB) record
digest: null, digestSkipped: true — existence and size changes are still detected.

=== A9e: build subject / runtime metadata ===
src/build.mjs inspectBuildSubject has 5 rejection branches; make sure none of them leak absolute
paths into the report (relativize like the rest of the report does).

Verify: node --test test/integration.test.mjs test/runtime.test.mjs test/policy.test.mjs
`, { label: 'A8b+A9', phase: 'Correctness' }),
])

phase('Coverage')
const coverage = await parallel([
  () => agent(`${COMMON}
TASK: unit tests for path/containment and policy trust boundary — the highest-risk untested code.
You own (create): test/files.test.mjs (EXTEND — P0 already created it), test/policy-paths.test.mjs

WHY THIS MATTERS: the three commits immediately before this work (8d77955, d8b0860, d8bd6b5) are
consecutive bugfixes to src/files.mjs path handling, and there was no regression test for any of
them. src/policy.mjs validateProtectedPaths is the symlink / out-of-tree trust boundary that stops
a contract or policy from being loaded from outside the repo, and it has ZERO coverage.

test/files.test.mjs — extend with:
  - isPathInside: same path, direct child, deep descendant, sibling with a shared prefix
    (/a/bc must NOT be inside /a/b), parent, unrelated, relative inputs, trailing separators,
    and (skip on win32) a symlinked path that resolves outside.
  - normalizeGitPath: MSYS /c/... forms, backslash forms, already-normal paths, empty input.
  - portableRelative: same dir returns ".", child, nested child, escaping path, and confirm it
    always emits forward slashes.
  - atomicWriteJson round-trips and leaves no .tmp- residue.

test/policy-paths.test.mjs — validateProtectedPaths:
  - contract inside the repo: ok
  - contract that is a SYMLINK pointing outside the git root: rejected (skip on win32)
  - contract that is a directory, not a regular file: rejected
  - contract resolved outside the git root entirely: rejected
  - policy file with the same four cases
  - a cwd that is not a git repo at all: reports the git-working-tree error
Use test/helpers.mjs createProject for real git fixtures.

Read the CURRENT source of src/files.mjs and src/policy.mjs first — P0 changed files.mjs.
Verify: node --test test/files.test.mjs test/policy-paths.test.mjs
`, { label: 'cov:files+policy', phase: 'Coverage', agentType: 'qa' }),

  () => agent(`${COMMON}
TASK: unit tests for the verdict engine and the report builder.
You own (create): test/score-ac.test.mjs, test/report.test.mjs (EXTEND — P0 already created it)

src/score-ac.mjs is THE VERDICT ENGINE and has zero direct tests. src/report.mjs is the largest
module and only has the listBundleEntries tests P0 added.

test/score-ac.test.mjs — scoreAcceptanceCriteria, exercising the documented precedence order:
  excluded -> "excluded"; judgmental -> "advisory"; validateOnly -> "not-run";
  no oracle -> "fail"; deterministic bound to an advisory oracle -> "fail";
  oracle command never executed -> "fail"; command status infra -> "blocked";
  command mutated the repo -> "fail"; command failed -> "fail";
  playwright tag missing or not pass -> "fail"; otherwise "pass".
  Also assert severity is NEVER consulted (a "minor" deterministic failure still blocks).
  Plus collectCommandsToRun (union of gated commands and deterministic-oracle commands, deduped)
  and expectedPlaywrightTags (per-command tag sets, deduped).

test/report.test.mjs — extend with:
  - classifyVerdict: all-infrastructure problems -> INFRA_ERROR; any product problem -> FAIL;
    empty -> PASS.
  - buildReport verdict matrix: validate x VALID/INVALID, run x VALID/INVALID, and the rule that
    verdict === validationVerdict in validate mode and proofVerdict is NOT_RUN.
  - the JUnit renderer counters (failures / errors / skipped) against a known report shape.
Call the functions directly with hand-built inputs; do not go through runDogfood.
Read the CURRENT source of both modules first.
Verify: node --test test/score-ac.test.mjs test/report.test.mjs
`, { label: 'cov:score+report', phase: 'Coverage', agentType: 'qa' }),

  () => agent(`${COMMON}
TASK: unit tests for advisory receipts, build subject, and the adapter surface.
You own (create): test/advisory.test.mjs, test/build.test.mjs; and EXTEND test/adapters.test.mjs

test/advisory.test.mjs — collectAdvisoryEvidence and validateAdvisoryReceipt.
NOTE: validateAdvisoryReceipt (src/validate.mjs) is currently called by NO test at all.
  - a valid receipt is accepted and copied into the bundle
  - receipt path outside the workspace -> error
  - receipt that is not valid JSON -> error
  - receipt failing schemas/advisory-receipt.schema.json -> error
  - receipt whose acId matches no declared criterion -> error (this rule is surprising and undocumented)
  - a listed artifact that does not exist / is not a regular file -> error
  - PARTIAL FAILURE: when artifact 3 of 5 is invalid, confirm what happens to the copies of
    artifacts 1 and 2. If they are left orphaned in the bundle, that is a real defect — report it
    clearly rather than asserting the buggy behavior as correct.

test/build.test.mjs — inspectBuildSubject's five rejection branches (only two are covered today):
  unsupported algorithm, missing file, SYMLINK (skip win32), path escaping the workspace,
  not a regular file (a directory). Plus the happy path digest+size. Plus collectRuntimeMetadata
  returning the expected shape without throwing when git/npm are absent.

test/adapters.test.mjs — extend with prepareAdapter (evidence path allocation and
PLAYWRIGHT_JSON_OUTPUT_FILE injection), evaluateAdapter dispatch, evaluateExitCode (pass on 0, fail
on non-zero, infra on timeout), and ADAPTER_VERSIONS being present for every supported adapter.
Do NOT break the P0 stdout-forgery rejection test in that file.
Verify: node --test test/advisory.test.mjs test/build.test.mjs test/adapters.test.mjs
`, { label: 'cov:advisory+build+adapters', phase: 'Coverage', agentType: 'qa' }),

  () => agent(`${COMMON}
TASK: CI hardening B3/B4/B5/B6. You own: .github/workflows/dogfood.yml, templates/ci/dogfood.yml,
test/workflow.test.mjs (EXTEND — P0 created it)

P0 already: deleted the junit job, fixed the duplicate check name, removed checks:write, replaced
\${{ }} interpolation in run: blocks with env vars, and added timeout-minutes + a concurrency block.
READ BOTH FILES AND test/workflow.test.mjs FIRST to see what is already done. Do not redo it.

REMAINING:
B3 - Add actions/cache for ~/.cache/ms-playwright, keyed on the RESOLVED @playwright/test version
     (read it after npm ci via: node -p "require('./node_modules/@playwright/test/package.json').version").
     There are two Chromium install sites; both must hit the cache. Add retention-days: 30 to the
     evidence upload. Add an upload-artifact step to the playwright-fixture job that fires on
     failure with the test-results / trace output — that job currently uploads NOTHING, so a
     CI-only browser failure leaves no diagnostic trail.
B4 - Matrix: node [20, 22, 24] (package.json engines says ">=20" but 22 LTS is untested) and add
     macos-latest with excludes so macOS runs node 24 only and Windows runs 20 and 24. Keep
     fail-fast: false.
B5 - templates/ci/dogfood.yml has drifted badly from the real workflow: it collapses to a single
     "tests" job and NEVER runs the Playwright fixture, despite naming a job "authoritative bundle /
     chromium" and installing Chromium unconditionally. Fix the misleading name, and replace the
     unconditional Chromium install with a clearly commented conditional block explaining it is only
     needed when the consumer's contract uses the playwright-json adapter.
B6 - Confirm the "::notice::" for the empty-baseline case is present in both files (P0 may have
     added it). Nightly schedule runs have no PR/merge base so ALL baseline regression rules
     silently do not apply; this must be visible in the run log.

EXTEND test/workflow.test.mjs to pin the new invariants: every job that installs Chromium also has a
cache step; the evidence upload has retention-days; the matrix includes node 22; prove-it's needs
still covers every job. Keep every action pinned to its existing full commit SHA — do not bump or
unpin anything, and do not add any new third-party action.
Verify: node --test test/workflow.test.mjs
`, { label: 'ci:B3-B6', phase: 'Coverage', agentType: 'qa' }),
])

phase('Verify')
const CLAIMS = [
  { key: 'mutation-codes', lens: 'Is the authoritative mutation boundary still sound after the string->code refactor? Find any consumer still comparing message text. Can a command mutate tracked files and escape detection? Does an initially-dirty repo still correctly avoid marking every command as mutating? Check allowUntracked glob semantics against the codes.' },
  { key: 'redaction-reach', lens: 'Trace EVERY byte written under artifacts/ and name each path that can still contain an unredacted secret: command logs, metadata.json command strings, adapter details, the Playwright report body, evaluation JSON, summary.json/md, junit.xml, contract/policy snapshots. Build a real bundle with a secret in an env var AND in a command string AND in test output, then grep the whole bundle for it.' },
  { key: 'verdict-engine', lens: 'Can a failing acceptance criterion produce a PASS, or a passing one produce a FAIL? Attack score-ac precedence: an excluded criterion bound to a failing command, a judgmental criterion bound to a deterministic oracle, a criterion whose oracle command was never in the run set, severity minor on a deterministic failure. Also check the validateOnly invariant added in A6 cannot itself crash a legitimate validate run.' },
  { key: 'path-safety', lens: 'After the summarizeRepository consolidation and the fsync/mode change, can any absolute host path still leak into the bundle? grep a real bundle for the string of the repo root and for $HOME. Also verify the new default file mode did not make anything world-writable, and that unborn-HEAD support did not weaken the diff comparison for normal repos.' },
  { key: 'regression', lens: 'Did P1 break anything P0 fixed? Re-run the P0 attack scenarios: plant an unrecorded file, plant a .tmp- named file, plant a symlink, fabricate a Playwright stdout report, pass a dash-prefixed --baseline-ref. All must still be caught. Also confirm the tool still verifies its own freshly produced authoritative bundle.' },
]

const verdicts = await parallel(CLAIMS.map((claim) => () => agent(`
You are an adversarial verifier in the repo at ${REPO} (branch dogfood-0.4.0-remediation).
This is a Node ESM CLI evidence gate. Two rounds of fixes (P0, then P1) have just landed.

YOUR JOB IS TO REFUTE, NOT CONFIRM. Assume the fix is broken until you have evidence otherwise.
Default to refuted = true when uncertain. A fix that "looks right" but that you did not actually
execute is NOT confirmed. FALSE POSITIVES (a legitimate case the fix now wrongly rejects) count as
refutation and matter as much as bypasses.

CLAIM UNDER TEST — ${claim.key}:
${claim.lens}

METHOD: read the CURRENT source. Write throwaway probes under
/private/tmp/claude-501/-Users-danillofelanso-projects-proofofworks-thinktank-concepts-testo/67ddd512-2138-42e8-958c-a0459b147b90/scratchpad
and run them. Create temp git repos under $TMPDIR and run the real CLI against them — that is
encouraged. Chromium IS installed so Playwright scenarios are runnable.
You MUST NOT modify any file inside ${REPO}. Read-only there.
`, { label: `refute:${claim.key}`, phase: 'Verify', agentType: 'security', schema: {
  type: 'object',
  additionalProperties: false,
  required: ['claim', 'refuted', 'evidence', 'findings'],
  properties: {
    claim: { type: 'string' },
    refuted: { type: 'boolean' },
    evidence: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'summary', 'reproduction', 'file'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string' },
          reproduction: { type: 'string' },
          file: { type: 'string' },
        },
      },
    },
  },
} })))

log(`refuted ${verdicts.filter(Boolean).filter((v) => v.refuted).length}/${verdicts.filter(Boolean).length}`)

phase('Gate')
const gate = await agent(`${COMMON}
TASK: reconcile, repair and prove P1. You own the whole repo — all other agents are done.
You MAY edit package.json in this phase.

ADVERSARIAL VERIFIER FINDINGS you must address:
${JSON.stringify(verdicts.filter(Boolean), null, 2)}

STEPS:
1. SYNC package.json scripts.test to every test/*.test.mjs that exists on disk, sorted, EXCLUDING
   test/playwright-fixture.mjs and test/helpers.mjs. test/meta.test.mjs verifies this exactly.
   Do NOT bump the version — a later phase owns that.
2. npm test — fix every failure. Distinguish (a) a test asserting old behavior a fix deliberately
   changed -> update the test and SAY SO explicitly, from (b) a genuine regression -> fix the
   source. Never weaken an assertion to get green.
3. Address every blocker and major from the verifiers. Fix minors if cheap; otherwise record them
   precisely. If a verifier is WRONG, say so with concrete evidence — they were told to be maximally
   skeptical and some findings are false alarms.
4. COVERAGE: run \`node --test --experimental-test-coverage test/*.test.mjs\` (excluding
   playwright-fixture). Report the per-file line coverage for src/files.mjs, src/policy.mjs,
   src/score-ac.mjs, src/build.mjs, src/advisory.mjs, src/report.mjs — these were at ZERO direct
   coverage before P1 and must now be meaningfully covered. Report the actual numbers.
5. FULL SCENARIO SWEEP — Chromium IS installed, so run everything:
   a. npm test
   b. npm run test:self
   c. npm run test:playwright-fixture   <- this now actually runs; it exercises a real browser,
      a planted failure, and the tag-binding logic. This is the scenario that has never been
      verified locally in this session.
   d. node bin/dogfood.mjs validate
   e. node bin/dogfood.mjs run --policy .dogfood/dogfood.policy.yaml
   f. read artifacts/dogfood/latest.json, then
      node bin/dogfood.mjs verify artifacts/dogfood/<runId>  -> MUST be VERIFIED
   g. node bin/dogfood.mjs run   (standard profile, no policy) -> confirm the A5 warning appears
   h. node bin/dogfood.mjs validate then node bin/dogfood.mjs report -> confirm report still shows
      the RUN, not the validation (the D3 fix)
   i. cd examples/minimal-broken && node ../../bin/dogfood.mjs validate -> must exit 1
   Report the verdict and exit code of each.
6. Report: files changed, npm test summary line, coverage numbers, the result of every scenario in
   step 5, every verifier finding and its resolution, and anything deferred.

Do not commit. Do not bump versions. Do not write documentation. Do not publish anything.
`, { label: 'gate', phase: 'Gate' })

return { correctness, coverage, verdicts, gate }
