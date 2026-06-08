# Master Plan: Configurable Comms-Lint

**Feature slug:** configurable-comms-lint
**Branch / worktree:** `feature/configurable-comms-lint` at `/Users/davidhunter/cortextos-obf-comms-lint` (off `main`)
**Orchestrator:** dane
**Date:** 2026-06-08
**Status:** PLANNED — no application code written yet

---

## 1. Feature Summary

Make the outbound comms-lint banned-phrase rules **configurable per org and per agent**, instead of being hardcoded in `src/cli/bus.ts`. The current hardcoded rule sets become the **fallback defaults**, so behavior is byte-for-byte identical when no config is present (fully backward compatible). Add a **`--suggest` dry-run mode** that, when a message would be blocked, prints the offending phrase plus a rewrite hint and **exits 0 without sending** — giving authors a corrected alternative instead of a hard rejection.

### Why
- The orchestrator's own Telegram messages get rejected for hardcoded banned phrases (e.g. "holding"), with the only escape being `--skip-lint`. There is no way to customize the rule set per org/agent without a code change + redeploy, and no way to get a suggested rewrite.
- Operators running this framework for other orgs need org-specific bans (a customer's internal jargon) and allowlists (technical teams that tolerate "PR #"). Today that requires editing TypeScript.

## 2. Non-Goals (binding, restated from discovery)

- NO hook-dispatcher wiring (RFC #15 Day-2 / `src/bus/hooks.ts`).
- NO `lint-report` / stats command.
- NO change to **which** subcommands are linted, or to the base-vs-telegram lint split.
- NO live external calls. All validation is offline vitest.
- NO change to the `OutboundLintResult` field names `ok` / `phrase` / `reason` (may ADD optional fields only).

---

## 3. Architecture Approach

### 3.1 Where the loader lives
A new standalone module: **`src/bus/comms-lint-config.ts`**. It exports:
- The config TypeScript interfaces (so both the loader and bus.ts share one source of truth).
- A pure data representation of the **hardcoded defaults** (the four rule groups currently in bus.ts, expressed as the new data shape).
- A single **loader/merge function** `resolveCommsLintRules(...)` that reads org + agent config, merges per the precedence rules below, compiles regex safely, and returns a fully-resolved, ready-to-run rule set. **Fails open** to defaults on any error (mirrors `checkDeliverableRequirement` in bus.ts L41-71).

This keeps `src/cli/bus.ts` (large, central) owned by exactly one writer (Shard 2). Shard 1 owns the new module and the type additions only.

### 3.2 How rules are represented as data
The current lint has four logical rule groups, today expressed as bare `RegExp[]` and `TelegramLintRule[]`. We normalize all four into a single typed rule shape so config and defaults are interchangeable:

```ts
// Each compiled rule the linter actually runs.
interface CommsLintRule {
  id: string;            // stable identifier, used for allowlist removal (e.g. "banned:holding", "telegram:pr-number")
  pattern: RegExp;       // compiled regex
  reason: string;        // human-readable why
  suggest?: string;      // rewrite hint (surfaced by --suggest; folded into reason on hard-fail for telegram parity)
  group: 'banned' | 'passive' | 'telegram' | 'agent-name'; // which lint stage runs it
}
```

The resolved object the loader returns:

```ts
interface ResolvedCommsLintRules {
  banned: CommsLintRule[];      // hard-fail base patterns (was BANNED_POSTURE_PATTERNS)
  passive: CommsLintRule[];     // soft base patterns (was PASSIVE_POSTURE_PATTERNS)
  activeContext: RegExp;        // was ACTIVE_WORK_CONTEXT (config may extend; see §4)
  nextSignalContext: RegExp;    // was NEXT_SIGNAL_CONTEXT
  telegram: CommsLintRule[];    // was TELEGRAM_BANNED_PATTERNS
  agentName: CommsLintRule | null; // was AGENT_NAME_PATTERN (null only if allowlisted away)
}
```

`bus.ts` keeps its existing `OutboundLintResult` and the two lint functions, but those functions are refactored to **accept a `ResolvedCommsLintRules` argument** instead of closing over module-level `const` arrays. `enforceOutboundLintOrExit` / `enforceTelegramLintOrExit` resolve the rules once (via the loader) and pass them in. Default-only path returns the defaults object whose `.id`/`.pattern`/`.reason` are identical to today's hardcoded values, so observable behavior is unchanged.

### 3.3 How bus.ts consumes them
- At each enforce site, call `resolveCommsLintRules({ org, agentDir, frameworkRoot })` (env already resolved at every call site via `resolveEnv()` / `resolvePaths()`).
- Pass the resolved object into `lintOutboundMessage(text, rules)` and `lintOutboundTelegramMessage(text, explicitNaming, rules)`.
- New `--suggest` flag: when set, run the lint, and if `ok === false`, print the phrase + suggest hint to **stdout** and **return without sending** (exit 0). If `ok === true` under `--suggest`, print a clean confirmation and still **do not send** (dry-run means dry-run — never sends). When `--suggest` is absent, behavior is unchanged (block + `process.exit(1)`, or send).

---

## 4. Precedence / Merge Semantics (the subtle part — fully specified)

### 4.1 Three layers, three operations
Config can do three things, expressed as **three explicit, separately-named arrays** so intent is never ambiguous (no "does adding replace?" guessing):

| Operation | Config key | Effect |
|-----------|-----------|--------|
| **ADD** | `add: RuleSpec[]` | Append new rules to the resolved set for that group. |
| **REMOVE** (allowlist) | `allow: string[]` | Remove rules whose `id` matches, by exact id. This is how an org tolerates "PR #" — it allowlists `telegram:pr-number`. |
| **REPLACE** | `replace: RuleSpec[]` | Discard ALL defaults for that group and use only these. Opt-in, per-group, explicit. |

Within a single group, the resolution order is deterministic: **start from defaults → if `replace` is present, the group's base becomes `replace` (defaults discarded) → apply `add` (append) → apply `allow` (remove by id).** `allow` runs last so it can also strip a just-added or just-replaced rule by id; `replace` makes `allow` against defaults a no-op (nothing left to remove) which is the intended semantics — replace is a clean slate.

### 4.2 Layer precedence: agent > org > hardcoded defaults
Two config layers exist: **org** (`<projectRoot>/orgs/<org>/context.json`, field `comms_lint`) and **agent** (`<agentDir>/config.json`, field `comms_lint`). Resolution:

1. Start from **hardcoded defaults** (the four groups).
2. Apply the **org** layer's `replace` / `add` / `allow` (in that intra-group order).
3. Apply the **agent** layer's `replace` / `add` / `allow` on top of the org-resolved set.

So agent config has the final say. An agent `replace` wipes whatever org+defaults produced for that group; an agent `allow` can re-permit a phrase the org added; an agent `add` can re-ban a phrase the org allowlisted. This is strict last-writer-wins by layer, with the operation order fixed within each layer. **Precedence is total and unambiguous: agent overrides org overrides hardcoded.**

### 4.3 Regex expressed safely in JSON
JSON cannot hold a native `RegExp`, so each `RuleSpec` carries the pattern as a **string + flags**:

```ts
interface RuleSpec {
  id: string;                 // required; used for allow/dedup. Must match /^[a-z0-9:_-]+$/
  pattern: string;            // regex source as a string
  flags?: string;             // subset of "gimsuy"; default "i" to match current case-insensitive behavior
  reason: string;             // required
  suggest?: string;           // optional rewrite hint
}
```

Compilation rules (all enforced in the loader, all FAIL OPEN — a bad rule is dropped, never thrown):
- **Flag validation:** flags must be a subset of `gimsuy`. Any other character → drop that single rule (skip it), keep the rest.
- **Length cap:** `pattern.length > 1000` → drop the rule (bounds pattern/memory size and accidental blowups; real patterns are short). NOTE: the length cap does NOT mitigate catastrophic backtracking (ReDoS) — a pathological pattern can hang on <10 chars (e.g. `(a+)+$`). See the trust note below.
- **Compile guard:** `new RegExp(pattern, flags)` wrapped in try/catch. On `SyntaxError` (invalid regex), **drop that single rule** and continue. One bad rule never disables the others, and never crashes the send path.
- **Injection note:** the pattern is only ever used as a *matcher against outbound text* — it is never `eval`'d, never interpolated into a shell, never used to build a path. The only attack surface is a catastrophic-backtracking pattern in a config the operator themselves wrote. The real mitigation is the TRUST MODEL: comms-lint config is operator-authored (not user/network input), trusted, and committed alongside code — not the length cap, which does not bound backtracking. Config authors must avoid nested quantifiers like `(a+)+`. We do NOT add a regex-safety static analyzer (out of scope); the trust boundary + try/catch + the operator-facing JSDoc caveat on `CommsLintRuleSpec.pattern` are the documented controls.
- **`add`/`replace` rule that fails any check is silently dropped**; if ALL of a layer's specs are invalid, the layer contributes nothing and we fall back to the prior layer's resolved set. If the whole config file is missing/malformed JSON → that layer is skipped entirely (fail open to defaults).

### 4.4 `activeContext` / `nextSignalContext`
These two are context *allowers* for the passive group, not banned patterns. To keep scope tight and the contract simple, config may **extend** them via optional string arrays `add_active_context: string[]` / `add_next_signal_context: string[]` — each compiled like a `RuleSpec` pattern (same guards) and OR-combined onto the default regex via `new RegExp(default.source + '|' + extra, 'i')`. If extension compilation fails, fall back to the default regex unchanged. There is no `replace` for these two (deliberately — weakening the active-context allower wholesale is a footgun; orgs that want to permit a passive phrase should allowlist the specific passive rule instead). This is documented as an intentional asymmetry.

### 4.5 Exact config schema (TypeScript + JSON example)

```ts
// Added to src/types/index.ts and consumed by the loader.
export interface CommsLintRuleSpec {
  id: string;
  pattern: string;
  flags?: string;        // subset of "gimsuy"; default "i"
  reason: string;
  suggest?: string;
}

export interface CommsLintGroupConfig {
  replace?: CommsLintRuleSpec[]; // discard defaults for this group, use only these
  add?: CommsLintRuleSpec[];     // append to the group
  allow?: string[];              // remove rules by id (allowlist)
}

export interface CommsLintConfig {
  banned?: CommsLintGroupConfig;
  passive?: CommsLintGroupConfig;
  telegram?: CommsLintGroupConfig;
  agentName?: CommsLintGroupConfig; // allow:["agent-name:default"] disables the agent-name gate
  add_active_context?: string[];    // regex sources OR-ed onto ACTIVE_WORK_CONTEXT
  add_next_signal_context?: string[];
}
```

- On `AgentConfig` (src/types/index.ts ~L160): add `comms_lint?: CommsLintConfig;`
- On `OrgContext` (src/types/index.ts ~L515): add `comms_lint?: CommsLintConfig;`

**JSON example** — an org that tolerates "PR #" and bans an internal codename, and one agent that re-bans nothing but adds a phrase:

`orgs/acme/context.json`:
```json
{
  "name": "acme",
  "comms_lint": {
    "telegram": {
      "allow": ["telegram:pr-number", "telegram:pull-request-number"],
      "add": [
        { "id": "telegram:project-bluebird", "pattern": "\\bproject bluebird\\b", "flags": "i",
          "reason": "internal codename leak", "suggest": "say 'the new portal' instead" }
      ]
    }
  }
}
```

`orgs/acme/agents/dane/config.json`:
```json
{
  "model": "opus",
  "comms_lint": {
    "banned": { "allow": ["banned:holding"] }
  }
}
```

Resolved effect for agent `dane` in org `acme`: telegram lint no longer blocks "PR #45" or "pull request #45" but DOES block "project bluebird"; base banned list no longer blocks "holding" (org didn't touch it, agent allowlisted it); all other defaults intact.

### 4.6 Default rule ids (the allowlist contract)
The loader assigns these stable ids to the hardcoded defaults so operators can allowlist them. These are part of the public contract and MUST be stable:

- Banned group: `banned:sleep-posture`, `banned:standing-by`, `banned:standby`, `banned:parked`, `banned:on-deck`, `banned:idle`, `banned:asleep`, `banned:sleeping`, `banned:waiting-on`, `banned:holding`
- Passive group: `passive:posture-set`, `passive:waiting`
- Telegram group: `telegram:pr-number`, `telegram:pull-request-number`, `telegram:commit-sha`, `telegram:brand-cortextos`, `telegram:em-dash`
- Agent-name: `agent-name:default`

(Spec 1 owns the exact mapping table; it must match the regexes in bus.ts L82-224 byte-for-byte in pattern + flags.)

---

## 5. Shard List & Dependency Order

| Shard | File | Title | Depends on |
|-------|------|-------|-----------|
| **Shard 1** | `spec-1-loader.md` | Rule-loader module + type additions | none |
| **Shard 2** | `spec-2-bus-integration.md` | bus.ts integration + `--suggest` flag + new tests | Shard 1 (compiled module + types) |

Two shards, as recommended. The split is along the one-writer-owns-bus.ts constraint: Shard 1 is pure new code (module + types, no edits to bus.ts), Shard 2 is the integration that consumes Shard 1's contract and is the **sole editor of bus.ts**. This is the natural seam — the loader is independently unit-testable, and bus.ts changes are confined to one writer.

**Implementation is SEQUENTIAL on the single feature branch**, not parallel worktrees: Shard 2 imports Shard 1's compiled module (`resolveCommsLintRules`) and its exported types. Writer 2 starts only after Writer 1 has landed and `npm run build` + `npx vitest run` are green for Shard 1. No second worktree is created.

---

## 6. File Ownership Strategy (NON-OVERLAPPING)

| File | Owner | Others |
|------|-------|--------|
| `src/bus/comms-lint-config.ts` (NEW) | Shard 1 | Shard 2 imports only |
| `src/types/index.ts` | Shard 1 (adds the 3 interfaces + 2 field additions) | Shard 2 reads |
| `src/cli/bus.ts` | **Shard 2 (sole editor)** | Shard 1 reads for grounding, never edits |
| `tests/unit/bus/comms-lint-config.test.ts` (NEW) | Shard 1 | — |
| `tests/unit/cli/outbound-comms-lint.test.ts` (existing 18) | Shard 2 (must keep green; may not modify existing cases) | Shard 1 reads |
| `tests/unit/cli/comms-lint-configurable.test.ts` (NEW) | Shard 2 | — |

`src/cli/bus.ts` is owned by exactly one shard (Shard 2). `src/types/index.ts` is owned by Shard 1 only; Shard 2 reads the new types but does not edit the file.

---

## 7. Cross-Spec Contracts

The loader function Shard 2 consumes (provided by Shard 1):

```ts
// src/bus/comms-lint-config.ts
export function resolveCommsLintRules(opts: {
  org?: string;
  agentDir?: string;
  frameworkRoot?: string;   // a.k.a. projectRoot; org context lives at <frameworkRoot>/orgs/<org>/context.json
}): ResolvedCommsLintRules;

// Always returns a fully-populated object. NEVER throws. Missing/malformed config
// or invalid regex → falls back to defaults (whole or per-rule). With all-undefined
// opts, returns the byte-for-byte default rule set.

export interface ResolvedCommsLintRules {
  banned: CommsLintRule[];
  passive: CommsLintRule[];
  activeContext: RegExp;
  nextSignalContext: RegExp;
  telegram: CommsLintRule[];
  agentName: CommsLintRule | null;
}

export interface CommsLintRule {
  id: string;
  pattern: RegExp;
  reason: string;
  suggest?: string;
  group: 'banned' | 'passive' | 'telegram' | 'agent-name';
}

// Also exported for Shard 1's own tests and as the canonical default source:
export function getDefaultCommsLintRules(): ResolvedCommsLintRules;
```

Types `CommsLintRuleSpec`, `CommsLintGroupConfig`, `CommsLintConfig` are added to `src/types/index.ts` (Shard 1) and re-exported / imported by both the loader and bus.ts.

`OutboundLintResult` gains one optional field (Shard 2, in bus.ts): `suggest?: string` — so `--suggest` can surface the rewrite hint separately from `reason`. This is the only `OutboundLintResult` change and it is additive.

---

## 8. Test Strategy

**Regression guard (non-negotiable):** the existing 18 cases in `tests/unit/cli/outbound-comms-lint.test.ts` must pass **unchanged**. They run with no `comms_lint` config in env, exercising the default path. Shard 2 may not edit existing cases; if any fails, the default-resolution path diverged from the hardcoded behavior and must be fixed in the loader/integration, not the test.

**Shard 1 unit tests** (`tests/unit/bus/comms-lint-config.test.ts`, pure loader, no bus):
1. No config (all opts undefined) → resolved set equals defaults (assert ids + pattern sources + flags for each group; assert count per group).
2. Missing config files → defaults (fail open).
3. Malformed JSON in org context → defaults (fail open).
4. `add` appends a rule to the right group.
5. `allow` removes a default rule by id (e.g. `banned:holding` gone).
6. `replace` discards all defaults for a group and uses only the provided rules.
7. Agent layer overrides org layer (agent `allow` re-permits an org-added ban; agent `add` re-bans an org-allowlisted phrase).
8. Invalid regex in a spec → that single rule dropped, others survive, no throw.
9. Invalid flags (e.g. `"xz"`) → that rule dropped.
10. Over-length pattern (>1000 chars) → dropped.
11. `add_active_context` extends the active-context regex (a passive phrase now passes when the extra context word is present); bad extension → default regex unchanged.
12. `agentName.allow: ["agent-name:default"]` → `agentName` resolves to `null`.

**Shard 2 integration tests** (`tests/unit/cli/comms-lint-configurable.test.ts`, drives `busCommand.parseAsync`, mirrors the existing test harness for env/tempdir/mocks):
1. Org config that allowlists `telegram:pr-number` → `send-telegram` with "PR #45" now SENDS (telegramSendSpy called).
2. Agent config that allowlists `banned:holding` → `send-message`/`send-telegram` with "holding" now SENDS.
3. Org `add` of a custom banned phrase → that phrase now BLOCKS.
4. `--suggest` on a would-be-blocked message → prints phrase + suggest to stdout, exits 0, does NOT send (spy not called, no exit-1/throw).
5. `--suggest` on a clean message → prints clean confirmation, does NOT send (dry-run).
6. Malformed agent config.json → falls open to defaults (a default-banned phrase still BLOCKS; a clean message still SENDS) — proves fail-open in the real send path.
7. Invalid regex in config → default rules still enforce, no crash.

**Commands (exact):**
- Build: `npm run build`
- Typecheck: `npm run typecheck`
- Tests: `npx vitest run`
- Scoped during dev: `npx vitest run tests/unit/bus/comms-lint-config.test.ts` (Shard 1), `npx vitest run tests/unit/cli/outbound-comms-lint.test.ts tests/unit/cli/comms-lint-configurable.test.ts` (Shard 2).

---

## 9. Rollout & Approval Gates

- All work lands on `feature/configurable-comms-lint` only. **No merge to `main`** without explicit human (David) approval.
- Gate 1 (after Shard 1): `npm run build` + `npm run typecheck` + Shard-1 unit tests green. Loader is independently correct and fail-open.
- Gate 2 (after Shard 2): full `npx vitest run` green INCLUDING the unchanged 18 regression tests + the new configurable + `--suggest` tests; `npm run build` + `npm run typecheck` clean.
- Gate 3 (integrated review): diff reviewed for the precedence/merge correctness, the fail-open posture (no throw reachable from a send path), and that `--suggest` never sends.
- Gate 4 (human approval): surface the branch + a short summary to David. Merge only on his go. This feature changes a guardrail that gates David-facing comms, so the human gate is mandatory.

---

## 10. Risk Notes Carried Forward

- `src/cli/bus.ts` is large and central — single writer (Shard 2) only.
- Default-path parity is the highest risk: the loader's default rule set must reproduce the four hardcoded groups exactly (pattern source + flags + order). Shard 1 test #1 is the explicit guard; Shard 2 regression tests are the end-to-end guard.
- Config schema is documented inline (type comments) and via the JSON example in §4.5 so operators can use it without reading TypeScript.
