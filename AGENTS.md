# Dogfood agent contract

Dogfood is a portable evidence gate. The normative operating instructions are in `templates/skill/SKILL.md`; product and format details are in `docs/`.

## Commands

`dogfood help` · `dogfood version` · `dogfood init` · `dogfood validate` · `dogfood run` · `dogfood verify` · `dogfood report` · `dogfood keygen`

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

## Signed bundles

`dogfood verify <bundle>` proves internal consistency only. A signature reported as `unverified` is **not** provenance — the public key inside a manifest is not a trust anchor, because whoever regenerates the manifest can regenerate the key. Only `dogfood verify <bundle> --key <key obtained out of band>` establishes origin. Never report a bundle as trusted on the strength of an unchecked signature.
