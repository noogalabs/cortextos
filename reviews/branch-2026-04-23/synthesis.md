# Code Review Synthesis — 2026-04-23

Consolidated findings from three parallel Stage 1 reviews (Correctness, Security & Performance, Architecture) covering 13 commits.

---

## Top 5 Must-Fix Issues

### 1. `FastChecker.watchdogTriggered` permanently silenced after first trigger

**Severity:** critical
**Caught by:** Correctness (Issue 3), Architecture (Issue 1)
**File:** `src/daemon/fast-checker.ts` (triggerHardRestart ~line 487, watchdogCheck ~line 404, start ~line 188)

`triggerHardRestart()` sets `this.watchdogTriggered = true` to prevent double-triggers. The flag is only cleared inside `FastChecker.start()`, which runs once per daemon lifecycle. `hardRestartSelf()` restarts the agent (`AgentProcess.stop()+start()`) but the same `FastChecker` instance keeps running — it never re-enters `start()`. After the first trigger, the ctx-exhaustion survey, 1M billing gate, and frozen-stdout detector (Signals 1/2/4) are silenced for the remainder of the daemon's life. `ctxThresholdTriggeredAt` has the same problem — it may already exceed `CTX_THRESHOLD_FALLBACK_MS` on next trigger, skipping the graceful injection entirely.

**Fix:** Add a `resetWatchdogState()` method on `FastChecker` that resets `watchdogTriggered`, `ctxThresholdTriggeredAt`, `bootstrappedAt`, `stdoutLastChangeAt`, and `lastHardRestartAt`. Call from the agent-status `running` transition (post-bootstrap).

---

### 2. Bot token exposed in process argv during crash-loop alert

**Severity:** high
**Caught by:** Security & Performance (Issue 2)
**File:** `src/daemon/index.ts` (sendCrashLoopAlertBestEffort, ~lines 5796-5802)

`spawnSync('curl', [...])` embeds the bot token in the URL argument. On Linux/macOS, process args are visible to all users via `ps aux` and `/proc/<pid>/cmdline`. During a crash storm this fires repeatedly, transiently exposing the token system-wide.

**Fix:** Use `curl -K -` to read config from stdin (invisible in `ps`), or write a temp config file via `mkstemp`, `--config <path>`, then delete. Token must never appear in argv.

---

### 3. Shell-escape regression in heartbeat + mismatched token/chat pair in crash alerts

**Severity:** high (two closely-related daemon-alert problems)
**Caught by:** Security & Performance (Issue 1), Correctness (Issue 2)
**File:** `src/daemon/fast-checker.ts` (~line 5064), `src/daemon/index.ts` (~line 5768)

Two defects in the same alerting subsystem:
- **Shell-escape regression:** Heartbeat call was changed from `execFile` to a shell-exec variant, interpolating `agentName` into a shell string. No shell features are needed — this is pure defense-in-depth regression and a latent injection surface.
- **Mismatched credentials:** `getOperatorChatCreds` Priority 2 computes `chatId = envChat || chatMatch[1].trim()`. If `CTX_OPERATOR_CHAT_ID` is set but `CTX_OPERATOR_BOT_TOKEN` is not, the code pairs the operator's chat id with an agent's bot token. The Telegram API rejects the send — crash-loop alerts silently fail at exactly the moment they're most needed.

**Fix:** Revert heartbeat to `execFile('cortextos', ['bus', 'update-heartbeat', ...])`. In `getOperatorChatCreds` Priority 2, always use the agent's own `chatMatch[1].trim()` as chatId.

---

### 4. `performRollback` runs synchronous `git fetch`/`reset` without timeout in the exit-callback chain

**Severity:** high
**Caught by:** Security & Performance (Issue 5), Architecture (Issue 9), Correctness (Issue 7 — related gap)
**File:** `src/daemon/watchdog.ts` (performRollback, ~lines 6137-6154, reset at ~line 284)

`performRollback()` uses synchronous `execFileSync` with no `timeout` for `git fetch origin main`, blocking the Node.js event loop for the OS TCP timeout (~75-120s) on slow/unreachable networks. It's called from `AgentProcess.handleExit()` (the PTY exit-callback chain). One hung fetch freezes message delivery, Telegram polling, and all other agent operations across the entire daemon. During a crash storm, the daemon can be unresponsive for minutes.

Related (Correctness Issue 7): after a successful `git reset --hard <target>`, `performRollback` does not set `stability.last_healthy = target`. A second rollback before `markHealthy` fires (60s) has no anchor and falls through to the network fetch — which then hangs.

**Fix:** Add `timeout: 15_000` to every `execFileSync` call in `watchdog.ts`. Set `stability.last_healthy = target` inside `performRollback` immediately after the successful reset so re-entry has an anchor. Consider moving the rollback off the exit critical path via `setImmediate()`.

---

### 5. `rateLimitTimer` leak in `stop()` — orphaned restart after explicit stop

**Severity:** high
**Caught by:** Architecture (Issue 2)
**File:** `src/daemon/agent-process.ts` (stop ~line 203, handleExit ~line 461)

`stop()` was updated in this diff to clear `healthTimer` and `sessionTimer` but not `rateLimitTimer`. If an agent exits with a rate-limit signature and is then stopped externally (via `cortextos stop`, daemon shutdown, or IPC `restart-agent`), the rate-limit timer fires after `pauseSeconds` and calls `this.start()` on a stopped agent — potentially re-animating an agent the operator explicitly stopped. The `status === 'rate-limited'` guard is fragile (race window + one refactor away from silent reopen).

**Fix:** Add explicit clear at the top of `stop()`:
```ts
if (this.rateLimitTimer) { clearTimeout(this.rateLimitTimer); this.rateLimitTimer = null; }
```

---

## Full Issue Register

Ranked by severity (critical → low). Deduped items merge all three reviewers' observations under one entry.

### Critical (1)

| # | Title | Reviews | File |
|---|-------|---------|------|
| C1 | `FastChecker.watchdogTriggered` never reset after hard-restart — watchdog permanently disabled | Correctness 3, Architecture 1 | `src/daemon/fast-checker.ts` |

### High (6)

| # | Title | Reviews | File |
|---|-------|---------|------|
| H1 | Bot token exposed in process argv during crash-loop alert | Sec/Perf 2 | `src/daemon/index.ts` |
| H2 | Shell-escape regression in heartbeat watchdog (switched off `execFile`) | Sec/Perf 1 | `src/daemon/fast-checker.ts` |
| H3 | `getOperatorChatCreds` pairs agent's bot token with operator's chat id when only one env var is set | Correctness 2 | `src/daemon/index.ts` |
| H4 | `performRollback` synchronous `git fetch`/`reset` with no timeout in exit-callback chain | Sec/Perf 5, Architecture 9 | `src/daemon/watchdog.ts` |
| H5 | `rateLimitTimer` not cleared in `stop()` — orphaned restart after explicit stop | Architecture 2 | `src/daemon/agent-process.ts` |
| H6 | `rateLimitBlock` reads rate-limit marker twice — pre-captured `hadRateLimit` diverges from in-prompt FS read | Correctness 1 | `src/daemon/agent-process.ts` |

### Medium (14)

| # | Title | Reviews | File |
|---|-------|---------|------|
| M1 | Crash stack traces written to disk may contain embedded secrets (no redaction, no 0600 mode) | Sec/Perf 3 | `src/daemon/index.ts` |
| M2 | `cron-audit.sh --fix` unquoted heredoc can terminate early on crafted `$PROMPT` | Sec/Perf 4 | `bus/cron-audit.sh` |
| M3 | `gmailDeliveredIds` not pruned on load — stale entries accumulate on startup | Sec/Perf 6 | `src/daemon/fast-checker.ts` |
| M4 | `pollCycle` timeout `setTimeout` leaks on every successful completion | Sec/Perf 7 | `src/daemon/fast-checker.ts` |
| M5 | `pollCycleWatchdog` can dispatch concurrent `hardRestartSelf` before first completes | Correctness 4 | `src/daemon/fast-checker.ts` |
| M6 | `cronExpressionMinIntervalMs` result not validated — `NaN`/`0` breaks gap threshold and repeat-alert suppression | Correctness 5 | `src/daemon/agent-process.ts` |
| M7 | `recoveryBlock`/`rateLimitBlock` placed after `onboardingAppend` in startup prompt | Correctness 6 | `src/daemon/agent-process.ts` |
| M8 | `performRollback` does not set `last_healthy = target` — no anchor for re-entry | Correctness 7 | `src/daemon/watchdog.ts` |
| M9 | `FastChecker` scope creep — owns Gmail, Slack, and usage-tier polling (SRP violation) | Architecture 3 | `src/daemon/fast-checker.ts` |
| M10 | Crash-history functions exported directly from `src/daemon/index.ts` entry point | Architecture 4 | `src/daemon/index.ts` |
| M11 | `watchdog.ts` uses raw `writeFileSync` for stability state — violates atomic-write convention | Architecture 6 | `src/daemon/watchdog.ts` |
| M12 | `TelegramAPI.sendMessage` retains dead `onParseFallback` parameter | Architecture 7 | `src/telegram/api.ts` |
| M13 | Sprint7 test expects `haiku-4-5` but template `config.json` not updated in diff | Architecture 8 | `tests/sprint7-environment.test.ts` |
| M14 | `src/cli/ascendops.ts` duplicates the entire cortextos CLI command registration | Architecture 10 | `src/cli/ascendops.ts` |

### Low (8)

| # | Title | Reviews | File |
|---|-------|---------|------|
| L1 | `deleteRateLimitMarker` uses dynamic `require('fs')` despite top-level `unlinkSync` import | Correctness 8, Sec/Perf 8, Architecture 5 | `src/daemon/agent-process.ts` |
| L2 | `checkUsageTier` still uses `execFile('cortextos', ...)` while heartbeat switched to shell-exec — inconsistent PATH resolution | Correctness 9 | `src/daemon/fast-checker.ts` |
| L3 | `validateCredentials` matches bare `Forbidden` as `bot_recipient` — false positives for kicks/bans/perms | Correctness 10 | `src/telegram/api.ts` |
| L4 | `watchdogCheck` reads 20KB synchronously from stdout.log on every poll tick | Sec/Perf 9 | `src/daemon/fast-checker.ts` |
| L5 | `skill-autopr.ts run()` uses `bash -c` with interpolated args — latent injection surface for future callers | Sec/Perf 10 | `src/bus/skill-autopr.ts` |
| L6 | `hook-skill-autopr.ts` security scan flags documentation prose (false positives on credential keywords and destructive-command examples) | Architecture 11 | `src/hooks/hook-skill-autopr.ts` |
| L7 | `consumeRecoveryNote` exported as deprecated but has no external callers | Architecture 12 | `src/daemon/watchdog.ts` |
| L8 | `getOperatorChatCreds` fallback picks lexicographically-first agent .env without logging selection | Architecture 13 | `src/daemon/index.ts` |

**Deduplication notes:**
- L1 (dynamic `require('fs')`) was independently flagged by all three reviewers.
- C1 (watchdog permanent silence) flagged by Correctness and Architecture; Architecture graded it critical, Correctness high — escalated to critical in synthesis.
- H4 (blocking git in rollback) flagged by Sec/Perf and Architecture with slightly different framing; Correctness Issue 7 is the related "no anchor on re-entry" gap and is folded in.
- H2 + H3 grouped as top-5 Issue #3 because they're the same failure domain (daemon crash-alert pipeline).

---

## What Landed Well

The following changes are correct, well-implemented, and safe to ship as-is:

- **Relative timestamps in channels route test** (`fix(test)`) — straightforward test-clock improvement, no reviewer concerns.
- **Worker PTY null-write guard + crash visibility** (`fix(daemon)`) — adds defense without behavior change; reviewers did not flag regressions.
- **Hard-restart IPC `restart-agent` wire-up** (`fix(bus)`) — correctly terminates the session; the one adjacent concern (rateLimitTimer not cleared) is captured as H5.
- **Four code-review bugs: watchdog reset / health timer / dead code / force-fresh reason** (`fix(daemon)`) — three out of four landed cleanly; the watchdog reset fix is incomplete (C1) because the FastChecker lifecycle wasn't re-examined.
- **CronCreate direct-call on boot skipping `/loop` cloud prompt** — no correctness or security issues surfaced.
- **Telegram HTML parse-mode switch** — eliminates silent Markdown drops; the only residual is M12 (dead `onParseFallback` opt), cosmetic API cleanup.
- **Gap detection extended to cron-expression crons** — correct in concept; M6 is the missing NaN/0 guard needed to make it robust.
- **BOT_TOKEN/CHAT_ID validation before enable + `.env` setup** — good hardening; L3 is a cosmetic error-classification overmatch, not a functional regression.
- **Gap bounded by session start + repeat-alert suppression** — correct change; works as intended once M6 is fixed.
- **Task ID random suffix widened 3 → 6 digits** — pure collision-probability win, no reviewer objections.

---

## Issue Counts

### By Severity

| Severity  | Count |
|-----------|-------|
| Critical  | 1     |
| High      | 6     |
| Medium    | 14    |
| Low       | 8     |
| **Total** | **29**|

### By Category

| Category     | Count | Notes |
|--------------|-------|-------|
| Correctness  | 10    | Watchdog reset, prompt ordering, rollback anchor, NaN guards, inconsistent PATH, error classification |
| Security     | 4     | Argv token exposure, shell-escape regression, crash-log secret leakage, heredoc termination |
| Performance  | 4     | Blocking `git fetch`, timer leaks, unbounded map load, hot-path sync I/O |
| Architecture | 11    | SRP violations, misplaced crash-history, atomic-write convention, dead params, CLI duplication, deprecated exports |

(Categories are cross-cutting — a single issue can count in multiple columns; the table reports the reviewer's primary classification.)

### Unique Total

- Raw issue count across all three reviews: 33 (10 + 10 + 13)
- After deduplication: **29 unique issues**
- Duplicates merged: 4 (L1 triple-counted; C1, H4, H3/H6 pairs)

**Recommended fix order for next deploy:** C1 → H1 → H2+H3 → H4 → H5, then M-series cleanup pass (starting with M1, M4, M6, M8 which are either security-adjacent or correctness-critical for the features they support).
