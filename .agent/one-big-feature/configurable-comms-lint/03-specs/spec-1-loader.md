# Spec 1: Rule-Loader Module + Type Additions

**Shard:** 1 of 2
**Depends on:** nothing
**Implement:** FIRST. Must be green before Shard 2 begins.

## Objective

Create a standalone, fail-open rule-loader module that reads per-org and per-agent comms-lint config, merges it with the hardcoded defaults per the precedence rules in the master plan (§4), compiles regex safely, and returns a fully-resolved rule set. Add the config type interfaces to `src/types/index.ts`. The module must reproduce the current hardcoded behavior byte-for-byte when no config is present, and must NEVER throw.

## Owned Files (you may create/edit)

- `src/bus/comms-lint-config.ts` (NEW — the loader, default rule set, and `CommsLintRule` / `ResolvedCommsLintRules` types)
- `src/types/index.ts` (ADD ONLY: `CommsLintRuleSpec`, `CommsLintGroupConfig`, `CommsLintConfig` interfaces; ADD `comms_lint?: CommsLintConfig` to `AgentConfig` ~L160 and to `OrgContext` ~L515). Do not modify anything else in this file.
- `tests/unit/bus/comms-lint-config.test.ts` (NEW)

## Files You May Read But NOT Edit

- `src/cli/bus.ts` (lines 76-279 — copy the regex sources/flags and the four rule groups EXACTLY; this is your source of truth for the defaults). Do not edit it — Shard 2 owns it.
- `src/utils/env.ts` (`resolveEnv` — for understanding `org`/`agentDir`/`frameworkRoot`).
- `tests/unit/cli/outbound-comms-lint.test.ts` (the env/tempdir/mock harness pattern to mirror in your own test).
- `src/types/index.ts` `OrgContext`/`AgentConfig` surrounding context.

## Provided Contracts (other specs consume these)

Exported from `src/bus/comms-lint-config.ts`:

```ts
export interface CommsLintRule {
  id: string;
  pattern: RegExp;
  reason: string;
  suggest?: string;
  group: 'banned' | 'passive' | 'telegram' | 'agent-name';
}

export interface ResolvedCommsLintRules {
  banned: CommsLintRule[];
  passive: CommsLintRule[];
  activeContext: RegExp;
  nextSignalContext: RegExp;
  telegram: CommsLintRule[];
  agentName: CommsLintRule | null;
}

export function getDefaultCommsLintRules(): ResolvedCommsLintRules;

export function resolveCommsLintRules(opts: {
  org?: string;
  agentDir?: string;
  frameworkRoot?: string;
}): ResolvedCommsLintRules;  // never throws; fails open to defaults
```

Added to `src/types/index.ts`:

```ts
export interface CommsLintRuleSpec {
  id: string;        // /^[a-z0-9:_-]+$/
  pattern: string;
  flags?: string;    // subset of "gimsuy"; default "i"
  reason: string;
  suggest?: string;
}
export interface CommsLintGroupConfig {
  replace?: CommsLintRuleSpec[];
  add?: CommsLintRuleSpec[];
  allow?: string[];
}
export interface CommsLintConfig {
  banned?: CommsLintGroupConfig;
  passive?: CommsLintGroupConfig;
  telegram?: CommsLintGroupConfig;
  agentName?: CommsLintGroupConfig;
  add_active_context?: string[];
  add_next_signal_context?: string[];
}
```

## Consumed Contracts

None (leaf module). Reads files via `fs` and `path` directly, mirroring `checkDeliverableRequirement`.

## Adjacent Specs

- Spec 2 (bus-integration) imports `resolveCommsLintRules`, `ResolvedCommsLintRules`, `CommsLintRule`, and the three config types. Keep the signature and exports stable.

## Implementation Steps

1. **Add the config types** to `src/types/index.ts` (the three interfaces above) and the two `comms_lint?: CommsLintConfig` field additions to `AgentConfig` and `OrgContext`. Add JSDoc comments on `CommsLintConfig` summarizing add/allow/replace semantics so operators see them in editor hover.

2. **Encode the defaults** in `comms-lint-config.ts` as `getDefaultCommsLintRules()`. Transcribe the four groups from `src/cli/bus.ts` EXACTLY:
   - `banned` ← `BANNED_POSTURE_PATTERNS` (bus.ts L82-93), ids per master plan §4.6, all flags `i`, order preserved.
   - `passive` ← `PASSIVE_POSTURE_PATTERNS` (L95-98): two rules `passive:posture-set`, `passive:waiting`, flags `i`.
   - `activeContext` ← `ACTIVE_WORK_CONTEXT` (L100), `nextSignalContext` ← `NEXT_SIGNAL_CONTEXT` (L101) — copy source + `i` flag exactly.
   - `telegram` ← `TELEGRAM_BANNED_PATTERNS` (L184-218): ids `telegram:pr-number`, `telegram:pull-request-number`, `telegram:commit-sha`, `telegram:brand-cortextos`, `telegram:em-dash`. **The em-dash pattern `/[–—―]/` has NO `i` flag in bus.ts — preserve flags exactly per-rule, do not blanket-apply `i`.** Carry each rule's `reason` and `suggest` verbatim.
   - `agentName` ← `AGENT_NAME_PATTERN` (L220-224), id `agent-name:default`, flags `i`.
   - Each default rule's `pattern` is a real compiled `RegExp` built from the same source + flags as bus.ts. Verify `.source` and `.flags` match.

3. **Write the safe compiler** `compileRuleSpec(spec): CommsLintRule | null`:
   - Validate `id` matches `/^[a-z0-9:_-]+$/`; else return null.
   - Validate `flags` (default `"i"`) is a subset of `gimsuy` (regex `/^[gimsuy]*$/`); else null.
   - Reject `pattern.length > 1000`; else null.
   - `try { new RegExp(spec.pattern, flags) } catch { return null }`.
   - Carry `id`, `reason`, `suggest`, and the `group` passed by the caller.

4. **Write the per-group merge** `mergeGroup(defaults: CommsLintRule[], cfg: CommsLintGroupConfig | undefined, group): CommsLintRule[]`:
   - Base = `cfg?.replace` present ? compile each replace spec (drop nulls) : `defaults`.
   - Append compiled `cfg?.add` specs (drop nulls).
   - Remove any rule whose `id` is in `cfg?.allow`.
   - Return the result. (Order: replace → add → allow, per master plan §4.1.)

5. **Write the layer apply** that takes a `CommsLintConfig | undefined` and a current `ResolvedCommsLintRules`, returns a new resolved set with each group merged, and extends `activeContext` / `nextSignalContext` from `add_active_context` / `add_next_signal_context` (compile each extra source with the length/syntax guard; OR onto the existing regex via `new RegExp(existing.source + '|' + extra, 'i')`; on any failure keep the existing regex). Handle `agentName` group specially: it is a single rule, so `mergeGroup` returns an array of 0 or 1 — map `[]` → `null`, `[rule]` → that rule; if `add`/`replace` would yield >1, take the first (document this).

6. **Write `resolveCommsLintRules`**:
   - Start from `getDefaultCommsLintRules()`.
   - Read org config: if `org && frameworkRoot`, read `<frameworkRoot>/orgs/<org>/context.json`, `JSON.parse` in try/catch (use `stripBom` like env.ts L85 if convenient, else plain parse), extract `.comms_lint`. On any error skip silently.
   - Apply org layer.
   - Read agent config: if `agentDir`, read `<agentDir>/config.json`, parse in try/catch, extract `.comms_lint`. On error skip.
   - Apply agent layer on top.
   - Return. Wrap the WHOLE body in a try/catch that returns `getDefaultCommsLintRules()` on any unexpected throw — belt-and-suspenders fail-open.

7. **Write the unit tests** (`tests/unit/bus/comms-lint-config.test.ts`) — the 12 cases listed in master plan §8 "Shard 1 unit tests". Use `mkdtempSync` tempdirs for the config files; no env mutation needed since you pass opts directly. Assert resolved ids/sources/flags for the default case.

## Validation Requirements (exact commands)

- `npm run build` — clean.
- `npm run typecheck` — clean.
- `npx vitest run tests/unit/bus/comms-lint-config.test.ts` — all green.
- `npx vitest run` — full suite green (confirms the type additions to index.ts didn't break anything; the existing 18 lint tests still pass since bus.ts is untouched in this shard).

## Handoff Requirements

- Module exports exactly the signatures in "Provided Contracts" — do not rename.
- Confirm in your handoff note: the default rule count per group (banned 10, passive 2, telegram 5, agentName 1) and that em-dash rule has empty flags.
- State that `resolveCommsLintRules({})` returns the byte-for-byte defaults (Shard 2 relies on this for the regression path).
- Leave `src/cli/bus.ts` untouched.
