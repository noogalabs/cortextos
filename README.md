<div align="center">

# AscendOps

**Persistent 24/7 Claude Code agents you control from Telegram.**

[Quick Start](#quick-start) · [Architecture](#architecture) · [Templates](#templates) · [Roadmap](#roadmap)

[![tests](https://img.shields.io/badge/tests-917%20passing-success)](.) [![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE) [![Node](https://img.shields.io/badge/node-20%2B-43853d)](https://nodejs.org) [![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)

</div>

---

## What it is

AscendOps runs Claude Code as a fleet of persistent agents — 24/7, multi-agent, controlled from Telegram. Each agent has its own role (orchestrator, analyst, specialist), shared state via a file bus, and survives crashes + 71-hour Claude session boundaries automatically.

Think: *Claude Code, but as your team — not a tool you open.*

```
Telegram chat

You:    Morning. What did you ship overnight?
Boss:   Overnight recap: completed 4 tasks, ran 2 theta-wave
        experiments, drafted 3 content scripts. One item needs
        your approval — email the beta waitlist.

You:    approve
Boss:   Sent. Email delivered to 47 recipients. Task closed.
```

---

## Why AscendOps

You already use Claude Code as a developer. AscendOps is what happens when you turn it into infrastructure: agents that run while you sleep, coordinate with each other, and surface decisions to you on your schedule, not theirs.

Built for:
- **Operators** running real businesses who need agents, not chatbots.
- **Builders** experimenting with multi-agent patterns at scale.
- **Property managers** specifically — AscendOps ships with PropertyMeld + AppFolio adapters out of the box.

Not built for:
- Single-prompt automations — use the Claude API directly.
- Cloud-only deployments — today AscendOps runs on your local Mac or Linux box, not in your cloud account. Cloud path is on the roadmap.

---

## Features

- 🤖 **Persistent agents** — Claude Code runs 24/7 in PTY sessions, auto-restarting on crash or after 71-hour context rotation.
- 🔀 **Multi-agent orchestration** — orchestrator, analyst, and specialist agents coordinate via a shared file bus. Tasks, blockers, and approvals flow automatically.
- 📱 **Telegram + iOS control** — send commands, approve actions, get reports from anywhere.
- 🌐 **Multi-vendor** — Claude / Codex / Gemini, switchable per agent via the vendor adapter.
- 🪝 **Hook framework** — fire-block-escalate event pipeline for custom routing and telemetry.
- 🌙 **Autoresearch (theta wave)** — agents run autonomous experiments overnight and surface findings for your morning review.
- 📊 **Web dashboard** — Next.js UI for tasks, approvals, experiments, and fleet health.

---

## Architecture

```mermaid
flowchart TD
    U[User · Telegram or iOS] --> D[AscendOps Daemon · Node.js]
    D --> O[Orchestrator]
    D --> A[Analyst]
    D --> W[Specialist agents]
    O <-->|file bus| A
    O <-->|file bus| W
    D --> Web[Web Dashboard · Next.js]
    Web --> U2[Browser]
```

Every agent is its own PTY-spawned Claude / Codex / Gemini process. The daemon handles spawn, restart, and heartbeat health. Inter-agent communication runs over a file-based bus — no network, no broker. Hooks fire on bus events for custom routing and observability.

---

## Quick Start

**Prereqs:** Node.js 20+, Claude Code CLI authenticated, Telegram bot token from @BotFather.

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/noogalabs/ascendops/main/install.mjs | node

# Open in Claude Code + run guided onboarding
claude ~/cortextos
> /onboarding
```

`/onboarding` handles dependency checks, org setup, bot creation, PM2 config, and dashboard launch. Your Orchestrator comes online in Telegram and finishes its own setup there.

More setup details in [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Templates

| Template | Best for |
|---|---|
| `orchestrator` | Your "boss" agent. Coordinates the fleet, runs morning + evening reviews, gates approvals. |
| `analyst` | System health, metrics, theta-wave autoresearch. |
| `agent` | General-purpose worker. Base for specialist agents. |
| `property-management/agent` | Pre-configured for PropertyMeld + maintenance ops. |

---

## CLI

```bash
cortextos install            # set up state directories
cortextos init <org>         # create an organization
cortextos add-agent <name>   # add an agent
cortextos status             # fleet health
cortextos doctor             # check prerequisites
cortextos dashboard          # start web dashboard
```

Run `cortextos --help` for the full CLI surface.

---

## Security

Every external action (email, deploy, delete, financial) requires explicit human approval. The guardrails system is self-improving: agents log near-misses and extend `GUARDRAILS.md` each session. Report vulnerabilities by opening a private security advisory on this repo.

---

## Roadmap

- ✅ Multi-vendor adapter MVP — Claude / Codex / Gemini per-agent
- ✅ Hooks framework Day-1 + Day-2 + Day-3 scaffolding
- ✅ Codex 2-seat rotation (path-shadow wrapper, rate-limit-aware seat-flip)
- ⬜ Rust SaaS response filter (token-efficiency layer for vendor APIs)
- ⬜ Cloud deployment path (Mac mini → AWS or similar)
- ⬜ Slack + human team-member roster

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup + code style. Framework-level patches go upstream to [grandamenium/cortextos](https://github.com/grandamenium/cortextos); AscendOps-specific patterns stay in this fork.

---

## License

MIT — see [LICENSE](./LICENSE).

---

<div align="center">

Built on [cortextos](https://github.com/grandamenium/cortextos) by James (grandamenium). AscendOps adds property management integrations, agent templates, and operational tooling.

</div>
