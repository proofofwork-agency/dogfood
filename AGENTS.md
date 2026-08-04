# Dogfood agent contract

Dogfood is a portable evidence gate. The normative operating instructions are in `templates/skill/SKILL.md`; product and format details are in `docs/`.

## Commands

`dogfood help` · `dogfood version` · `dogfood init` · `dogfood validate` · `dogfood run` · `dogfood verify` · `dogfood report` · `dogfood migrate`

When `.dogfood/dogfood.policy.yaml` exists, pass it explicitly with `--policy`; policies are not auto-discovered. `artifacts/dogfood/latest.json` selects the latest executed proof, while `latest-validate.json` selects validation-only output.

## Exit codes

- 0 — VALID, PASS, or verified bundle
- 1 — INVALID, FAIL, input failure, or invalid bundle
- 2 — INFRA_ERROR
- 3 — invalid CLI usage
- 4 — unexpected internal error

## Hard rules

1. Missing oracle is FAIL; never invent a skip.
2. Do not edit product code or tests during a proof run to force green.
3. On FAIL, use the report in a separate implementation workflow or re-refine only when the criterion is wrong.
4. On INFRA_ERROR, recover the environment and start a fresh complete run.

Judgmental criteria and advisory receipts never change the hard verdict. All deterministic criteria block regardless of severity.
