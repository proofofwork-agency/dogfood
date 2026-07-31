# @proofofwork-agency/dogfood

Dogfood is a final verification checkpoint that you add after implementation:

```mermaid
flowchart TB
    A[Plan] --> B[Implement the work]
    B --> C[Ready for verification]
    C --> D[Run the Dogfood CLI]

    H[Human or CI] --> D
    CL[Claude Code: /dogfood] --> D
    CO[Codex: $dogfood] --> D

    D --> E[Architecture checks]
    D --> F[Tests, build, and types]
    D --> G[Playwright journeys]
    E --> V{Verdict}
    F --> V
    G --> V

    V -->|PASS| P[Complete work and save evidence]
    V -->|FAIL| X[Fix the work]
    V -->|INFRA_ERROR| Y[Fix the environment]
    X --> D
    Y --> D
```

Claude Code invokes `/dogfood`; Codex invokes `$dogfood`. Both validate the contract, run the same independent Dogfood CLI, read the generated report, and return the same PASS, FAIL, or INFRA_ERROR verdict to the workflow.

You configure the checks that matter to your project: architecture rules, unit or integration tests, builds, type checks, security checks, and exact Playwright user journeys. Dogfood runs those checks, connects their results to your acceptance criteria, and blocks the workflow when the required proof is missing or failing. It also produces a report showing exactly what passed and failed.

Dogfood does not invent your architecture rules or automatically decide what “correct architecture” means. You provide the architecture command—for example dependency-boundary tests, lint rules, or a custom architecture script—and Dogfood makes that command a required, recorded part of completion.

You can run Dogfood manually, from CI, at the end of an implementation workflow, or through Claude Code or Codex. All four use the same independent CLI and receive the same verdict.

## What Dogfood does

Dogfood sits above the verification tools a project already has. It does not replace unit tests, architecture checks, build scripts, or Playwright; it runs them under an explicit proof contract and records what they actually establish.

The core contract concepts are:

| Concept | Purpose |
|---|---|
| `commands` | Trusted shell commands that perform verification. |
| `gates` | Explicit must-run command groups. A gated command can fail the project even when it is not mapped to one acceptance criterion. |
| `oracles` | The evidence source for an acceptance criterion: a complete command, an exact Playwright tag, or an advisory review. |
| `acceptanceCriteria` | The claims being evaluated and the oracle assigned to each claim. |
| adapters | The code that interprets command evidence. V2 includes `exit-code` and `playwright-json`. |

The proof flow is:

```text
acceptance criteria -> declared oracles -> commands -> evidence adapters
                                                        |
                                                        v
                                    AC matrix + PASS/FAIL + artifact bundle
```

When you run `dogfood run`, Dogfood:

1. Loads and validates `.dogfood/dogfood.contract.yaml`. Missing or broken oracle mappings fail before proof execution.
2. Captures the Git commit and initial tracked repository state.
3. Runs each required command once, with its configured timeout and without automatic retries or repair.
4. Evaluates the evidence. An `exit-code` adapter proves only that the complete named command passed. A `playwright-json` adapter proves the exact configured `@dogfood:AC-ID` tests ran and passed on their first attempt.
5. Compares tracked repository state before and after verification. A command that changes tracked files fails the run.
6. Scores every acceptance criterion and classifies the overall result as `PASS`, `FAIL`, or `INFRA_ERROR`.
7. Writes a portable evidence bundle containing the contract snapshot, command logs, adapter evidence, AC matrix, JUnit, checksums, environment metadata, and human-readable summary.

Dogfood is not a test framework, code generator, or repair agent. It orchestrates evidence produced by tools you already use and never edits product code to make a run pass. It also does not require Claude, Codex, ContextRelay, or any other agent: a human, CI job, Claude, or Codex all run the same CLI. Agent or human browser reviews can be attached as advisory receipts, but they never replace deterministic proof or change the hard verdict.

### What a PASS means

A `PASS` means the contract was valid, every required project command passed, every deterministic acceptance criterion received its configured evidence, required exact Playwright tags passed without retry, the required build identity was available, and no tracked mutation was detected inside the configured workspace.

A `PASS` does **not** mean that:

- Dogfood proved requirements that were never declared in the contract;
- a judgmental usability or design review was satisfied;
- untracked cache or screenshot files were absent;
- tracked files outside the configured `--cwd` scope were unchanged; or
- `minor` deterministic criteria were ignored. All deterministic severities block in v2.

## Quick start

### 1. Install an exact revision

The package is intentionally private and unpublished on npm while v2 is validated. Install an exact public Git revision:

```bash
npm install --save-dev github:proofofwork-agency/dogfood#<full-commit-sha>
npx dogfood version
```

For local development, `npm install --save-dev /absolute/path/to/dogfood` also works. `private: true` prevents accidental npm publication; it does not prevent local-path or Git dependency installation.

### 2. Initialize the project

Run this from the Git repository or package directory you want Dogfood to verify:

```bash
npx dogfood init
```

Initialization creates:

```text
.dogfood/dogfood.contract.yaml               # intentionally incomplete proof contract
.dogfood/README.md                            # local setup reminder
.dogfood/gitignore.fragment                   # artifact ignore rule to merge
.dogfood/github-workflow.dogfood.yml          # optional GitHub Actions example
.claude/skills/dogfood/SKILL.md               # Claude Code project skill
.agents/skills/dogfood/SKILL.md               # Codex project skill
artifacts/dogfood/                             # evidence output root
```

The generated contract is intentionally unable to pass. This prevents a newly initialized project from reporting success before its real commands and acceptance criteria have been mapped. Existing agent skill files are preserved unless you explicitly use `--force`.

Merge the contents of `.dogfood/gitignore.fragment` into the project's `.gitignore` so generated evidence does not pollute normal commits.

### 3. Map the real proof

Edit `.dogfood/dogfood.contract.yaml` and replace the placeholder with the project's actual verification commands. For every in-scope deterministic criterion:

1. Give the criterion a stable ID such as `AC-checkout`.
2. Declare the command that produces its evidence.
3. Select `exit-code` for a complete generic command or `playwright-json` for exact browser-test evidence.
4. Declare an oracle that references the command.
5. Point the acceptance criterion at that oracle.
6. For Playwright, tag the test with the exact corresponding tag, for example `@dogfood:AC-checkout`.

Do not map a broad browser command through `exit-code` when the claim requires proof of one specific user journey. A successful Playwright process is not proof that the expected tagged test existed or ran.

### 4. Validate, run, and read the report

```bash
npx dogfood validate
npx dogfood run
npx dogfood report
```

`validate` checks schema and mappings only. It reports deterministic criteria as not run and never pretends the commands executed. `run` executes the complete proof and returns a process exit code suitable for CI. `report` prints the latest Markdown summary.

The machine-readable pointer is `artifacts/dogfood/latest.json`; it points to the latest run directory using relative paths.

## Use Dogfood with Claude Code and Codex

Claude and Codex are **operators of the same independent CLI**, not alternative evidence engines. The generated skills teach each agent when to validate, when to run, where to read the result, and what it must not do during verification.

The skills are optional convenience and policy layers:

- Dogfood still works if neither agent is installed.
- Claude and Codex execute the same `dogfood` binary and receive the same verdict.
- The skills do not grant a PASS, weaken a criterion, retry flaky evidence, or repair code during a proof run.
- After `dogfood init`, start a new agent session if the newly created skill does not appear immediately.

### Claude Code

Dogfood installs a project skill at `.claude/skills/dogfood/SKILL.md`. Claude Code discovers project skills from `.claude/skills`; the directory name makes this skill available as `/dogfood`. See the official [Claude Code skills documentation](https://code.claude.com/docs/en/slash-commands).

Start Claude Code from the project repository, then invoke the skill explicitly:

```text
/dogfood Run the deterministic acceptance gate for the current implementation. Do not repair anything during the run. Report the verdict, failing ACs, and evidence path.
```

You can also ask naturally because the skill description allows automatic matching:

```text
Run Dogfood before we call this work complete. If the contract is invalid, stop and explain the missing mappings. If it runs, summarize the acceptance matrix and link the report.
```

### Codex

Dogfood installs the equivalent project skill at `.agents/skills/dogfood/SKILL.md`. Codex discovers repository skills from `.agents/skills` and supports explicit `$skill-name` invocation. See the official [Codex skills documentation](https://learn.chatgpt.com/docs/build-skills).

Start Codex from the project repository, then invoke:

```text
$dogfood Run the deterministic acceptance gate for the current implementation. Do not change product code or tests during verification. Report the verdict, failing ACs, and evidence path.
```

The same workflow can be requested in plain language:

```text
Use the Dogfood evidence gate now. Validate first, run only when mappings are valid, then read artifacts/dogfood/latest.json and summarize what was actually proved.
```

### What the agent should do with each result

Whether Claude or Codex runs the gate, the expected workflow is the same:

| Result | Agent behavior |
|---|---|
| Contract validation failure | Stop. Report the invalid or missing mapping. Do not claim tests ran. |
| `PASS` | Report the deterministic AC matrix and preserve/link the evidence directory for the candidate commit. |
| `FAIL` | Report the failed commands and criteria. Fix the product or refine an incorrect criterion in a separate workflow, then start a fresh complete Dogfood run. |
| `INFRA_ERROR` | Recover the environment without changing the proof contract, then start a fresh complete run. |

The no-repair rule applies **during** the proof run. After a `FAIL`, an agent may use the report to implement a fix in a separate step; it must then rerun the whole gate rather than reusing partial evidence.

### Advisory browser reviews from an agent

Claude, Codex, another browser agent, or a human may perform a qualitative review and write an advisory receipt. Dogfood does not launch that review automatically. The reviewer must save the receipt and referenced artifacts inside the project workspace, after which the receipt can be attached:

```bash
npx dogfood run --evidence reviews/AC-usability.receipt.json
```

This is useful for usability, visual quality, or clarity observations that are not deterministic. An advisory `satisfied` assessment is visible in the report but cannot make a failed hard gate pass. A `concern` assessment is also visible but does not change a deterministic PASS into FAIL.

### Use without generated skills

An agent does not need the generated skill if you provide the operating instructions directly. The minimum safe prompt is:

```text
Run `npx dogfood validate`. If it passes, run `npx dogfood run`. Do not edit code or tests during the run. Read `artifacts/dogfood/latest.json` and its summary, then report PASS, FAIL, or INFRA_ERROR with the failing criteria and evidence path.
```

This is functionally the same CLI workflow; the checked-in skills simply make the policy reusable across sessions and team members.

## Requirements

- Node.js 20 or newer
- Git for repository identity and tracked-mutation protection
- Playwright only when a contract uses the `playwright-json` adapter

## CLI

```bash
dogfood init
dogfood validate
dogfood run
dogfood run --evidence reviews/usability.json
dogfood migrate                 # print converted v2 YAML
dogfood migrate --write         # back up and replace a v1 contract
dogfood report
```

Exit codes are stable:

| Code | Meaning |
|---:|---|
| 0 | PASS |
| 1 | FAIL: invalid contract, failed proof, missing evidence, or mutation |
| 2 | INFRA_ERROR |
| 3 | Invalid CLI usage |
| 4 | Unexpected runner error |

## Contract v2

```yaml
version: 2
project: example-project

build:
  requireIdentity: true

commands:
  architecture:
    run: npm run test:architecture
    timeoutMs: 120000
    adapter: exit-code
  browser:
    run: npx playwright test --reporter=json
    timeoutMs: 600000
    adapter: playwright-json

gates:
  architecture: [architecture]
  browser: [browser]

oracles:
  architecture-boundaries:
    kind: command
    command: architecture
  checkout-completes:
    kind: playwright
    command: browser
    tag: "@dogfood:AC-checkout"

acceptanceCriteria:
  - id: AC-architecture
    class: deterministic
    oracle: architecture-boundaries
    severity: major
  - id: AC-checkout
    class: deterministic
    oracle: checkout-completes
    severity: blocker
```

Unknown fields, duplicate criterion IDs, unsupported kinds, broken references, invalid severities, missing oracles, and excluded criteria without reasons all fail validation. `validate` reports deterministic criteria as `not-run`; it never pretends tests executed.

Severity is classification metadata in v2. Every deterministic criterion fails closed regardless of whether its severity is `blocker`, `major`, or `minor`. Judgmental criteria must use an `advisory` oracle and never affect the hard verdict.

`gates` are explicit must-run command sets, not the only source of execution. Commands referenced by deterministic oracles run even when `gates` is empty. Conversely, a gated command without an AC mapping remains a hard project-level check; validation warns about both shapes.

An `exit-code` adapter proves only that its complete named command exited successfully.

### Playwright evidence contract

A `playwright-json` command must enable Playwright's JSON reporter. Dogfood sets `PLAYWRIGHT_JSON_OUTPUT_FILE` to the run's evidence directory, so the recommended command is:

```yaml
run: npx playwright test --reporter=json
adapter: playwright-json
```

Or pin it in `playwright.config`:

```js
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE }]],
});
```

The report file is authoritative. If it is absent, Dogfood accepts captured stdout only when the entire stdout value is a structurally valid standalone Playwright JSON report, then persists that report into the evidence directory. Mixed reporter/log output is rejected with configuration guidance.

The adapter requires the configured exact `@dogfood:AC-ID` tag and rejects missing, skipped, interrupted, failed, expected-failure, retry-passed, or flaky executions. It uses Playwright's supported [test tags](https://playwright.dev/docs/api/class-test) and [JSON reporter](https://playwright.dev/docs/test-reporters).

## Advisory browser evidence

Advisory receipts are copied into the run but never satisfy deterministic criteria or change the hard verdict:

```json
{
  "version": 1,
  "acId": "AC-usability",
  "actor": "reviewer identity",
  "driver": "browser-review",
  "assessment": "satisfied",
  "summary": "The critical interaction was clear.",
  "artifacts": ["reviews/usability.png"]
}
```

Receipt and artifact paths must resolve inside the project workspace. Assessments are `satisfied`, `concern`, or `inconclusive`.

## Artifacts

```text
artifacts/dogfood/<run-id>/
  summary.json
  summary.md
  matrix.json
  junit.xml
  manifest.json
  contract.snapshot.yaml
  commands/<name>/metadata.json
  commands/<name>/stdout.log
  commands/<name>/stderr.log
  evidence/<adapter>/*
artifacts/dogfood/latest.json
```

The manifest includes SHA-256 checksums, contract digest, Git HEAD and dirty-state digest, runtime and package versions, command definitions, timestamps, and adapter versions. `latest.json` contains only relative pointers.

Dogfood has no retries and no repair loop. Infrastructure trouble blocks affected criteria and yields `INFRA_ERROR` only when every blocking problem is infrastructure-related; mixed product and infrastructure problems yield `FAIL`.

## Trust and mutation boundary

The contract is trusted executable project code. Commands run through the system shell so projects can use ordinary shell syntax; do not run contracts obtained from an untrusted source.

Mutation enforcement compares Git HEAD and a streamed SHA-256 digest of `git diff HEAD -- .` before and after each command. It covers tracked files inside the configured `--cwd` workspace. Untracked writes and tracked sibling paths outside `--cwd` are recorded in repository metadata where visible, but do not fail the run. This boundary intentionally permits test caches and generated evidence; projects requiring a pollution-free workspace should run Dogfood in a clean disposable checkout.

`--timeout-ms` is a global hard ceiling: each command uses the smaller of this value and its contract `timeoutMs`.

The CLI is the supported public interface in v2. Direct imports from `src/` are internal and may change before publication.

## Development

From the package root:

```bash
npm test
npm run test:playwright-fixture
npm run test:self
```

The neutral Playwright fixture includes a genuine pass and a planted product failure. The GitHub Actions example in `templates/ci/dogfood.yml` uses the stable `dogfood / prove-it` check, supports merge queues, publishes JUnit, and uploads evidence unconditionally.
