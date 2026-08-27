# Upstream CLI/Bus Mechanics — Binding Family Report

## Custody and scope

- Base: `d7ca29d6c179af7900fb648ba236e5aa69a25349`.
- Canonical family: 35 upstream commits supplied by the catch-up census.
- Scope: missing CLI and bus mechanics only; preserve fork authority.
- External messaging and automatic-notification policy changes require a ruling
  rather than an inferred port.
- This repository has no tracked-file manifest. Freeze custody uses the Git tree
  and full-index patch digest.

## Disposition

### Already patch-equivalent (28)

`2b3409d8`, `21aeaf0d`, `3df05a54`, `f12f8b46`, `426c4101`,
`7d5ab2b0`, `7732ebd1`, `c73a292e`, `98ce4539`, `6e36a0f3`,
`2db93286`, `764dd84a`, `6869e458`, `8d16468b`, `c7db670a`,
`d77820b4`, `55cf04ad`, `fbe58fee`, `a00ed2cb`, `ae644527`,
`28ae5833`, `bc71008a`, `7782a35a`, `701161d6`, `28224eb0`,
`2985b18d`, `56045eaf`, and `9a30342d` are already represented on
the fork according to `git cherry` patch equivalence. No duplicate port is
carried. Existing notification behavior from `7732ebd1` and `7782a35a` is
therefore evidence of current fork authority, not a newly enabled policy.

### Missing mechanics represented here (5)

- `5f9cc6cb`: validate org names in `init` and `add-agent --org`.
- `bdcbc01d`: resolve manage-cycle configuration against the target agent,
  not the caller. The isolated family adds the explicit `resolvePath` import
  that upstream inherited from another family.
- `72708bdd`: render an unset model as `default` in CLI status.
- `f1b8aad9`: render complete task ids and support project filtering.
- `756b931b`: convert command action failures to a controlled CLI error boundary.

### Non-applicable: conflicts with standing policy (1)

- `f2b399a4`: introduces `cortextos update --yes`, which can apply an upstream
  merge after setting `CORTEXTOS_CONFIRM_UPSTREAM_MERGE`. That conflicts with
  this fork's standing policy: upstream adoption occurs through review-gated
  batches, not a direct operator auto-apply path. It is not ported. David may
  override that policy only through an explicit daylight ruling.

### Obsolete / no applicable payload (1)

- `2b6932e7`: removes a Codex token-expiry auto-send block that does not exist in
  this base's usage script. Carrying a deletion with no target would be noise.

The frozen family therefore closes **33 of 35** commits through equivalence or
implemented mechanics. The other two have terminal dispositions above; neither
is an unclassified remainder.

## Validation

- Run the seven affected CLI/bus test files, including target-agent resolution,
  org validation, task table filtering, status output, and the CLI error boundary.
- Build all TypeScript bundles and run `git diff --check`.
- The target-agent tests are the behavioral probe for `bdcbc01d`: resolving a
  sibling and fallback layouts must return the target directory, while a missing
  target remains null.
- The org validator casualties reject traversal/invalid names before filesystem
  construction. Task-table tests pin full ids and project filtering. The error
  boundary casualty pins controlled exit rather than an unhandled rejection.
