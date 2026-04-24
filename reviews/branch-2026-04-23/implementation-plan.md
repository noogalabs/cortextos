# Implementation Plan — Top 5 Must-Fix Issues (branch-2026-04-23)

Derived from synthesis.md. Real line numbers verified against source on 2026-04-24.
(Synthesis line numbers were concatenated approximations; the numbers below are the
actual locations in the current tree.)

---

## Fix 1: Reset `FastChecker` watchdog state on every `running` transition

**Files:**
- `/Users/davidhunter/cortextos/src/daemon/fast-checker.ts` (add method)
- `/Users/davidhunter/cortextos/src/daemon/agent-manager.ts` (invoke it)

**Lines:**
- `fast-checker.ts`: insert new `resetWatchdogState()` method near line 319 (right after the existing `wake()` helper, which is a similar small public mutator).
- `agent-manager.ts`: augment the existing `onStatusChanged` handler at lines 287-297.

**Change:**

In `fast-checker.ts` after `wake()` at line 319, add:

    /**
     * Reset all watchdog-trigger state. Called by AgentManager whenever the
     * agent transitions back to `running` (post-bootstrap of a fresh or
     * hard-restarted PTY). Without this, watchdogTriggered stays true forever
     * after the first hard-restart — Signals 1/2/4 go dark for the rest of
     * the daemon's life. See review synthesis 2026-04-23, issue C1.
     */
    resetWatchdogState(): void {
      this.watchdogTriggered = false;
      this.ctxThresholdTriggeredAt = 0;
      this.bootstrappedAt = Date.now();
      this.stdoutLastChangeAt = Date.now();
      this.stdoutLastSize = 0;
      this.lastHardRestartAt = 0;
      this.lastPollCycleCompletedAt = Date.now();
      this.log('Watchdog state reset (agent transitioned to running)');
    }

In `agent-manager.ts`, extend the handler at lines 287-297. Preserve every
existing branch. Add one new `if (status.status === 'running')` block at the
end (inside the same arrow function, before `prevStatus = status.status;`):

    // C1 fix: re-arm watchdog after any return to `running` (first spawn,
    // crash recovery, hard-restart, session refresh). The FastChecker
    // instance outlives the AgentProcess's PTY, so start() no longer
    // clears its trigger flags on its own.
    if (status.status === 'running') {
      checker.resetWatchdogState();
    }

Note: the `onStatusChanged` setter on AgentProcess is single-handler (see
agent-process.ts:366). The hook must live inside the existing handler; do not
call `onStatusChanged` twice. `checker` is already captured from the enclosing
scope via the `const checker = new FastChecker(...)` declaration at line 272.

**Test:**
1. Boot an agent, trigger a hard-restart (write the ctx-survey sentinel to stdout.log and wait for the watchdog tick, or call `agent.hardRestartSelf('test')` via IPC).
2. Confirm new log line `Watchdog state reset (agent transitioned to running)` appears after the PTY comes back up.
3. Trigger a second ctx-exhaustion event — the watchdog must fire again (previously silent).
4. `grep 'WATCHDOG' logs/<agent>/fast-checker.log` should show two triggers, not one.

**Risk:**
- If `resetWatchdogState()` also cleared the WATCHDOG circuit-breaker state (`watchdogCircuitBroken`, `watchdogRestarts`, `ctxCircuit*`), we would defeat loop-protection. The fields listed above are intentionally the *only* ones reset — the circuit-breaker and ctx-circuit state persist.
- If an agent flaps `running → crashed → running` very quickly, `stdoutLastChangeAt` gets reset on each transition. That is the correct behaviour (new PTY, new stdout.log).

---

## Fix 2: Stop leaking the bot token via curl argv

**File:** `/Users/davidhunter/cortextos/src/daemon/index.ts`
**Lines:** 161-178 (body of `sendCrashLoopAlertBestEffort`)

**Change:**

Replace the `spawnSync('curl', [...URL-with-token...])` block with a `curl -K -`
call that reads configuration from stdin. The URL (with the embedded bot token)
and POST data move off argv and into the stdin-fed config, which is never
visible to `ps aux` or `/proc/<pid>/cmdline`.

Before (current, lines 161-178):

    try {
      const r = spawnSync('curl', [
        '-s', '--max-time', '3',
        '-X', 'POST',
        `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
        '-d', `chat_id=${creds.chatId}`,
        '--data-urlencode', `text=${message}`,
      ], { timeout: TELEGRAM_SEND_TIMEOUT_MS, stdio: 'pipe' });
      if (r.status === 0) { ... return true; }
      ...
    }

After:

    // H1 fix: token must never appear in argv. Pipe a libcurl config file
    // through stdin via `-K -` so the URL (containing the bot token) and
    // POST fields never land on the process command line.
    const cfg = [
      'url = "https://api.telegram.org/bot' + creds.botToken + '/sendMessage"',
      'request = "POST"',
      'data = "chat_id=' + creds.chatId + '"',
      'data-urlencode = "text=' + message.replace(/"/g, '\\"') + '"',
      'silent',
      'max-time = 3',
    ].join('\n') + '\n';
    try {
      const r = spawnSync('curl', ['-K', '-'], {
        input: cfg,
        timeout: TELEGRAM_SEND_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (r.status === 0) {
        console.error('[daemon] Crash-loop alert sent to operator chat');
        return true;
      }
      console.error('[daemon] Crash-loop alert send failed (non-fatal)');
      return false;
    } catch {
      return false;
    }

**Test:**
1. Force a crash-loop (3 uncaught exceptions in <15min) in a scratch daemon.
2. While the alert is firing, run `ps auxww | grep curl` on the host — the token must not appear.
3. Operator chat must still receive the alert (end-to-end send still works).
4. Unit test: mock `spawnSync`, assert argv is exactly `['-K', '-']` and the captured `input` string contains both `sendMessage` and `chat_id=`.

**Risk:**
- libcurl config files are sensitive to escaping. Messages containing embedded `"` are rare (we build them ourselves) but the `replace(/"/g, '\\"')` above guards the one user-controlled field. Do NOT pass a user-supplied string into any of these fields without escaping.
- `curl -K -` requires curl ≥ 7.0 (universal on macOS/Linux). The existing path already assumes `curl` is on PATH.
- If stdin-config support ever breaks, the alert silently fails — same failure mode as today.

---

## Fix 3: Heartbeat shell → execFile, and operator-chat credential pairing

**Files:**
- `/Users/davidhunter/cortextos/src/daemon/fast-checker.ts` (heartbeat)
- `/Users/davidhunter/cortextos/src/daemon/index.ts` (getOperatorChatCreds)

### 3a. Heartbeat shell-escape regression

**Lines:** `fast-checker.ts` 193-198

Current behaviour: heartbeat builds a full shell command string interpolating
`agentName` and `ts`, then hands it to the shell via `exec(...)`. The agent name
is trusted today but this is a defense-in-depth regression with no functional
payoff — there are no shell features in use.

Replace the `exec(...)` call inside the `setInterval` body with `execFile`:

Before (lines 194-197):

    const ts = new Date().toISOString();
    exec(
      'cortextos bus update-heartbeat "[watchdog] ' + agentName + ' alive — idle session ' + ts + '"',
      (err) => {
        if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
      },
    );

After:

    const ts = new Date().toISOString();
    execFile(
      'cortextos',
      ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`],
      { timeout: 10_000 },
      (err) => {
        if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
      },
    );

The top-of-file import `import { exec, execFile } from 'child_process';` on
line 2 already exposes `execFile`; no import change needed.

### 3b. Mismatched token/chat pairing

**Lines:** `index.ts` 125-140 (inside `getOperatorChatCreds` Priority 2 loop)

Before (line 134):

    const chatId = envChat || chatMatch[1].trim();

After:

    // H3 fix: when falling back to an agent's .env we MUST use THAT agent's
    // chat_id — pairing the agent's bot token with a different operator chat
    // yields a 401/403 from Telegram and the alert silently drops. If the
    // operator wants a custom destination, they must also set
    // CTX_OPERATOR_BOT_TOKEN (Priority 1 already handles that pair atomically).
    const chatId = chatMatch[1].trim();

**Test:**
- 3a: grep `logs/<agent>/fast-checker.log` for `Heartbeat watchdog error` across a week of runtime — no shell-escape anomalies. Manually set `agentName` to a string containing `$(whoami)` in a test harness; confirm the literal string is passed to `cortextos bus update-heartbeat` and not interpolated by a shell.
- 3b: unit test — set env `CTX_OPERATOR_CHAT_ID=12345`, unset `CTX_OPERATOR_BOT_TOKEN`, put one agent .env with `BOT_TOKEN=X` and `CHAT_ID=99999`. `getOperatorChatCreds()` must return `{ chatId: '99999', botToken: 'X' }`, NOT `{ chatId: '12345', botToken: 'X' }`.

**Risk:**
- 3a: zero — `execFile` with an array is a strict subset of the shell-exec behaviour for non-shell invocation. Both reach the same binary.
- 3b: anyone relying on the broken pairing today was receiving failed sends. If an operator actually wants "send to my custom chat using any discovered bot," they need a separate multi-chat feature, not this silent coupling.

---

## Fix 4: Bound every `execFileSync` in watchdog, set `last_healthy` on rollback

**File:** `/Users/davidhunter/cortextos/src/daemon/watchdog.ts`
**Lines:**
- Add a file-local `GIT_EXEC_TIMEOUT_MS` constant near line 42 (alongside the existing `ROLLBACK_THRESHOLD` / `MIN_HEALTHY_SECONDS` constants).
- Add `timeout: GIT_EXEC_TIMEOUT_MS` to each of the eight `execFileSync` options objects at lines 111, 127, 226, 232, 251, 255, 275, 284.
- Add `stability.last_healthy = target;` inside `performRollback` just before `saveStability(stateDir, stability)` in the success path (around line 326).

**Change:**

New constant near line 42:

    // H4 fix: bound every sync git call. performRollback runs in the PTY-exit
    // callback chain — a single slow `git fetch` over a dead network would
    // block the daemon's event loop for the OS TCP timeout (~75-120s),
    // freezing Telegram polling and message delivery fleet-wide.
    const GIT_EXEC_TIMEOUT_MS = 15_000;

For each of the 8 `execFileSync` call sites below, add `timeout: GIT_EXEC_TIMEOUT_MS,` to the options object:

| Line | Call |
|------|------|
| 111  | `git rev-parse --show-toplevel` (findGitRoot) |
| 127  | `git rev-parse HEAD` (getCurrentCommit) |
| 226  | `git stash push -u -m cct-recovery-<ts>` |
| 232  | `git stash list --max-count=1` |
| 251  | `git fetch origin main --quiet` — **highest priority** |
| 255  | `git rev-parse origin/main` |
| 275  | `git tag failed-<ts>-<hash>` |
| 284  | `git reset --hard <target>` |

Anchor `last_healthy` in the success path of `performRollback`. The existing
block around lines 323-326 reads:

    // Update stability: clear failed commit's count, record rollback time
    stability.last_rollback_at = new Date().toISOString();
    delete stability.restart_counts[failedCommit];
    saveStability(stateDir, stability);

Change it to:

    // Update stability: clear failed commit's count, record rollback time.
    // M8 fix: anchor the target commit so a second rollback before
    // markHealthy() fires (60s window) has somewhere to point. Without this,
    // the next rollback falls through to `git fetch origin main` — which
    // without the timeout above would hang the exit-callback chain.
    stability.last_rollback_at = new Date().toISOString();
    stability.last_healthy = target;
    delete stability.restart_counts[failedCommit];
    saveStability(stateDir, stability);

**Test:**
1. Simulate a dead network (block outbound 443 in pf/iptables, or run inside a network-isolated container). Force a rollback by removing `last_healthy` and triggering three crashes in a row. `performRollback` must return `{ success: false, reason: 'fetch failed: ...' }` within ~15s — not hang for 75s+.
2. Manually corrupt `last_healthy` to empty string, trigger two back-to-back rollbacks. Second rollback must use the target recorded from the first rollback; no network fetch should occur.
3. After the first successful rollback, `jq .last_healthy state/<agent>/watchdog.json` must equal the target commit hash, not an empty string.

**Risk:**
- `git fetch` on large repos with cold caches can exceed 15s legitimately. In those environments, rollback returns `success: false` with reason `fetch failed: ETIMEDOUT`. The daemon already handles that path (normal crash-backoff restart takes over). If this becomes an operational problem, raise the constant to 30s; do NOT remove the timeout.
- Setting `last_healthy = target` means that target is treated as "healthy" even though we never observed it running for 60s. That is a deliberate tradeoff — the alternative (hanging the event loop) is strictly worse. A subsequent genuine `markHealthy` after `MIN_HEALTHY_SECONDS` will overwrite it with the same value.

---

## Fix 5: Clear `rateLimitTimer` on `stop()`

**File:** `/Users/davidhunter/cortextos/src/daemon/agent-process.ts`
**Lines:** 210-212 (top of `stop()` body, immediately after `clearHealthTimer()`)

**Change:**

Before (lines 210-212):

    this.log('Stopping...');
    this.clearSessionTimer();
    this.clearHealthTimer();

After:

    this.log('Stopping...');
    this.clearSessionTimer();
    this.clearHealthTimer();
    // H5 fix: a rate-limit pause scheduled a setTimeout that will call
    // this.start() after pauseSeconds (default 5h). Without clearing it
    // here, an external stop() (cortextos stop / daemon shutdown / IPC
    // restart-agent) silently re-animates the agent hours later. The
    // status === 'rate-limited' guard in the timer body is fragile (one
    // refactor away from a reopen).
    if (this.rateLimitTimer) {
      clearTimeout(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }

**Test:**
1. Induce a rate-limit exit: write `.rate-limited` marker so the next exit is treated as rate-limit, then kill the PTY so `handleExit` schedules the timer.
2. Immediately run `cortextos stop <agent>`.
3. Wait past `rate_limit_pause_seconds` (use a test config with 30s). Agent must stay `stopped`; no re-spawn; no `Rate-limit restart failed` in logs.
4. Regression: ensure ordinary rate-limit recovery (no intervening `stop()`) still restarts after `pauseSeconds`.

**Risk:**
- Virtually none. The timer is set in exactly one place (handleExit line 461) and reset in one adjacent place (handleExit lines 457-460 before re-arming). Adding a third clear point at the top of `stop()` is additive and cannot regress the existing pattern.
- Ordering matters: the clear must run BEFORE the `await exitPromise` at line 266 (otherwise the timer can fire between the await and the clear and start a new lifecycle mid-stop). The placement above, immediately after `clearHealthTimer()`, satisfies this.

---

## Apply Order

**Independent (no inter-fix dependency — can be applied in parallel or any order):**
- Fix 2 (index.ts — token argv)
- Fix 3a (fast-checker.ts — heartbeat execFile)
- Fix 3b (index.ts — chatId pairing)
- Fix 4 (watchdog.ts — timeouts + anchor)
- Fix 5 (agent-process.ts — stop() rateLimitTimer clear)

Fixes 2 and 3b both live in `index.ts` but touch different functions
(`sendCrashLoopAlertBestEffort` vs `getOperatorChatCreds`); they do not
conflict. Either order works; one combined edit is cleanest.

**Sequential only:**
Fix 1 has an internal ordering constraint across its two files:
1. First add `resetWatchdogState()` to `fast-checker.ts`.
2. Then update the handler in `agent-manager.ts` that calls it.
Applying step 2 first leaves `agent-manager.ts` referencing a non-existent method — TypeScript compile fails (caught by `npm run build`).

**Recommended commit sequence for review / bisect:**
1. Fix 5 (smallest, highest isolation — 4 lines)
2. Fix 3a + 3b (same daemon-alert subsystem; ship together)
3. Fix 2 (same subsystem as 3b; sequences cleanly)
4. Fix 4 (watchdog — independent module)
5. Fix 1 (largest behavioural change; ship last so earlier bisects are clean)

---

## Estimated Scope

| Fix | Files | Lines changed | New tests |
|-----|-------|---------------|-----------|
| 1   | `src/daemon/fast-checker.ts` (+~14), `src/daemon/agent-manager.ts` (+3) | ~17 added, 0 removed | 1 unit (reset clears fields), 1 integration (two consecutive hard-restarts both trigger) |
| 2   | `src/daemon/index.ts` | ~12 changed | 1 unit (argv does not contain token) |
| 3a  | `src/daemon/fast-checker.ts` | ~5 changed | no new test required |
| 3b  | `src/daemon/index.ts` | 1 line | 1 unit (operator env partial set) |
| 4   | `src/daemon/watchdog.ts` | 1 constant + 8 option-object updates + 1 assignment ≈ 10 changed | 1 unit (last_healthy anchors after rollback), optional integration (git fetch timeout) |
| 5   | `src/daemon/agent-process.ts` | +4 lines | 1 unit (stop() cancels pending rate-limit restart) |

**Totals:**
- **Files touched:** 5 (`fast-checker.ts`, `agent-manager.ts`, `index.ts`, `agent-process.ts`, `watchdog.ts`).
- **Net source lines changed:** ~50.
- **New tests:** 5-6 unit tests, 1 integration test (consecutive hard-restarts).
- **Build impact:** `npm run build` must stay green after each fix. Fix 1 specifically will fail the build if applied out of order (see Apply Order).
- **Runtime risk surface:** all five fixes are behind existing failure paths (crash-loop alert, rollback, rate-limit, watchdog trigger). No cold-path user-facing changes, no config migration, no state-file schema change.
