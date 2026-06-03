---
name: nepq-followup-cadence
description: The recurring follow-up sweep on open prospects, plus no-show / no-response recovery. Use on the daily followup-sweep cron and whenever a prospect goes quiet. Every follow-up adds value or asks a question — never a bare nudge.
---

# NEPQ Follow-Up Cadence — Win the Game Most People Quit

Most deals are won in follow-up, not first touch. Most reps stop after one or two tries. The pipeline edge is simply *continuing* — calmly, with value, on a cadence.

## The cadence (configured at onboarding as `{{followup_cadence}}`)

A sane default if none is configured:

| Touch | Timing | Channel | Angle |
|---|---|---|---|
| 1 | Day 0 | first-touch channel | the original question |
| 2 | Day 2 | different channel | a new angle on the same problem |
| 3 | Day 5 | call or voicemail | "checking if timing changed" |
| 4 | Day 10 | email | a relevant resource / proof point, no ask |
| 5 | Day 17 | call/DM | the honest "should I close your file?" |
| Nurture | every 30–45 days | rotating | value-only, until they re-engage or opt out |

## Rules for every follow-up

1. **No bare nudges.** "Just checking in" is banned. Every touch either adds value (a relevant insight, a resource) or asks a genuine question.
2. **Vary the channel and the angle.** Never send the same message twice. Reframe around the gap they named.
3. **Stay low-pressure.** Calm, detached. "No rush at all — just didn't want to let it drop if the timing's now better."
4. **The break-up touch works.** The honest close-your-file message often re-engages: "Haven't heard back, which usually means it's not a priority right now — totally fine. Want me to close it out, or check back in a few months?"

## No-show recovery

A no-show is almost never a hard no — it's a calendar failure. Recover calmly, never guilt-trip:
- "Looks like we got our wires crossed on the {time} — no problem at all. Want to grab a new slot? Here's two: {A} / {B}."
- If second no-show → one more low-pressure re-open, then move to nurture. Don't chase.

## No-response recovery

- After 2 unanswered touches, change the channel AND the angle.
- Use the consequence question as a re-open: "Last I heard, {problem} was costing you {X} — is that still the case, or did it get handled?"
- Honor the break-up touch before dropping to nurture.

## The daily sweep (followup-sweep cron)

1. Pull every open prospect (not advanced, not disqualified).
2. For each, determine the next due touch on its cadence position.
3. Draft the touch (value or question, varied channel/angle).
4. **Send only if auto-send is enabled** (see SOUL.md); otherwise route the batch for approval.
5. Recover any no-shows / no-responses from the prior day.
6. Log every touch + outcome to the pipeline.
7. Report pipeline movement to the owner (advances, disqualifies, re-engagements) — on cadence, not as noise.

## When to stop

Stop the cadence cleanly when a prospect disqualifies, asks to stop, or hits the end of the sequence without engaging. Move to nurture or close the file — and log the reason. Never keep hammering a real no; it costs trust and pipeline credibility.
