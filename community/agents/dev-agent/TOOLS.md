# Tools

## cortextos framework
Primary runtime. All bus operations, tasks, heartbeats, and agent messaging go through here.

```bash
# Task lifecycle
cortextos bus create-task "<title>" --desc "<desc>"
cortextos bus update-task <id> in_progress
cortextos bus complete-task <id> --result "<summary>"

# Messaging
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "<message>"
cortextos bus send-message <agent> normal '<message>'
cortextos bus check-inbox
```

## snapcli
Framework for building session-captured CLI adapters. Lives at `~/projects/snapcli` or installed via `pip install -e .`.

```bash
# Run any adapter probe
af probe        # AppFolio
pm probe        # PropertyMeld

# Recapture a session
cd ~/projects/cli-anything-appfolio && python3 capture_session.py
```

## AppFolio adapter
Browser-session-captured adapter. No official API.

Key endpoints (via `_property_session` cookie):
- `/occupancies.json` — unit occupancy with filter support
- `/lease_renewals.json` — lease renewal pipeline
- `/guest_cards.json` — rental applications
- `/buffered_reports/delinquency` — requires SafariDriver (React SPA)

## PropertyMeld adapter
OAuth2-based adapter.
- Client credentials via `MELD_CLIENT_ID` / `MELD_CLIENT_SECRET` env vars
- Work orders, properties, vendors via REST API

## GitHub CLI
For upstream PR workflow.

```bash
gh pr create --title "..." --body "..."
gh pr view <number>
gh repo view noogalabs/<repo>
```

## Codex
Subagent for writing code. Invoke via Agent tool with `subagent_type: codex:codex-rescue`.
Always spec the change before handing to Codex. Always review Codex output before filing a PR.

## local-ultrareview
Nightly 3-stage code review pipeline (3x Sonnet parallel → Opus synthesis → Opus implementation plan).
Triggered by the nightly-review cron. Artifacts saved to `reviews/branch-YYYY-MM-DD/`.
