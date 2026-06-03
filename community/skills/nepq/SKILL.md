---
name: nepq
description: The NEPQ (Neuro-Emotional Persuasion Questioning) sales method — the domain skill bundle for the Business Development persona. Use whenever doing prospect outreach, discovery, objection handling, or follow-up. Read the relevant sub-skill before any prospect-facing conversation.
---

# NEPQ — Neuro-Emotional Persuasion Questioning

NEPQ (developed by Jeremy Miner / 7th Level) is a question-based selling method. The core premise: **people are persuaded by what they conclude, not by what they are told.** Your job is to ask questions that lower resistance and let the prospect talk themselves toward the gap and the decision — never to pitch, pressure, or rebut.

This bundle is the domain layer of the Business Development agent profile. The persona, voice, and approval rules live in `SOUL.md` / `IDENTITY.md`. This bundle is the *how* — the question frameworks themselves.

## The three governing rules (from SOUL.md)

1. **Lower resistance, always.** Stay neutral, calm, curious, slightly detached. Pressure creates resistance.
2. **Ask, do not tell.** The prospect talks 70%+ of the time. If you are pitching, you are losing.
3. **Let them feel the gap.** Surface current situation → the gap → the consequence, *before* the offer.

## The stage flow (the spine of every conversation)

```
Connection  →  Engagement  →  Transition  →  Presentation  →  Commitment
                    │
                    ├── Situation questions      (where are they now?)
                    ├── Problem-Awareness         (what is not working?)
                    ├── Solution-Awareness         (what would better look like?)
                    └── Consequence questions      (what does staying stuck cost?)
```

Objections can surface at any stage and are **diffused, never rebutted**.

## Sub-skills (read the one that fits the moment)

| Sub-skill | When to use |
|---|---|
| `nepq-framework/` | Any discovery conversation — the full stage flow + question types with examples |
| `nepq-cold-outreach/` | First-touch outbound — cold call openers, email, DM (pattern interrupt → situation) |
| `nepq-objection-handling/` | A prospect raises any objection (price, timing, "think about it", "send info", partner, existing provider) |
| `nepq-followup-cadence/` | The recurring follow-up sweep on open prospects; no-show / no-response recovery |
| `nepq-question-bank/` | The verbatim NEPQ Black Book questions — the canonical phrasings to pull from |
| `nepq-discovery-notes/` | How to capture and hand off discovery (situation, gap, consequence, what they want) |

## How to use this bundle in a live conversation

1. **Identify the stage** the prospect is in (see `nepq-framework/`).
2. **Pull the question** that moves them forward from `nepq-question-bank/` (verbatim phrasings) or `nepq-framework/` (the type + examples).
3. **If an objection lands** → switch to `nepq-objection-handling/` (diffuse with a question, do not argue).
4. **Capture** the discovery to notes (`nepq-discovery-notes/`) as you go.
5. **Book or advance** while problem-awareness is high; hand off qualified opportunities with full context.

## Configuration

The offer, ideal customer profile (ICP), qualification gates, and follow-up cadence are set during onboarding and live in the persona's config / USER.md. This bundle is offer-agnostic — the *questions* adapt to whatever offer the agent is configured to sell.

> **Verbatim questions:** The canonical NEPQ Black Book phrasings drop into `nepq-question-bank/SKILL.md`. Until those are loaded, the sub-skills carry method-faithful example phrasings you can use directly.
