# Hermes Agent

A cortextos agent running on the [Hermes](https://github.com/NousResearch/hermes-agent) Python REPL runtime instead of Claude Code. The daemon manages Hermes as a PTY subprocess — same lifecycle, inbox polling, and heartbeat mechanics as any other agent on the bus.

## Prerequisite

**Hermes must be installed before this agent will start:**

```bash
pip install hermes-agent
```

Verify it is available:
```bash
which hermes
```

If `which hermes` returns nothing, the daemon cannot spawn this agent. Install first, then start.

---

## Setup

**Step 1 — Copy this template into your org**

```bash
cp -r ascendops-agent-pack/agents/hermes /path/to/cortextos/orgs/myorg/agents/myagent
```

**Step 2 — Configure**

Edit `config.json`:
- Set `agent_name` to your agent's name
- Set `timezone` to your local timezone
- Adjust `crons` if you want a different heartbeat interval

Edit `IDENTITY.md` with the agent's name, role, and personality.

**Step 3 — Set environment variables**

```bash
cp .env.example .env
```

Fill in `.env`:
- `BOT_TOKEN` — Telegram bot token from @BotFather (leave blank for agent-to-agent only)
- `CHAT_ID` — your Telegram user ID
- `ALLOWED_USER` — optional, restrict to one user

**Step 4 — Register and start**

```bash
cortextos start myagent
```

The daemon will spawn `hermes` as a PTY process. On first boot, Hermes reads `.cortextos-startup.md` and initializes its session.

---

## How it works

The `runtime: "hermes"` field in `config.json` tells the cortextos daemon to use `HermesPTY` instead of the standard Claude Code PTY. The daemon:

1. Spawns the local `hermes` binary via node-pty
2. Waits for the `❯` prompt (Hermes's idle REPL indicator)
3. Injects the startup prompt to load `.cortextos-startup.md`
4. Polls the inbox and injects incoming messages as text into the PTY
5. Monitors stdout for heartbeat updates and crash signals

Session state persists in `~/.hermes/state.db` (SQLite). On restart, the daemon passes `--continue` if the database exists, so the agent picks up where it left off.

---

## Differences from Claude Code agents

| | Claude Code | Hermes |
|---|---|---|
| Binary | `claude` | `hermes` |
| Idle prompt | `>` | `❯` |
| Session state | Context window | SQLite (`~/.hermes/state.db`) |
| Memory | Files + context | SQLite FTS5 + flat files |
| Cron verification | Daemon-checked | Skipped (Hermes owns its scheduler) |
| Install | `npm install -g @anthropic-ai/claude-code` | `pip install hermes-agent` |

Bus participation (heartbeat, inbox, tasks, events) is identical — Hermes runs `cortextos bus` shell commands from within its session exactly like Claude Code agents do.

---

## On Session Start

1. Read all bootstrap files: `IDENTITY.md`, `SOUL.md`, `GUARDRAILS.md`, `HEARTBEAT.md`, `MEMORY.md`, `TOOLS.md`
2. Restore crons from `config.json`
3. Check inbox: `cortextos bus check-inbox`
4. Update heartbeat: `cortextos bus update-heartbeat "online"`
5. Log session start: `cortextos bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'`
6. Send online status via Telegram (if `BOT_TOKEN` is configured)

---

## Crons

Defined in `config.json`. The 4h heartbeat cron is included by default. Add more as needed:

```json
{
  "name": "my-cron",
  "type": "recurring",
  "interval": "6h",
  "prompt": "Read .claude/skills/my-skill/SKILL.md and follow its instructions."
}
```

---

## Telegram Messages

If `BOT_TOKEN` is set, messages arrive via fast-checker:

```
=== TELEGRAM from <name> (chat_id:<id>) ===
<text>
Reply using: cortextos bus send-telegram <chat_id> "<reply>"
```

For agent-to-agent only deployments (no `BOT_TOKEN`), the inbox polling still works — messages from other agents arrive via the standard bus inbox.
