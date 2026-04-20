# Security & Performance Review — branch-2026-04-19

Reviewed file: `src/daemon/agent-process.ts`
Diff scope: Issue #182 fix — cron-verification dedup, gap-nudge stagger, idle-wait extension.

---

## No Security Issues Found

The diff introduces no new surface for injection, authentication bypass, privilege escalation, sensitive data exposure, or insecure storage. The cron names and interval strings that appear in injected prompts (`verifyPrompt`, `nudge`) originate from `config.json` — a file the daemon process already owns and trusts. No external or user-controlled input reaches the injected strings without first being parsed through `parseDurationMs` and matched against the structured `crons` config array.

---

## Performance Issues

### Unbounded sleep(30 000) inside gap-detection loop blocks subsequent nudges

**File:** `src/daemon/agent-process.ts:937`
**Severity:** warning
**Type:** performance
**What is wrong:** After each gap nudge is injected, the code calls `await sleep(30_000)` while still inside the `for (const cronDef of crons)` inner loop. The loop does not re-check the lifecycle guard (`generation !== this.lifecycleGeneration || this.status !== 'running'`) between the sleep and the next iteration. An agent with N stale crons will hold the loop open for N × 30 s (e.g. 5 stale crons = 2.5 min of blocked iteration) before reaching the outer `await sleep(GAP_POLL_MS)` and the lifecycle guard there.
**Attack vector / Impact:** If the agent is stopped or restarted during the 30 s sleep windows, the loop continues injecting nudges into the PTY of the *new* lifecycle (the outer guard is only checked once per poll cycle, not between individual nudges). This can cause nudges from a dead lifecycle to reach the new agent. Additionally, on agents with many crons, the stagger adds meaningful latency to the gap-detection cycle.
**What needs to change:** Move the lifecycle guard check to immediately after the `sleep(30_000)` call (before the next loop iteration), or restructure the stagger to happen outside the `for` loop so the guard is tested between nudges:

```typescript
if (this.pty && this.status === 'running') {
  injectMessage((data) => this.pty!.write(data), nudge);
  await sleep(30_000);
  // Guard re-check after stagger sleep
  if (generation !== this.lifecycleGeneration || this.status !== 'running') return;
}
```

---

### 30-minute idle-wait polling holds a promise and file-descriptor reference open indefinitely on agent churn

**File:** `src/daemon/agent-process.ts:965–988`
**Severity:** suggestion
**Type:** performance
**What is wrong:** `verifyCronsAfterIdle` polls `last_idle.flag` with `existsSync` + `readFileSync` every 15 s for up to 30 minutes. Each poll opens and closes a file descriptor synchronously on the main Node event loop (`readFileSync` is blocking). The outer lifecycle guard correctly bails when the agent stops, so in the normal stop/restart path this resolves quickly. However, on a long-running agent that simply never goes idle (e.g. a stuck boot or non-stop LLM turn), the function runs for the full 30 minutes: 120 synchronous file reads on the hot event loop, keeping the enclosing `AgentProcess` object and its PTY reference alive in memory for that entire window.
**Attack vector / Impact:** On a fleet of agents each doing rapid --continue restarts (the exact scenario Issue #182 targets), the dedup guard (`cronVerificationPending`) prevents stacking within a single lifecycle, but each *new* lifecycle after `cronVerificationPending` resets to `false` will start a fresh 30-minute waiter. Memory and event-loop pressure scale linearly with restart frequency. At high restart rates (multiple per minute), 30+ concurrent waiters each doing blocking reads every 15 s can measurably degrade event-loop latency for other daemon operations.
**What needs to change:** Replace `readFileSync`/`existsSync` with their async counterparts (`fs/promises` `stat` + `readFile`) inside the polling loop. Also consider surfacing a cancel signal (e.g. an `AbortController`) so the outer `stop()` path can terminate a mid-wait waiter immediately rather than relying solely on the flag check at the top of the next poll cycle.

---

### `cronList` string grows unboundedly with cron count in injected prompt

**File:** `src/daemon/agent-process.ts:1003–1004`
**Severity:** suggestion
**Type:** performance
**What is wrong:** `expectedCrons.join(', ')` concatenates all recurring cron names into a single inline string that is injected directly into the agent's PTY as a [SYSTEM] message. There is no cap on the number of crons or on individual cron name length. A config with many crons (or pathologically long names) produces a proportionally large injected string.
**Attack vector / Impact:** The injected string lands in the agent's context window. A very large cron list wastes context tokens unnecessarily. This is the same class of problem the 30 s stagger was introduced to mitigate for gap nudges (back-to-back injections spiking context). The verification prompt has the same risk on a large fleet config.
**What needs to change:** Cap the rendered list at a reasonable maximum (e.g. first 20 names, then `"... and N more"`). This is a low-priority hardening item, not a regression introduced by this diff.

---

## Summary

| # | Title | Severity | Type |
|---|-------|----------|------|
| 1 | Missing lifecycle guard after 30 s stagger sleep | warning | performance |
| 2 | Synchronous blocking reads in 30-min polling loop | suggestion | performance |
| 3 | Unbounded cron-list string in injected verification prompt | suggestion | performance |

No security issues were found in this diff.
