# Discovery: Configurable Comms-Lint

**Feature slug:** configurable-comms-lint
**Branch / worktree:** `feature/configurable-comms-lint` at `/Users/davidhunter/cortextos-obf-comms-lint` (off `main` @ bce2db5)
**Orchestrator:** dane
**Date:** 2026-06-08 (overnight run)

## Feature Request

Make the outbound comms-lint banned-phrase rules **configurable per org and per agent**, instead of hardcoded in `src/cli/bus.ts`. Preserve the current rules as **fallback defaults** so behavior is byte-for-byte identical when no config is present (backward compatible). Add a **`--suggest` dry-run mode** that reports the offending phrase plus a rewrite hint instead of failing — so message authors get a corrected alternative, not just a rejection.

### Motivation (real, dogfooded)
- Tonight the orchestrator's own Telegram messages were rejected twice for the word "holding" (a hardcoded banned posture phrase). The only escape was `--skip-lint`. There is no way to (a) customize the rule set per org/agent without a code change + redeploy, or (b) get a suggested rewrite.
- Operators running this agent framework for other orgs need org-specific bans (a customer's internal jargon) and allowlists (technical teams that tolerate "PR #"). Today that requires editing TypeScript.

## Current State (grounded in code)

### Lint implementation — `src/cli/bus.ts` (lines 76–279)
- `OutboundLintResult` type: `{ ok: boolean; phrase?: string; reason?: string }`.
- `BANNED_POSTURE_PATTERNS: RegExp[]` (L82-93) — hard fail list (sleep posture, standing by, parked, idle, holding, waiting-on-X, etc).
- `PASSIVE_POSTURE_PATTERNS: RegExp[]` (L95-98) — soft list; only fails when NEITHER `ACTIVE_WORK_CONTEXT` (L100) NOR `NEXT_SIGNAL_CONTEXT` (L101) regex matches.
- `lintOutboundMessage(text): OutboundLintResult` (L103-129) — base lint used by all outbound (send-message, send-mobile-reply, send-telegram).
- `TelegramLintRule` type (L178-182): `{ pattern: RegExp; reason: string; suggest?: string }`. **NOTE: `suggest` already exists** — half the rewrite-hint work is done; rules already carry suggestions, they are just folded into the reason string today (L241), not surfaced as a separate actionable rewrite.
- `TELEGRAM_BANNED_PATTERNS: TelegramLintRule[]` (L184-218) — telegram-only: PR #, pull request #, commit SHA, "cortextos" brand, em/en-dash. Each has a `suggest`.
- `AGENT_NAME_PATTERN: TelegramLintRule` (L220-224) — blocks agent names unless `--explicit-naming`.
- `lintOutboundTelegramMessage(text, explicitNaming)` (L226-261) — runs base lint, then telegram patterns, then agent-name gate.
- `enforceOutboundLintOrExit(text, skipLint)` (L158-171) and `enforceTelegramLintOrExit(text, skipLint, explicitNaming)` (L263-279) — call the lint, `console.error` + `process.exit(1)` on violation.

### Config-loading conventions (the pattern to follow)
- `checkDeliverableRequirement` (L41-71) is the canonical example: reads `<frameworkRoot>/orgs/<org>/context.json`, `JSON.parse`, **fails open** (returns null / allows) on any read/parse error. Mirror this defensive posture.
- Env resolution: `resolveEnv()` (`src/utils/env.ts`) gives `frameworkRoot`/`projectRoot`, `org`, `agentName`, `agentDir`. `agentDir = <projectRoot>/orgs/<org>/agents/<agentName>` (L62-71). Org context = `<projectRoot>/orgs/<org>/context.json` (L80).
- Agent config lives at `<agentDir>/config.json` (`AgentConfig`, `src/types/index.ts` L160). Org context = `OrgContext` (`src/types/index.ts` L515).

### Tests — `tests/unit/cli/outbound-comms-lint.test.ts` (259 lines, 18 cases, all PASS)
- Per-test tempdir via `mkdtempSync`; isolated `CTX_*` env; mocks `sendMessage`, `logEvent`, `TelegramAPI`; drives via `busCommand.parseAsync([...], { from: 'user' })`; asserts spies + rejects.
- This file MUST stay green (regression guard for default behavior).

## Contracts (to be honored by all writers)

1. **`OutboundLintResult` stays shape-compatible.** May ADD optional fields (e.g. `suggest?: string`); must not remove or rename `ok`/`phrase`/`reason`.
2. **Default behavior is identical when no config present.** Hardcoded rule sets become the fallback defaults. The existing 18 tests pass unchanged.
3. **Rule loader fails OPEN** (missing/malformed config → fall back to defaults, never crash a send). Mirror `checkDeliverableRequirement`.
4. **Config is additive/overriding, explicitly scoped.** Define precedence: agent config overrides org config overrides hardcoded defaults. Define whether config *adds* phrases, *replaces* the list, or *removes* (allowlists) phrases — must be unambiguous.
5. **`--suggest` is dry-run only**: prints phrase + rewrite hint, exits 0, does NOT send. Without `--suggest`, behavior is unchanged (block + exit 1).

## Non-Goals (explicit scope fence)
- NO hook-dispatcher wiring (RFC #15 Day-2 / `src/bus/hooks.ts`).
- NO `lint-report`/stats command.
- NO change to which subcommands are linted, or to the base vs telegram split.
- NO live external calls. All validation is offline vitest.

## Risk Notes
- `src/cli/bus.ts` is large and central. Only ONE writer should own it (Shard 2). The new loader module (Shard 1) owns its own file + the type additions.
- Config schema must be documented so operators can actually use it (README or inline type comments).
- Precedence/merge semantics are the subtle part — get the contract crisp in the master plan before any code.
