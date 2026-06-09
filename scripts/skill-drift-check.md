# Skill Drift Check

`skill-drift-check.mjs` compares declared shared skill directories against their
canonical template copy. It hashes the whole skill tree by relative file path,
including `SKILL.md` and helper scripts.

## Run Modes

```bash
node scripts/skill-drift-check.mjs --tier ci
node scripts/skill-drift-check.mjs --tier local
```

- `--tier ci` checks only git-tracked template mirrors. Gitignored deployed
  runtime copies are reported as skipped so fresh CI checkouts do not fail
  because `orgs/*/agents/*` is absent.
- `--tier local` checks every declared mirror, including deployed runtime copies.
  This is the primary safety check after editing a deployed skill because it
  catches template/runtime drift that CI cannot see. Run it from the canonical
  framework root after that root is updated to latest `origin/main`; a stale root
  can falsely report drift against deployed copies that were already updated.

## Local Hook

Install local hooks once per clone:

```bash
bash scripts/setup-hooks.sh
```

The installed `pre-commit` hook runs the CI tier:

```bash
node scripts/skill-drift-check.mjs --tier ci
```

This is intentional: agents usually commit framework changes from isolated
worktrees where gitignored deployed agent copies are absent. Commit-time checks
must stay worktree-safe and cover only tracked template mirrors.

## Periodic Deployed-Parity Runner

The deployed-copy check is a standalone local runner for the canonical framework
root:

```bash
bash scripts/skill-drift-local-runner.sh
```

The runner fails loud unless the framework root is at latest `origin/main`, then
runs:

```bash
node scripts/skill-drift-check.mjs --tier local
```

Wire this script into a heartbeat or daemon cron only after activation is gated.
It is the check that catches gitignored deployed skill drift; CI and pre-commit
cannot see those runtime copies from fresh checkouts or isolated worktrees.

Runner exit codes are stable for automation:

| Code | Meaning |
|---|---|
| 0 | Clean: every declared local mirror matches canonical. |
| 1 | Real drift found by `skill-drift-check.mjs`. |
| 2 | Operational/checker error: not in a git repo, checker files missing, bad manifest, or checker failure. |
| 3 | Stale root: after fetching `origin/main`, `HEAD` is not `origin/main`. |

If a deployed skill is intentionally agent-customized, do not force it into a
shared mirror group. Either remove it from the manifest or split the group so
only truly shared copies are compared. For example,
`framework-upstream-auto-update` is template-variant parity only because deployed
copies are personalized from `[AGENT_NAME]` / `[ORCHESTRATOR]` placeholders.

## Fix Mode

Fix mode is dry-run by default:

```bash
node scripts/skill-drift-check.mjs --tier local --fix
```

It prints the files that would be copied from canonical and writes nothing. To
apply declared mirror updates:

```bash
node scripts/skill-drift-check.mjs --tier local --fix --write
```

`--write` is scoped strictly to declared mirror members. Extra files in a mirror
are treated as a conflict (`declared-shared but locally modified`) and are not
removed automatically.
