# FIX-SUMMARY — config.json → crons.json cron-sync gap

Status: IMPLEMENTED. The plan below was written before any code edits
(PLAN-FIRST constraint) and was executed as written; results are at the bottom.

Branch: `fable5/cron-config-sync` (worktree of /Users/davidhunter/cortextos,
based on origin/main bdb9906). NOT merged, NOT pushed — Dane final-gates.

## Root cause

`migrateCronsForAgent()` (src/daemon/cron-migration.ts) is gated by a per-agent
`.crons-migrated` marker file and runs ONCE. The daemon calls it on every
`startAgent()` (src/daemon/agent-manager.ts ~L652), but after the first boot it
is a guaranteed no-op (`skipped-already-migrated`). Any cron added to (or edited
in) `config.json` after that first migration therefore never reaches the
canonical live source `crons.json`, and the CronScheduler (which only reads
`crons.json`) never sees it. The merge-aware reconcile that WOULD fix this —
`reloadCronsForAgent()` — already exists in the same module but is only reachable
via the manual CLI `cortextos bus reload-crons <agent>`. Operators who edit
config.json get silent nothing.

## Option chosen: (a) reconcile on every agent/daemon start

On every `startAgent()` (daemon boot starts every agent through this path, and
restarts go stopAgent→startAgent), run:

1. `migrateCronsForAgent()` exactly as today (first-boot one-shot, marker-gated).
2. If the result is `skipped-already-migrated`, run `reloadCronsForAgent()` with
   `prune: false` — the existing, Codex-reviewed merge primitive that:
   - adds config crons missing from crons.json (the bug being fixed),
   - overwrites only config-authoritative fields (prompt/schedule/enabled/
     wake_on_fire/description) on name matches,
   - PRESERVES runtime metadata (`fire_count`, `last_fired_at`,
     `last_fire_attempted_at`, `created_at`, operator-set description/metadata),
   - PRESERVES orphans (live-only crons added via `bus add-cron`, not in
     config.json) — never prunes without explicit opt-in,
   - fail-loud no-ops on missing/corrupt config.json (never wipes crons.json).
3. Refresh any already-running scheduler for the agent (`scheduler.reload()`)
   so a lazy-wired scheduler (start-window gap) picks up the reconciled file;
   in the normal path `startAgentCronScheduler()` starts fresh AFTER the
   reconcile and reads the merged crons.json anyway.

Packaged as a new exported `syncCronsForAgent()` in cron-migration.ts
(migrate-then-reconcile), called from agent-manager. No change to the contracts
of `migrateCronsForAgent`, `reloadCronsForAgent`, or any CLI command.

## Why not (b) or (c)

- (b) deprecate config.json crons: breaking workflow change — fleet-wide agent
  teaching (CLAUDE.md "Crons are defined in config.json", onboarding skills,
  templates) all instruct editing config.json and expecting restore-on-restart.
  Deprecation would need a doc/teaching migration across every deployed agent.
  Wrong blast radius for a sync bug.
- (c) periodic reconcile: adds a polling loop, plus a mid-edit race window
  (half-written config.json read on a timer) and ambiguity about when a
  config edit "lands". Boot-time reconcile matches the already-documented
  operator mental model ("crons are recreated from config on each restart")
  exactly — least surprising, zero new timers.

No double-fire risk: reload preserves `last_fired_at`/`last_fire_attempted_at`,
the scheduler computes `nextFireAt` from those references, and
`CronScheduler.reload()` keeps the in-memory `nextFireAt` for unchanged
name|schedule pairs (plus a reload-while-firing guard already in place).

## Planned changes

- `src/daemon/cron-migration.ts` — add `syncCronsForAgent()` (+ result type).
- `src/daemon/agent-manager.ts` — call `syncCronsForAgent()` instead of bare
  `migrateCronsForAgent()` in `startAgent()`; `reload()` any pre-existing
  scheduler before `startAgentCronScheduler()`.
- `tests/integration/cron-config-sync.test.ts` — new tests:
  1. cron added to config.json AFTER first migration reaches crons.json via sync
     (and a fresh CronScheduler schedules it);
  2. runtime metadata (`fire_count`, `last_fired_at`) preserved across sync;
  3. orphan (live-only) crons preserved across sync;
  4. no double-firing: scheduler `nextFireAt` derives from preserved
     `last_fired_at` (no spurious catch-up fire after sync);
  5. first-boot path unchanged (sync == migrate, marker written);
  6. missing config.json → sync no-ops without wiping crons.json.

## Files changed

- `src/daemon/cron-migration.ts` — added `SyncResult` + `syncCronsForAgent()`:
  runs the existing marker-gated `migrateCronsForAgent()` first; when that
  returns `skipped-already-migrated` (every boot after the first), runs the
  existing `reloadCronsForAgent()` with `prune: false`. No existing function's
  contract changed; CLI `migrate-crons` / `reload-crons` behavior untouched.
- `src/daemon/agent-manager.ts` — `startAgent()` now calls
  `syncCronsForAgent()` (wrapped in try/catch so a sync failure can never
  abort agent startup) instead of bare `migrateCronsForAgent()`, then
  `reload()`s any scheduler that was lazy-wired during the start-window gap
  before `startAgentCronScheduler()` runs. Import updated accordingly.
- `tests/integration/cron-config-sync.test.ts` — NEW, 7 tests (see below).

## Behavior after the fix

Editing `config.json` crons + restarting the agent (or daemon) now lands the
change in `crons.json` and the live CronScheduler — no manual
`bus reload-crons` needed. `bus add-cron` / `bus reload-crons [--prune]`
continue to work exactly as before; orphan pruning remains an explicit
operator opt-in and never happens automatically at boot.

## Test results

New suite `tests/integration/cron-config-sync.test.ts` — 7/7 PASS:
1. first boot: sync == one-shot migration, marker written
2. THE GAP: cron added to config.json after first migration is skipped by
   bare migration (bug reproduced) but lands via sync, and a fresh
   CronScheduler schedules it (`getNextFireTimes` includes it)
3. fire_count / last_fired_at / last_fire_attempted_at / created_at preserved
   on existing crons while config-authoritative prompt edit applies
4. orphan (live-only `bus add-cron`) cron survives two consecutive boots,
   `kept_orphan` reported, never pruned
5. no double-fire: scheduler `nextFireAt` = preserved `last_fired_at` + 6h
   (~5h in the future, not an immediate catch-up); new crons fire one full
   interval out; nothing fires synchronously on start
6. missing config.json: sync no-ops with `reload.error` set, crons.json intact
7. re-sync with no config change: idempotent (`unchanged`), no duplicates,
   runtime metadata intact

Existing cron suites (crons-migration, multi-agent-crons,
cron-pipeline-cross-pr, concurrent-cron-mutations, ipc-cron-mutations,
agent-bootstrap-crons, cron-scheduler, bus-crons, crons-io): 149/149 PASS —
zero modifications needed to any existing test.

`npm run typecheck` (tsc --noEmit): clean.
`npm run build` (tsup): success.

FULL-SUITE RESULT (`npm test`, vitest):
`Test Files  149 passed | 1 skipped (150)` /
`Tests  2439 passed | 2 skipped (2441)` — ZERO failures.
(One environment note: the fresh worktree initially showed 11 failing test
files, all dashboard tests unable to import `next/server` because
`dashboard/node_modules` does not exist in a bare worktree. Symlinking the
main checkout's root and dashboard `node_modules` resolved all of them —
no relation to this change.)
