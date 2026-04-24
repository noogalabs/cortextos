# Correctness Review — branch-2026-04-23

13 commits, reviewed 2026-04-24.

---

## Issue 1: `rateLimitBlock` reads the rate-limit marker file twice — prompt builders do an independent FS read instead of using the pre-captured `hadRateLimit` boolean

**Severity:** high
**File:** `src/daemon/agent-process.ts` (buildStartupPrompt / buildContinuePrompt)
**Problem:** `start()` captures `hadRateLimit = this.hasRateLimitMarker(stateDir)` and passes `recoveryNote` to both prompt builders. The marker is deleted only after `pty.spawn()` succeeds. However, inside both `buildStartupPrompt` and `buildContinuePrompt` the code makes a *second independent call* to `this.hasRateLimitMarker(stateDir)` to compute `rateLimitBlock`. This call is redundant — it reads the file system a second time when the value was already captured. More critically, the pre-captured `hadRateLimit` controls deletion, while the in-prompt call controls what the agent sees. If the two ever diverge (file deleted between calls, or a future refactor changes one path), the agent either gets the block but the marker is not cleaned up, or the marker is cleaned up but the block is absent. The fix is to thread `hadRateLimit` as a parameter so both prompt builders use the same value.

**Evidence:**
```ts
// start():
const hadRateLimit = this.hasRateLimitMarker(stateDir);
const prompt = mode === 'fresh'
  ? this.buildStartupPrompt(recoveryNote)   // does NOT receive hadRateLimit
  : this.buildContinuePrompt(recoveryNote); // does NOT receive hadRateLimit

// inside buildStartupPrompt():
const rateLimitBlock = this.hasRateLimitMarker(stateDir)  // second FS read
  ? ' RATE-LIMIT RECOVERY: ...'
  : '';
```

**Fix:** Add `hadRateLimit: boolean` as a second parameter to both prompt builders and remove the internal `hasRateLimitMarker` calls.

---

## Issue 2: `getOperatorChatCreds` uses `envChat` (operator env var) with an agent's `botToken` — mismatched token/chat pair causes crash-loop alerts to silently fail

**Severity:** high
**File:** `src/daemon/index.ts` line ~5768
**Problem:** The function enters Priority 2 (agent .env scan) only when `!(envChat && envToken)`. If `CTX_OPERATOR_CHAT_ID` is set but `CTX_OPERATOR_BOT_TOKEN` is missing, the code scans for an agent's `BOT_TOKEN` and then computes `chatId = envChat || chatMatch[1].trim()`, which evaluates to `envChat`. The result: a Telegram alert is sent using an *agent's* `BOT_TOKEN` paired with the *operator's* `CHAT_ID`. These almost certainly belong to different bots; the Telegram API rejects the send. The crash-loop alert silently fails at exactly the moment it is most needed.

**Evidence:**
```ts
// Priority 1 exits early if both are set. Falls through when envChat is set but envToken is missing:
const botToken = tokenMatch[1].trim();          // agent's token
const chatId = envChat || chatMatch[1].trim();  // ← uses operator's envChat
if (/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
  return { chatId, botToken };                 // mismatched pair
}
```

**Fix:** In Priority 2, always use the agent's own `chatMatch[1].trim()` as `chatId` regardless of whether `envChat` is set:
```ts
const chatId = chatMatch[1].trim();  // always use agent's own chatId in fallback
```

---

## Issue 3: `watchdogTriggered` is never reset after `hardRestartSelf` completes — the stdout-frozen and ctx-exhaustion watchdog is permanently silenced after its first trigger until the daemon restarts

**Severity:** high
**File:** `src/daemon/fast-checker.ts` (watchdogCheck, triggerHardRestart)
**Problem:** `triggerHardRestart` sets `this.watchdogTriggered = true`, which short-circuits all subsequent `watchdogCheck` calls. After the hard restart, the same `FastChecker` instance continues running (it is constructed once per agent in `AgentManager` — `hardRestartSelf` calls `stop()` + `start()` on the `AgentProcess` but does not recreate the `FastChecker`). On the next session, `watchdogTriggered` is still `true`, so the watchdog never fires again — not for frozen stdout, not for the ctx-exhaustion survey prompt, not for the 1M context billing gate — until the daemon itself is restarted.

Related: `ctxThresholdTriggeredAt` is also not reset. If the agent hits the threshold again in the new session quickly, `now - ctxThresholdTriggeredAt` may already exceed `CTX_THRESHOLD_FALLBACK_MS` (15 min), so the *fallback hard restart* fires on the first detection of the new session, skipping the graceful injection entirely.

**Evidence:**
```ts
private triggerHardRestart(reason: string): void {
  this.watchdogTriggered = true;               // ← never reset
  this.lastHardRestartAt = Date.now();
  ...
  this.agent.hardRestartSelf(reason).catch(...); // same FastChecker continues
}

private watchdogCheck(): void {
  if (this.watchdogTriggered) return;           // ← always true after first trigger
  ...
}
```

**Fix:** Reset `watchdogTriggered = false` and `ctxThresholdTriggeredAt = 0` when the agent successfully completes a new boot. The cleanest approach is a `resetWatchdogState()` method on `FastChecker` called from the post-bootstrap path in `start()`.

---

## Issue 4: `pollCycleWatchdog` interval can trigger a second restart before the first `hardRestartSelf` completes — async restart is not guarded against concurrent re-entry

**Severity:** medium
**File:** `src/daemon/fast-checker.ts` (pollCycleWatchdog setInterval callback)
**Problem:** When the stall watchdog fires, it calls `hardRestartSelf(...)` (async, not awaited) and then sets `this.lastPollCycleCompletedAt = now`. If `hardRestartSelf` takes longer than `WATCHDOG_INTERVAL_MS` (30s) to complete `stop()` + `start()`, the next watchdog tick may see `stallMs > STALL_THRESHOLD_MS` again (the poll loop is still stalled because the agent is mid-restart) and dispatch a second `hardRestartSelf` call concurrently. The circuit breaker provides the outer guard, but two concurrent `stop()` + `start()` sequences interleaved on the same `AgentProcess` can leave the PTY in an inconsistent state.

**Evidence:**
```ts
this.watchdogRestarts.push(now);
this.agent.hardRestartSelf(...).catch(err => {    // ← async, not awaited
  this.log(`Force-restart error: ${err}`);
});
this.lastPollCycleCompletedAt = now;              // ← reset, but restart is async
```

**Fix:** Set a `hardRestartInFlight: boolean` flag before calling `hardRestartSelf` and check it at the top of the stall check. Clear the flag in `.then()` and `.catch()`.

---

## Issue 5: `cronExpressionMinIntervalMs` result is not validated — a `NaN` or `0` return breaks both the gap threshold and the repeat-alert suppression

**Severity:** medium
**File:** `src/daemon/agent-process.ts` lines ~4841-4844 and ~4876-4879
**Problem:** The `monitorable` filter admits cron-expression entries unconditionally (`if (c.cron) return true`). In `runGapDetectionLoop`, `intervalMs = cronExpressionMinIntervalMs(cronDef.cron!)` is used without validation. If the cron expression is malformed or very frequent (e.g., `* * * * *`), `cronExpressionMinIntervalMs` may return `NaN` or `0`. Downstream:

- `threshold = intervalMs * GAP_MULTIPLIER` → `NaN` or `0`
- `gapMs > NaN` is always `false` → gap never detected
- `now - lastAlerted < NaN` is always `false` → repeat-alert suppression never fires → every 10-min poll injects a new nudge

**Evidence:**
```ts
// monitorable filter — cron expressions admitted without validation:
if (c.cron) return true;   // no isNaN/> 0 guard

// runGapDetectionLoop:
const intervalMs = cronDef.interval
  ? parseDurationMs(cronDef.interval)
  : cronExpressionMinIntervalMs(cronDef.cron!);  // could be NaN or 0

const threshold = intervalMs * GAP_MULTIPLIER;   // NaN → gap never fires
if (now - lastAlerted < intervalMs) continue;   // NaN → suppression never fires
```

**Fix:** Mirror the existing interval guard in the monitorable filter:
```ts
if (c.cron) {
  const ms = cronExpressionMinIntervalMs(c.cron);
  return !isNaN(ms) && ms > 0;
}
```

---

## Issue 6: `buildStartupPrompt` places `recoveryBlock` and `rateLimitBlock` after `onboardingAppend` — recovery instructions buried after onboarding content

**Severity:** medium
**File:** `src/daemon/agent-process.ts` line ~4757
**Problem:** The prompt template ends with `...${onboardingAppend}${recoveryBlock}${rateLimitBlock}`. When `onboardingAppend` is populated (new agent, heartbeat-without-.onboarded case), it can be substantial. The watchdog recovery note is the most urgent instruction — if an agent is recovering from a crash-induced git rollback AND happens to trigger the onboarding path, the recovery instruction appears after the onboarding content and may be deprioritized or missed. The old code had an explicit comment warning about placement order for the handoff block; the same principle applies here.

**Evidence:**
```ts
return `...${onboardingAppend}${recoveryBlock}${rateLimitBlock}`;
//           ^^^^^^^^^^^^^^^^ may be long before recovery
```

**Fix:** Swap the order so recovery instructions precede onboarding:
```ts
return `...${recoveryBlock}${rateLimitBlock}${onboardingAppend}`;
```

---

## Issue 7: `performRollback` does not set `last_healthy` to the rollback target — the rollback anchor is not established until `markHealthy` fires 60s later, leaving a gap where a second rollback targets `origin/main` over the network

**Severity:** medium
**File:** `src/daemon/watchdog.ts` (performRollback)
**Problem:** After a successful `git reset --hard <target>`, `performRollback` deletes the failed commit's failure count but does NOT update `stability.last_healthy`. This field is only updated by `markHealthy`, which fires after `MIN_HEALTHY_SECONDS` (60s) of uptime. If the agent crashes again before 60s — for any reason, not necessarily the same bug — `shouldRollback` will be evaluated again. With no `last_healthy` anchor, the code falls through to `fetch origin/main`. If the network is unavailable, the rollback fails with "no healthy commit, fetch failed". This is a correctness gap because the rollback target (a known-good commit) exists but is not recorded.

**Evidence:**
```ts
// performRollback — after successful git reset:
stability.last_rollback_at = new Date().toISOString();
delete stability.restart_counts[failedCommit];
saveStability(stateDir, stability);
// ↑ last_healthy is NOT set to `target` here
```

**Fix:** Set `stability.last_healthy = target` inside `performRollback` after the successful reset:
```ts
stability.last_healthy = target;          // anchor the known-good commit
stability.last_rollback_at = new Date().toISOString();
delete stability.restart_counts[failedCommit];
```

---

## Issue 8: `deleteRateLimitMarker` uses `require('fs').unlinkSync` when `unlinkSync` is already a named static import at the top of the file

**Severity:** low
**File:** `src/daemon/agent-process.ts` line ~4678
**Problem:** The static import at the top of the file already includes `unlinkSync`:
`import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';`
But `deleteRateLimitMarker` uses a dynamic `require('fs').unlinkSync`. This is functionally identical at runtime but is inconsistent with the rest of the file and defeats static analysis.

**Evidence:**
```ts
private deleteRateLimitMarker(stateDir: string): void {
  try {
    const { unlinkSync } = require('fs');  // ← redundant dynamic require
    unlinkSync(join(stateDir, '.rate-limited'));
  } catch { /* ignore */ }
}
```

**Fix:** Remove the `require` line and call the statically-imported `unlinkSync` directly.

---

## Issue 9: `checkUsageTier` uses `execFile('cortextos', ...)` while the heartbeat in the same class was switched to `exec(...)` — inconsistent PATH resolution behavior

**Severity:** low
**File:** `src/daemon/fast-checker.ts` line ~5530
**Problem:** The heartbeat timer was intentionally changed from `execFile('cortextos', ...)` to `exec('cortextos bus update-heartbeat ...')` in this branch. The stated reason is that `exec` spawns a shell which correctly resolves `cortextos` on systems where it is installed via npm link or nvm. `checkUsageTier` still uses `execFile('cortextos', ['bus', 'check-usage-api', '--json'], ...)`. On systems where `cortextos` is not on `execFile`'s PATH, usage checks will silently fail with ENOENT, and the usage-tier guard will never fire — meaning the rate-limit protection is silently disabled.

**Evidence:**
```ts
// Heartbeat (updated to exec):
exec(`cortextos bus update-heartbeat "..."`, (err) => { ... });

// checkUsageTier (still uses execFile):
execFile('cortextos', ['bus', 'check-usage-api', '--json'], { timeout: 10_000 }, (err, stdout) => { ... });
```

**Fix:** Switch `checkUsageTier` to use `exec` for consistency, or use `execFileSync` with the resolved binary path from `process.execPath`.

---

## Issue 10: `validateCredentials` classifies any `Forbidden` error from `getChat` as `bot_recipient` — overbroad; kicks/bans also return 403

**Severity:** low
**File:** `src/telegram/api.ts` line ~7572
**Problem:** The error pattern `/bots can.?t send messages to bots|Forbidden/i` maps all 403 responses from `getChat` to `bot_recipient`. A bot being kicked from a group, a private chat where the user blocked the bot, or a supergroup where the bot lacks send permissions all return 403. In these cases the error message shown to the operator ("CHAT_ID resolves to a bot") is factually wrong, which can send them troubleshooting in the wrong direction.

**Evidence:**
```ts
if (/bots can.?t send messages to bots|Forbidden/i.test(msg)) {
  return { ok: false, reason: 'bot_recipient', detail: chatIdStr };
  // ↑ 'Forbidden' alone captures kick/ban/permission cases
}
```

**Fix:** Remove the bare `Forbidden` alternative and match only the specific bot-to-bot error string:
```ts
if (/bots can.?t send messages to bots/i.test(msg)) {
  return { ok: false, reason: 'bot_recipient', detail: chatIdStr };
}
// Other 403s fall through to network_error
```

---

## Summary

| Severity | Count | Issues |
|----------|-------|--------|
| Critical | 0 | — |
| High | 3 | 1 (dual rate-limit marker read), 2 (mismatched token/chat in crash alert), 3 (watchdog permanently silenced after first trigger) |
| Medium | 4 | 4 (concurrent watchdog restarts), 5 (NaN/0 interval for cron expressions), 6 (recovery block buried after onboarding), 7 (rollback target not anchored as healthy) |
| Low | 3 | 8 (redundant dynamic require), 9 (execFile vs exec inconsistency), 10 (Forbidden overmatch in validateCredentials) |
| **Total** | **10** | |

**Highest priority to fix before shipping:** Issues 2 and 3. Issue 2 causes crash-loop Telegram alerts to silently fail using a mismatched bot/chat pair — the one moment the alert system is most needed. Issue 3 permanently disables the stdout-frozen and ctx-exhaustion watchdog for an agent after the first trigger, leaving it dark until the daemon itself restarts.
