# Upstream Security Primitives — Binding Family Report

## Custody

- Family: security primitives from the 273-commit upstream catch-up census.
- Base: `d7ca29d6c179af7900fb648ba236e5aa69a25349`.
- Scope rule: structural security primitives only. No new transport, permission
  mode, or public endpoint is enabled by this family.
- Gap Rule: trust-boundary and policy divergences stop for an explicit ruling;
  no intent is inferred from upstream labels.
- Manifest: this repository has no tracked-file custody manifest. File custody
  is therefore the base/head tree plus the full-index patch digest reported at
  freeze time.

## Canonical 23-commit disposition

### Already equivalent on the fork (11)

`fdd95999`, `36a9bcb0`, `3006eced`, `d988f595`, `2bc3fc3a`,
`e537d053`, `63a0d6a6`, `a7e278a8`, `166ebb85`, `6befcfb`, and
`fef58bf` are patch-equivalent according to `git cherry` and require no port.

### Represented by this family (8)

- `46f8761b`: require `CTX_AGENT_DIR` to remain subordinate to
  `CTX_FRAMEWORK_ROOT`.
- `20583d3e`, `025cce8c`, `0db2a84d`, `2faa961e`, and `5362a5a2`:
  the dependency-ordered PTY-injection sanitization chain, including media,
  unhandled callbacks, Unicode-whitespace forged headers, and Telegram reaction
  display names.
- `fc0ac54a`: validate task ids and assignees before path construction.
- `d06936da` (intentional hardened divergence): adopt verified NextAuth session
  cookies only. The upstream change also made `/api/workflows/health` public;
  this fork deliberately keeps that endpoint authenticated. Named casualties
  prove a forged cookie fails and the health endpoint still requires auth.

### Policy-gated / separately tracked (3)

- `db39193a`: permission-gate auto-approval and path-semantics changes remain
  David-gated and are not ported here.
- `8267bab9` + `5a0882d0`: the upstream leak guard and auto-installed pre-push
  behavior are excluded. A separate equivalence review must compare them with
  this fork's member-hygiene, member-visible, and leak-guard authorities. Any
  adaptation must derive identity from those authorities and must not copy
  upstream roster literals.

Morning question: should the fork adopt `db39193a`'s changed permission-gate
auto-approval boundary, and if so which current fork policy is authoritative
when its command/path semantics differ?

### Obsolete incident cleanup (1)

- `086ba1df`: an upstream-specific purge of reports and operator paths that are
  not present in this fork. Evidence-only; no deletion or vestigial ignore rule
  is carried.

## Validation contract

- Build the TypeScript bundles.
- Run the environment-containment, PTY sanitizer, callback/media, task-path,
  and dashboard middleware tests.
- The environment-containment suite runs with inherited live `CTX_AGENT_DIR`,
  `CTX_PROJECT_ROOT`, and `CTX_FRAMEWORK_ROOT` unset so a test sandbox cannot
  accidentally inherit the operator's live agent path.
- Mutation/probe boundary: replacing the NextAuth verification result with a
  cookie-name presence check must kill the forged-cookie casualty; adding the
  health route to the public-path list must kill the health-auth casualty.

## Callback structural-injection recut

Exact review of the first candidate found that unhandled Telegram
`callback_data` was passed through the lossy unfenced sanitizer. That sanitizer
originally recognized only `AGENT MESSAGE` and `TELEGRAM`, so sibling daemon
headers such as `URGENT SIGNAL` and `REACTION` could remain byte-exact after a
fence breakout.

The recut makes `DAEMON_STRUCTURAL_HEADERS` the authoritative registry shared
by producers and the unfenced sanitizer, and wraps arbitrary callback data with
`wrapFenceSafe` at construction. A production-path casualty injects a callback
containing a backtick breakout plus both sibling headers and proves the complete
payload remains inside a dynamically larger fence. Removing that fence kills
the casualty. A source census compares every structural producer variable with
the registry-derived set, while sanitizer tests iterate the registry itself;
future sibling headers therefore cannot bypass the guard by omission.
