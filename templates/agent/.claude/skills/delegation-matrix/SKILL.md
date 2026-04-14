---
name: delegation-matrix
effort: low
description: "Orchestrator/agent/Codex delegation matrix. Reference this when scoping a task to determine who owns what. Dividing line: execution-heavy work goes to Codex, judgment-heavy work stays with the agent."
triggers: ["who owns", "delegation", "codex or agent", "should codex", "task scoping", "who does this", "delegation matrix"]
---

# Delegation Matrix

> Reference when scoping any task. Three roles, clear owner per work type.
> Dividing line: **execution-heavy → Codex. Judgment-heavy → Agent.**

---

## Matrix

| Work type | Orchestrator | Agent | Codex |
|-----------|-------------|-------|-------|
| Requirement intake from user | **owns** | — | — |
| Task decomposition + dispatch | **owns** | consults | — |
| Briefings and status to user | **owns** | input | — |
| Architecture decisions | — | **owns** | — |
| Spec writing + acceptance criteria | — | **owns** | — |
| Security and domain modeling | — | **owns** | — |
| Ambiguous / judgment calls | routes | **owns** | — |
| Review of Codex output | — | **owns** | — |
| PR decisions (file, scope, merge) | — | **owns** | — |
| First-pass implementation (clear spec) | — | delegates | **owns** |
| Mechanical refactors and migrations | — | delegates | **owns** |
| Repetitive multi-file edits | — | delegates | **owns** |
| Test drafting and fixture setup | — | delegates | **owns** |
| Applying decided fixes across files | — | delegates | **owns** |

---

## Default Coding Workflow

For any task touching **>~20 lines or multiple files**:

1. **Orchestrator** receives task from user, dispatches to Agent with context
2. **Agent** designs the approach, writes a tight spec (what to build, file paths, expected behavior, edge cases)
3. **Agent** calls Codex with the full spec — Codex implements
4. **Agent** reviews Codex output for correctness and architectural fit
5. **Agent** opens the PR

For **one-liners and config changes**: Agent writes directly, no Codex needed.

---

## When to Override

**Keep with Agent (don't send to Codex) when:**
- The correct behavior is unclear and requires judgment
- Security, auth, or trust-boundary code
- The design is still open — spec isn't settled yet
- Output will be shown directly to users or external systems

**Always send to Codex when:**
- The spec is unambiguous and complete
- The task is mechanical repetition across many files
- Test coverage for already-designed behavior
- Token cost of Agent implementation would be high

---

*Deployment note: replace "Orchestrator" / "Agent" with your actual agent names.*
