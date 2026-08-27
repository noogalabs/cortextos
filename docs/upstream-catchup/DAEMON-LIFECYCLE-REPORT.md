# Upstream Catch-up: Daemon/Lifecycle Family

## Binding header

- Family: `daemon/lifecycle`
- Canonical upstream set: 56 commits
- Fork base: `d7ca29d6c179af7900fb648ba236e5aa69a25349`
- Port commit: `65908823f07d71c0554818a99413a78759036cf2`
- Represented before port: 36 (33 patch-equivalent leaf commits and 3 merge shells)
- Newly represented: 3
- Held or routed by ruling: 17
- Deployment/restart: excluded

## Represented upstream commits

The following mechanics were already represented at the base. The merge shells
`3de02fc1`, `f81a8d0`, and `2137d48` add no separately portable behavior beyond
their represented leaves.

`39163d9d`, `3de02fc1`, `aecdcfa6`, `b0bb43ce`, `4ed0d58e`,
`8e34742e`, `fce35b6a`, `2f7ee06e`, `3fae1c1e`, `fd5a252f`,
`ba4dcac1`, `2c51dfdc`, `a4a322ae`, `ec9d0b5b`, `1562fa47`,
`897b8d6`, `4fd6e05`, `72f6c29`, `b7ef973`, `b0c8a0a`,
`6d8cbe1`, `788a9e6`, `f81a8d0`, `2137d48`, `dfc5556`,
`59913b5`, `918d3a8`, `476ea61`, `de521d1`, `164742e`,
`bf2c898`, `c074194`, `525ba48`, `93b8d09`, `1e1224ee`,
`5685bc32`.

Three clearly absent mechanics were ported with two-direction probes:

- `f03de889`: pass an explicitly selected worker model into `AgentPTY`.
- `452a9c7a`: select Codex resume mode only from the persisted Codex thread
  state, never from stale Claude JSONL.
- `d11d8e00`: require an explicit `.onboarded` marker; heartbeat presence does
  not silently mark onboarding complete.

The represented set after this port is therefore 39/56.

## Ratified holds and owner routing

- `adc6b63a`, `b3657dd1`: held for equivalence/map-entry-race reconciliation.
- `d81fe556`, `ee21f179`: split-by-owner census; these span hooks, templates,
  security, CLI, Telegram, PowerShell, and daemon behavior.
- `b15ca019`: OpenCode aggregate excluded from this family.
- `19def471`: reconciliation-gated against the fork's reaper v6.2 IPC
  admission semantics.
- `06774c2c`: not adopted. Although it logs malformed JSON, its exact failure
  path still executes `return {}` and discovery then starts the agent with a
  default configuration. That is tolerant fallback, not fail-loud admission.
- `da766313`: crash-window thresholds are runtime policy.
- `7eed2e23`: automatic back-online Telegram is external-communications policy.
- `897c5afb`: persisted Codex-thread/task import custody conflicts with the
  fork-specific adapter and requires reconciliation.
- `593e0c09`: marker unlink and first-heartbeat crash-classification policy.
- `381aa497`: image-poison auto-recovery mutates conversation artifacts.
- `4369e945`: usage and quota-monitor policy.
- `dab255a0`: `--dangerously-skip-permissions` is security policy.
- `99158f82`: upstream's default-on 60% handoff conflicts with the fork's
  configurable handoff lifecycle.
- `a15baad4`: automatic acceptance of the Claude bypass-permissions screen is
  runtime/security policy.
- `fdfaa786`: first-run prompt automation and working-directory admission mix
  UX and runtime policy.

No ambiguous behavior was guessed through.

## Native Windows priority proof

`5685bc32` has stable patch ID
`1e64218094e45eae3436037eea0389cd392ef802`; the identical fork patch is
`32152c0d6b797343665a5410e20bdb6b521a54d0`, ancestral to both the base and
this head. `93b8d09a` has stable patch ID
`0e58c24a3c8f748fe0075b5089a68d1b3f50c214`; the identical fork patch is
`c67e8de052ade9a11f40c957c43a34ba7a5148b6`, also ancestral to both.

For `5685bc32`, these current blobs are byte-identical to upstream:

- `scripts/install-windows-pm2-startup.ps1`
- `src/cli/ecosystem.ts`
- `src/pty/agent-pty.ts`
- all three affected Claude settings templates

The README is not wholly byte-identical because later multi-runtime sections
were added. Its Windows instructions and support matrix are unchanged: Windows
uses Task Scheduler rather than `pm2 startup`, the script path is the same, and
the supported-platform row remains `macOS, Linux, or Windows 10/11`.

`ca0ea77` (comprehensive Windows support) is outside this 56-commit family. It
is independently patch-equivalent to fork commit `201340eb` and is the other
Windows-specific upstream commit in the catch-up range. The Task Scheduler
script and README matrix themselves originate in in-family `5685bc32`; no
additional unrepresented Windows script/doc commit was found.

PowerShell is unavailable on the audit host, so no claim of native Windows
execution is made. Static blob/patch equivalence is exact. Existing PTY and
lifecycle tests pass on the host.

## Validation

- TypeScript build: pass.
- Full daemon unit suite: 16 files, 321 tests passed.
- Port-specific suite: 3 files, 33 tests passed.
- Windows-adjacent PTY/lifecycle selection: 1 discovered file, 9 tests passed.
- Worktree was clean after the source/test commit; no daemon restart or
  deployment was performed.

## Current-main integration custody

The original family head `867e634f4ae7292d09d155b400151d6a9b26fe56`
was reviewed against the historical fork base `d7ca29d6`. Before landing, the
family was composed with current fork main
`0832e6bed60a78c46daf3db0d3a2c3a48f64474e` so CI and review exercise the
actual landing tree rather than carrying old-head evidence across integration.

The merge was text-clean. The landed-family overlap census contains exactly
four paths:

- `src/daemon/agent-manager.ts`
- `src/daemon/agent-process.ts`
- `src/daemon/worker-process.ts`
- `tests/unit/daemon/agent-process.test.ts`

The composed tree preserves the previously landed fail-closed predecessor
death/admission behavior and the typed daemon-injection boundary, while
retaining all three daemon/lifecycle family mechanics: selected worker-model
transport, Codex-only resume selection, and explicit onboarded-marker
admission.

Validation on the composed tree:

- TypeScript build: pass.
- TypeScript typecheck: pass.
- Lifecycle status CLI verifier: pass.
- Full daemon unit suite: 18 files, 356 tests passed, including the manager
  death-unconfirmed successor-admission casualty, the typed-injection/fence
  boundary casualties, and the three daemon/lifecycle family probes.
- No daemon restart or deployment was performed.
