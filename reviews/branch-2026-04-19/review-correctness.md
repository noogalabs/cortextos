# Correctness Review — branch-2026-04-19

Scope: `src/daemon/agent-process.ts` (diff reviewed in full, surrounding context read).

---

## cronVerificationPending Reset on Lifecycle Change

**File:** `src/daemon/agent-process.ts:858–861`
**Severity:** critical
**What is wrong:** `cronVerificationPending` is set to `true` at the start of `scheduleCronVerification()` and cleared in a `.finally()` on `verifyCronsAfterIdle`. `verifyCronsAfterIdle` can run for up to 30 minutes. If the agent stops and is restarted within that 30-minute window, `scheduleCronVerification()` returns early at the guard check (line 850) because `cronVerificationPending` is still `true` from the old in-flight waiter. The old waiter detects the stale generation and exits at the lifecycle check inside `verifyCronsAfterIdle` (line 972), which then resolves the promise and `.finally()` clears the flag — but only after the new lifecycle has already called `scheduleCronVerification()` and silently skipped it. The new lifecycle therefore never gets cron verification.
**Why it matters:** After a rapid-restart sequence (e.g. --continue restart during a busy boot), the agent's crons go unverified permanently for that session. A missing cron would not be detected or restored. This is the exact failure mode Issue #182 is trying to prevent, but the fix re-introduces it for the restart case.
**What needs to change:** `cronVerificationPending` must be reset when a new lifecycle begins. The cleanest fix is to reset it at the top of `start()`, alongside the existing `this.stopRequested = false` reset (line 135). Alternatively, make the guard generation-aware: skip only if the pending flag is true AND the current generation matches the one the waiter was started under. Store the generation when setting the flag:

```typescript
private cronVerificationPendingGeneration: number = -1;

// In scheduleCronVerification():
if (this.cronVerificationPending && this.cronVerificationPendingGeneration === this.lifecycleGeneration) {
  this.log('Cron verification already pending — skipping duplicate');
  return;
}
this.cronVerificationPending = true;
this.cronVerificationPendingGeneration = this.lifecycleGeneration;
```

---

## Nudge Stagger Sleep Ignores Lifecycle Staleness

**File:** `src/daemon/agent-process.ts:937`
**Severity:** warning
**What is wrong:** After injecting a gap nudge, the code calls `await sleep(30_000)` (30 seconds) before moving to the next cron. The surrounding loop checks `generation !== this.lifecycleGeneration || this.status !== 'running'` at the top of each `while(true)` iteration, but NOT immediately after the `sleep(30_000)` inside the inner `for` loop. If the agent stops or restarts during the 30-second sleep, the next loop iteration does check the guard — but only after the full `GAP_POLL_MS` (10 min) sleep that follows, not immediately after the stagger sleep.

More specifically: after `await sleep(30_000)` the `for` loop continues to the next `cronDef`. If the agent has stopped by then, `this.pty` will be `null` (nulled in `stop()`) so `injectMessage` won't fire, but the code still evaluates the next cron and sleeps another 30 seconds per stale cron, holding the loop alive for up to `N_crons * 30s` past lifecycle death.
**Why it matters:** Low practical risk because the guard before `injectMessage` (`this.pty && this.status === 'running'`) prevents actual injection, but the loop remains live and burning for up to several minutes past agent stop. On a rapid-restart scenario with many stale crons, multiple overlapping gap loops could pile up in the 10-min poll gap before the while-loop guard catches them.
**What needs to change:** Add a lifecycle guard immediately after the stagger sleep, mirroring the while-loop check:

```typescript
await sleep(30_000);
if (generation !== this.lifecycleGeneration || this.status !== 'running') return;
```

---

## 30-Minute Idle Wait Has No Feedback Path on Timeout

**File:** `src/daemon/agent-process.ts:992–994`
**Severity:** warning
**What is wrong:** When `verifyCronsAfterIdle` times out after 30 minutes, it logs a message and returns without taking any remedial action. The `cronVerificationPending` flag is cleared by `.finally()`, so a subsequent call to `scheduleCronVerification()` could re-queue the check. However, nothing triggers a re-queue. The caller (`scheduleCronVerification`) is only ever called from the agent startup path. If a slow boot causes the 30-minute timeout, cron verification is permanently skipped for that lifecycle with no retry and no alert to the agent.
**Why it matters:** The problem that drove the timeout increase from 10 to 30 minutes (agents busy with gap nudges during startup) is still not structurally resolved — it is only mitigated. An agent receiving a large burst of gap nudges on a very slow machine could still exceed 30 minutes. The silent drop means missing crons go undetected until the next restart.
**What needs to change:** On timeout, either: (a) inject the verification prompt anyway (accepting the risk of mid-conversation injection, but defaulting to "verify rather than skip"), or (b) schedule a one-shot retry after a short delay by calling `scheduleCronVerification()` again. At minimum, the timeout log message should be surfaced at `warn` level rather than `info`/debug so operators can detect the pattern.

---

## Stagger Sleep Added Inside Condition That Checks `this.pty`

**File:** `src/daemon/agent-process.ts:931–938`
**Severity:** suggestion
**What is wrong:** The `await sleep(30_000)` is inside the `if (this.pty && this.status === 'running')` block. This means the stagger only applies when a nudge is actually sent. If `this.pty` is null (agent stopped between gap detection and nudge delivery), the sleep is skipped and all remaining crons are evaluated immediately in the same loop tick. This is actually correct behavior — no point staggering when nothing is injected — but it creates a subtle asymmetry: the stagger is meant to protect the agent from burst context pressure, but it only fires when the agent is already running. If the agent bounces between `running` and `stopped` during the inner loop, the stagger is inconsistent.
**Why it matters:** Low risk in practice, but the comment at line 933–936 describes the stagger as unconditional protection against burst injections, while the implementation is conditional. Future readers may add nudge injection outside the `if` block without realizing the sleep needs to move with it.
**What needs to change:** Either move the `sleep(30_000)` outside the `if` block to match the documented intent, or update the comment to clarify it only fires when a nudge is actually sent. The former is safer.

---

## No issues found

The following areas were reviewed and are correct:

- **lifecycleGeneration guard in `verifyCronsAfterIdle`** (line 972): correctly bails the 30-minute polling loop if the generation changes, preventing a stale waiter from injecting into a new lifecycle.
- **`.finally()` cleanup of `cronVerificationPending`**: correctly fires on both success and failure paths.
- **Gap detection `loopStartedAt` cold-start handling** (line 916): treating the loop start as the implicit last fire on no-record is logically sound for the stated goal.
- **`parseInt(..., 10)` on the idle flag timestamp** (line 958, 980): correctly uses radix 10. The `isNaN` guard on `lastFireMs` (line 919) is present and correct.
- **Lifecycle generation increment in `start()`** (line 140): `++this.lifecycleGeneration` before `scheduleCronVerification()` is called, so the generation captured by the new waiter is always the current one.
