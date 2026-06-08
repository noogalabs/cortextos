# Spec 2: bus.ts Integration + `--suggest` Flag + New Tests

**Shard:** 2 of 2
**Depends on:** Shard 1 (`resolveCommsLintRules`, `ResolvedCommsLintRules`, `CommsLintRule`, config types) — must be landed and green first.
**Implement:** SECOND, sequentially on the same `feature/configurable-comms-lint` branch. No parallel worktree.

## Objective

Wire the Shard-1 loader into `src/cli/bus.ts`: refactor the two lint functions to consume a `ResolvedCommsLintRules` argument (instead of closing over module-level `const` arrays), resolve the rules at each enforce site, and add a `--suggest` dry-run flag to the three linted commands. Preserve default behavior exactly so the existing 18 tests pass unchanged. Add new tests for config-driven behavior and `--suggest`.

## Owned Files (you may create/edit)

- `src/cli/bus.ts` (SOLE editor)
- `tests/unit/cli/comms-lint-configurable.test.ts` (NEW)
- `tests/unit/cli/outbound-comms-lint.test.ts` (may run/keep green; **do NOT modify existing cases** — you may only add cases if strictly necessary, prefer the new file)

## Files You May Read But NOT Edit

- `src/bus/comms-lint-config.ts` (Shard 1 module — import from it).
- `src/types/index.ts` (import the config types; do not edit — Shard 1 owns it).
- `src/utils/env.ts`, `src/utils/paths.ts` (env/path resolution at call sites).

## Provided Contracts

- `--suggest` flag on `send-message`, `send-telegram`, `send-mobile-reply`.
- `OutboundLintResult` gains optional `suggest?: string` (additive; `ok`/`phrase`/`reason` unchanged).

## Consumed Contracts (from Shard 1)

```ts
import { resolveCommsLintRules, type ResolvedCommsLintRules, type CommsLintRule } from '../bus/comms-lint-config.js';
// resolveCommsLintRules({ org, agentDir, frameworkRoot }) -> ResolvedCommsLintRules (never throws, defaults on error)
```

## Adjacent Specs

- Spec 1 provides the loader. If a default-path test fails, the fix belongs in Spec 1's default set (coordinate), not in mutating the regression test.

## Implementation Steps

1. **Delete the four module-level rule consts** (`BANNED_POSTURE_PATTERNS`, `PASSIVE_POSTURE_PATTERNS`, `ACTIVE_WORK_CONTEXT`, `NEXT_SIGNAL_CONTEXT`, `TELEGRAM_BANNED_PATTERNS`, `AGENT_NAME_PATTERN`) and the local `TelegramLintRule` type from `src/cli/bus.ts` (bus.ts L82-101, L178-224). Their data now lives in the loader's defaults.

2. **Add `suggest?: string`** to the `OutboundLintResult` type (L76-80).

3. **Refactor `lintOutboundMessage`** to `lintOutboundMessage(text: string, rules: ResolvedCommsLintRules): OutboundLintResult`:
   - Iterate `rules.banned` (each is a `CommsLintRule`); on match return `{ ok:false, phrase:m[0], reason:'banned jargon', suggest:rule.suggest }`.
   - Passive check: `rules.passive.some(r => r.pattern.test(text))`; active context = `rules.activeContext.test(text) || rules.nextSignalContext.test(text)`; on passive-without-context return the same shape as today (reason string unchanged: `'passive posture framing without active-work or specific next-signal context'`). Match phrase via the two passive rules' patterns. Preserve the existing fallback phrase string.

4. **Refactor `lintOutboundTelegramMessage`** to `(text, explicitNaming, rules)`:
   - Run base `lintOutboundMessage(text, rules)`; return on fail.
   - Iterate `rules.telegram`; on match return `{ ok:false, phrase:m[0], reason: rule.suggest ? `${rule.reason} — ${rule.suggest}` : rule.reason, suggest: rule.suggest }`. (Keep the existing reason-folding for backward-compatible error text; ALSO surface `suggest` separately for `--suggest`. NOTE the folded reason uses an em-dash today at L241 — preserve the existing character to keep error text identical for the regression tests; this is internal CLI stderr, not a David-facing send.)
   - Agent name: if `!explicitNaming && rules.agentName` and it matches, return the fail shape (same reason-folding, plus `suggest`). If `rules.agentName` is `null` (allowlisted away), skip the gate.

5. **Refactor the two enforce functions** to resolve rules and pass them in, and to handle `--suggest`:
   - Change `enforceOutboundLintOrExit(text, skipLint, opts?)` and `enforceTelegramLintOrExit(text, skipLint, explicitNaming, opts?)` to accept a `suggest?: boolean` (thread it from the command options) and to resolve rules:
     ```ts
     const env = resolveEnv();
     const rules = resolveCommsLintRules({ org: env.org, agentDir: env.agentDir, frameworkRoot: env.frameworkRoot });
     ```
   - **`--skip-lint` path: unchanged** — return immediately, no resolution needed (keep current early-return).
   - **`--suggest` path:** run the lint with resolved rules. If `!result.ok`, print to **stdout** a dry-run report (phrase + `result.suggest ?? result.reason`) and **return without sending / without exit 1**. If `result.ok`, print a clean "would pass" confirmation to stdout and **return without sending** (dry-run never sends). Signal back to the caller that it must NOT proceed to send — simplest: have the enforce functions return a boolean `proceed` (false under `--suggest` always; false on block; true otherwise) and update the three call sites to `if (!enforce...) return;`. Alternatively keep `process.exit`-on-block for the non-suggest path and add a separate `runSuggest(...)` helper the action calls first. Pick one; the master plan only requires: suggest => exit 0, no send; no-suggest block => exit 1; no-suggest clean => send.
   - **Default (no flags) path: unchanged** — block + `process.exit(1)` on fail, proceed on pass.

6. **Add the `--suggest` option** to the three commands and thread it:
   - `send-message` (action ~L354): add `.option('--suggest', 'Dry-run: print the offending phrase + a rewrite hint and exit 0 without sending', false)`; pass `opts.suggest` into `enforceOutboundLintOrExit`.
   - `send-telegram` (~L1366): add the same option; pass into `enforceTelegramLintOrExit`.
   - `send-mobile-reply` (~L2115): add the same option; pass into `enforceOutboundLintOrExit`.

7. **Verify the default path is byte-for-byte.** Because `resolveCommsLintRules({...})` with no config returns the defaults, and the lint functions now run those defaults, the existing 18 tests must pass with zero changes. Run them.

8. **Write `tests/unit/cli/comms-lint-configurable.test.ts`** — the 7 cases in master plan §8 "Shard 2 integration tests". Mirror the existing harness (tempdir `CTX_*` env, `fwRoot/orgs/testorg/...`, mocks for `sendMessage`/`logEvent`/`TelegramAPI`). For config-driven cases, write a `comms_lint` block into `<fwRoot>/orgs/testorg/context.json` (org layer) or `<fwRoot>/orgs/testorg/agents/test-agent/config.json` (agent layer) inside the test's tempdir before calling `parseAsync`. For `--suggest` cases, spy on `console.log`/stdout and assert the phrase + hint printed and the send spy was NOT called and no throw occurred.

## Validation Requirements (exact commands)

- `npm run build` — clean.
- `npm run typecheck` — clean.
- `npx vitest run tests/unit/cli/outbound-comms-lint.test.ts` — all 18 PASS, unchanged.
- `npx vitest run tests/unit/cli/comms-lint-configurable.test.ts` — all new cases green.
- `npx vitest run` — full suite green.

## Handoff Requirements

- Confirm the 18 existing tests pass with no edits to that file.
- Confirm no code path reachable from a send can throw out of `resolveCommsLintRules` (fail-open verified by the malformed-config integration test).
- Confirm `--suggest` never calls the send spy in any test.
- `src/types/index.ts` and `src/bus/comms-lint-config.ts` left unedited (import-only).
- Summarize for the human approval gate: what changed in bus.ts, the new flag, and the config schema location (point to master plan §4.5).
