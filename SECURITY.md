# Security model

Dogfood usually gates an implementation produced by an automated coding workflow, so the implementation and its generated output may be adversarial. The contract and policy are part of the trusted computing base.

Contracts contain shell commands and run without a sandbox. Review a contract before executing it, especially when it comes from an untrusted branch or artifact.

Mutation detection compares Git-visible snapshots before and after a command within its configured boundary. Authoritative mode expands that boundary to the Git root and non-ignored untracked files. A byte-for-byte edit-and-revert between snapshots is not observable, and Git-ignored files—including the usual `artifacts/` evidence tree—remain invisible.

`dogfood verify` proves a bundle is internally consistent. On its own it does not prove provenance: an actor able to rewrite the bundle can regenerate an unsigned manifest, and a public key recorded inside a manifest is not a trust anchor because the same actor can replace it. Sign runs with `dogfood run --sign`, and establish origin with `dogfood verify --key <public key obtained out of band>`. Bare `verify` on a signed bundle reports the signature as present but unverified and never claims provenance.

Standard and authoritative runs redact matching environment values and declared literals by default. Redaction cannot protect secrets that were not selected, and `logs.capture: full` disables it. Avoid secrets in command lines and limit access to uploaded bundles.

Only files Dogfood publishes through its own log and adapter paths are redacted. Contract commands are arbitrary shell programs and can create additional files in the run tree; those files are checksummed but not rewritten. Treat contracts as trusted code and do not let them publish secrets as side files.

Report security issues through the repository's issue tracker: <https://github.com/proofofwork-agency/dogfood/issues>. Do not include live credentials or sensitive bundle contents in a public report.
