# Architecture Review — Branch 2026-04-23

13 commits covering daemon reliability, Telegram HTML mode, gap detection, task ID widening, and new watchdog/skill-autopr/loop-detector subsystems.

---

## Issue 1: `FastChecker.watchdogTriggered` never reset after `hardRestartSelf` — watchdog permanently disabled

**Severity:** critical
**File:** `src/daemon/fast-checker.ts:487` / `src/daemon/fast-checker.ts:188`

**Problem:**
`triggerHardRestart()` sets `this.watchdogTriggered = true` (line 487) to prevent double-triggers during the restart. The flag is only cleared at line 188, inside `FastChecker.start()`, which runs once per daemon lifecycle. After a `hardRestartSelf()` call, the agent restarts (via `AgentProcess.stop()+start()`) but `FastChecker` keeps running — it does not go back through `start()` or call `waitForBootstrap()`. So `watchdogTriggered` stays `true` for the remainder of the daemon's life: the ctx-exhaustion survey, 1M billing gate, and frozen-stdout signals (Signals 1, 2, 4) are all permanently silenced after the first watchdog trigger.

**Evidence:**
```typescript
// fast-checker.ts:487
private triggerHardRestart(reason: string): void {
  this.watchdogTriggered = true;   // set here, never cleared after restart
  ...
  this.agent.hardRestartSelf(reason).catch(...);
}

// fast-checker.ts:404 — guard short-circuits forever after first trigger
private watchdogCheck(): void {
  if (this.watchdogTriggered) return;
  ...
}

// fast-checker.ts:188 — only reset happens here, inside start() which is called once
await this.waitForBootstrap();
this.watchdogTriggered = false;    // agent.hardRestartSelf() never reaches this
```

**Fix:** Reset `watchdogTriggered` (and `bootstrappedAt`, `stdoutLastChangeAt`, `lastHardRestartAt`) when the underlying agent process transitions back to `running` status. The cleanest hook is adding a reset call in the `onStatusChange` callback when the new status is `running`, or subscribe to the agent's status updates inside `FastChecker`. Alternatively, reset inside the poll-cycle watchdog's `setInterval` callback when it detects the agent has restarted (status `running`, bootstrappedAt lag).

---

## Issue 2: `rateLimitTimer` not cleared in `stop()` — orphaned timer fires restart on stopped agent

**Severity:** high
**File:** `src/daemon/agent-process.ts:203`

**Problem:**
`handleExit()` sets `this.rateLimitTimer` to a `setTimeout` for the rate-limit recovery restart. `stop()` clears `healthTimer` and `sessionTimer` (added in this diff, lines 211–212) but does NOT clear `rateLimitTimer`. If an agent exits with a rate-limit signature and is then stopped externally (e.g. via `cortextos stop`, daemon shutdown, or IPC `restart-agent`), the timer fires after `pauseSeconds` and calls `this.start()` on a stopped agent, potentially restarting it when the operator explicitly stopped it.

**Evidence:**
```typescript
// agent-process.ts:203 — stop() clears healthTimer but not rateLimitTimer
async stop(): Promise<void> {
  ...
  this.clearSessionTimer();
  this.clearHealthTimer();    // added this diff — good
  // rateLimitTimer is NOT cleared here
  ...
}

// agent-process.ts:461 — rateLimitTimer set in handleExit, can outlive stop()
this.rateLimitTimer = setTimeout(() => {
  this.rateLimitTimer = null;
  if (this.status === 'rate-limited') {
    this.start().catch(...);   // fires even after explicit stop
  }
}, pauseSeconds * 1000);
```

The `status === 'rate-limited'` guard provides partial protection (stop() changes status to `stopped`), but status is set to `stopped` only after the PTY has actually exited — there is a window between setting `rateLimitTimer` and `stop()` completing where the guard check passes. More importantly, a future change to the status field could silently reopen this.

**Fix:** Add `if (this.rateLimitTimer) { clearTimeout(this.rateLimitTimer); this.rateLimitTimer = null; }` at the top of `stop()`, parallel to `clearHealthTimer()`.

---

## Issue 3: `FastChecker` owns Gmail polling, Slack polling, and usage-tier checking — wrong module

**Severity:** high
**File:** `src/daemon/fast-checker.ts:48–100`

**Problem:**
`FastChecker` was designed as a PTY-level message injector and Telegram poller. This diff adds three orthogonal subsystems directly into it: Gmail inbox polling (`checkGmailWatch`), Slack message polling (`checkSlackWatch`), and Claude Max API usage-tier monitoring (`checkUsageTier`). The class now manages ~15 private state fields spanning three separate integration domains, two external APIs (Gmail CLI via `gws`, Slack REST), and a daemon-level quota guard. This violates single responsibility and will make the class progressively harder to test and maintain.

**Evidence:**
```typescript
// fast-checker.ts:52–100 — heterogeneous state across unrelated domains
private gmailWatch?: { query: string; intervalMs: number; ... };
private gmailLastCheckedAt: number = 0;
private gmailDeliveredIds: Map<string, number> = new Map();
private slackWatch?: { channel: string; intervalMs: number };
private slackApi?: SlackAPI;
private slackLastTs: string = '0';
private usageLastCheckedAt: number = Date.now();
private usageTier: 0 | 1 | 2 = 0;
private usageTierFile: string = '';
```

The constructor options type already grew from 5 fields to 8 in this diff alone.

**Fix:** Extract these as self-contained watchers (`GmailWatcher`, `SlackWatcher`, `UsageTierGuard`) with their own `start(intervalMs)` / `stop()` / `poll()` API. `AgentManager.startAgent()` can construct and start them alongside `FastChecker`, passing `sendMessage(paths, ...)` as the delivery callback. This is consistent with how `FastChecker` and `AgentProcess` are already separated.

---

## Issue 4: `src/daemon/index.ts` exports crash-handling infrastructure that belongs in its own module

**Severity:** high
**File:** `src/daemon/index.ts:1659–1844`

**Problem:**
`index.ts` is the daemon entry point — it should only contain startup and wiring code. This diff adds ~200 lines of exported crash-history functions (`readCrashHistory`, `writeCrashHistory`, `recordCrash`, `shouldSendCrashLoopAlert`, `writeDaemonCrashedMarkers`, etc.) directly to the entry point. The unit tests for these functions import from `index.ts`, meaning any future daemon wiring change risks breaking the test imports. The pattern contradicts how `watchdog.ts` was correctly extracted as a separate module in the same diff.

**Evidence:**
```typescript
// src/daemon/index.ts — exported domain logic in an entry point
export interface CrashEvent { ts: string; err: string; }
export interface CrashHistory { crashes: CrashEvent[]; lastAlertAt?: string; }
export const CRASH_HISTORY_MAX = 20;
export function readCrashHistory(ctxRoot: string): CrashHistory { ... }
export function writeCrashHistory(...) { ... }
export function recordCrash(...) { ... }
export function shouldSendCrashLoopAlert(...) { ... }
export function writeDaemonCrashedMarkers(...) { ... }
```

The test at `tests/unit/daemon/crash-handlers.test.ts` will import from `index.ts`, coupling tests to the entry point.

**Fix:** Extract crash-history logic into `src/daemon/crash-history.ts` (paralleling `watchdog.ts`). `index.ts` imports and calls them; the functions remain testable via `crash-history.ts` imports.

---

## Issue 5: `AgentProcess.deleteRateLimitMarker` uses `require('fs')` despite `unlinkSync` being top-level imported

**Severity:** medium
**File:** `src/daemon/agent-process.ts:531` and `:548`

**Problem:**
`unlinkSync` is already statically imported at line 1 of `agent-process.ts` (added by this diff). But two new private methods — `deleteRateLimitMarker` and the removed `consumeHandoffBlock` — use `require('fs').unlinkSync` (dynamic require). This inconsistency suggests the code was written independently of the top-level import change and is confusing to readers. More importantly, `require()` in ES module context bypasses TypeScript's static analysis.

**Evidence:**
```typescript
// agent-process.ts line 1 — static import exists
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';

// agent-process.ts line 531 — dynamic require used instead
private deleteRateLimitMarker(stateDir: string): void {
  try {
    const { unlinkSync } = require('fs');   // redundant — already imported above
    unlinkSync(join(stateDir, '.rate-limited'));
  }
```

**Fix:** Remove the `require('fs')` wrapper and use the statically imported `unlinkSync` directly. Same pattern applies at lines 548 and 569 where `require('fs').readdirSync`, `openSync`, `readSync`, and `closeSync` are used dynamically.

---

## Issue 6: `watchdog.ts` violates the project's atomic-write convention for state files

**Severity:** medium
**File:** `src/daemon/watchdog.ts:95` and `:318`

**Problem:**
The project convention (documented in `CONTRIBUTING.md` and enforced throughout `src/bus/`) is that all state files use `atomicWriteSync` from `src/utils/atomic.ts` (write to `.tmp`, then rename). `watchdog.ts` ignores this: `saveStability()` and `performRollback()` use raw `writeFileSync`. A crash between the `writeFileSync` call and the OS flush could corrupt `watchdog.json` (the crash-recovery state file, of all files). The irony is that the watchdog's own state is unprotected from the exact condition it exists to recover from.

**Evidence:**
```typescript
// watchdog.ts:95 — raw writeFileSync on crash-recovery state
function saveStability(stateDir: string, data: CommitStability): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stabilityPath(stateDir), JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch { ... }
}
```

Compare with the established pattern in `src/bus/heartbeat.ts:33`:
```typescript
atomicWriteSync(join(paths.heartbeatDir, `${agentName}.json`), JSON.stringify(heartbeat));
```

**Fix:** Import `atomicWriteSync` from `'../utils/atomic.js'` and replace both `writeFileSync` calls in `saveStability()` and `performRollback()`.

---

## Issue 7: `TelegramAPI.sendMessage` signature retains dead `onParseFallback` parameter

**Severity:** medium
**File:** `src/telegram/api.ts:363`

**Problem:**
Switching to HTML mode removes the Markdown fallback retry — but the `sendMessage` signature retains `opts.onParseFallback?: (reason: string) => void`. The parameter is now ignored: `sendChunk` no longer accepts an `onFallback` callback, the old `parseFallbackReason` tracking in `bus.ts` was deleted, yet the option type remains. This is a misleading API surface — callers who pass `onParseFallback` silently get nothing.

**Evidence:**
```typescript
// src/telegram/api.ts:363 — option is declared but never used
async sendMessage(
  chatId: string | number,
  text: string,
  replyMarkup?: object,
  opts?: {
    parseMode?: 'HTML' | null;
    onParseFallback?: (reason: string) => void;  // dead — sendChunk no longer accepts it
  },
): Promise<any> {
```

The old code passed `onParseFallback` into `sendChunk`, which no longer has that parameter:
```typescript
// new sendChunk signature — no callback
private async sendChunk(
  chatId: string | number,
  text: string,
  parseMode: 'HTML' | null,
  replyMarkup: object | undefined,   // onFallback removed
): Promise<any>
```

**Fix:** Remove `onParseFallback` from the `sendMessage` opts type. Any callers that passed it can be found and updated — the `bus.ts` changes already removed the only real usage.

---

## Issue 8: Sprint7 test change — expectation updated to `haiku` without matching the `analyst` config change

**Severity:** medium
**File:** `tests/sprint7-environment.test.ts:83`

**Problem:**
The test was changed to expect `model: 'claude-haiku-4-5-20251001'` for the `analyst` agent (commit message: "use Haiku 4.5 model in analyst config"). But the diff shows the test's expected config object sits inline in the test — it was changed only in the test assertion, with no corresponding change to the actual analyst template's `config.json`. If the template still has `claude-sonnet-4-6`, the test assertion is not testing the real template; it is testing a hypothetical. If the template was changed, that change is not in this diff.

**Evidence:**
```typescript
// tests/sprint7-environment.test.ts:83
analyst: {
  enabled: true,
  status: 'configured',
  org: 'acme',
  template: 'orchestrator',
-  model: 'claude-sonnet-4-6',
+  model: 'claude-haiku-4-5-20251001',   // changed, but templates/analyst/config.json not in diff
},
```

**Fix:** Confirm whether `templates/analyst/config.json` (or equivalent) was updated outside this diff. If not, the test is asserting a value that will never match the actual template instantiation — the test passes only because it uses inline fixtures not read from disk.

---

## Issue 9: `performRollback` runs `git reset --hard` synchronously in the crash-exit path

**Severity:** medium
**File:** `src/daemon/watchdog.ts:284`

**Problem:**
`performRollback()` is called from `AgentProcess.handleExit()`, which is invoked from the PTY's exit callback. The function runs multiple synchronous `execFileSync` calls: `git stash`, `git stash list`, `git fetch origin main`, `git rev-parse`, `git tag`, `git reset --hard`. On a slow network (e.g., git fetch against a remote), these can block the Node.js event loop for seconds to minutes inside what is effectively an event handler. The daemon handles all agents on one event loop. A hanging `git fetch` during rollback would freeze message delivery, Telegram polling, and all other agent operations.

**Evidence:**
```typescript
// watchdog.ts:251 — network fetch inside exit callback chain
execFileSync('git', ['fetch', 'origin', 'main', '--quiet'], {
  cwd: repoRoot,
  stdio: 'pipe',   // no timeout specified — can block indefinitely
});
```

**Fix:** Make `performRollback` async and use `execFile` (the async variant) with a timeout, or run the rollback off the critical path by scheduling it with `setImmediate()` / `Promise.resolve().then(...)` to yield back to the event loop before the git operations begin.

---

## Issue 10: `src/cli/ascendops.ts` duplicates the entire `cortextos` CLI command registration

**Severity:** medium
**File:** `src/cli/ascendops.ts:1–74`

**Problem:**
`ascendops.ts` is a verbatim copy of the entire command-registration block from `src/cli/index.ts` (or equivalent), plus a one-off `crash-alert` inline command. Any command added to the cortextos CLI in the future must be added twice: once in the main CLI entry and once in `ascendops.ts`. This is a maintenance trap — the duplication is near-certain to drift. The `crash-alert` command's inline `spawnSync` implementation also belongs in the hook infrastructure, not embedded in a CLI entry point.

**Evidence:**
```typescript
// src/cli/ascendops.ts — every command imported and re-added manually
program.addCommand(initCommand);
program.addCommand(installCommand);
program.addCommand(addAgentCommand);
// ... 20+ more commands, all duplicated from the main CLI
```

**Fix:** The AscendOps binary should be a thin wrapper: read the brand from env and delegate to the main CLI `program` object. The simplest approach is a single `bin/ascendops` entry that sets `ASCENDOPS_BRAND=1` and runs `node dist/cli.js "$@"`, or import and re-export the program from the shared CLI module without re-registering commands.

---

## Issue 11: `hook-skill-autopr.ts` security scan fires on the skill's own instructional content

**Severity:** low
**File:** `src/hooks/hook-skill-autopr.ts:852`

**Problem:**
The `scanForSecurityIssues()` function scans the full SKILL.md content including its own documentation. A skill that legitimately documents what patterns to avoid (e.g., a security-hardening skill, a reverse-shell detection skill) will flag itself. The credential-keyword check at line 865 matches `api_key`, `secret_key`, `access_token`, `bearer` — words that legitimately appear in documentation explaining how to authenticate to an API. The `rm -rf` pattern at line 894 matches any documentation that warns operators not to run `rm -rf /`. The result is false-positive flags in draft PRs for skills that are documenting, not implementing, dangerous patterns.

**Evidence:**
```typescript
// hook-skill-autopr.ts:865
if (/api[_-]?key|secret[_-]?key|access[_-]?token|bearer\s+[a-z0-9]{20}/i.test(content)) {
  flags.push('Credential keyword detected — verify no hardcoded secrets...');
}
// This fires on any skill that documents "how to set API_KEY in your .env"
```

**Fix:** Scope the scan to code blocks only (content between ``` fences), not to prose sections. Prose documentation of dangerous patterns is expected in skill files and should not be flagged. Alternatively, lower the signal to `warn` (already in PR body) but do not block the PR — which is already the behavior — just document the high false-positive rate so reviewers calibrate accordingly.

---

## Issue 12: `consumeRecoveryNote` exported as deprecated but unreachable from outside the file

**Severity:** low
**File:** `src/daemon/watchdog.ts:366`

**Problem:**
`consumeRecoveryNote` is marked `@deprecated` in its JSDoc and is not called from any other file (verified by grep). It was the original single-call interface before the split into `readRecoveryNote` + `deleteRecoveryNote`. Keeping a deprecated, unused export in a new file adds confusion for future contributors who may not notice the deprecation notice and use the simpler-looking function.

**Evidence:**
```typescript
// watchdog.ts:366 — deprecated, no callers outside this file
/**
 * @deprecated Prefer readRecoveryNote() + deleteRecoveryNote() so the note
 * is only deleted after the prompt that contains it has been delivered.
 */
export function consumeRecoveryNote(stateDir: string): string | null {
  const note = readRecoveryNote(stateDir);
  if (note) deleteRecoveryNote(stateDir);
  return note;
}
```

**Fix:** Remove `consumeRecoveryNote`. Since it has no callers outside `watchdog.ts` and was never in a released public API, removal is safe and removes a future footgun.

---

## Issue 13: `getOperatorChatCreds` fallback scans the filesystem at crash time — non-deterministic in CI

**Severity:** low
**File:** `src/daemon/index.ts:5742`

**Problem:**
The `getOperatorChatCreds` fallback walks `orgs/*/agents/*/.env` to find a bot token. This is called from `handleFatal()` (the `uncaughtException` handler), which means a filesystem scan runs during a crash. In CI environments where the `orgs/` directory does not exist, this is a no-op. But in any environment with multiple orgs, the function picks the lexicographically first agent's token — which may belong to a different operator than the one experiencing the crash. The comment says "Good enough for small single-operator installs" but the sorted order of `readdirSync` is filesystem-dependent and the selection is undocumented to end users.

**Evidence:**
```typescript
// index.ts:5754 — lexicographic scan, first match wins
const agents = readdirSync(agentsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
for (const a of agents) {
  const envFile = join(agentsRoot, a.name, '.env');
  // ... first .env with BOT_TOKEN is used — potentially wrong operator
```

**Fix:** Document the selection behavior explicitly in a log line (e.g., `[daemon] Crash-loop alert: using bot token from agent ${a.name} (first found — set CTX_OPERATOR_BOT_TOKEN for a deterministic target)`). This is a low-severity issue because the operator env vars are the recommended path, but the silent fallback is confusing.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 3 |
| Medium | 5 |
| Low | 4 |
| **Total** | **13** |

### Priority order for fixes

1. **Issue 1** (critical): `watchdogTriggered` permanent blind-spot — affects all Signal 1/2/4 watchdog paths after first trigger.
2. **Issue 2** (high): `rateLimitTimer` leak in `stop()` — orphaned restart after explicit stop.
3. **Issue 3** (high): `FastChecker` scope creep — will compound as more integrations land.
4. **Issue 4** (high): Crash-history domain logic in the daemon entry point.
5. **Issue 9** (medium): Blocking `execFileSync` `git fetch` in the exit-callback chain.
6. **Issues 5, 6, 7, 8, 10**: Medium/low correctness and convention fixes, addressable in the next cleanup pass.
