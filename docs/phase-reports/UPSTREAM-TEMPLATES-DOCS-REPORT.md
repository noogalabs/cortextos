# Upstream Templates / Docs Family Report

## FAMILY

`templates/docs/dashboard/community`

Base: `d7ca29d6`. Canonical census: 47 upstream commits. This branch preserves
the fork's current policy/runtime envelope and upstream's final state; it does
not replay content that was later reverted or import policy/domain payloads
without a ruling.

## Proposed review tier

**LIGHT.** The landed delta is limited to two dashboard correctness fixes and a
mechanical shell-date quoting correction across existing templates. No daemon,
security, permission, external-integration, or domain-practice behavior is
enabled by this branch. Deferred items remain absent.

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

### Missing and ported (3)

| SHA | Ported behavior |
|---|---|
| `467e9777` | Agent status grid indexes heartbeat state and detail links by stable `systemName`, while preserving display names. |
| `ad4e0d39` | Dashboard Max-plan widget reads the already-produced Claude/Codex usage cache as a fallback. No watchdog or cache producer is activated. |
| `138a507c` | Existing template `date -u` format strings are quoted so shell expansion records timestamps correctly. Deleted research-agent/OpenCode trees remain deleted. |

### Deliberately excluded by existing ruling/final-state requirement (2)

| SHA | Disposition |
|---|---|
| `9f019812` | Excluded under the explicit dual-runtime ruling: the fork supports Claude and `codex-app-server`, not OpenCode; templates must not teach an unsupported runtime. |
| `143f9151` | Skipped because later upstream commit `69ae2473` reverts the workflows-engineering skill. Replaying the add would violate the instructed final upstream state. |

### Gap Rule hold: not ported pending explicit ruling (9 commits / 8 decisions)

| SHA(s) | Named gap |
|---|---|
| `e68def79` | Permission policy: changes all template defaults to `bypassPermissions`. |
| `53accd45` | Mixes quota UI with automatic watchdog/resume/shadow-command activation policy. |
| `97b8574c` | Introduces an Obsidian wiki integration and filesystem/API surface. |
| `40bdacdc` | Adds domain/workflow skills for idea grooming, business-news monitoring, and multi-perspective review. |
| `4a0ca24a` | Adds a research-agent template with workflow, scoring, and judgment content. |
| `46bd9105` | Adds a voice-agent-factory skill with external/provider practice. |
| `20543a7f` | Changes the CRM template from detecting tools to connecting and verifying external tools. |
| `12bd3274`, `dcdbfa3e` | Adds and catalogs a Claude-to-Codex migration practice package. |

These are source gaps, not implementation backlog hidden inside this branch.
They remain byte-absent until the orchestrator returns a policy/content ruling.

## Conflict handling

`138a507c` attempted to modify the deleted research-agent and OpenCode template
trees. Those modify/delete conflicts were resolved in favor of the fork's
deletions. The mechanical quoting correction was retained only in shipped trees.

## Validation

Commands executed successfully:

```text
npm test -- --run tests/sprint1-templates.test.ts tests/unit/daemon/fast-checker.test.ts
npm --prefix dashboard test -- --run src/components/overview src/components/analytics src/lib/data/reports.test.ts
npm run build
npm --prefix dashboard run build
```

Results:

- root template/FastChecker slice: 2 files, 79 tests passed;
- dashboard slice: 8 files, 114 tests passed;
- root production build passed;
- dashboard production build and TypeScript phase passed.

The dashboard build reports pre-existing Next/Turbopack warnings about dynamic
module tracing, deprecated middleware naming, workspace-root inference, and
viewport metadata. It nevertheless completes successfully; none is introduced
by this three-commit delta.

## Gap Rule

**PASS.** Every permission, activation, external-integration, and domain-content
gap was stopped and named before editing. Only artifact-determined mechanical
corrections were ported. No practice content, thresholds, scripts, or policy was
invented.

## Custody

This repository has no `MANIFEST.sha256` or tracked manifest generator/checker.
Custody is the base/head/tree/full-index-patch tuple plus exact-head CI evidence.
