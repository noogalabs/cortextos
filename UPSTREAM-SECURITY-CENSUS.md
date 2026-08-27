# Upstream Security Primitives — Binding Family Report

## Custody

- Family: security primitives from the 275-commit upstream catch-up census.
- Integrated base: `4c1cbb2486ad1aba5b5f4570e34cbe5a575912d2`
  (post CLI/bus and equivalence-closure landings).
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

## Typed final-boundary structural injection

Exact review of the first candidate found that unhandled Telegram
`callback_data` was passed through the lossy unfenced sanitizer. That sanitizer
originally recognized only `AGENT MESSAGE` and `TELEGRAM`, so sibling daemon
headers such as `URGENT SIGNAL` and `REACTION` could remain byte-exact after a
fence breakout.

Three retired candidates tried to prove source-string provenance with regex or
AST expression censuses. Direct concat, `String.repeat`, and
`String.fromCharCode` plants proved that JavaScript strings retain no such
provenance. Those detectors remain defense in depth only; they are not the
security boundary.

The terminal recut moves authority to the final PTY boundary. Every daemon
message is a closed `DaemonInjection` discriminated union. A `structural`
variant carries a registry enum plus sanitized details/body and is the only
variant whose header bytes are rendered. A `raw` variant accepts arbitrary
runtime strings but is always dynamically fenced as content by
`renderDaemonInjection` immediately before the PTY write. Unknown variants,
unregistered headers, malformed fields, and raw strings passed to the TUI-key
write API reject loudly.

The finite sink census covers the two PTY ingress modules. `AgentProcess`
accepts only `DaemonInjection`, renders it at the final sink, and exposes a
separate runtime-checked `TuiKey` writer for control input. `WorkerProcess`
wraps worker text as raw before the same renderer. Manager, cron, Telegram,
reaction, media, callback, urgent-signal, and context/handoff producers now
construct typed values rather than authority-bearing strings. The legacy
source census stays labeled defense in depth and is no longer claimed as
provenance enforcement.

Named arms prove the boundary rather than any expression spelling: literal,
template, helper/array, split-literal concat, `String.repeat`, and
`String.fromCharCode` plants sent through raw ingress all remain fenced content;
bypassing the final renderer kills the production `AgentProcess` casualty;
weakening the raw neutralizer kills both the renderer and production-sink
casualties; malformed and non-registry structural variants halt. The prior
callback breakout and sibling-header exploit casualties carry unchanged.

Terminal local validation on the integrated base: the root matrix passed 118
files / 1,932 tests (one skip) with inherited live agent-directory variables
removed from the sandbox harness; the focused final-boundary matrix passed 5
files / 115 tests; build and TypeScript typecheck completed successfully.
