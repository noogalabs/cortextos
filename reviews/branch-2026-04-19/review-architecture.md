# Architecture Review — branch-2026-04-19

Reviewed files: `src/daemon/agent-process.ts` (diff + full file), `src/daemon/agent-manager.ts`, `src/bus/cron-state.ts`, `tests/unit/daemon/agent-process.test.ts`.

---

## Duplicate `isDaemonShuttingDown()` guard block in `handleExit`

**File:** `src/daemon/agent-process.ts:405–430`
**Severity:** warning
**What is wrong:** The `if (this.isDaemonShuttingDown()) { return; }` call appears twice in `handleExit`, with an identical multi-paragraph comment block repeated verbatim above each call (lines 387–407 and 409–430). This is not introduced by the diff under review, but the diff touched this method and did not remove the duplicate — the second call is dead code and will never execute because the first one returns.
**Why it matters:** Dead code in a method that handles crash/restart decisions is dangerous at review time: future authors reading `handleExit` may not notice the dead block and think two different shutdown signals are being handled, or may insert logic between the two guards expecting it to run. The duplicated comment also erodes confidence that comments accurately describe behavior.
**What needs to change:** Remove the second `if (this.isDaemonShuttingDown()) { return; }` block (lines 409–430) entirely. This is a pre-existing bug that should be cleaned up as part of this PR since the diff already touches `handleExit`'s surrounding code.

---

## 30-second stagger sleep inside the per-cron loop leaks async time across lifecycle boundaries

**File:** `src/daemon/agent-process.ts:937` (hunk at line 46–47 of the diff)
**Severity:** warning
**What is wrong:** The `await sleep(30_000)` inserted between gap nudges runs *inside* `runGapDetectionLoop`, which captures `generation` at call time. However the generation check at the top of the while-loop (`if (generation !== this.lifecycleGeneration || this.status !== 'running') return;`) is only evaluated *after* the full inner `for` loop completes, including all the 30-second sleeps for each stale cron. If an agent has N stale crons, the loop holds the async context for up to N×30s before re-checking whether the lifecycle is still valid.

Concretely: if the agent is stopped during a multi-cron stagger sequence, nudges will still be injected for the remaining crons in that pass — `this.pty` and `this.status` are checked inside the `if` block at line 931, but `this.pty` may already be null and `this.status` may no longer be `'running'`. The existing guard at line 931 (`if (this.pty && this.status === 'running')`) does prevent the injection itself, but the loop continues sleeping for the remaining crons unnecessarily, delaying teardown visibility.
**Why it matters:** During rapid `--continue` restarts (the exact scenario this fix targets), the gap loop from the old lifecycle can remain alive for up to N×30s after the lifecycle has changed, sleeping between non-injections. This is not a correctness bug (the guard on line 931 prevents actual injection), but it means the old loop lingers longer than expected, creating subtle confusion when debugging restart timing.
**What needs to change:** Add a lifecycle check inside the stagger: after the `await sleep(30_000)`, check `if (generation !== this.lifecycleGeneration || this.status !== 'running') return;` before proceeding to the next cron. This mirrors the pattern used at the top of the while-loop and at the start of `verifyCronsAfterIdle`.

---

## `cronVerificationPending` flag is never reset on lifecycle change — can block re-verification after restart

**File:** `src/daemon/agent-process.ts:858–861`
**Severity:** warning
**What is wrong:** `cronVerificationPending` is set to `true` when a verification waiter starts and cleared in `.finally()` when it resolves or throws. But `verifyCronsAfterIdle` can take up to 30 minutes (the newly extended `maxWaitMs`). During that window, if the agent crashes and is restarted (a new lifecycle), `scheduleCronVerification()` is called again from `agent-manager.ts:308`. The generation check inside `verifyCronsAfterIdle` will cause the old waiter to bail out early — but `cronVerificationPending` will only be cleared when the old waiter's `finally` runs. If the `finally` has not yet run by the time the new `scheduleCronVerification()` call arrives (a very tight race, but possible in the same event-loop turn as the restart), the new call will see `cronVerificationPending = true` and skip scheduling — leaving the new lifecycle without a verification pass.

In practice the race window is narrow (it requires the restart to complete synchronously before the old waiter's finally block runs), but the invariant "one pending flag, valid for the current lifecycle only" is not encoded anywhere and will surprise future maintainers.
**Why it matters:** This is the same class of stale-state bug that motivated Issue #182 in the first place. The dedup mechanism correctly solves the rapid-restart stacking problem, but the flag's lifecycle is not tied to the generation counter that governs everything else in this class. Future changes to restart timing could make the race window larger.
**What needs to change:** Reset `cronVerificationPending = false` at the start of `start()` (alongside the existing `stopRequested = false` and `lifecycleGeneration` increment), so that each new lifecycle always begins with a clean slate. The `.finally()` cleanup can remain as-is. This removes the race entirely without requiring any generation-aware logic in the flag itself.

---

## Magic constant `30_000` (stagger sleep) is inline with no named configuration

**File:** `src/daemon/agent-process.ts:937`
**Severity:** suggestion
**What is wrong:** The 30-second stagger value is embedded as a bare numeric literal. All other timing constants in this file follow one of two patterns: module-level named constants (`GAP_POLL_MS = 10 * 60 * 1000`, `GAP_MULTIPLIER = 2.0` inside `runGapDetectionLoop`) or class-level config fields (`max_session_seconds`, `rate_limit_pause_seconds`, `ctx_restart_threshold`). The stagger does not follow either pattern.
**Why it matters:** Operators tuning for agents that fire many simultaneous gap nudges have no way to adjust the stagger without editing source. More importantly, when reading the gap detection loop it is not immediately clear why 30 seconds was chosen over 10 or 60, and there is no companion test that exercises multi-cron stagger timing.
**What needs to change:** Extract `const GAP_STAGGER_MS = 30_000;` alongside `GAP_POLL_MS` and `GAP_MULTIPLIER` at the top of `runGapDetectionLoop`. Add a brief comment explaining the rationale (prevent context-spike / ctx-watchdog restart). No config exposure needed at this stage, but the constant should be named.

---

## `maxWaitMs` extension from 10 min to 30 min is not covered by any test

**File:** `src/daemon/agent-process.ts:965`
**Severity:** suggestion
**What is wrong:** The diff extends `maxWaitMs` from 600,000ms to 1,800,000ms with the rationale that agents busy processing gap nudge bursts would never go idle in the shorter window. The test suite (`tests/unit/daemon/agent-process.test.ts:312`) exercises the happy-path idle detection but does not test the timeout-expiry path ("timed out waiting for idle flag, skipping injection" branch at line 992). The extended timeout makes the timeout path harder to exercise in real time, but there is no fake-timer test that verifies the log message and non-injection behavior when `foundIdle` remains `false`.
**Why it matters:** The extended window is load-bearing for the Issue #182 fix. Without a test for the timeout branch, a regression that accidentally makes `foundIdle` always-false will silently stop injecting verification prompts and no test will catch it.
**What needs to change:** Add a `vi.useFakeTimers()` test that advances past 30 minutes without an idle-flag update and verifies: (a) `mockInjectMessage` is not called, and (b) the log output contains the timeout message. This follows the same pattern as the existing `verifyCronsAfterIdle` test.

---

## No issues found

The following aspects of the diff are clean and consistent with existing patterns:

- **`cronVerificationPending` boolean field** — placement alongside `lifecycleGeneration` and `stopRequested` is correct; naming and comment follow the established BUG-NNN fix annotation style.
- **`.finally()` reset** — using `.finally()` rather than `.then()` + `.catch()` is the right idiom for guaranteed cleanup; consistent with how `rateLimitTimer` is nulled after use.
- **Dedup guard placement** — checking `cronVerificationPending` before capturing `generation` prevents the new waiter from ever starting, which is strictly safer than letting it start and then bailing inside `verifyCronsAfterIdle`. Correct choice.
- **`maxWaitMs` location** — the change is inside `verifyCronsAfterIdle` only; the gap-detection loop's `GAP_POLL_MS` is unchanged, which is correct (the two loops have different cadences and should not share a constant).
- **Stagger sleep position** — sleeping *after* the inject (not before) means the first nudge goes out immediately; subsequent ones are staggered. This is the right order.
