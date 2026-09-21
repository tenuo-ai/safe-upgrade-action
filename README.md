# safe-upgrade Action

Assess a Dependabot or Renovate dependency pull request against the repository's
own code and checks. The Action publishes the verdict as a job summary, annotates
affected files, can comment on the pull request, and attaches the complete evidence
record to the workflow run.

The first release supports Linux runners. Its process isolation layer installs
Bubblewrap when the runner image does not already provide it.

```yaml
name: Assess dependency upgrades

on:
  pull_request_target:
    types: [opened, synchronize, reopened]

jobs:
  safe-upgrade:
    if: >-
      github.actor == 'dependabot[bot]' ||
      github.actor == 'renovate[bot]'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout the base revision
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          persist-credentials: false

      - name: Assess the upgrade
        uses: tenuo-ai/safe-upgrade-action@v1
```

The base revision is intentional. `safe-upgrade` applies the requested release
inside its own disposable worktree and evaluates the resulting change. The pull
request's code is not checked out by this workflow.

## What appears in GitHub

Every completed run produces:

- A `verified`, `partial`, `human_required`, `blocked`, or `indeterminate` result
- The repository-specific reasons behind that result
- Findings attached to affected files
- Baseline and final check outcomes
- A downloadable evidence record containing the report, findings, checks, diff,
  route history, audit log, and authorization events

Dependabot titles and common single-package Renovate titles are inferred. For an
unusual Renovate title or a manually triggered workflow, provide an exact target:

```yaml
- uses: tenuo-ai/safe-upgrade-action@v1
  with:
    package: postcss
    version: 8.4.35
```

## Jev and repository-specific migrations

Set the keys as step environment variables. Credentials are not accepted as
ordinary Action inputs.

```yaml
- uses: tenuo-ai/safe-upgrade-action@v1
  with:
    engine: jev
    patch-model: your-model-id
  env:
    TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## Authorization

The first release defaults to `authorization-mode: development`. The job summary
labels this as a self-authorized trial, which makes the Action usable before a
Tenuo warrant issuer is configured.

For an existing production issuer, set `authorization-mode: production` and
provide `TENUO_ROOT_PUBLIC_KEY`, `TENUO_RUN_WARRANT`, and
`TENUO_RUN_HOLDER_SECRET` through the step environment. GitHub OIDC exchange for
a short-lived run warrant is planned as the next authorization layer.

## Inputs and outputs

See [`action.yml`](action.yml) for the full input and output contract. Important
outputs include `status`, `exit-code`, `report-path`, and `artifact-path`.

The Action preserves `safe-upgrade`'s exit codes. A result requiring attention
therefore fails the check unless `partial-allowed: true` applies to a partial
result.

## License

[Apache License 2.0](LICENSE)
