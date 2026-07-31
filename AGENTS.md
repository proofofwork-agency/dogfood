# Dogfood — agent notes

## What this package is

Portable **prove-it** gate for any Proof of Work project after refine/implement.

- CLI: `dogfood validate` | `dogfood run` | `dogfood init`
- Contract: `.dogfood/dogfood.contract.yaml`
- Report: `artifacts/dogfood/<runId>/summary.md`

## Rules for agents

1. **Missing oracle = FAIL** — do not invent silent skips.
2. **No auto-repair** — do not edit product code or tests inside the dogfood run to force green.
3. **On FAIL** → re-implement with the report, or re-refine if the AC is wrong (human/PO).
4. **On INFRA_ERROR** → recover env, re-run dogfood only.
5. **Judgmental ACs** → advisory; soft `/test` is separate.
6. Claude and Codex both run the same CLI; ContextRelay may record the report; Headless council is optional after PASS.

## ContextRelay (optional)

- After run: `record_artifact` with kind `test_report`, path to `summary.md`, status from verdict.
- Do not `propose_final` when verdict is FAIL or INFRA_ERROR.
- Idle scanners: treat “claimed complete without dogfood report” as incomplete.

## Headless (optional)

- Not required for CI.
- Optional: `headless experimental council` on the summary after deterministic PASS.
- Do not make contained credential discovery a dependency of the gate.
