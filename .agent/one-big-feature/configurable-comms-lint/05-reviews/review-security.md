# Security / Privacy / Fail-Open Review — configurable-comms-lint

**Reviewer lens:** SECURITY/PRIVACY, FAIL-OPEN ROBUSTNESS, MAINTAINABILITY
**Branch:** `feature/configurable-comms-lint` (3a89dce + 7642412 on bce2db5)
**Validation run:** `npm run typecheck` clean, `npm run build` success, target tests 29/29 pass.

---

## Summary verdict

The fail-open architecture is genuinely solid on the dimensions that matter most: every
file read, JSON parse, merge, and regex compile is wrapped, and `resolveCommsLintRules`
has a belt-and-suspenders outer try/catch returning defaults. No path from a malformed
config file (missing, bad JSON, wrong-typed `comms_lint`, wrong-typed group, null/array,
null entries in `add`) can throw or crash a send. I verified this empirically with a
throwaway harness (deleted) — see Evidence below. Regex source is only ever used in
`.match`/`.test`; never eval'd, shelled, or path-built. The ReDoS surface is documented
and accepted in the master plan (config is operator-authored = trusted).

Two real findings keep this from a clean approve: (1) a **fail-open-TOO-far** case where a
`replace` block that is empty or all-invalid silently wipes an entire rule group to zero —
this also diverges from the master plan's own stated contract; (2) a documentation gap on
the trust model at the operator-facing surface. Both are fixable cheaply.

---

## Findings

### F1 — `replace: []` (or all-invalid `replace`) silently disables an entire rule group [HIGH]
**Where:** `src/bus/comms-lint-config.ts:197-204` (`mergeGroup`)
**Why it matters:** This is the one place fail-open fails the wrong direction. comms-lint
is a David-facing **safety gate**. When `replace` is present, `mergeGroup` builds `base`
purely from the compiled specs and never falls back to defaults if that set is empty. So:
- `{ banned: { replace: [] } }` → `banned.length === 0` (gate fully disabled for that group)
- `{ banned: { replace: [<every spec malformed>] } }` → `banned.length === 0`

A fat-fingered operator config (every rule has a bad id/flag/pattern, or someone leaves an
empty array as a placeholder) silently removes ALL banned-jargon protection for that group
with no error, no log, no signal. This is the exact destructive-default-on-already-populated
pattern: an empty/all-invalid replace-list should NOT be read as "operator wants zero rules"
when the safe reading is "operator's replacement failed, keep protecting."

**Spec divergence (compounds it):** master-plan §4.3 last bullet explicitly states:
> "if ALL of a layer's specs are invalid, the layer contributes nothing and we fall back to
> the prior layer's resolved set."

The implementation does the opposite for `replace` — it wipes to empty instead of falling
back. So this is also a contract violation, not just a judgment call.

**Evidence (throwaway test, deleted):**
```
{ banned: { replace: [] } }                              -> banned.length = 0
{ banned: { replace: [{id:'BAD ID!!',pattern:'x',...}] }} -> banned.length = 0
```
Contrast (these correctly keep 10 defaults):
```
comms_lint: ['nonsense']        -> 10   (array-typed comms_lint, group undefined)
{ banned: 'oops' }              -> 10   (string-typed group)
{ banned: { replace: null } }   -> 10
{ banned: { add: [null,5,ok] } }-> 11   (nulls dropped, valid kept)
```

**Required fix:** In `mergeGroup`, when `cfg.replace` is present but the compiled result is
empty (length 0), keep `defaults` instead of an empty base — and/or treat a non-empty
`replace` array where ALL specs drop as a fall-back-to-prior-layer (per the spec). Minimal:
```ts
if (Array.isArray(cfg.replace)) {
  const compiled = cfg.replace
    .map((spec) => compileRuleSpec(spec, group))
    .filter((r): r is CommsLintRule => r !== null);
  base = compiled.length > 0 ? compiled : defaults.map((r) => ({ ...r }));
} else { ... }
```
This keeps `add`/`allow` semantics intact (an operator who genuinely wants zero rules in a
group should `allow`-list them by id, which is the explicit, intentional path — and which
the agent-name group already documents). Add a unit test for both the empty-array and
all-invalid-replace cases asserting defaults are retained.

---

### F2 — ReDoS is real but accepted; the "length cap mitigates it" framing is inaccurate [LOW, doc fix]
**Where:** `src/bus/comms-lint-config.ts:155,168,174` and master-plan §4.3 injection note.
**Why it matters:** The plan says the 1000-char length cap is the ReDoS mitigation. It is
not — catastrophic backtracking is independent of pattern length. I confirmed a 6-char
operator pattern `(a+)+$` against a 41-char input hangs the process indefinitely (probe
killed at exit 144 after >4s with no return). Because the linter runs synchronously on the
**send path**, a clumsy config pattern can wedge every outbound send (send-message,
send-telegram, send-mobile-reply) until the process is killed.

**However** this is an explicitly documented, accepted risk: config is operator-authored and
sits at the same trust level as the TypeScript it replaces (master-plan L17, L114). That is a
reasonable trust model for org/agent config. So this is **not a blocker** — but the
mitigation claim should be corrected so a future maintainer doesn't believe the cap protects
them. The honest statement: "config is trusted; the length cap bounds memory/abuse, NOT
backtracking; a malicious/clumsy pattern can hang the send path and that is accepted because
config authors are trusted." If cheap defense is ever wanted, the real mitigation is a
backtracking-bounded matcher (RE2/`node:re2`) or a per-match timeout — both correctly noted
as out of scope.

**Flags validation is airtight:** `FLAGS_RE = /^[gimsuy]*$/` anchored both ends, deduplication
not required because `new RegExp` rejects duplicate flags inside the try/catch. No way to slip
a bad flag. Good.

---

### F3 — Trust model not documented at the operator-facing surface [LOW]
**Where:** type JSDoc in `src/types/index.ts:160-220`; no README/operator doc.
**Why it matters:** Finding 5 of the brief — "is treating config authors as trusted reasonable,
and is that documented." It is reasonable. It is documented in the **master plan** (an internal
build artifact) but NOT where an operator editing `context.json`/`config.json` would see it.
The type JSDoc documents schema and fail-open behavior thoroughly but says nothing about the
fact that a pattern is compiled and run as a live regex on every send (the ReDoS/trust caveat).
**Required fix (cheap):** add one sentence to the `CommsLintRuleSpec.pattern` JSDoc: e.g.
"Compiled with `new RegExp` and run against every outbound message; config authors are trusted
— a pathological pattern can hang sends. Keep patterns simple." This closes the trust-model
documentation gap at the surface operators actually touch.

---

### F4 — `--suggest` / error output: low leak risk, acceptable [INFO]
**Where:** `bus.ts` `printSuggestReport` (~L160s).
`printSuggestReport` prints only `result.phrase` (the single matched substring) plus the
`suggest`/`reason` hint — never the full message body, never the config. The default block
path (`process.exit(1)`) likewise prints only phrase+reason to stderr. No full-message or
full-config echo anywhere. Minor note: for the SHA/PR-number telegram rules the "offending
phrase" echoed to stdout could be a partial token/number; since stdout of the bus CLI may be
captured into logs, this is a theoretical low-grade leak, but it is the same substring the
operator is being told to remove, so it is acceptable. No change required.

---

## Maintainability notes (no blocker)

- **Defaults transcription drift (F-maint):** `DEFAULT_*` in comms-lint-config.ts are a
  hand-copy of the former bus.ts consts. The header comment claims "transcribed byte-for-byte"
  and the test file asserts source+flags equality, which is the right guard against drift. The
  old consts ARE fully removed from bus.ts (verified — no dead `BANNED_POSTURE_PATTERNS` etc.
  remain), so there is a single source of truth now. Good. The only residual drift risk is the
  em-dash rule's missing `i` flag, which is called out in a comment AND covered by the
  byte-for-byte test. Adequate.
- **Types are clear and well-documented** (`CommsLintRuleSpec` / `CommsLintGroupConfig` /
  `CommsLintConfig` JSDoc spells out replace→add→allow ordering and precedence). Good.
- **`extendContext` (L226-243):** validates each `extra` compiles alone before OR-combining,
  and keeps the original on failure — correct fail-open. Note the combined regex inherits the
  same ReDoS exposure as F2 (an `extra` that is safe alone could backtrack badly once OR'd onto
  a 200-char default source); same accepted-risk umbrella. No change.
- **agentName single-rule group (L257-266):** `[] -> null`, `[rule] -> rule`, ">1 takes first"
  is documented and the null case is correctly guarded at the bus.ts call site
  (`if (!explicitNaming && rules.agentName)`). Clean.

---

## What must change to reach a 5

1. **F1 (required):** Fix `mergeGroup` so an empty / all-invalid `replace` retains defaults
   (align with master-plan §4.3), + unit tests for both cases. This is the only finding that
   weakens the safety gate in production and it contradicts the documented contract.
2. **F2 + F3 (required, cheap):** Correct the "length cap mitigates ReDoS" wording and add the
   one-line trust/ReDoS caveat to the `pattern` JSDoc.

No source files were modified during this review; all probe tests were scratch and deleted.

## Score: 3 / 5

Strong fail-open core, correct injection containment, clean removal of old consts, good
types/tests. Held at 3 by F1 — a genuine fail-open-TOO-far bug (empty/all-invalid `replace`
silently zeroes a David-facing safety group, contradicting the plan's own contract) — plus the
inaccurate ReDoS-mitigation claim and the missing operator-surface trust doc. Fix F1 (with
tests) and correct F2/F3 wording and this is a 5.
