# Artifact bundles and verification

Every `validate` and `run` creates a new directory under `artifacts/dogfood/<run-id>/`. A run directory is never overwritten.

## Bundle layout

```text
artifacts/dogfood/<run-id>/
├── contract.original.yaml
├── contract.snapshot.yaml
├── policy.original.yaml       # authoritative only
├── policy.snapshot.yaml       # authoritative only
├── commands/<name>/
│   ├── metadata.json
│   ├── stdout.log
│   └── stderr.log
├── evidence/<adapter>/...
├── evidence/advisory/...      # when --evidence is supplied
├── summary.json
├── summary.md
├── matrix.json
├── junit.xml
├── manifest.json
└── manifest.sig              # signed runs only
```

The original contract and policy preserve the redacted source bytes. The snapshots are normalized YAML serializations used for cross-checking. Command metadata records timing, status, exit information, truncation, mutation state, repository snapshots, adapter evaluation, and evidence paths.

`summary.json` is the complete machine-readable report. `summary.md` is its human-readable rendering. `matrix.json` contains the acceptance-criterion matrix, and `junit.xml` exposes verdict, criterion, and command cases to CI systems.

## Pointers

`artifacts/dogfood/latest.json` points only to the latest executed `run`. `artifacts/dogfood/latest-validate.json` points to the latest validation-only bundle. They are separate so `dogfood validate` cannot replace the proof consumed by `dogfood report`.

Pointers contain relative paths and follow the run that started most recently, even when concurrent runs finish out of order. `report` resolves the selected directory through real paths, verifies the bundle before printing it, rejects pointer metadata that disagrees with `summary.json`, derives its exit code from the verified report, and warns when the current Git commit differs from the commit recorded by the proof.

## Manifest version 1

`manifest.json` records `version`, `checksumAlgorithm`, `runId`, `mode`, `profile`, `verdict`, `validationVerdict`, `proofVerdict`, `contract`, `policy`, `repository`, `runtime`, `package`, `build`, `commands`, `adapters`, `baseline`, `metadata`, `startedAt`, `finishedAt`, `checksums`, optional `signing`, and `integrityNotice`.

Every regular bundle file present when the manifest is written is checksummed with SHA-256 except `manifest.json` itself. A signed run then writes the detached `manifest.sig`; verifier exemptions are limited to those two exact names. Before checksumming, the writer prunes empty directories. It refuses symbolic links, hard links, unreadable entries, and other non-regular entries rather than silently omitting them.

## `dogfood verify`

Verification reads `manifest.json` once and reuses those exact bytes for parsing and detached-signature verification. It checks the manifest version and checksum algorithm, walks the complete bundle without following symlinks, rejects missing or unrecorded entries, recomputes checksums, and cross-checks the recorded contract, normalized snapshot, policy, report, repository state, verdicts, run identity, and optional build subject. `--subject` additionally requires an external file to match the recorded path, algorithm, size, and digest.

The verifier may warn about a recorded file with an additional hard link because archived bundles can acquire one after creation. A warning does not turn an otherwise internally consistent bundle invalid.

An unsigned or signature-unchecked consistent bundle is `INTACT`: exit 0 means the requested integrity check succeeded, not that its origin is trusted. `dogfood verify <bundle> --key <public-key obtained out of band>` checks the detached ed25519 signature and reports `AUTHENTICATED`. A key embedded in `manifest.signing` is descriptive metadata, never a trust anchor. See [Signing](signing.md).

Dogfood redacts its own command logs, metadata, and republished adapter evidence. A contract command can still create arbitrary side files under the run tree; those files are checksummed but are not rewritten or redacted. Treat the contract as trusted code and review bundles before sharing them.
