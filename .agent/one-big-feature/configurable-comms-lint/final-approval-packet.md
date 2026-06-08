# Final Approval Packet: Configurable Comms-Lint

**Branch:** `feature/configurable-comms-lint` (worktree `/Users/davidhunter/cortextos-obf-comms-lint`, off `main` @ bce2db5)
**Orchestrator:** dane | **Run:** one-big-feature framework, overnight 2026-06-08
**Status:** COMPLETE — awaiting human approval to merge (HOLD; do not auto-merge)

## What it does
Moves the comms-lint banned-phrase rules out of hardcoded TypeScript and into per-org / per-agent JSON config, with the current rules as fallback defaults so behavior is unchanged when no config exists. Adds a `--suggest` dry-run mode that reports the offending phrase + a rewrite hint and exits 0 without sending.

Operators can now, with no code change or redeploy:
- **add** org/agent-specific banned phrases (e.g. a customer's internal jargon),
- **allow** (remove) a default rule by id (an allowlist),
- **replace** a whole rule group (opt-in),
with precedence **agent config > org config > hardcoded defaults**.

## Changed files (code) — 5 files, +1204 / −97
| File | Change |
|---|---|
| `src/bus/comms-lint-config.ts` | NEW. Fail-open rule loader, defaults transcribed byte-for-byte from old bus.ts, safe regex compiler, layered merge. |
| `src/types/index.ts` | +3 config interfaces (`CommsLintRuleSpec`/`GroupConfig`/`Config`) + `comms_lint?` on `AgentConfig` and `OrgContext` (additive, optional). |
| `src/cli/bus.ts` | Removed 6 module-level rule consts; lint fns now consume resolved rules; `--suggest` added to send-message / send-telegram / send-mobile-reply. |
| `tests/unit/bus/comms-lint-config.test.ts` | NEW. 22 loader unit tests. |
| `tests/unit/cli/comms-lint-configurable.test.ts` | NEW. 12 CLI integration tests. |

Commits: `3a89dce` (shard 1 loader) → `7642412` (shard 2 bus + --suggest) → `cc2cf3f` (review F1 fix + ReDoS doc).

## Tests
- **52/52 comms-lint tests green** (22 loader + 18 unchanged regression + 12 integration).
- The 18 pre-existing regression tests pass **unedited** — proves byte-for-byte default fidelity.
- `npm run typecheck` clean, `npm run build` success.
- Full `npx vitest run` has ~12 failing suites that are PRE-EXISTING flaky cron-scheduler/`next/server`-import noise, confirmed unrelated (the one named failure passes in isolation on baseline `main`). None are comms-lint or bus-send.

## Live end-to-end smoke (real built binary, nothing sent — --suggest is dry-run)
1. `--suggest` on "holding…" (defaults) → `Would be BLOCKED. Offending phrase: "holding".` exit 0, no send. ✓
2. Real block path (no flag) on "holding…" → blocked, **exit 1**, no send. ✓
3. Org config `allow` both `banned:holding` + `passive:posture-set` → `Would pass comms-lint cleanly (not sent — dry-run).` ✓
4. Org config `add` custom phrase "synergy" → `Would be BLOCKED. Offending phrase: "synergy". Suggestion: say what it actually does` ✓ (operator-defined rule + custom hint, zero code change — the headline capability)

## Review scores
- **Correctness / contract / backward-compat: 5/5.** No regressions; default fidelity verified rule-by-rule incl. the em-dash no-`i`-flag edge.
- **Security / fail-open / maintainability: 3/5 → resolved.** Found one real HIGH bug (F1): an empty/all-invalid `replace` silently zeroed a David-facing safety group, contradicting the plan's own §4.3 contract. FIXED (`cc2cf3f`): empty/all-invalid replace now falls back to defaults, with 5 regression tests. F3 (operator ReDoS/trust JSDoc caveat) added. F2 doc wording corrected.

## Known sharp edges (honest)
- **A phrase can be governed by more than one group.** "holding" is in BOTH `banned` and `passive` defaults, so allowing it from one group alone does not fully permit it (smoke TEST 2 → still blocked by passive). A full allow needs both, or add active-work context. This is correct layered behavior, but operators must understand it. Documented in JSDoc; worth a short operator note in a follow-up README.
- **`--suggest` hint quality varies.** The `banned`/`passive` default groups don't carry per-rule `suggest` strings (only `telegram` rules do), so their suggestion falls back to the reason text ("banned jargon"). Custom-added rules and telegram rules give real rewrite hints. Enhancing default banned-group hints is a clean follow-up (correctness reviewer F2, non-blocking).
- **ReDoS:** operator-authored patterns are compiled with `new RegExp`; trust model (operator-authored, committed config) is the control, not the length cap. Documented.

## Human decision required
This feature gates David-facing comms. Per autonomy rules + the framework's approval gate, **merge to main needs David's approval.** Recommended: approve merge; optionally take the two follow-ups (operator README note + default banned-group suggest hints) as a fast second pass.

Nothing has been merged. The branch + worktree are intact for inspection.
