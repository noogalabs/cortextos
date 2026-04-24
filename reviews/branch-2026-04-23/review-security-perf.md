# Security & Performance Review — Branch 2026-04-23

13 commits reviewed. Focus: security vulnerabilities, credential exposure, injection risks, memory leaks, unbounded growth, timer accumulation, and hot-path I/O.

---

## Issue 1: Shell injection via exec() replacing execFile() in heartbeat watchdog

**Severity:** high
**File:** src/daemon/fast-checker.ts (heartbeat setInterval, diff line ~5064)
**Problem:** The heartbeat watchdog was changed from `execFile('cortextos', [...args])` to `exec(shell_string)`. The substituted variable `agentName` is injected directly into the shell string without sanitization. If `agentName` contains shell metacharacters (semicolons, backticks, `$()`), an attacker or corrupt config could execute arbitrary commands inside the daemon process.
**Evidence:**
```
-  execFile('cortextos', ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`], (err) => {
+  exec(`cortextos bus update-heartbeat "[watchdog] ${agentName} alive — idle session ${ts}"`, (err) => {
```
**Fix:** Revert to `execFile('cortextos', ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`], ...)`. Agent names are validated at creation but defense-in-depth requires not using a shell for this call. No shell features are needed here.

---

## Issue 2: Bot token exposed in process argv during crash-loop alert

**Severity:** high
**File:** src/daemon/index.ts (sendCrashLoopAlertBestEffort, diff lines ~5796-5802)
**Problem:** The crash-loop Telegram alert constructs a `curl` command via `spawnSync` with the bot token embedded in the URL argument. On Linux/macOS, process arguments are visible to all users via `ps aux` or `/proc/<pid>/cmdline` for the duration of the child process. During a crash storm this fires repeatedly and the token is transiently visible system-wide.
**Evidence:**
```
    const r = spawnSync('curl', [
      '-s', '--max-time', '3',
      '-X', 'POST',
      `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
      '-d', `chat_id=${creds.chatId}`,
      '--data-urlencode', `text=${message}`,
    ], { timeout: TELEGRAM_SEND_TIMEOUT_MS, stdio: 'pipe' });
```
**Fix:** Use curl's `-K -` flag to read configuration from stdin (which is not visible in `ps`), passing the URL with the token via stdin instead of argv. Alternatively, write a minimal curl config file to a `mkstemp` path, pass `--config <path>`, then delete it after the call. The token must never appear in the argv array.

---

## Issue 3: Crash error stack traces written to disk may contain embedded secrets

**Severity:** medium
**File:** src/daemon/index.ts (recordCrash, diff lines ~5693-5701)
**Problem:** `recordCrash` stores up to 2000 characters of `err.stack || err.message` in `.daemon-crash-history.json`. If the uncaught exception originates from a network call that includes a URL containing a bot token (e.g. a rejected `fetch('https://api.telegram.org/bot<TOKEN>/...')`) or from a database connection string, the token will be written to disk in cleartext. The file has no enforced permissions.
**Evidence:**
```
  const errStr = err instanceof Error ? (err.stack || err.message) : String(err);
  // ...
  history.crashes.push({ ts: new Date().toISOString(), err: errStr.slice(0, 2000) });
```
**Fix:** Before storing `errStr`, apply a redaction pass: `errStr.replace(/bot[\w:]{5,}[A-Za-z0-9_-]{20,}/g, 'bot***REDACTED***')`. Also create the crash history file with mode `0600` (`writeFileSync(path, ..., { mode: 0o600 })`) so only the daemon user can read it.

---

## Issue 4: cron-audit.sh heredoc embeds unvalidated cron prompt — early termination risk

**Severity:** medium
**File:** bus/cron-audit.sh (--fix path, diff lines ~289-299)
**Problem:** When `--fix` is used, the script writes a new SKILL.md file using an unquoted heredoc. The cron `$PROMPT` is extracted from `config.json` via `jq` and embedded verbatim. An unquoted heredoc (`<< SKILL_EOF`) interprets content normally, which means if `$PROMPT` contains the string `SKILL_EOF` on a line by itself, the heredoc terminates early and subsequent lines are executed as shell commands. A crafted or corrupt `config.json` could exploit this.
**Evidence:**
```bash
        cat > "$SKILL_FILE" << SKILL_EOF
# ${TITLE} Skill
...
${PROMPT}
SKILL_EOF
```
**Fix:** Quote the heredoc delimiter (`<< 'SKILL_EOF'`) to make all content literal, then write the prompt separately via `printf '%s\n' "$PROMPT" >> "$SKILL_FILE"` after the heredoc writes the static header. Or use `printf` exclusively and avoid the heredoc pattern when including user-controlled content.

---

## Issue 5: performRollback calls git fetch without timeout — can block daemon event loop

**Severity:** medium
**File:** src/daemon/watchdog.ts (performRollback, diff lines ~6137-6154)
**Problem:** `performRollback` uses synchronous `execFileSync` for `git fetch origin main` with no `timeout` option. On a slow network or unreachable remote, this blocks the Node.js process for the OS TCP timeout (~75-120 seconds). This function is called from `AgentProcess.handleExit()` on every crash that meets the rollback threshold — a crash storm could leave the daemon unresponsive for minutes.
**Evidence:**
```
      execFileSync('git', ['fetch', 'origin', 'main', '--quiet'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
```
**Fix:** Add `timeout: 15_000` to all `execFileSync` calls in `watchdog.ts` (`git fetch`, `git stash push`, `git reset --hard`, `git tag`). A 15-second ceiling is generous for git operations on local repos.

---

## Issue 6: gmailDeliveredIds Map not pruned on load — stale entries accumulate in memory

**Severity:** medium
**File:** src/daemon/fast-checker.ts (loadGmailDeliveredIds, diff lines ~5431-5444)
**Problem:** `pruneGmailDeliveredIds()` is only called inside `checkGmailWatch()` (every 15 minutes). `loadGmailDeliveredIds()` loads the full contents of the persisted file into memory without pruning. If the daemon was running before the 2h TTL logic existed, or if a bug caused many entries to be stored, all stale entries load into memory and are re-serialized on every check cycle. With 20 adds per 15-minute cycle, a 24-hour continuous run accumulates ~1,920 entries (well within the TTL), but a multi-day instance or a pre-TTL migration could load thousands.
**Evidence:**
```ts
  private loadGmailDeliveredIds(): void {
    // ... loads all entries into this.gmailDeliveredIds
    // pruneGmailDeliveredIds() is never called here
  }
```
**Fix:** Add `this.pruneGmailDeliveredIds()` at the end of `loadGmailDeliveredIds()` so stale entries are evicted on startup, not deferred to the first check cycle.

---

## Issue 7: pollCycle timeout Promise leaks a timer on every successful completion

**Severity:** medium
**File:** src/daemon/fast-checker.ts (run loop, diff lines ~5144-5152)
**Problem:** Each `pollCycle` invocation creates a `setTimeout` inside a `new Promise`. When `pollCycle` finishes before the timeout, the race resolves but the timer is not cancelled. Node.js holds the timer reference until it fires, preventing clean shutdown and accumulating `POLL_CYCLE_TIMEOUT_MS / pollInterval` outstanding timers at steady state. At a 2-second poll interval and a 30-second timeout, this is ~15 pending timers at all times.
**Evidence:**
```ts
        await Promise.race([
          this.pollCycle(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`pollCycle timeout after ${this.POLL_CYCLE_TIMEOUT_MS}ms`)),
              this.POLL_CYCLE_TIMEOUT_MS,
            ),
          ),
        ]);
```
**Fix:**
```ts
let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
await Promise.race([
  this.pollCycle(),
  new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`pollCycle timeout after ${this.POLL_CYCLE_TIMEOUT_MS}ms`)),
      this.POLL_CYCLE_TIMEOUT_MS,
    );
  }),
]).finally(() => { if (timeoutHandle !== undefined) clearTimeout(timeoutHandle); });
```

---

## Issue 8: deleteRateLimitMarker uses require('fs') despite unlinkSync being a top-level import

**Severity:** low
**File:** src/daemon/agent-process.ts (deleteRateLimitMarker, diff lines ~4676-4681)
**Problem:** `deleteRateLimitMarker` calls `require('fs')` dynamically to obtain `unlinkSync`, even though `unlinkSync` is already imported at the top of the file (`import { ..., unlinkSync, ... } from 'fs'`). This is inconsistent and will break if the build is ever run in a strict ESM context where `require` is not available.
**Evidence:**
```ts
  private deleteRateLimitMarker(stateDir: string): void {
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(join(stateDir, '.rate-limited'));
    } catch { /* ignore */ }
  }
```
**Fix:** Remove `const { unlinkSync } = require('fs');` and use the already-imported `unlinkSync` directly.

---

## Issue 9: watchdogCheck reads 20 KB from stdout.log synchronously on every poll tick

**Severity:** low
**File:** src/daemon/fast-checker.ts (watchdogCheck, diff lines ~5205-5226)
**Problem:** `watchdogCheck()` runs inside `pollCycle()` on every tick. It performs `statSync` + synchronous `openSync/readSync/closeSync` to read the last 20 KB of `stdout.log`. At a short poll interval (e.g. 2 seconds), this is 20 KB of synchronous disk I/O every 2 seconds. On a slow disk or NFS mount, this adds latency to every poll cycle and interacts badly with the `Promise.race` timeout.
**Evidence:**
```ts
        const fd = openSync(stdoutPath, 'r');
        const buf = Buffer.alloc(tailBytes);
        readSync(fd, buf, 0, tailBytes, size - tailBytes);
        closeSync(fd);
```
**Fix:** Add an interval guard: track `this.watchdogLastCheckedAt` and skip the disk read if fewer than 60 seconds have elapsed. Signal detection latency goes from sub-second to at most 60 seconds, which is acceptable for a "frozen for 30 minutes" detector.

---

## Issue 10: skill-autopr.ts run() interpolates branch name into bash -c string

**Severity:** low
**File:** src/bus/skill-autopr.ts (run helper, diff lines ~3759-3781)
**Problem:** `run()` passes commands to `spawnSync('bash', ['-c', cmd])`. Variables `skillName`, `branch`, and `ts` are interpolated directly into the shell string. The `skillName` regex (`/^[a-z0-9][a-z0-9_-]{0,63}$/`) currently prevents injection, but `branch` is constructed as `community/skill/${skillName}-${ts}` and `ts` is a Unix timestamp integer — both safe today. However the `run()` helper pattern is a latent risk: any future caller that passes a less-sanitized string gets shell injection for free.
**Evidence:**
```ts
    run(`git checkout -b ${branch} origin/main`, frameworkRoot);
    run(`git add community/skills/${skillName}/`, frameworkRoot);
    run(`git push origin ${branch}`, frameworkRoot);
```
**Fix:** Refactor `run()` to accept `(args: string[], cwd: string)` and use `spawnSync` directly without `bash -c`. Pass each git argument as a separate array element. This eliminates the shell quoting surface entirely.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 2     |
| Medium   | 4     |
| Low      | 4     |
| **Total**| **10**|

**Most urgent (fix before next deploy):** Issue 1 (shell injection via `exec`) and Issue 2 (bot token in process argv) are exploitable in production today. Issue 5 (synchronous `git fetch` without timeout on crash path) can stall the daemon for minutes during a crash storm and should also be addressed promptly.
