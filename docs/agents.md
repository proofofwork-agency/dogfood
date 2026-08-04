# Agent operation

## Which harnesses are supported

All of them, and none of them specially.

Dogfood is a plain CLI. It reads a contract, runs commands, writes files, and exits with a status code. There is no plugin API, no daemon, no SDK, and no vendor integration to install. Grep the runtime and the only harness-specific string in `src/` and `bin/` is one line in `dogfood init` choosing where to copy a Markdown file.

So anything able to run a command and read its exit code already works:

| Harness | How it integrates | Shipped for it |
|---|---|---|
| Claude Code | Runs the CLI; `init` installs a skill at `.claude/skills/dogfood/SKILL.md` | A skill file |
| Codex | Runs the CLI; `init` installs the same skill at `.agents/skills/dogfood/SKILL.md` | A skill file |
| Cursor, Aider, Copilot, Devin, Windsurf, others | Run the CLI; point the agent at `.agents/skills/dogfood/SKILL.md`, or paste its contents into your rules file | Nothing, and nothing is needed |
| Plain CI | Run the CLI, gate on the exit code | A composite Action and a workflow template |
| A human at a terminal | Run the CLI | — |

The two skill files `init` writes are **byte-identical copies of one template**. `.claude/skills/` is Claude Code's convention; `.agents/skills/` is the vendor-neutral one other tools are converging on. If your harness reads neither, it is still plain Markdown — put it where your tool looks, or paste it into your system prompt.

:::tip Nothing about the verdict depends on the agent
A human, a CI job, Claude Code, and Codex run the same binary against the same contract and get the same hard verdict. The gate cannot be talked into a different answer, because there is nothing to talk to.
:::

## The integration surface

Three things, all stable.

**Exit codes.**

| Code | Meaning |
|---|---|
| `0` | `PASS` or `VALID`, or a verified bundle |
| `1` | `FAIL`, `INVALID`, bad input, or an invalid bundle |
| `2` | `INFRA_ERROR` — the environment broke, not the product |
| `3` | Invalid CLI usage |
| `4` | Unexpected internal error |

**`--json`** on `validate`, `run`, and `verify`. The [workflow integration snippet](https://github.com/proofofwork-agency/dogfood/blob/main/templates/integration/implement-batch-hook.snippet.js) shows parsing `dogfood run --json` while preserving exit-code semantics.

**Pointer files.** `artifacts/dogfood/latest.json` selects the latest executed proof. `artifacts/dogfood/latest-validate.json` selects validation-only output and must not be treated as evidence that any command ran.

Every command dogfood executes also receives `DOGFOOD=1` in its environment, so a test can branch on being run under the gate.

## Required agent behavior

The skill template encodes these, and they are identical for every harness.

1. Validate with the explicit policy when `.dogfood/dogfood.policy.yaml` exists — policies are never auto-discovered.
2. Run only after validation is valid.
3. Read `artifacts/dogfood/latest.json` and its `summary.md`.
4. On `PASS`, verify the referenced bundle.
5. Report the acceptance matrix, failed commands, verdict, and bundle path.

A missing oracle is a failure, never a skip. **Do not repair product code or tests during a proof run** — that is the behavior the gate exists to catch, and mutation detection fails the run regardless. On `FAIL`, leave the bundle intact and re-implement in a separate workflow, or ask the product owner to re-refine a criterion that was wrong. On `INFRA_ERROR`, recover the environment and start a fresh complete run. Judgmental criteria and advisory receipts never override deterministic evidence.

The normative source is [the shipped skill template](https://github.com/proofofwork-agency/dogfood/blob/main/templates/skill/SKILL.md). Start a new agent session if a newly installed skill is not discovered immediately.

## Why there is no plugin API

A gate an agent can configure is a gate the agent can weaken. Keeping the integration surface to exit codes and files means the only way to change the verdict is to change the contract — and `--baseline-ref` refuses contract changes that remove criteria, downgrade their class, or trade a tagged test for an exit code.
