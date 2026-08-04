# Agent operation

Dogfood requires no agent framework. A human, CI job, Claude Code, or Codex runs the same CLI and receives the same hard verdict.

`dogfood init` installs equivalent project skills at:

- `.claude/skills/dogfood/SKILL.md`
- `.agents/skills/dogfood/SKILL.md`

The normative source is [the shipped skill template](../templates/skill/SKILL.md). Start a new agent session if a newly installed skill is not discovered immediately.

## Required behavior

1. Validate with the explicit policy when `.dogfood/dogfood.policy.yaml` exists.
2. Run only after validation is valid.
3. Read `artifacts/dogfood/latest.json` and its `summary.md`.
4. On PASS, verify the referenced bundle.
5. Report the acceptance matrix, failed commands, verdict, and bundle path.

Missing oracle means failure. Do not repair product code or tests during a proof run. On FAIL, leave the bundle intact and re-implement in a separate workflow, or ask the product owner to re-refine a wrong criterion. On INFRA_ERROR, recover the environment and start a fresh complete run. Judgmental criteria and advisory receipts never override deterministic evidence.

## Machine-readable integration

Use `--json` on `validate`, `run`, or `verify`. The [workflow integration snippet](../templates/integration/implement-batch-hook.snippet.js) demonstrates parsing `dogfood run --json` and preserving exit-code semantics.

`latest.json` selects executed proof. `latest-validate.json` selects validation-only output and must not be treated as evidence that commands ran.

