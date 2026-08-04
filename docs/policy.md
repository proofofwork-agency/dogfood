# Authoritative policy version 1

Passing `--policy` selects the authoritative profile. Dogfood never auto-discovers a policy because silently enabling one could change a verdict. If `.dogfood/dogfood.policy.yaml` exists and you omit `--policy`, the run stays standard and records a warning.

## Complete policy

```yaml
version: 1
profile: authoritative

criteria:
  minimumDeterministic: 1
  forbidAllExcluded: true
  requiredGates: [verification]

baseline:
  blockRemovedDeterministic: true
  blockClassDowngrade: true
  blockPlaywrightToCommand: true
  blockRemovedRequiredGates: true

mutation:
  scope: git-root
  mode: git-visible
  allowUntracked:
    - artifacts/dogfood/**
    - test-results/**
    - playwright-report/**

build:
  requireSubject: false

logs:
  capture: full-redacted
  redactEnv:
    - GITHUB_TOKEN
    - AWS_ACCESS_KEY_ID
    - "*_TOKEN"
    - "*_SECRET"
    - "*_PASSWORD"
    - "*_KEY"
    - "*_KEY_ID"
    - "*_CREDENTIAL*"
    - "*_CONNECTION_STRING"
    - CONNECTION_STRING
    - "*_DSN"
    - DATABASE_URL
    - "*_URL"
    - "*_AUTH"
    - "*_COOKIE"
  redactLiterals: []
```

Unknown fields are rejected.

## Criteria rules

| Field | Effect |
|---|---|
| `criteria.minimumDeterministic` | Requires at least this many deterministic criteria. Keep it synchronized with the contract when criteria are added or removed. |
| `criteria.forbidAllExcluded` | Refuses a non-empty contract whose criteria are all excluded. |
| `criteria.requiredGates` | Requires each named gate to exist and contain at least one command. |

## Baseline regression rules

Baseline rules apply only when `--baseline-ref <git-ref>` is supplied with the policy.

| Field | Blocked change |
|---|---|
| `baseline.blockRemovedDeterministic` | Removing a deterministic criterion. |
| `baseline.blockClassDowngrade` | Changing a deterministic criterion to another class. |
| `baseline.blockPlaywrightToCommand` | Replacing exact Playwright evidence with a generic command oracle. |
| `baseline.blockRemovedRequiredGates` | Removing or emptying a gate named by `criteria.requiredGates`. |

The ref is first resolved to a commit object ID; only that object ID is used to read the baseline contract. If the contract is absent at the baseline, Dogfood records first adoption as a warning.

`baseline.compared` reports whether a comparison actually happened, and `baseline.notComparedReason` says why not:

| Reason | Effect | Why |
|---|---|---|
| `baseline-absent` | Warning | First adoption; no contract existed at **any** discovery path in the baseline commit. |
| `baseline-invalid` | Warning | The baseline contract does not validate under the current schema, so the two are not in the same format and a field-by-field comparison would be meaningless. Blocking here would make it impossible to ever change the contract format: the commit introducing the change could never go green. |
| `baseline-unparseable` | **Blocks** | A baseline that is not even parseable is not explained by any format change; it means a broken contract was committed. |

**Moving the contract does not skip the check.** If the contract is missing at its current path, Dogfood looks for it at every other discovery path in the baseline commit before concluding first adoption. A move is compared against its previous location and recorded as a `contract-moved` change with `reviewRequired`, so renaming the contract cannot launder a removed criterion past the gate.

A skipped comparison is never silent — it is stated in `validation.warnings`. It also cannot be used to slip a regression through: the baseline is a past commit and is immutable, so the only way it stops validating is a schema change in the same change set, which is reviewable code. The head contract is still fully validated, and `criteria.minimumDeterministic` and `criteria.requiredGates` still apply.

## Mutation boundary

`mutation.scope` is `git-root` and `mutation.mode` is `git-visible`. Authoritative runs inspect tracked state across the whole repository and non-ignored untracked files before and after commands. The run fails if it starts with tracked changes, if tracked state changes, or if an untracked path outside `allowUntracked` is present or changes.

`mutation.allowUntracked` uses Git-like portable globs: `*` matches within one path segment, `**` crosses directories, and `?` matches one non-separator character.

Git-ignored files are invisible to this check. The report records `ignoredFilesCovered: false`; this normally includes Dogfood's own `artifacts/dogfood/` evidence tree. Mutation enforcement compares before/after snapshots, so an edit reverted byte-for-byte before the after-snapshot is also outside the guarantee. Do not claim that authoritative mutation detection observes intermediate writes, caches, or other ignored output.

## Build subject

`build.requireSubject` requires the contract to declare `build.subject`. The run records its path, `sha256` digest, and size; `dogfood verify --subject <file>` can require a candidate file to match.

## Logs and redaction

| Field | Behavior |
|---|---|
| `logs.capture` | `full-redacted` keeps redacted log bodies; `metadata-only` writes empty bodies; `full` disables redaction and is a discouraged opt-out. |
| `logs.redactEnv` | Wildcard patterns selecting environment-variable names whose values are masked. |
| `logs.redactLiterals` | Exact strings masked in logs and published contract-derived documents. |

Standard runs use the same `full-redacted` defaults shown above even without a policy. Matching environment values that are too short, boolean-like, or small numeric strings are not replaced because they would corrupt unrelated log text. Do not put secrets on command lines and assume an undeclared value will be found: redaction is a containment layer, not a secret-management system.
