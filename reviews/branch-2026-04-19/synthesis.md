# Code Review Synthesis — branch — 2026-04-19

## Overall Assessment

The diff (Issue #182 fix — cron-verification dedup, gap-nudge stagger, idle-wait extension) is directionally correct and introduces no security regressions, but it is **not safe to merge as-is**. The biggest concern is unanimous across all three reviewers: the `cronVerificationPending` flag is not reset on a new lifecycle, which re-introduces the exact failure mode the PR is trying to prevent — after a rapid restart, cron verification can be silently skipped for the entire new session. Overall quality is good (clean idioms, correct `.finally()` cleanup, sensible generation gating), but the fix's core invariant ("one pending flag, valid for the current lifecycle only") is not encoded in code.

## Critical Issues (must fix before merge)

### 1. `cronVerificationPending` not reset on lifecycle change — permanent verification skip after rapid restart
**File:** `src/daemon/agent-process.ts:858–861`
**Flagged by:** correctness (critical), architecture (warning) — agreement across two reviewers
**Problem:** `cronVerificationPending` is set `true` at start of `scheduleCronVerification()` and cleared only in `.finally()` on `verifyCronsAfterIdle`, which can run up to 30 minutes. If the agent stops and restarts within that window, `scheduleCronVerification()` on the new lifecycle returns early at the guard (line 850) because the flag is still `true` from the old in-flight waiter. The old waiter then bails at its generation check and clears the flag — but only after the new lifecycle already silently skipped scheduling. The new lifecycle never gets cron verification for the remainder of the session.
**Why it matters:** This is the exact failure mode Issue #182 targets. A missing cron goes undetected and unrestored. Correctness reviewer rates this critical; architecture reviewer confirms the invariant is not encoded and the race window could grow with future restart-timing changes.
**Fix:** Reset `cronVerificationPending = false` at the top of `start()`, alongside `this.stopRequested = false` and the `lifecycleGeneration` increment (line 135/140). This removes the race entirely. A generation-aware guard is an acceptable alternative but less clean.

## Warnings (should fix)

### 2. Missing lifecycle guard after 30-second stagger sleep
**File:** `src/daemon/agent-process.ts:937`
**Flagged by:** correctness (warning), security-perf (warning), architecture (warning) — agreement across all three reviewers
**Problem:** After `await sleep(30_000)` between gap nudges, the `for (const cronDef of crons)` inner loop does not re-check `generation !== this.lifecycleGeneration || this.status !== 'running'`. An agent with N stale crons holds the loop open for N × 30s past lifecycle death. The inner `if (this.pty && this.status === 'running')` guard on line 931 prevents actual injection, but the loop lingers, and security-perf flags that on a stop-during-stagger, nudges could theoretically reach the new lifecycle's PTY (outer guard only fires once per poll cycle).
**Fix:** Add `if (generation !== this.lifecycleGeneration || this.status !== 'running') return;` immediately after `await sleep(30_000)`, mirroring the while-loop guard pattern.

### 3. 30-minute idle wait has no feedback path on timeout
**File:** `src/daemon/agent-process.ts:992–994`
**Flagged by:** correctness (warning)
**Problem:** When `verifyCronsAfterIdle` times out at 30 minutes, it logs and returns with no remedial action and no retry. An agent receiving a large burst of gap nudges on a slow machine could still exceed 30 minutes; the silent drop means missing crons go undetected until the next restart.
**Fix:** Either (a) inject the verification prompt anyway on timeout (prefer verify-rather-than-skip), or (b) schedule a one-shot retry via another `scheduleCronVerification()` call. At minimum, raise the timeout log to `warn` level so operators can detect the pattern.

### 4. Duplicate `isDaemonShuttingDown()` guard block in `handleExit`
**File:** `src/daemon/agent-process.ts:405–430`
**Flagged by:** architecture (warning)
**Problem:** The `if (this.isDaemonShuttingDown()) { return; }` block appears twice with identical multi-paragraph comments (lines 387–407 and 409–430). The second block is dead code. Not introduced by this diff, but the diff touches surrounding code. Dead code in a crash/restart handler is dangerous — future authors may insert logic between the guards expecting it to run.
**Fix:** Remove the second `if (this.isDaemonShuttingDown()) { return; }` block (lines 409–430). Clean up as part of this PR since it already touches `handleExit`.

## Suggestions (nice to have)

### Performance / resource hardening
- **Synchronous blocking reads in 30-min polling loop** (`src/daemon/agent-process.ts:965–988`, security-perf): `verifyCronsAfterIdle` uses `existsSync` + `readFileSync` every 15s for up to 30 minutes (120 blocking reads on the event loop). Replace with `fs/promises` `stat`/`readFile`. Consider an `AbortController` so `stop()` can terminate the mid-wait waiter immediately rather than waiting for the next poll.
- **Unbounded `cronList` string in injected verification prompt** (`src/daemon/agent-process.ts:1003–1004`, security-perf): `expectedCrons.join(', ')` has no cap. Large fleet configs waste context tokens. Cap at e.g. first 20 names + `"... and N more"`.

### Code clarity
- **Stagger sleep inside conditional block** (`src/daemon/agent-process.ts:931–938`, correctness): The `await sleep(30_000)` sits inside `if (this.pty && this.status === 'running')`, so it only fires when a nudge is actually sent. This is correct behavior but contradicts the comment's framing of the stagger as unconditional protection. Either move the sleep outside the `if` block (safer) or update the comment to reflect the conditional nature.
- **Magic constant `30_000` for stagger sleep** (`src/daemon/agent-process.ts:937`, architecture): Extract `const GAP_STAGGER_MS = 30_000;` alongside `GAP_POLL_MS` and `GAP_MULTIPLIER` at the top of `runGapDetectionLoop`, with a comment explaining the rationale (prevent context-spike / ctx-watchdog restart).

### Test coverage
- **No test for `maxWaitMs` timeout branch** (`src/daemon/agent-process.ts:965`, architecture): The extension from 10 to 30 minutes is load-bearing for the fix but the timeout-expiry path (line 992) is untested. Add a `vi.useFakeTimers()` test that advances past 30 minutes without an idle flag update and verifies (a) `mockInjectMessage` is not called and (b) the log contains the timeout message.

## Points of Agreement

These issues were flagged independently by multiple reviewers — highest confidence.

1. **`cronVerificationPending` lifecycle reset missing** — flagged by **correctness** (critical) and **architecture** (warning). Both recommend resetting the flag at the start of `start()`. Correctness also offers a generation-aware guard as an alternative.

2. **Stagger sleep missing post-sleep lifecycle guard** — flagged by **all three reviewers** (correctness, security-perf, architecture). All three recommend the same fix: add the generation/status check immediately after `await sleep(30_000)`. This is the single most agreed-upon issue in the review set.

## What Looks Good

All reviewers inspected these areas and found nothing problematic — the author can treat these as solid.

- **`lifecycleGeneration` guard inside `verifyCronsAfterIdle`** (line 972): correctly bails the 30-minute polling loop on generation change, preventing stale waiter injection into a new lifecycle.
- **`.finally()` cleanup of `cronVerificationPending`**: correct idiom, fires on both success and failure, consistent with how `rateLimitTimer` is nulled. Architecture review explicitly calls this out as the right idiom.
- **Gap detection `loopStartedAt` cold-start handling** (line 916): treating the loop start as the implicit last fire on no-record is logically sound.
- **`parseInt(..., 10)` on idle flag timestamp** (lines 958, 980) and the `isNaN` guard on `lastFireMs` (line 919): correct.
- **Lifecycle generation increment in `start()`** (line 140): `++this.lifecycleGeneration` runs before `scheduleCronVerification()`, so the captured generation is always current.
- **`cronVerificationPending` field placement and naming**: consistent with `lifecycleGeneration` / `stopRequested` and follows the BUG-NNN annotation style.
- **Dedup guard placement** (checking the flag before capturing `generation`): strictly safer than letting a new waiter start and bail inside `verifyCronsAfterIdle`.
- **`maxWaitMs` scoping**: change is isolated to `verifyCronsAfterIdle`; `GAP_POLL_MS` is unchanged, which is correct (different cadences, different constants).
- **Stagger sleep order** (after injection, not before): first nudge goes out immediately, subsequent ones are staggered — the right order.
- **Security surface**: no new injection, authentication bypass, privilege escalation, or sensitive-data exposure. Injected strings originate from `config.json` (trusted) and are parsed through `parseDurationMs` before use. **No security issues found by the dedicated security reviewer.**
