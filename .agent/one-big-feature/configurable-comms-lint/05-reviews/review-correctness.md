# Review — Correctness, Contract Compatibility, Backward-Compatibility

**Branch:** `feature/configurable-comms-lint` (3a89dce + 7642412 on bce2db5)
**Reviewer lens:** correctness, contract compatibility, backward-compat
**Validation run:** `npm run typecheck` (clean), `npm run build` (success), targeted vitest 47/47 PASS.

---

## Summary verdict

The implementation is faithful to the master plan and is genuinely backward-compatible. Default rule fidelity is byte-for-byte (verified by code inspection AND an honest test that compares source + flags + counts). Merge/precedence matches §4. `--suggest` never sends on either path and exits 0. The 18 original regression tests pass unchanged. I found **no correctness or compatibility regressions**. There are two minor design inconsistencies worth noting (non-blocking) and one test-coverage gap (non-blocking, the loader layer already covers it).

---

## 1. Byte-for-byte default fidelity — PASS

`src/bus/comms-lint-config.ts:52-131` transcribes the old `bce2db5:src/cli/bus.ts:82-224` constants exactly:

- **banned (10):** all 10 sources + `i` flag match (`sleep posture`, `standing by`, `standby`, `parked`, `on-?deck`, `idle`, `asleep`, `sleeping`, `waiting[- ]on[- ]\w+`, `holding`).
- **passive (2):** `\b(standing by|standby|parked|idle|asleep|sleeping|holding)\b/i` + `\bwaiting\b/i`.
- **telegram (5):** pr-number, pull-request-number, commit-sha (the tightened lookahead `\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*[a-f][0-9a-f]*\b/i`), brand-cortextos, em-dash.
- **em-dash flag:** `/[–—―]/` carries NO `i` flag (`comms-lint-config.ts:117`); every other rule has `i`. Verified, and explicitly asserted in `comms-lint-config.test.ts:82-84`.
- **agentName (1):** `\b(codie|collie|dane|aussie|blue|codex)\b/i`.
- **activeContext / nextSignalContext:** sources + flags identical (`comms-lint-config.ts:80-83`).

`getDefaultCommsLintRules()` returns fresh shallow copies and freshly-constructed context RegExps; no `g`/`y` flag anywhere, so shared literal `lastIndex` statefulness is a non-issue. Counts/order verified against `comms-lint-config.test.ts:58-89` (counts 10/2/5/1, ids in order, source+flags per rule).

**No drift.**

## 2. Merge / precedence correctness — PASS

`mergeGroup` (`comms-lint-config.ts:190-219`) implements §4.1 order exactly: base = `replace` (if present) else defaults → append `add` → remove by `allow`. `allow` running last correctly lets it strip an added/replaced rule, and against a `replace` base it is a no-op against defaults (intended clean-slate). `applyLayer` (`251-268`) applies org then agent (`resolveCommsLintRules:300-317`), so agent overrides org overrides defaults — strict last-writer-wins by layer. Verified in tests: agent-allow re-permits an org-added ban (`comms-lint-config.test.ts:165`), agent-add re-bans an org-allowlisted phrase (`:180`).

agentName single-rule mapping (`applyLayer:257-266`): defaults wrapped as `[rule]`, `mergeGroup` returns 0/1, `[]→null` / `[rule]→rule`, multi-rule replace takes `[0]`. Matches §4 and tested (`:266` null case, `:272` first-wins). Allow-by-id removes the right rule via exact-id `Set` membership (`mergeGroup:213-215`) — tested at `:138`.

`extendContext` (`226-243`) OR-s validated extras with `'i'`, falls back to unchanged regex on bad source — matches §4.4 (extend-only, no replace). Tested good/bad at `:243`/`:257`.

## 3. Contract compatibility — PASS

- `OutboundLintResult` gained only an **optional** `suggest?: string` (`bus.ts:78`). Additive.
- New types in `src/types/index.ts` (`CommsLintRuleSpec`, `CommsLintGroupConfig`, `CommsLintConfig`) and the `comms_lint?` fields on `AgentConfig`/`OrgContext` are all optional/additive. No existing field changed.
- The folded em-dash separator in telegram-group reasons is preserved exactly: `reason: rule.suggest ? `${rule.reason} — ${rule.suggest}` : rule.reason` (`bus.ts`, telegram path) — same em-dash glyph as bce2db5. This is internal CLI stderr, not a David-facing send, so it is correct that the lint output itself contains an em-dash.
- All 18 regression tests in `tests/unit/cli/outbound-comms-lint.test.ts` pass unchanged.

## 4. `--suggest` semantics — PASS

`enforceOutboundLintOrExit` / `enforceTelegramLintOrExit` now return `bool`; every call site uses `if (!enforce(...)) return;` (`bus.ts:387`, `:1389`, `:2136` — send-message, send-telegram, send-mobile-reply). Under `--suggest`, both functions call `printSuggestReport` (stdout) and `return false` **before** any send, so the action returns without side effect. No `process.exit`/`exitCode` is set on that path → exit 0. Tested for both would-block and would-pass (`comms-lint-configurable.test.ts:214,230,245,258`), including assertions that the send spies were NOT called and the outbound log file was NOT written. `--skip-lint` still early-returns `true` → unchanged send. Default no-flag path still blocks via `process.exit(1)` → exit 1 (regression tests `rejects.toThrow()`).

## 5. Test adequacy & honesty — STRONG, one minor gap

Tests are end-to-end through `busCommand.parseAsync` with side-effecting modules mocked as spies; "would send" is observable, "did not send" is provable. Not vacuous. Coverage spans org-allow, agent-allow, multi-group allow, org-add-blocks, --suggest (block/clean/no-send on all three commands), malformed-config fail-open, invalid-regex drop. The loader unit test additionally covers replace, both-layers precedence (both directions), context extension (good+bad), agentName→null, agentName replace-first-wins, all four spec-validation drops, and never-throws.

**Gap (non-blocking):** The CLI-level integration test (`comms-lint-configurable.test.ts`) never exercises **org AND agent config simultaneously**, nor `replace`, nor a combined replace+add+allow, nor `add_active_context` at the CLI seam. These ARE covered at the loader unit level (`comms-lint-config.test.ts:165,180,148,243`), so the behavior is proven — only the end-to-end wiring of those specific combinations through `parseAsync` is untested. Low risk because `resolveLintRules()` is a thin pass-through to the loader.

---

## Findings

### F1 (minor, non-blocking) — banned/passive group reason is hardcoded, ignoring the rule's `reason`
**File:** `src/cli/bus.ts:98` and `:116`
`lintOutboundMessage` always returns `reason: 'banned jargon'` (banned) and the fixed passive string, regardless of a custom rule's own `reason`. This is *correct for backward-compat* (preserves the exact legacy strings) but means an org-added custom banned rule's `reason` (a required field per `CommsLintRuleSpec`) never reaches the operator's stderr. The telegram group, by contrast, surfaces `rule.reason`. Inconsistent contract: `reason` is documented as "why the phrase is blocked" but is dead data for banned/passive.
**Why it matters:** an operator who adds `{id:'banned:codename', reason:'internal codename leak'}` will see "banned jargon" instead of their reason, which is confusing.
**Required fix to reach 5:** none required (backward-compat is the higher priority and the master plan does not promise per-rule reason surfacing for banned/passive). Optional improvement: surface `rule.reason` when it differs from the legacy default, or document this limitation in the spec.

### F2 (minor, non-blocking) — passive group does not propagate `suggest`
**File:** `src/cli/bus.ts:113-117`
The passive-group return omits `suggest: rule.suggest`, so `--suggest` cannot surface a hint for a custom passive rule. No default passive rule has a `suggest`, so there is no regression; it only limits future custom passive rules.
**Required fix to reach 5:** none. Optional: add `suggest: <first-matching-passive-rule>.suggest`.

### F3 (info) — CLI-seam coverage gap for combined-layer / replace / context-extension
Covered above in §5. Loader-level tests prove the behavior; only the CLI pass-through of these specific cases is untested. **Not required for approval.**

---

## Score

**5 / 5 — would approve after the listed validation (already run: typecheck clean, build success, 47/47 targeted tests pass).**

No changes are required to reach 5. The implementation is byte-for-byte backward-compatible, the merge/precedence logic matches the master plan, contracts are additive-only, `--suggest` is dry-run-safe with exit 0, and the regression suite is intact. F1/F2 are optional polish (reason/suggest surfacing for custom banned/passive rules); F3 is an optional belt-and-suspenders CLI-seam test for a path already proven at the loader level. None affect correctness or compatibility.
