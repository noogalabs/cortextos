# Upstream Equivalence / High-Value Tail Family Report

## FAMILY

`equivalence-closure/high-value-tail`

This branch is based on fork commit `d7ca29d6` and represents the canonical
14-commit upstream family listed below. The implementation is a behavior port,
not a blind cherry-pick: fork-local runtime and daemon divergence was preserved,
and only behavior absent from the fork was added.

## Proposed review tier

**HEAVY.** The family changes daemon lifecycle, PTY teardown, liveness reporting,
heartbeat custody, cron reload behavior, context handoff, Telegram polling, and a
new read-only lifecycle status contract. Review should independently probe the
race/liveness guards and inspect exact-head CI logs before merge.

## Canonical upstream set and disposition

| Upstream SHA | Disposition | Representation |
|---|---|---|
| `94c58451` | Already equivalent | `git cherry fork/main upstream/main` reports the patch as present; hook-based activity no longer depends on stdout-log growth. |
| `844ef577` | Already equivalent | Its synchronized activity tests are patch-equivalent on the fork. |
| `42e1bbad` | Merge shell | No unique bytes beyond `844ef577`; the parent-to-merge diff is empty. |
| `a7a59322` | Already superseded | The fork already ships the later Codex app-server PTY, template, handoff integration, and runtime tests. Replaying the 16-commit squash would overwrite newer fork behavior. |
| `86729341` | Ported | Read-only lifecycle status bridge, versioned schemas, CLI command, verifier, and tests. |
| `f5f995e3` | Adapted | Map-entry identity, stopped-entry ownership, idempotent live starts, callback ownership, and identity-safe teardown were applied to the fork's smaller AgentManager without importing unrelated Slack/Buzz/multi-user dependency bleed. |
| `5095f336` | Deliberately non-applicable | OpenCode-only recovery. OpenCode is deliberately unsupported in this fork; see the ruling below. |
| `af58ef8f` | Ported | `crons.json` mtime reload and its scheduler/failure-mode probes. |
| `f4eeda4f` | Adapted | Telegram transient exponential backoff with jitter plus supervised recovery from a 409 lock conflict. |
| `c80d86bb` | Adapted | A duplicate start against a live/starting entry is idempotent; a start racing a stopped entry uses the queued-restart path. |
| `28500e76` | Ported | Heartbeat refresh is opt-in so on-behalf bus activity cannot spoof agent liveness. |
| `0247aaab` | Adapted | Silent dormancy calculation, per-agent cadence threshold, absent-enabled-agent census, and status rendering, without unrelated upstream transport/runtime bytes. |
| `5a8e7cbc` | Adapted | Runtime-aware handoff grace and futile high-resume-baseline suppression on the fork's existing context-handoff lifecycle. |
| `9f39d4db` | Ported | Death-confirmed stop, bounded `SIGKILL` escalation, join-in-flight teardown, and fail-closed containment when the observation deadline expires without authoritative child-death evidence. |

## OpenCode exclusion ruling

The orchestrator relayed Dane's explicit ruling that this fork supports exactly
the Claude and `codex-app-server` runtimes. OpenCode is deliberately unsupported.
Accordingly, `5095f336` and sole-purpose OpenCode adapter dependencies are
non-applicable, deleted OpenCode files were not restored, and this decision may
be reopened only by a future David-directed OpenCode adoption project.

## Fork-divergence handling

- The lifecycle CLI conflict retained the fork's command set and added only the
  lifecycle command/version authority; it did not invent the unrelated upstream
  `update` command.
- The upstream map-race squash contains behavior accumulated from other families.
  Slack, Buzz, multi-user Telegram, and unrelated liveness changes were excluded.
- The Telegram 409 exit contract was paired with a fork-local poller supervisor so
  the poller cannot stop permanently after surrendering a stale lock.
- Dormancy and context-handoff changes were applied to the fork's current daemon
  and handoff state machines rather than replacing them with upstream variants.
- The lifecycle reader's BOM dependency is represented by a four-line exact
  `stripBom` utility instead of importing the unrelated silent-failure family.

## Probes and validation

The checked-in probes cover:

- lifecycle schema and legacy-status compatibility;
- cron mtime reload and failure-mode behavior;
- Telegram backoff, jitter, retry hints, and conflict exit behavior;
- heartbeat refresh caller gating;
- dormancy thresholds and status classification;
- Codex-versus-default handoff grace;
- map-entry identity/stopped-entry construction-site census plus a real stale-
  teardown race proving an old entry cannot delete its replacement identity;
- death-confirmed teardown construction-site census plus a wedged-child casualty
  proving an alive child after the post-`SIGKILL` deadline rejects teardown,
  remains non-stopped, and refuses successor admission.

Both behavior guards were mutation-armed while their source strings remained:
neutralizing the death-unconfirmed throw made the wedged-child casualty fail,
and weakening the map identity predicate to mere name presence made stale
teardown delete the replacement and fail its casualty. The existing source
census therefore remains a structural complement rather than the sole proof.

Commands run successfully on the branch:

```text
npm run build
npx tsc --noEmit
node scripts/verify-lifecycle-status-cli.mjs
npm test -- --run tests/unit/daemon
```

The final daemon command passed 17 test files / 327 tests, including the focused
process, manager, and equivalence-closure casualties. Build, typecheck, and the
lifecycle CLI verifier all exited zero.

## Known harness limitation

`npm test` at the repository root is not a clean all-surfaces command in this
worktree because root `npm ci` does not install dashboard-local dependencies.
The full invocation reached **99 passing files, 1,665 passing tests, and 48
skipped tests**, then reported ten import-failed suites and one dependent test:

- `next/server` is unavailable to dashboard/API integration suites;
- `better-sqlite3` is unavailable to dashboard database/cost-parser suites.

Those failures occur during module import, not a changed-code assertion. They are
recorded here rather than described as green. Binding CI must either install the
dashboard dependency set or use the repository's intended split jobs.

## Gap Rule

**PASS.** No ambiguous runtime or operational policy was invented. The one real
scope gap—whether to restore OpenCode—was stopped and escalated before editing;
the resulting explicit exclusion ruling governs this branch. All other conflict
resolutions were mechanical adaptations of upstream behavior to already-shipped
fork contracts.

## Custody

This repository has no tracked `MANIFEST.sha256` or manifest generator/checker.
No synthetic manifest was introduced. Custody for the freeze is therefore the
base/head/tree/full-index-patch tuple plus exact-head CI run identifiers.
