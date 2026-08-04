# Signing

Signing binds a bundle to a key you control. It is optional; unsigned bundles can still prove checksum integrity as `INTACT`.

## The trust model — read this first

**A public key recorded inside a manifest is not a trust anchor.** Whoever can regenerate the manifest can also generate a fresh keypair and re-sign it. A self-described key proves only that the bundle is internally consistent, which the checksums already prove.

So exactly one thing establishes provenance:

```bash
dogfood verify <bundle> --key <public key you obtained out of band>
```

Everything else is weaker, and dogfood says so rather than implying otherwise:

| Command | Verdict | `signatureStatus` | What it means |
|---|---|---|---|
| `verify <bundle>` on an unsigned bundle | `INTACT` | `absent` | Checksums are internally consistent. Nothing about origin. |
| `verify <bundle>` on a signed bundle | `INTACT` | `unverified` | A signature exists and **was not checked**. Not provenance. |
| `verify <bundle> --key <yours>` | `AUTHENTICATED` | `verified` | The bundle came from the holder of that key. |
| `verify <bundle> --key <wrong>` | `INVALID` | `invalid` | Altered after signing, or signed by someone else. |
| `verify <unsigned> --key <any>` | `INVALID` | `absent` | You asked for a signature check on a bundle with no signature. |

Bare `verify` on a signed bundle remains `INTACT` and never describes the bundle as authenticated — not in the CLI output or `--json`. Exit 0 means the requested check succeeded: integrity for bare `verify`, provenance only when `--key` is supplied. A signing scheme that anchors to itself is worse than no signing, because it invites trust the artifact has not earned.

## Generating a key

```bash
dogfood keygen --out ./keys
```

Writes `dogfood-signing-key` (private, mode `0600`) and `dogfood-signing-key.pub`. It refuses to overwrite an existing pair unless you pass `--force`.

**Never commit the private key.** In CI, hold it in a secret and write it to a temp path for the run.

Distribute the *public* key through a channel independent of the bundle — a repository whose history you trust, an internal key server, your organization's documentation. A public key that arrives alongside the artifact it vouches for proves nothing.

## Signing a run

```bash
dogfood run --policy .dogfood/dogfood.policy.yaml --sign ./keys/dogfood-signing-key
```

This adds two things to the bundle:

- **`manifest.sig`** — the detached ed25519 signature, base64. It is detached because a signature cannot be contained in the bytes it signs.
- **`manifest.signing`** — `{ algorithm, keyId, publicKey, signatureFile }`, describing *which* key signed so a verifier can tell whether it holds the right one. This block is inside the signed payload, so it cannot be swapped without breaking the signature.

The signature covers the **exact on-disk bytes** of `manifest.json`, never a re-serialized object. Any change to the manifest — even reformatting — invalidates it.

`manifest.sig` is the only file besides `manifest.json` exempt from the unrecorded-file check, and it is exempt **by exact name**. A file named `evidence-manifest.sig.bak` is still rejected; substring exemptions are how planted files got through in an earlier version.

## Verifying

```bash
dogfood verify artifacts/dogfood/<runId> --key ./keys/dogfood-signing-key.pub
```

Two independent layers must both hold:

1. **Checksums** — every recorded file matches, and no unrecorded file is present.
2. **Signature** — `manifest.sig` verifies against the key you supplied, and the key recorded in the manifest matches it.

Failing either makes the bundle `INVALID`. They are independent by design: tampering with `summary.json` breaks layer 1 while leaving the signature valid over an unchanged manifest, which is why both are checked.

## What signing does not give you

- **It does not prove the software is correct.** It proves who produced the bundle, nothing about what the bundle asserts.
- **It does not prove the key holder is trustworthy.** Provenance is only as good as your independent trust in that key.
- **It does not protect gitignored files.** Mutation detection cannot see them, signed or not.
- **It does not establish a timestamp.** There is no countersignature or transparency log, so a signature does not prove *when* the bundle was produced.

## Algorithm

ed25519 via `node:crypto`, no dependency. Keys are PEM: PKCS#8 private, SPKI public. The `keyId` is the first 32 hex characters of the SHA-256 of the normalized public-key PEM, so it is stable across CRLF and LF line endings.

Sigstore keyless signing — which would remove long-lived key management and add a transparency log — is a plausible future direction, not something this version does.
