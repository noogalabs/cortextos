# Implementation Plan — branch — 2026-04-19

## Summary

The Issue #182 diff to `src/daemon/agent-process.ts` (cron-verification dedup, gap-nudge stagger, 30-minute idle extension) is directionally correct but has one critical lifecycle-reset bug and several tight-loop lifecycle guards missing. This plan fixes all issues flagged in the synthesis. All changes are isolated to `src/daemon/agent-process.ts` with one small test addition. Estimated scope: ~10 edits in a single file, plus one new test case — roughly 1.5–2 hours of implementation + build/test verification.

## Fix Plan

### Fix 1: Reset `cronVerificationPending` on lifecycle start
**File(s):** `src/daemon/agent-process.ts:135` (inside `start()`)
**Priority:** critical
**Approach:** The flag is cleared only in the `.finally()` of `verifyCronsAfterIdle`, which can run up to 30 minutes. If the agent stops/restarts while a waiter is mid-poll, the new lifecycle's call to `scheduleCronVerification()` bails at the dedup guard (line 850) because the flag is still `true` from the old in-flight waiter. The old waiter eventually exits and clears the flag, but by then the new lifecycle has already silently skipped scheduling — no cron verification for the remainder of the session. Fix by resetting the flag at the top of `start()`, immediately alongside the existing `stopRequested = false` reset and the `lifecycleGeneration` bump. This is the same pattern already used for `stopRequested`: "new lifecycle = clean state". The orphaned old waiter will still self-terminate at its own generation check (line 972), so no leaked injections.
**Code change:**
Replace the block at lines 132–140:
```typescript
    // BUG-040 fix: clear any stale stop request from a previous lifecycle
    // (e.g. if the previous stop() timed out before the PTY actually exited).
    // We're starting fresh — the new PTY has no pending stop.
    this.stopRequested = false;
    // Issue #182 fix: clear any stale cron-verification pending flag from a
    // previous lifecycle. The old waiter (if any) will self-terminate at its
    // generation check; we must not let its stale flag block the new lifecycle
    // from scheduling its own verification.
    this.cronVerificationPending = false;
    // BUG-040 fix: bump generation. The onExit closure below captures THIS
    // value and uses it to detect "I'm an old PTY whose exit fired after a
    // new lifecycle began" — in which case it bails out without touching
    // handleExit, preventing spurious crash recovery on the new agent.
    const myGeneration = ++this.lifecycleGeneration;
```
**Test:** Unit test that calls `start()` → simulates long-running waiter (flag still true) → calls `stop()` → calls `start()` again → asserts `cronVerificationPending === false` after the second start and that `scheduleCronVerification()` does NOT bail at the dedup guard. Also verify that the original in-flight waiter still bails at its generation check without injecting.

---

### Fix 2: Add lifecycle guard after the 30-second stagger sleep in `runGapDetectionLoop`
**File(s):** `src/daemon/agent-process.ts:937`
**Priority:** warning (unanimous across all three reviewers)
**Approach:** After `await sleep(30_000)`, the inner `for (const cronDef of crons)` loop continues without re-checking generation/status. If the lifecycle dies mid-stagger, the loop can burn N × 30s before the next outer while-loop guard fires. The inner `if (this.pty && this.status === 'running')` guard prevents the actual `injectMessage`, but a stop-during-stagger could still theoretically reach the new lifecycle's PTY if a restart completes during those 30s. Fix by adding the same generation/status check used at the top of the while loop (line 901) immediately after the sleep.
**Code change:**
Replace lines 931–938:
```typescript
          if (this.pty && this.status === 'running') {
            injectMessage((data) => this.pty!.write(data), nudge);
            // Stagger: wait between nudges so the agent can process each one
            // before the next arrives. Without this, N simultaneous stale crons
            // fire N back-to-back injections, spiking context and triggering
            // ctx-watchdog restarts. (Issue #182)
            await sleep(GAP_STAGGER_MS);
            // Bail if the lifecycle changed or agent stopped during the stagger.
            // Without this check, a stop-during-stagger could hold the loop open
            // for up to N * 30s past lifecycle death, and a restart completing
            // inside that window could theoretically reach the new PTY.
            if (generation !== this.lifecycleGeneration || this.status !== 'running') return;
          }
```
(Note: `GAP_STAGGER_MS` is the extracted constant added by Fix 7.)
**Test:** Unit test that starts `runGapDetectionLoop` with 3 stale crons, lets the first nudge fire, then inside the stagger sleep bumps `lifecycleGeneration` — assert only 1 `injectMessage` call, no further calls after the generation bump.

---

### Fix 3: Feedback path on 30-minute idle-wait timeout
**File(s):** `src/daemon/agent-process.ts:992–994`
**Priority:** warning
**Approach:** On timeout, current code logs at default level and returns silently. Per synthesis recommendation (a): prefer verify-rather-than-skip — inject the verification prompt anyway rather than silently dropping. This matches the conservative bias of the rest of the fix (the whole point of Issue #182 is "don't silently skip verification"). We still gate on `this.pty && this.status === 'running'` and re-check generation so we don't inject into a dead/new lifecycle. Also elevate the log to `warn`-style visibility by prefixing `WARN:` so operators can grep for the pattern (the `this.log` method does not have level support; prefix is the established convention in this file).
**Code change:**
Replace lines 990–1009:
```typescript
    // If the loop timed out without detecting an idle transition, we still want
    // to inject the verification prompt — dropping it silently is the exact
    // failure mode Issue #182 targets. The agent may be slow but alive; better
    // to inject a late verification than skip it entirely. Still gate on the
    // lifecycle check and PTY readiness so we never target a dead or new agent.
    if (!foundIdle) {
      this.log('WARN: Cron verification: timed out waiting for idle flag after 30 minutes — injecting anyway');
    }

    // Final stale check
    if (generation !== this.lifecycleGeneration || this.status !== 'running') {
      return;
    }

    // Inject the verification prompt (cap cron list to prevent unbounded token spend — see Fix 6)
    const MAX_CRON_NAMES = 20;
    const shown = expectedCrons.slice(0, MAX_CRON_NAMES);
    const remaining = expectedCrons.length - shown.length;
    const cronList = remaining > 0
      ? `${shown.join(', ')}, ... and ${remaining} more`
      : shown.join(', ');
    const verifyPrompt = `[SYSTEM] Cron verification: your config.json defines these recurring crons: ${cronList}. Run CronList now. If any are missing, restore them from config.json using /loop. This is an automated safety check.`;

    this.log(`Injecting cron verification (expecting: ${cronList})`);
    if (this.pty) {
      injectMessage((data) => this.pty!.write(data), verifyPrompt);
    }
```
**Test:** `vi.useFakeTimers()` test: start `verifyCronsAfterIdle`, advance clock past 30 minutes without touching `last_idle.flag`, assert `injectMessage` IS called exactly once and the log includes `'WARN:'` and `'timed out'`. (This also serves as the missing timeout-branch test from the synthesis's test-coverage suggestion.)

---

### Fix 4: Remove duplicate `isDaemonShuttingDown()` guard block in `handleExit`
**File(s):** `src/daemon/agent-process.ts:409–430`
**Priority:** warning
**Approach:** Lines 386–407 and 409–430 are byte-identical comment + guard blocks. The second is dead code. Remove the duplicate entirely. Keep lines 386–407 untouched. This is a pure deletion — no logic change.
**Code change:**
Delete lines 409–430 (the entire second occurrence of the comment block plus its `if (this.isDaemonShuttingDown()) { return; }`). After the edit, line 407's closing `}` should be followed directly by the blank line preceding the `// BUG-040 fix: check stopRequested...` comment block.
**Test:** Build must compile cleanly. Existing `handleExit` unit/integration tests (daemon shutdown during stop) must still pass — behavior is identical because the dead block was unreachable anyway.

---

### Fix 5: Replace synchronous `existsSync` + `readFileSync` with `fs/promises`
**File(s):** `src/daemon/agent-process.ts:956–960, 978–987`
**Priority:** suggestion
**Approach:** `verifyCronsAfterIdle` polls every 15s for up to 30 minutes — up to 120 blocking event-loop reads. Replace with async `fs/promises` `stat`/`readFile`. Check the existing imports at the top of the file; if `fs/promises` is not already imported, add it. `existsSync` is replaced by catching ENOENT from `stat` or `readFile`. We do NOT introduce an AbortController in this PR (synthesis lists that as an optional further improvement) — the existing generation check on each poll iteration already bounds stale-lifecycle damage to one 15s poll window.
**Code change:**
At the top of the file, add to imports (adjust grouping to match existing style):
```typescript
import { readFile, stat } from 'node:fs/promises';
```
(If `existsSync`/`readFileSync` are imported from `node:fs` and used elsewhere in the file, leave the existing import alone — only *add* the promises imports. If they are not used elsewhere in the file after this change, remove them from the existing import.)

Replace lines 955–960:
```typescript
    // Record the idle flag timestamp at boot so we can detect the NEXT idle
    // (i.e. after the agent has finished processing its startup prompt).
    let bootIdleTs = 0;
    try {
      const raw = await readFile(flagPath, 'utf-8');
      bootIdleTs = parseInt(raw.trim(), 10);
      if (isNaN(bootIdleTs)) bootIdleTs = 0;
    } catch { /* flag may not exist yet — treat as 0 */ }
```

Replace lines 978–987:
```typescript
      try {
        const raw = await readFile(flagPath, 'utf-8');
        const currentIdleTs = parseInt(raw.trim(), 10);
        if (!isNaN(currentIdleTs) && currentIdleTs > bootIdleTs) {
          // Agent has gone idle after boot — safe to inject
          foundIdle = true;
          break;
        }
      } catch { /* ignore read errors (ENOENT, transient), keep polling */ }
```
**Test:** `npm run build` passes. Existing verification tests pass. Optionally add a test that spins up `verifyCronsAfterIdle` against a real tmp dir, writes to the flag asynchronously, and confirms `foundIdle` trips without blocking the event loop (use `setImmediate` spy).

---

### Fix 6: Cap the injected cron list
**File(s):** `src/daemon/agent-process.ts:1003–1004`
**Priority:** suggestion
**Approach:** `expectedCrons.join(', ')` has no upper bound. Cap at 20 names + `"... and N more"`. Already folded into the code block for Fix 3 above — this entry documents the reasoning. Matches synthesis suggestion verbatim.
**Code change:** See Fix 3. No separate edit.
**Test:** Unit test with 25 cron names; assert the injected prompt contains only the first 20 + `"... and 5 more"`.

---

### Fix 7: Extract `GAP_STAGGER_MS` constant and move stagger sleep clarification
**File(s):** `src/daemon/agent-process.ts:893–944`
**Priority:** suggestion (clarity + magic-constant cleanup)
**Approach:** Extract `30_000` into a named constant alongside `GAP_POLL_MS` and `GAP_MULTIPLIER` at the top of `runGapDetectionLoop`. Simultaneously address the synthesis "stagger sleep inside conditional" note by leaving the sleep inside the `if (this.pty && this.status === 'running')` block (safer: don't sleep if we didn't actually nudge) and updating the comment to accurately reflect that the stagger is conditional on an actual injection.
**Code change:**
Replace lines 893–894:
```typescript
    const GAP_POLL_MS = 10 * 60 * 1000;
    const GAP_MULTIPLIER = 2.0;
    // Stagger between successive nudges to avoid a burst of N injections in
    // one tick. Prevents the context-spike / ctx-watchdog restart that
    // originally motivated Issue #182. Only applied when an injection actually
    // fires (see stagger block below).
    const GAP_STAGGER_MS = 30_000;
```
The conditional `sleep(GAP_STAGGER_MS)` inside the `if (this.pty && this.status === 'running')` block remains (as modified by Fix 2).
**Test:** Build passes. Behavior unchanged.

---

### Fix 8: Add missing timeout-branch test for `verifyCronsAfterIdle`
**File(s):** `tests/daemon/agent-process.test.ts` (or nearest existing test file for `AgentProcess` — grep for existing `scheduleCronVerification` / `verifyCronsAfterIdle` tests to locate)
**Priority:** suggestion (test coverage)
**Approach:** The maxWaitMs extension from 10 to 30 minutes is load-bearing for Issue #182 but the timeout-expiry path is untested. Add a `vi.useFakeTimers()` test that:
1. Constructs an `AgentProcess` with a fake PTY/status.
2. Calls `scheduleCronVerification()` with known recurring crons.
3. Does NOT update `last_idle.flag`.
4. Advances the clock past 30 minutes.
5. Post-Fix-3 behavior: asserts `injectMessage` WAS called once (the "inject anyway on timeout" branch) AND the log contains `'WARN:'` + `'timed out'`.
6. Restores real timers.

This test guards both Fix 3 (the timeout now injects instead of silently dropping) and the base extension from 10→30 min.
**Code change:** Concrete test file location should be determined by `rg 'verifyCronsAfterIdle|scheduleCronVerification' tests/` at implementation time. If no existing test file covers this class, create `tests/daemon/agent-process-cron-verification.test.ts` following the existing test-style conventions.
**Test:** The test itself is the verification. `npm test` must pass.

---

## Order of Operations

Apply in this sequence to avoid dependency conflicts:

1. **Fix 1** (reset `cronVerificationPending` in `start()`) — critical, independent, apply first.
2. **Fix 4** (delete duplicate guard block) — pure deletion, no dependencies, do next to shrink line-number churn before the other edits.
3. **Fix 7** (extract `GAP_STAGGER_MS` constant) — must precede Fix 2, which references the constant.
4. **Fix 2** (post-stagger lifecycle guard) — depends on Fix 7's constant.
5. **Fix 5** (async fs in `verifyCronsAfterIdle`) — independent, but touches the same function as Fix 3/6; apply before them so Fix 3's edits land on the updated async skeleton.
6. **Fix 3 + Fix 6** (timeout injection + cron-list cap) — combined edit as shown in the Fix 3 code block.
7. **Fix 8** (test) — last, after all behavior changes are in place.

After each of steps 1–6, run `npm run build` to confirm TypeScript still compiles. After step 7, run `npm test`.

## Risk

- **Fix 1 interaction with orphaned waiters:** Resetting `cronVerificationPending` on a new lifecycle means the old waiter's `.finally()` will still run and reset the flag a second time — but since the new lifecycle may have already set it `true` again by then, the second reset could clobber an in-flight waiter on the NEW lifecycle. Watch for this: the old waiter self-terminates at the generation check (line 972) BEFORE reaching `.finally()`, so `.finally()` fires on return from that early bail. If a new waiter started in the meantime, its flag would be cleared prematurely. Mitigation: the old waiter's `.finally()` runs so quickly after generation-check bail that it almost certainly fires BEFORE the new `start()` triggers `scheduleCronVerification()`. But to be safe, consider making the flag generation-aware (store the generation that set it, only clear in `.finally()` if the current generation matches). If implementation time allows, prefer the generation-aware variant. If not, accept the small residual race (much smaller than the original bug) and document it.

- **Fix 3 (inject-on-timeout) on a wedged agent:** If the agent is genuinely stuck (not slow but hung), injecting another prompt won't help and may queue a stale message in the PTY. Acceptable: the nudge sits in the PTY buffer until the agent recovers; if the agent never recovers, the watchdog restart path handles it separately.

- **Fix 5 (async fs) test flakiness:** `vi.useFakeTimers()` interacts awkwardly with real `fs/promises` calls. The timeout test (Fix 8) may need `vi.advanceTimersByTimeAsync()` rather than `vi.advanceTimersByTime()` to correctly flush pending promise microtasks between poll iterations. Watch for hangs in the test.

- **Fix 4 (delete dead block):** Zero behavior risk — the block was unreachable because the identical guard above it returns unconditionally on the same condition. Only risk is if some unseen external patch inserted code between the two guards that we'd delete; `git diff` before commit to confirm only the intended range is removed.

- **No risk expected on:** Fix 2, Fix 6, Fix 7 — these are tightening/clarifying existing correct logic. Lifecycle guard additions can only cause early return, never incorrect continuation.
