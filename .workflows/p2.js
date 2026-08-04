export const meta = {
  name: 'dogfood-p2',
  description: 'Dogfood 0.4.0 P2: docs gate, docs/ tree, slim README, root docs',
  phases: [
    { title: 'Gate', detail: 'test/docs.test.mjs built first so prose is written against a live check' },
    { title: 'Reference', detail: 'docs/ tree written in parallel' },
    { title: 'Front', detail: 'README, AGENTS.md, CHANGELOG, CONTRIBUTING, SECURITY' },
    { title: 'Prove', detail: 'every example executed, every claim checked' },
  ],
}

const REPO = '/Users/danillofelanso/projects/proofofworks/thinktank/concepts/testo'

const COMMON = `
Repo: ${REPO} (branch dogfood-0.4.0-remediation, Node v22.13.0, Chromium installed).

"@proofofwork-agency/dogfood" v0.4.0 — a Node >=20 ESM CLI evidence gate being prepared for a
public npm release. A contract (.dogfood/dogfood.contract.yaml) maps acceptance criteria to ORACLES
— an exact shell command, an exact Playwright test tag, or an exact JUnit testcase. "dogfood run"
executes them and emits a tamper-evident bundle under artifacts/dogfood/<runId>/. "dogfood verify"
re-checks it offline. --policy enables an "authoritative" profile.

THE CARDINAL RULE OF THIS PHASE:
Never write a claim you have not verified against the source. This project previously shipped a
README that documented commands the CLI did not have, omitted flags it did have, and contained two
contract examples that FAILED the tool's own schema validation. Read bin/dogfood.mjs for the CLI
surface, schemas/*.json for field vocabularies, and the relevant src/*.mjs for behavior. Cite
nothing from memory. Every fenced bash block should be a command you actually ran.

TRUTHS THAT MUST SURVIVE INTO THE DOCS (this project's credibility rests on stating its own limits):
- A PASS does not mean the software is correct. It means the declared criteria were proven by the
  declared oracles.
- "verify" proves internal consistency, NOT provenance — unless --key is supplied against an
  EXTERNALLY trusted anchor. Bare "verify" on a signed bundle reports present-but-unverified.
- The contract is trusted executable code. Running someone else's contract runs their shell
  commands. There is no sandbox.
- Mutation detection cannot see gitignored files.
- Warnings never affect the verdict.
- Severity is metadata; every deterministic criterion blocks regardless.
- Nightly scheduled CI runs have no baseline, so regression rules do not apply on that event.

STYLE: second person, present tense, active voice. No marketing register — no "simply", "just",
"powerful", "seamless". Tables for reference, prose for concepts, fenced blocks for anything
copy-pasteable. Every example COMPLETE and runnable; a fragment that omits required fields is the
exact defect this project already shipped. Do not duplicate a fact across files — link instead.

RULES: only touch your assigned files. No git commands. No commits. Never run npm publish.
Report: files written, which source file you verified each non-obvious claim against, and anything
you could NOT verify.
`

phase('Gate')
await agent(`${COMMON}
TASK: build the documentation gate BEFORE any prose exists. You own: test/docs.test.mjs (create)

This test is what makes doc drift impossible to reintroduce. It must fail loudly and name the exact
missing item. Write it with node:test + node:assert/strict and the existing "yaml" and "ajv"
dependencies — no new packages.

Checks:
1. CONTRACT EXAMPLES VALIDATE. Scan README.md and every docs/*.md for fenced \`\`\`yaml blocks. Any
   block whose parsed value is an object with a "version" key equal to 2 (or that has both
   "acceptanceCriteria" and "commands") is treated as a full contract and MUST pass
   validateContract() from src/validate.mjs with zero errors. Blocks explicitly marked as fragments
   (the line immediately before the fence contains the word "fragment") are exempt — but report how
   many were exempted so nobody hides a broken example behind the label.
2. POLICY EXAMPLES VALIDATE. Same scan; any block with "profile: authoritative" or version 1 plus a
   "criteria" key must validate against schemas/policy.schema.json via ajv.
3. CLI SURFACE IS FULLY DOCUMENTED. Import or parse bin/dogfood.mjs to extract its command list and
   its option-spec table (read the file — the commands are in one array/table and the options in
   another). EVERY command name and EVERY option flag must appear literally in docs/cli.md. Failure
   message must list exactly which are missing.
4. SCHEMA FIELDS ARE DOCUMENTED. Every property name in schemas/contract.schema.json must appear in
   docs/contract.md; every property name in schemas/policy.schema.json must appear in
   docs/policy.md. Walk the schema recursively including nested "properties" and "items". Allow a
   small explicit ignore-list for generic JSON-schema noise ("type","description","$schema" etc.)
   but keep it tight and declare it in the test.
5. NO DEAD INTERNAL LINKS. Every relative markdown link target in README.md and docs/*.md must
   exist on disk.
6. NO STALE VERSION STRINGS. Grep README.md and docs/*.md for /v0\\.\\d+/ and assert every match
   equals the current major.minor from package.json. This catches "v0.3" left behind after a bump.

The test must PASS on an empty docs/ only if docs/ genuinely has no files yet — i.e. skip checks 3
and 4 with a clear "docs/cli.md not present yet" message rather than failing, so this can land
before the prose. Once the files exist the checks are live. Make that conditional obvious.

Verify: node --test test/docs.test.mjs
`, { label: 'docs-gate', phase: 'Gate', agentType: 'qa' })

phase('Reference')
const reference = await parallel([
  () => agent(`${COMMON}
TASK: docs/cli.md (create). The complete command and flag reference.
Read bin/dogfood.mjs IN FULL first — it is the only source of truth for this file.

Cover EVERY command and EVERY flag from its tables. Historically absent from all documentation and
therefore high priority: --json (the only machine-readable output mode, valid on validate/run/verify),
--contract, --cwd, --force, --timeout-ms, the fact that --evidence is repeatable, the second binary
alias "pow-dogfood" declared in package.json's bin block, the "help" and "version" commands, and any
signing flags added in the previous phase (keygen, --sign, --key) — check what actually exists now.

Also document, each verified against source:
- Exit codes: 0 PASS/VALID, 1 FAIL/INVALID, 2 INFRA_ERROR, 3 CLI usage, 4 unexpected internal.
  Include the paths that yield 1 which the old table omitted: contract not found / unparseable, and
  "report" with no pointer file.
- Contract auto-discovery order — read src/load-contract.mjs and list the candidate paths in order,
  including the .json variants.
- DOGFOOD=1 is injected into every command's environment (src/run-commands.mjs) — a user-visible
  contract that tests can branch on.
- DOGFOOD_DEBUG enables stack traces and temp-sweep diagnostics.
- The stdout/stderr capture cap and what truncation does.
- --timeout-ms is a CEILING applied via Math.min against each command's own timeoutMs, so raising it
  above a command's declared timeout does nothing.
- Which flags are valid on which commands — the option table encodes per-command allowlists.

Format the flag reference as a table: flag | takes value | valid on | what it does.
Verify each command you document by actually running \`node bin/dogfood.mjs <cmd> --help\` or the
command itself.
`, { label: 'docs:cli', phase: 'Reference', agentType: 'documenter' }),

  () => agent(`${COMMON}
TASK: docs/contract.md (create). The contract v2 reference.
Read schemas/contract.schema.json and src/validate.mjs IN FULL first.

Structure: what a contract is -> the five sections (commands, gates, oracles, acceptanceCriteria,
build) -> field-by-field reference -> two complete worked examples -> validation rules and warnings.

EVERY property in the schema must be documented. Historically undocumented and therefore mandatory:
top-level "description"; build.identityCommand (default \`git rev-parse HEAD\`) and build.timeoutMs;
acceptanceCriteria[].text, .reason, .issue; oracles.*.kind: advisory WITH a YAML example; the name
pattern ^[A-Za-z0-9][A-Za-z0-9._-]*$ (ids with spaces or slashes are silently rejected); the tag
pattern ^@dogfood:...$; the timeoutMs maximum; and the junit oracle kind + reportPath if the JUnit
adapter landed (check src/adapters.mjs and the schema).

THE TWO WORKED EXAMPLES ARE THE POINT OF THIS FILE and both must be COMPLETE, VALID DOCUMENTS —
the previous README shipped both as fragments starting at "commands:" with required version/project/
gates missing, so pasting either produced three validation errors:
  A) a functional criterion proven by an exact Playwright tag
  B) a system/architecture criterion proven by an exact command
Validate both with the repo's own validator before you write them down, and say in your report that
you did.

Document the doctrine explicitly:
- a deterministic criterion with no oracle is a FAIL, never a skip
- a deterministic criterion may not use an advisory oracle
- a judgmental criterion must use one
- a Playwright oracle's tag must be exactly @dogfood:<criterion id>
- exit-code proves only that the complete named command exited 0 — it is the weakest oracle and must
  not be used where the claim needs proof of one specific journey
- severity is metadata; all deterministic criteria block

Document the five validation WARNING classes from src/validate.mjs and state plainly that warnings
never affect the verdict.
`, { label: 'docs:contract', phase: 'Reference', agentType: 'documenter' }),

  () => agent(`${COMMON}
TASK: docs/policy.md (create) and docs/artifacts.md (create).
Read schemas/policy.schema.json, src/policy.mjs, src/repository.mjs, src/report.mjs, src/verify.mjs,
src/redact.mjs and src/baseline.mjs first.

=== docs/policy.md ===
The old README gave this 14 lines of prose with NOT ONE FIELD NAME and deflected to "the generated
file is the reference" — a file the reader has to generate first. Every field below currently has
zero documentation and all must be covered with a complete worked YAML example:
  criteria.minimumDeterministic / forbidAllExcluded / requiredGates
  baseline.blockRemovedDeterministic / blockClassDowngrade / blockPlaywrightToCommand /
    blockRemovedRequiredGates
  mutation.scope / mode / allowUntracked
  build.requireSubject
  logs.capture / redactEnv / redactLiterals
  signing.required  (if it exists — check the schema)
Also cover: passing --policy is what selects the authoritative profile (there is no auto-discovery;
a warning fires if the default policy file exists but --policy was omitted); the mutation boundary
and its honest limit (gitignored files are invisible to it); the glob syntax accepted by
allowUntracked and redactEnv; redaction defaults now that it is on by default, the value-length
guard, and the discouraged logs.capture: "full" opt-out; and the caveat that minimumDeterministic
must stay in sync with the contract's actual deterministic count.

=== docs/artifacts.md ===
Bundle layout, every file and what it is for. The manifest version and its full field list. What
"verify" checks, in order, and what each failure message means. latest.json vs latest-validate.json
and WHY they are separate (validate used to overwrite the run pointer, so "report" showed the check
instead of the proof). What verify does NOT prove. The integrity notice the manifest carries.
Read a REAL bundle under artifacts/dogfood/ and describe what is actually there, not what you expect.
`, { label: 'docs:policy+artifacts', phase: 'Reference', agentType: 'documenter' }),

  () => agent(`${COMMON}
TASK: docs/playwright.md, docs/junit.md, docs/advisory.md, docs/signing.md (all create).
Read src/adapters.mjs, src/advisory.mjs, schemas/advisory-receipt.schema.json, and src/sign.mjs
(if it exists) IN FULL first. Check which adapters actually exist before writing.

=== docs/playwright.md ===
The evidence contract. PLAYWRIGHT_JSON_OUTPUT_FILE is set to a FILE PATH, not a directory — the old
README said directory, which was wrong. Show the playwright.config.mjs pattern that honors it. State
the strictness rules exactly: the tag must be present, every matching execution must have exactly
one attempt, the first result must be "passed", expectedStatus must be "passed" — retries, flakes
and skips all FAIL. State that a tag matching NOTHING is a FAIL, and why (a --grep matching nothing
still exits 0). State that stdout is NOT accepted as evidence and that the report path is unlinked
before the command runs, so "a report exists" means this command wrote it.

=== docs/junit.md ===
Only write this if the junit-xml adapter exists — check src/adapters.mjs and the schema first; if it
does not exist, write nothing and say so in your report. If it does: the reportPath contract and why
it is a declared path rather than an injected env var (pytest --junitxml=, Vitest --reporter=junit
--outputFile=, gotestsum --junitfile= are all different, so one env var does not generalize), the
testcase selector semantics (classname + name, exact match), that a selector matching nothing is a
FAIL, that multiple matches must ALL pass, and runnable snippets for pytest, Vitest and Go.

=== docs/advisory.md ===
Receipts, the --evidence flag (repeatable), the receipt schema field by field. State the surprising
rule that a receipt's acId MUST match a declared criterion id or the run fails. Draw the distinction
the old README got wrong: an advisory ASSESSMENT never changes the verdict, but a malformed
--evidence ARGUMENT is a usage failure and does fail the run. Use ONE consistent example path
throughout — the old README used three different ones in three places.

=== docs/signing.md ===
Only if src/sign.mjs exists. This is the most important file to get right in the whole doc set.
Cover: keygen, --sign, --key. The detached manifest.sig design and why a signature cannot live in
the bytes it signs. And THE TRUST MODEL, stated so a reader cannot misread it:
  a public key embedded in the manifest is WORTHLESS on its own, because whoever can regenerate the
  manifest can generate a fresh keypair and re-sign. Only \`verify --key <externally trusted key>\`
  proves provenance. Bare \`verify\` on a signed bundle reports present-but-unverified and does not
  upgrade the verdict.
Say plainly what signing does NOT give you, and note that Sigstore keyless is a future path.
`, { label: 'docs:adapters+signing', phase: 'Reference', agentType: 'documenter' }),

  () => agent(`${COMMON}
TASK: docs/ci.md, docs/agents.md, docs/examples.md (all create).
Read .github/workflows/dogfood.yml, templates/ci/dogfood.yml, action.yml (if it exists),
templates/skill/SKILL.md, and every directory under examples/ first.

=== docs/ci.md ===
GitHub Actions setup as it exists NOW. Branch protection: require the single status check named
"dogfood / prove-it" — and note that a previous version shipped TWO checks with that exact name, one
of which carried fail-on-error:false and could never go red, making the requirement ambiguous; that
job is gone. Fork PR behavior and why no job requests checks:write. The nightly schedule caveat: on
a schedule event there is no PR or merge-queue base, so ALL baseline regression rules silently do
not apply — this must be stated, it is a real weakening of the nightly gate. The
.dogfood/CODEOWNERS.fragment that init writes, which the old README never mentioned despite telling
owners to require code-owner review. If action.yml exists, document its inputs, outputs and a usage
snippet.

=== docs/agents.md ===
Move the Claude Code / Codex integration material out of the README. What init generates
(.claude/skills/dogfood/SKILL.md and .agents/skills/dogfood/SKILL.md), the agent rules (missing
oracle = FAIL; no auto-repair inside the run; on FAIL re-implement or re-refine; on INFRA_ERROR
recover the environment and re-run only; judgmental criteria are advisory), and how to read results
programmatically with --json and the pointer files. Reference
templates/integration/implement-batch-hook.snippet.js — it is the only worked --json example in the
repo and is currently referenced by nothing. State that dogfood requires no agent framework at all.

=== docs/examples.md ===
The README never mentioned ANY example directory, yet all of them ship in the npm tarball. Document
each: what it demonstrates, how to run it, what output to expect. Cover examples/minimal,
examples/minimal-broken (the deliberately invalid fixture that exits 1), examples/playwright, and
any junit/authoritative/advisory examples that now exist. RUN each one and record the real output.
Note honestly that the shipped playwright example needs @playwright/test, which is a devDependency
here, so a consumer must install it themselves.
`, { label: 'docs:ci+agents+examples', phase: 'Reference', agentType: 'documenter' }),
])

phase('Front')
const front = await agent(`${COMMON}
TASK: the front door. You own: README.md (rewrite), AGENTS.md (rewrite), CHANGELOG.md (create),
CONTRIBUTING.md (create), SECURITY.md (create)

The docs/ tree now exists — READ IT FIRST and link to it rather than repeating it.

=== README.md — cut from ~564 lines to ~150 ===
Keep: the mermaid diagram (ONE diagram only — the old file drew the same pipeline three separate
ways), what dogfood is, what a PASS does and does not mean, install, a 5-minute quickstart, a
compact CLI table, and a links section pointing into docs/.
Remove: the ~130 lines of agent and automation prose (now docs/agents.md), the 100-line
"map the real proof" section (now docs/contract.md), the two duplicate ASCII diagrams, and the
repeated claims — the old file said "no repair during the run" five times, "missing oracle = FAIL"
four times, "severity is metadata" three times, and "advisory never changes the verdict" four times.
Add a table of contents. INSTALL INSTRUCTIONS MUST WORK: the package is being prepared for public
npm release, so check package.json for the current private/publishConfig state and write install
steps that match reality — if it is not yet published, say so and give the git-install path.

=== AGENTS.md — cut to ~25 lines ===
This is the first file an agent reads and it is currently the most stale document in the repo: it
lists 3 of the CLI's commands, omits verify/report/migrate and the entire --policy authoritative
mode, never mentions the pointer files, frames the tool as org-specific in a way that contradicts
the README's independence claim, and hard-couples to ContextRelay tooling and a "Headless
experimental council" that appear nowhere in the README or src/. Replace with: the real command
list, the five exit codes, the four hard agent rules, and a pointer to templates/skill/SKILL.md as
the normative agent contract plus docs/ for everything else. Delete every ContextRelay and Headless
reference.

=== CHANGELOG.md ===
Keep a Changelog format. The 0.4.0 entry must be honest and complete, and must state which of the
FOUR independent version numbers moved: package (0.4.0), contract (v2), policy (v1), report/manifest
(check src/report.mjs and src/verify.mjs for the current number). List every behavior change under
Changed/Fixed/Added/Removed, and mark clearly which ones flip a previously-passing run to failing —
read \`git log\` on this branch for the real list rather than inventing one.

=== CONTRIBUTING.md ===
The old README listed three npm scripts and explained none. Cover: repo layout, the node:test
convention and that there is no Jest/Vitest, the NO-NEW-DEPENDENCIES rule (runtime deps are exactly
ajv, ajv-formats, yaml), that \`npx playwright install --with-deps chromium\` is required for the
fixture (only the CI workflow knew this), that package.json's scripts.test enumerates test files
explicitly and test/meta.test.mjs enforces it so a new test file must be registered, that the repo
gates ITSELF with .dogfood/ and how to run that gate, and the caveat that
.dogfood/dogfood.policy.yaml's minimumDeterministic must stay in sync with the contract's actual
deterministic criterion count.

=== SECURITY.md ===
Warranted by the trust model. State: the threat model (the adversary is typically the coding agent
being gated), that contracts are trusted executable code and there is no sandbox, that mutation
detection cannot see gitignored files, what verify does and does not prove, the signing trust model
in one paragraph, what redaction covers and its limits, and a reporting channel (use the repository
issues URL from package.json). Do not overclaim.

Run \`node --test test/docs.test.mjs\` before reporting done and fix anything it flags.
`, { label: 'front-door', phase: 'Front', agentType: 'documenter' })

phase('Prove')
const proof = await parallel([
  () => agent(`
Repo: ${REPO}. You are a skeptical technical editor. Documentation was just written for
"@proofofwork-agency/dogfood", a Node ESM CLI evidence gate being prepared for public release.

YOUR JOB: find every claim in README.md, AGENTS.md and docs/*.md that the code does not support.
Assume the docs are wrong until you have checked each claim against source or by execution.

Method:
- Extract EVERY fenced bash/shell block and RUN it (in a temp directory or temp git repo where it
  would mutate things). Record which fail.
- Extract EVERY fenced yaml block that is presented as a complete contract or policy and validate it
  with the repo's own validator.
- Diff the documented CLI surface against bin/dogfood.mjs's actual command and option tables, in
  BOTH directions: documented-but-absent, and present-but-undocumented.
- Diff documented schema fields against schemas/*.json in both directions.
- Check every relative markdown link resolves.
- Check every stated default value, exit code, file path and env var against source.

You MUST NOT modify any file in ${REPO}. Read-only. Write probes to
/private/tmp/claude-501/-Users-danillofelanso-projects-proofofworks-thinktank-concepts-testo/67ddd512-2138-42e8-958c-a0459b147b90/scratchpad
`, { label: 'verify:claims', phase: 'Prove', schema: {
    type: 'object', additionalProperties: false,
    required: ['refuted', 'evidence', 'findings'],
    properties: {
      refuted: { type: 'boolean' },
      evidence: { type: 'string' },
      findings: { type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'summary', 'file', 'reproduction'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string' },
          file: { type: 'string' },
          reproduction: { type: 'string' },
        } } },
    } } }),

  () => agent(`
Repo: ${REPO}. You are a first-time reader evaluating "@proofofwork-agency/dogfood" — a CLI that
claims to be an evidence gate for AI coding agents. You have never seen it before. You are deciding
whether to adopt it.

Read README.md, then follow the quickstart EXACTLY as written, in a fresh temp directory, running
every command. Then read into docs/ as a real evaluator would.

Judge honestly:
- Can you tell what this does and why it is different within 60 seconds?
- Does the quickstart actually work end to end? Where did you get stuck?
- Are the two genuine differentiators discoverable — binding an acceptance criterion to an EXACT
  test tag (so a grep matching nothing cannot pass), and blocking contract regression against a
  base commit (so the agent cannot weaken the gate)? Or are they buried?
- Is anything overclaimed? This tool's credibility depends on stating its limits, so flag any place
  it promises more than it delivers.
- What is missing that you would need before adopting it?

You MUST NOT modify any file in ${REPO}. Work in a temp directory.
Be blunt. A polite review is useless here.
`, { label: 'verify:newcomer', phase: 'Prove', schema: {
    type: 'object', additionalProperties: false,
    required: ['verdict', 'quickstartWorked', 'findings'],
    properties: {
      verdict: { type: 'string' },
      quickstartWorked: { type: 'boolean' },
      findings: { type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'summary', 'file'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string' },
          file: { type: 'string' },
        } } },
    } } }),
])

phase('Prove')
const gate = await agent(`${COMMON}
TASK: fix everything the reviewers found, then prove the docs. You own the whole repo.

REVIEWER FINDINGS:
${JSON.stringify(proof.filter(Boolean), null, 2)}

STEPS:
1. Fix every blocker and major. For a claim the code does not support, decide deliberately: correct
   the DOC when the code is right, or report it as a code bug when the doc describes intended
   behavior. Never paper over a conflict in prose.
2. Sync package.json scripts.test to every test/*.test.mjs on disk (excluding playwright-fixture and
   helpers). Add "docs/" to files[] if it is not there.
3. node --test test/docs.test.mjs -> must pass
4. npm test -> must be fully green
5. node scripts/check-package-contents.mjs -> must now PASS (docs/ exists at last)
6. Re-run every fenced bash block in README.md and confirm each works.
7. Report: files changed, the npm test summary line, the docs-test result, the package-contents
   result, and every finding with its resolution.

Do not commit. Do not publish. Do not push.
`, { label: 'docs-gate', phase: 'Prove' })

return { reference, front, proof, gate }
