# Advisory evidence

Judgmental criteria use `kind: advisory`. An advisory assessment is recorded beside the deterministic proof and never changes the hard verdict.

Pass receipts to `dogfood run` with the repeatable `--evidence` flag:

```bash
dogfood run --evidence evidence/usability-review.json
```

The path must resolve to a readable JSON file inside the project workspace. Any artifact paths named by the receipt must also resolve to regular files inside that workspace.

## Receipt version 1

```json
{
  "version": 1,
  "acId": "AC-usability",
  "actor": "reviewer@example.test",
  "driver": "manual-browser-review",
  "assessment": "concern",
  "summary": "The confirmation state is understandable, but the recovery link is hard to find.",
  "artifacts": ["evidence/checkout-review.png"]
}
```

| Field | Rule |
|---|---|
| `version` | Must be 1. |
| `acId` | Must match an acceptance criterion declared in the current contract. |
| `actor` | Non-empty reviewer identity. |
| `driver` | Non-empty description of the review mechanism. |
| `assessment` | `satisfied`, `concern`, or `inconclusive`. |
| `summary` | Non-empty human-readable result. |
| `artifacts` | Array of workspace-relative file paths to copy into the bundle. |

A malformed, unreadable, escaping, or unknown-`acId` receipt is a rejected CLI input and fails the run. That is different from a valid receipt whose assessment is `concern`: the assessment remains advisory and does not flip PASS to FAIL.

Validation mode accepts no `--evidence` flag and never collects receipts because it executes no proof.

