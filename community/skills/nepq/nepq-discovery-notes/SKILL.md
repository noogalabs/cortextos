---
name: nepq-discovery-notes
description: How to capture discovery during/after a conversation and hand off a qualified opportunity to the closer with full context. Use after any discovery conversation and before any handoff.
---

# NEPQ Discovery Notes — Capture the Gap, Hand Off Clean

A qualified opportunity is only as good as the context that travels with it. The closer should be able to pick up exactly where you left off, in the prospect's own words.

## Capture as you go — the discovery record

For every meaningful conversation, log:

- **Prospect / company** — name, role, contact, ICP-fit notes
- **Situation** — where they are now (their words)
- **The gap** — the problem they articulated (their words, not your interpretation)
- **The consequence** — what staying stuck costs them, as *they* described it (this is the emotional core; capture it verbatim if you can)
- **What they want** — the desired state they named
- **Objections raised** — and how they resolved (or didn't)
- **Qualification gates** — Fit / Problem / Authority / Timeline / Budget signal (✓ / ✗ / unknown for each)
- **Stage** — where the conversation ended on the flow
- **Next step** — booked meeting / follow-up due / disqualified / nurture, with the date

> Capture the prospect's *exact phrasing* for the gap and the consequence. "It's eating up my whole weekend" lands harder in the handoff than "time management issue."

## The handoff to the closer

When you hand off a qualified opportunity, the closer gets a tight brief:

```
PROSPECT: {name}, {role} at {company}
FIT: {why they match the ICP}
SITUATION: {current state, their words}
THE GAP: {the problem they named}
CONSEQUENCE: {what it's costing them — their words}
WHAT THEY WANT: {desired state}
QUALIFICATION: Fit ✓ / Problem ✓ / Authority {who decides} / Timeline {when} / Budget {signal}
OBJECTIONS SO FAR: {raised + status}
BOOKED: {meeting type, date/time, calendar link}
SAY THIS FIRST: {the one thing the closer should open on, tied to the consequence they felt}
```

## Quality bar for a handoff

A handoff is ready only if:
- The prospect clears **Fit** and **Problem** (non-negotiable — never hand off or book a non-fit)
- The consequence is captured in the prospect's words
- The next step is concrete and on the calendar
- The closer could open the call without re-discovering anything

If any of those is missing, it's not a qualified opportunity yet — keep it in discovery or move it to nurture. Protect the closer's time; an inflated pipeline trains the team to distrust your handoffs.

## Logging

Every conversation outcome → a pipeline record (see SOUL.md Documentation Rule). No prospect advanced or disqualified without a logged reason. Log a `task_completed` / `decision_made` event on significant advances so the activity feed reflects pipeline movement.
