# Continuous integration

The repository workflow and generated template run the same CLI used locally:

- [repository workflow](https://github.com/proofofwork-agency/dogfood/blob/main/.github/workflows/dogfood.yml)
- [generated workflow template](https://github.com/proofofwork-agency/dogfood/blob/main/templates/ci/dogfood.yml)

`dogfood init` also writes `.dogfood/github-workflow.dogfood.yml` and `.dogfood/CODEOWNERS.fragment`. Merge the relevant fragments into the host repository rather than assuming generated files alter GitHub settings.

## Gate shape

The repository workflow runs unit tests on its Node/OS matrix, runs the real Chromium fixture, produces an authoritative bundle, verifies that bundle, uploads it, and aggregates every required job into one status named `dogfood / prove-it`.

Require that single status in branch protection. Earlier workflow revisions published two checks with that name, including a non-failing reporter check; the separate reporter job has been removed. JUnit is now rendered into `$GITHUB_STEP_SUMMARY` from the authoritative job, so no job requests `checks: write` and fork pull requests can reach the same final gate.

Every action is pinned to a full commit SHA, jobs use least-privilege `contents: read`, and each job has a timeout. Superseded pull-request runs may be cancelled; merge-group and main-branch runs are allowed to finish.

## Baseline behavior

Pull-request and merge-group events pass their protected base commit through `--baseline-ref`. Push, manual, and scheduled events have no PR or merge-queue base, so baseline regression rules are not applied to those runs. The remaining authoritative checks still run, but this is a real weakening of the nightly drift detector.

## Evidence retention

The workflow uploads `artifacts/dogfood/` even when the proof step fails. Treat uploaded command logs as potentially sensitive despite default redaction. Set repository-specific retention and access controls in the host workflow.

