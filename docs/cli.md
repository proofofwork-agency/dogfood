# CLI reference

The package exposes the same executable as `dogfood` and `pow-dogfood`. Examples below use `dogfood`.

## Commands

| Command | Behavior |
|---|---|
| `help` | Prints usage, commands, flags, and exit codes. `--help` and `-h` also select this command. |
| `version` | Prints the version from `package.json`. `--version` also selects it. |
| `init` | Writes the starter contract, CI and CODEOWNERS fragments, and Claude/Codex skills. `--authoritative` also writes a policy. Existing files are preserved unless `--force` is supplied. |
| `validate` | Validates the contract, explicit policy, baseline, and oracle mappings. It writes a validate bundle but runs no proof commands. |
| `run` | Executes a fresh proof and writes the run bundle plus `latest.json`. |
| `verify` | Verifies one existing bundle. It does not execute the contract. |
| `report` | Prints the `summary.md` selected by `latest.json` and returns the recorded verdict's exit code. |
| `migrate` | Converts a version 1 contract to version 2. Without `--write`, YAML is printed; with it, the source is replaced after a timestamped backup is created. |
| `keygen` | Writes an ed25519 signing pair into `--out`. The private key is created mode `0600`. Existing keys are preserved unless `--force` is supplied. |

## Options

| Flag | Takes value | Valid on | Behavior |
|---|---:|---|---|
| `--cwd` | yes | `init`, `validate`, `run`, `report`, `migrate` | Resolves all project-relative inputs from this directory. |
| `--contract` | yes | `validate`, `run`, `migrate` | Uses this YAML, YML, or JSON contract instead of discovery. |
| `--policy` | yes | `validate`, `run` | Loads an authoritative policy. Policies are never auto-discovered. |
| `--baseline-ref` | yes | `validate`, `run` | Compares the contract with the resolved Git commit. Requires a valid `--policy`; values beginning with `-` are rejected. |
| `--subject` | yes | `verify` | Requires the supplied file to match the subject recorded in the manifest. |
| `--json` | no | `validate`, `run`, `verify` | Prints the machine-readable result. |
| `--force` | no | `init` | Allows generated files to overwrite existing destinations. |
| `--authoritative` | no | `init` | Installs `.dogfood/dogfood.policy.yaml` in addition to the standard files. |
| `--write` | no | `migrate` | Replaces the v1 contract after writing a backup. |
| `--timeout-ms` | yes | `run` | Applies a 1–3,600,000 ms ceiling to every command. The effective timeout is `Math.min` of this value and the command's declared `timeoutMs`. |
| `--evidence` | yes | `run` | Adds one advisory receipt. The flag is repeatable. |
| `--sign` | yes | `run` | Signs the manifest with this ed25519 private key and writes a detached `manifest.sig`. |
| `--key` | yes | `verify` | Checks the detached signature against this public key. **Only this establishes provenance** — see [signing](signing.md). |
| `--out` | yes | `keygen` | Directory to write `dogfood-signing-key` and `dogfood-signing-key.pub` into. |

Each non-repeatable option may appear once. `dogfood verify` also requires the positional `<bundle-dir>`.

## Contract discovery

Without `--contract`, the first existing path in this order is used:

1. `.dogfood/dogfood.contract.yaml`
2. `.dogfood/dogfood.contract.yml`
3. `.dogfood/dogfood.contract.json`
4. `dogfood.contract.yaml`
5. `dogfood.contract.yml`
6. `dogfood.contract.json`

A missing, unreadable, or unparseable contract is an ordinary input failure and exits 1.

## Runtime environment and capture

Every declared command receives `DOGFOOD=1`. Tests can use it to distinguish an evidence-gate invocation from a developer run.

Set `DOGFOOD_DEBUG` to include unexpected stack traces and temp-file sweep diagnostics. It does not change the verdict.

Standard output and error are captured independently. Each stream keeps at most the final 5 MiB; when older bytes are dropped, the command metadata marks the stream as truncated and preserves valid UTF-8 at the retained boundary.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | `VALID`, `PASS`, or a verified bundle. |
| 1 | `INVALID`, `FAIL`, bundle verification failure, contract input failure, migration failure, or `report` with no usable run pointer. |
| 2 | `INFRA_ERROR`, including a bundle writer integrity refusal. |
| 3 | Invalid CLI usage. |
| 4 | Unexpected internal runner error. |

Machine-readable examples:

```bash
dogfood validate --json
dogfood run --policy .dogfood/dogfood.policy.yaml --json
dogfood verify artifacts/dogfood/<run-id> --json
```

