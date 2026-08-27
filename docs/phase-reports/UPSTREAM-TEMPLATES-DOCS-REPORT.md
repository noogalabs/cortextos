# Upstream Templates / Docs Family Report

## FAMILY

`templates/docs/dashboard/community`

Base: `d7ca29d6`. Canonical census: 47 upstream commits. This branch preserves
the fork's current policy/runtime envelope and upstream's final state; it does
not replay content that was later reverted or import policy/domain payloads
without a ruling.

## Proposed review tier

**HEAVY.** Alongside two dashboard correctness fixes and a mechanical shell-date
quoting correction, this branch now carries the previously approved
Claude-to-Codex migration skill and its catalog entry. The migration package is
substantial executable tooling with its own leakage guard and bake suite, so the
larger review tier is appropriate even though no daemon or permission behavior
is enabled. Deferred items remain absent.

## Canonical 47-set disposition

### Already patch-equivalent on `fork/main` (33)

`81786580`, `ba52e0c5`, `b4f9eabb`, `0e3359fe`, `0ea6b8f6`,
`495a8740`, `9cf92a84`, `875a8674`, `004b8eeb`, `6cb72443`,
`376195ab`, `c34c11d9`, `93e1f5b3`, `8ec8ccaf`, `890d69e8`,
`ace70454`, `fcf11453`, `0f45fdda`, `abca0a42`, `d86d50f4`,
`bede753b`, `ab32c688`, `70d11dab`, `a47b1e4d`, `dc9e296e`,
`b81f247a`, `6f4bc20b`, `8e45560d`, `5df9d317`, `d5c4acdf`,
`67a6a632`, `d7cf5d0b`, `7751ae4a`.

The two merge SHAs (`abca0a42`, `b81f247a`) have no independent behavior to
replay; their payload parents are already represented.

### Missing and ported (5)

| SHA | Ported behavior |
|---|---|
| `467e9777` | Agent status grid indexes heartbeat state and detail links by stable `systemName`, while preserving display names. |
| `ad4e0d39` | Dashboard Max-plan widget reads the already-produced Claude/Codex usage cache as a fallback. No watchdog or cache producer is activated. |
| `138a507c` | Existing template `date -u` format strings are quoted so shell expansion records timestamps correctly. Deleted research-agent/OpenCode trees remain deleted. |
| `12bd3274` | Adds the previously approved Claude-to-Codex migration skill, scripts, references, leakage-fixture hygiene, and bake tests. Fork-only deleted research-agent content was not resurrected during conflict resolution. |
| `dcdbfa3e` | Adds the approved migration skill to the community catalog without importing the separately held voice-provider entry. |

### Deliberately excluded by existing ruling/final-state requirement (2)

| SHA | Disposition |
|---|---|
| `9f019812` | Excluded under the explicit dual-runtime ruling: the fork supports Claude and `codex-app-server`, not OpenCode; templates must not teach an unsupported runtime. |
| `143f9151` | Skipped because later upstream commit `69ae2473` reverts the workflows-engineering skill. Replaying the add would violate the instructed final upstream state. |

### Ruled deferrals/exclusions: not ported (7 commits / 7 decisions)

| SHA(s) | Named gap |
|---|---|
| `e68def79` | Daylight member-security question: changes all template defaults to `bypassPermissions`. |
| `53accd45` | Deferred to daemon reconciliation: mixes quota UI with automatic watchdog/resume/shadow-command activation policy. |
| `97b8574c` | Excluded by the 2026-04-18 no-Obsidian governance lock. |
| `40bdacdc` | Deferred to the daylight content/provider group: domain/workflow skills for idea grooming, business-news monitoring, and multi-perspective review. |
| `4a0ca24a` | Deferred to the daylight content/provider group: research-agent workflow, scoring, and judgment content. |
| `46bd9105` | Deferred to the daylight content/provider group: voice-agent-factory skill with external/provider practice. |
| `20543a7f` | Deferred to the daylight content/provider group: CRM external-tool connection and verification behavior. |

These are ruled exclusions or named daylight/reconciliation work, not hidden
implementation backlog. The migration pair was adopted under the prior catalog
approval recorded by Aussie; all other held content stays byte-absent.

## Conflict handling

`138a507c` attempted to modify the deleted research-agent and OpenCode template
trees. Those modify/delete conflicts were resolved in favor of the fork's
deletions. The mechanical quoting correction was retained only in shipped trees.

`12bd3274` also encountered `.gitignore` history from those deleted trees. The
fork kept its deletion policy and imported only the migration skill's
leakage-fixture exclusions. `dcdbfa3e` was resolved by adding only the approved
migration catalog row; the independently deferred voice-provider row remains
absent.

The imported migration package also carried a Python-incompatible regular
expression with repeated global inline flags after alternation. The fork moved
those flags to `re.compile(..., re.IGNORECASE | re.MULTILINE)` without changing
the expression's matching contract; this is the sole code adaptation inside the
approved package and is required for the bake suite to import at all.
The bake suite now pins that adaptation at its behavioral seam: sentence-case
(`You are the Orchestrator`) and lowercase orchestrator declarations both pass
through `_agent_declares_orchestrator`, while non-orchestrator prose remains
excluded. Dropping `re.IGNORECASE` kills exactly the sentence-case casualty.

## Validation

Commands executed successfully:

```text
npm test -- --run tests/sprint1-templates.test.ts tests/unit/daemon/fast-checker.test.ts
npm --prefix dashboard test -- --run src/components/overview src/components/analytics src/lib/data/reports.test.ts
npm run build
npm --prefix dashboard run build
python3 community/skills/claude-to-codex-migration/tests/test_migration_bakes.py
npm test -- --run tests/sprint4-catalog.test.ts tests/unit/bus/catalog.test.ts
```

Results:

- root template/FastChecker slice: 2 files, 79 tests passed;
- dashboard slice: 8 files, 114 tests passed;
- migration skill bake suite: 96 probes passed, 0 failed;
- catalog/install slice: 2 files, 34 tests passed;
- root production build passed;
- dashboard production build and TypeScript phase passed.

The dashboard build reports pre-existing Next/Turbopack warnings about dynamic
module tracing, deprecated middleware naming, workspace-root inference, and
viewport metadata. It nevertheless completes successfully; none is introduced
by this five-commit delta.

## Gap Rule

**PASS.** Every permission, activation, external-integration, and domain-content
gap was stopped and named before editing. The only practice package added was
the migration skill covered by the prior catalog approval; it was ported rather
than invented. All other content/provider questions remain deferred by ruling.

## Custody

This repository has no `MANIFEST.sha256` or tracked manifest generator/checker.
Custody is the base/head/tree/full-index-patch tuple plus exact-head CI evidence.
