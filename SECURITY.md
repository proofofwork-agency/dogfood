# Security model

Dogfood usually gates an implementation produced by an automated coding workflow, so the implementation and its generated output may be adversarial. The contract and policy are part of the trusted computing base.

Contracts contain shell commands and run without a sandbox. Review a contract before executing it, especially when it comes from an untrusted branch or artifact.

Mutation detection covers Git-visible state within its configured boundary. Authoritative mode expands that boundary to the Git root and non-ignored untracked files, but Git-ignored files remain invisible.

`dogfood verify` proves internal consistency of a manifest v3 bundle. It does not prove provenance: an actor able to rewrite the bundle can regenerate its unsigned manifest. Preserve evidence in an independently trusted store when origin matters.

Standard and authoritative runs redact matching environment values and declared literals by default. Redaction cannot protect secrets that were not selected, and `logs.capture: full` disables it. Avoid secrets in command lines and limit access to uploaded bundles.

Report security issues through the repository's issue tracker: <https://github.com/proofofwork-agency/dogfood/issues>. Do not include live credentials or sensitive bundle contents in a public report.

