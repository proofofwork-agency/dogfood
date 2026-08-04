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
└── manifest.json
```

The original contract and policy preserve the redacted source bytes. The snapshots are normalized YAML serializations used for cross-checking. Command metadata records timing, status, exit information, truncation, mutation state, repository snapshots, adapter evaluation, and evidence paths.

`summary.json` is the complete machine-readable report. `summary.md` is its human-readable rendering. `matrix.json` contains the acceptance-criterion matrix, and `junit.xml` exposes verdict, criterion, and command cases to CI systems.

## Pointers

`artifacts/dogfood/latest.json` points only to the latest executed `run`. `artifacts/dogfood/latest-validate.json` points to the latest validation-only bundle. They are separate so `dogfood validate` cannot replace the proof consumed by `dogfood report`.

Pointers contain relative paths and follow the run that started most recently, even when concurrent runs finish out of order. `report` warns when the current Git commit differs from the commit recorded by the selected proof.

## Manifest version 3

`manifest.json` records `version`, `checksumAlgorithm`, `runId`, `mode`, `profile`, `verdict`, `validationVerdict`, `proofVerdict`, `contract`, `policy`, `repository`, `runtime`, `package`, `build`, `commands`, `adapters`, `baseline`, `metadata`, `startedAt`, `finishedAt`, `checksums`, and `integrityNotice`.

Every regular bundle file except `manifest.json` is checksummed with SHA-256. Before checksumming, the writer prunes empty directories. It refuses symbolic links, hard links, and other non-regular entries rather than silently omitting them.

## `dogfood verify`

Verification checks the manifest version and checksum algorithm, walks the complete bundle without following symlinks, rejects missing or unrecorded entries, recomputes checksums, and cross-checks the recorded contract, normalized snapshot, policy, report, repository state, verdicts, run identity, and optional build subject. `--subject` additionally requires an external file to match the recorded path, algorithm, size, and digest.

The verifier may warn about a recorded file with an additional hard link because archived bundles can acquire one after creation. A warning does not turn an otherwise internally consistent bundle invalid.

Verification proves internal consistency, not provenance. Manifest v3 is unsigned. An actor able to rewrite the bundle can regenerate the files and manifest together, so preserve bundles in a separately trusted system when provenance matters.
