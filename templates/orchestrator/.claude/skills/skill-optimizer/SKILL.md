---
name: skill-optimizer
description: Audits how well an agent followed a skill by reading an agent JSONL transcript and evaluating it against the skill SKILL.md. Produces a structured improvement report with tracked diffs over time. Use after any skill-driven agent run to identify what worked, what failed, and exactly how to improve the skill for the next run.
triggers: ["audit this skill", "skill autoresearch", "evaluate skill execution", "review skill run", "skill improvement", "did the skill work", "analyze transcript", "skill audit", "improve this skill", "check skill execution", "skill-autoresearch"]
effort: medium
---

# skill-optimizer

Reads an agent's JSONL transcript and evaluates how well it followed a target SKILL.md. Writes a structured report with ratings, findings, and an exact diff to improve the skill.

Run this after any skill-driven agent run to close the loop: what did the agent actually do vs. what the skill expected?

---

## Dependency Check

Before using, verify:

```bash
# Python 3.11+
python3 --version

# jq (for JSONL processing)
which jq || brew install jq

# patch (for applying suggested diffs)
which patch
```

---

## Inputs

You need two things:

1. **Transcript path** — the agent's JSONL session file. Find the most recent one:
   ```bash
   ls -t ~/.claude/projects/*/  # list project directories
   ls -t ~/.claude/projects/<project-dir>/*.jsonl | head -1
   ```
   Each project directory is named after the working directory path (slashes replaced with dashes).

2. **Skill path** — the SKILL.md being evaluated:
   ```
   <agent>/.claude/skills/<skill-name>/SKILL.md
   ```

---

## Default Audit Target (when no input is specified)

When the skill is invoked without explicit inputs (e.g. via the recurring 9:33a cron on Aussie's calendar per RFC #8 D), the default target is **the most-fired skill of the last 24 hours for the running agent**. Discover via the activity log:

```bash
# Aggregate skill invocations from today's event JSONL
# Canonical path is org-scoped (paths.ts:46 resolves analyticsDir to <orgBase>/analytics
# where orgBase = ${CTX_ROOT}/orgs/${CTX_ORG}/).
# The legacy ${CTX_ROOT}/analytics/events/ tree is pre-org-scoped — do NOT use.
EVENTS_DIR="${CTX_ROOT:-$HOME/.cortextos/default}/orgs/${CTX_ORG:-ascendops}/analytics/events/${CTX_AGENT_NAME}"
TODAY="$(date -u +%Y-%m-%d)"
YEST="$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d 'yesterday' +%Y-%m-%d)"

# Count skill-invocation events, resolved to their SKILL dir.
# The activity log records EVENT names (heartbeat/SKILL.md logs 'agent_heartbeat'),
# but the audit target is the SKILL dir (.claude/skills/<skill>/SKILL.md), so the
# event must be mapped to its skill before counting/selecting — emitting raw event
# names here would make the default audit look for .claude/skills/agent_heartbeat/
# (which does not exist) and silently skip the most-fired skill.
cat "$EVENTS_DIR/$YEST.jsonl" "$EVENTS_DIR/$TODAY.jsonl" 2>/dev/null \
  | python3 -c "
import sys, json, collections
# Only events that UNIQUELY identify one skill are mapped. General action/task
# events (session_start, task_completed, briefing_sent, task_dispatched, ...) are
# NOT skill-fires (or are logged by multiple skills) and are ignored. Extend this
# map as new skill-invocation events are added.
EVENT_TO_SKILL = {
    'agent_heartbeat': 'heartbeat',
    'skill_activated': 'auto-skill',
    'skill_draft_created': 'auto-skill',
    'skill_rejected': 'auto-skill',
    'theta_wave_start': 'theta-wave',
    'theta_wave_complete': 'theta-wave',
    'worker_spawned': 'worker-agents',
    'worker_completed': 'worker-agents',
    'nighttime_mode_start': 'nighttime-mode',
    'morning_briefing_ready': 'nighttime-mode',
}
c = collections.Counter()
for line in sys.stdin:
    try:
        skill = EVENT_TO_SKILL.get(json.loads(line).get('event',''))
        if skill: c[skill] += 1   # unmapped events are ignored, not mis-targeted
    except: pass
for skill, n in c.most_common(5): print(f'{n:>4}  {skill}')
"
```

The counter prints **skill names** (already resolved from events via the map above). Pick the top skill, and verify its dir exists at `<agent>/.claude/skills/<skill>/SKILL.md` before auditing — if the resolved skill dir is missing (e.g. a mapped skill was renamed/removed), log a warning and skip rather than audit a wrong or nonexistent skill. If unambiguous (>2x runner-up), use the top skill as the target. If ambiguous, log a warning and skip the run — Dane can manually re-dispatch with explicit inputs.

**Override:** if `SKILL_OPTIMIZER_TARGET=<skill-name>` env var is set at invocation, use that instead of the activity-log inference.

**Today's expected default** (2026-04-29): heartbeat (fired ~5x in last 24h on Aussie — the `agent_heartbeat` events resolve to the `heartbeat` skill via the map) — see today's audit run as the validating example.

---

## Running the Audit

```
Run skill-optimizer on <transcript-path> against <skill-path>
```

---

## How It Works

### Step 1: Discover the JSONL format and parse the transcript

Claude Code JSONL files use this structure — do NOT assume flat message format:

```python
# Correct parsing pattern
for line in open(transcript_path):
    entry = json.loads(line)
    entry_type = entry.get('type')  # 'assistant', 'user', 'system', etc.

    if entry_type == 'assistant':
        # Tool calls are nested inside message.content
        msg = entry.get('message', {})
        content = msg.get('content', [])
        for block in content:
            if block.get('type') == 'tool_use':
                tool_name = block['name']
                tool_input = block['input']  # dict

    if entry_type == 'user':
        # Tool results are in user messages
        content = entry.get('message', {}).get('content', [])
        for block in content:
            if block.get('type') == 'tool_result':
                result_content = block.get('content', '')
```

Build a sequential log: list of (tool_name, tool_input, result) tuples in order.

### Step 2: Read the skill

Read the SKILL.md and extract:
- Trigger conditions
- Required steps (numbered or bulleted workflow)
- Tool calls and scripts referenced
- Expected outputs

### Step 3: Evaluate 5 dimensions (score 1–10 each)

**Dimension 1 — Trigger (was the right skill invoked for the right reason?)**
- Was the skill appropriate for the request?
- Did the trigger match one of the listed trigger conditions?
- Score 10: perfect match. Score 1: wrong skill invoked.

**Dimension 2 — Step coverage (did the agent follow all steps in correct order?)**
- Map each required step in SKILL.md to what the agent did
- Note: skipped steps, reordered steps, added steps not in skill
- Score 10: all steps followed in order. Score 1: majority of steps skipped.

**Dimension 3 — Reference accuracy (were tool calls and scripts used correctly?)**
- For each tool referenced in the skill, check: right tool? Right flags? Right arguments?
- Score 10: all references correct. Score 1: wrong tools or missing scripts.

**Dimension 4 — Execution quality (did things run clean? Were errors handled?)**
- Scan transcript for error outputs, failed commands, retries
- Check if error handling matched skill spec
- Score 10: clean execution. Score 1: multiple unhandled failures.

**Dimension 5 — Output match (did the final output match what the skill intended?)**
- Compare what the skill specifies as output vs. what was produced
- Score 10: matches exactly. Score 1: output missing or wrong format.

### Step 4: Write the report

Create the output files:

**analysis.md:**
```markdown
# Skill Audit: [skill-name]
Date: YYYY-MM-DD HH:MM UTC
Transcript: [path]
Skill: [path]

## Scores
| Dimension | Score | Notes |
|-----------|-------|-------|
| Trigger | X/10 | ... |
| Step coverage | X/10 | ... |
| Reference accuracy | X/10 | ... |
| Execution quality | X/10 | ... |
| Output match | X/10 | ... |
| **Total** | **X/50** | |

## What Worked
[Specific things the agent did correctly]

## What Failed
[Specific failures — which steps, which tool calls]

## Root Cause
[Why the failures happened — ambiguous instruction, missing step, wrong tool referenced]

## Recommended Changes
[Plain English summary of what to change in SKILL.md]
```

**diff.patch** — exact proposed changes to SKILL.md in unified diff format:
```diff
--- a/SKILL.md
+++ b/SKILL.md
@@ -12,3 +12,5 @@
 ## Step 3: Do the thing
+
+Note: Always check X before Y.
```

Apply the patch:
```bash
patch <agent>/.claude/skills/<skill-name>/SKILL.md < skill-improvement/<skill-name>/[date]-diff.patch
```

### Step 5: Update history

Append this run to `history.json`:

```json
{
  "skill": "skill-name",
  "runs": [
    {
      "date": "ISO timestamp",
      "transcript": "path/to/transcript.jsonl",
      "scores": {
        "trigger": 9,
        "step_coverage": 7,
        "reference_accuracy": 8,
        "execution_quality": 6,
        "output_match": 8
      },
      "total": 38,
      "diff_applied": false
    }
  ]
}
```

### Step 6: Compare to previous run (if history exists)

If there is a previous run:
- Show score delta per dimension
- Flag whether a previously applied diff improved scores
- Example: "Last run: 34/50 → This run: 38/50 (+4). Step coverage improved 5→7 after applying 2026-04-15 diff."

---

## Output Format

All output goes to `skill-improvement/` in your current working directory:

```
skill-improvement/
  <skill-name>/
    YYYY-MM-DD-HH-analysis.md    ← findings + scores
    YYYY-MM-DD-HH-diff.patch     ← proposed SKILL.md improvements
    history.json                 ← all runs with scores for trend tracking
```

Create the directory if needed:
```bash
mkdir -p skill-improvement/<skill-name>
```

---

## Workflow Summary

```
1. Find transcript path + skill path
2. Parse transcript using correct nested structure (see Step 1)
3. Read SKILL.md — extract required steps and references
4. Score 5 dimensions (1–10 each)
5. Write analysis.md with findings
6. Write diff.patch with exact SKILL.md improvements
7. Update history.json
8. Compare to previous run, report delta
9. Report: "[skill-name] scored X/50. Top gap: [dimension]. Diff written to skill-improvement/[skill-name]/."
```

---

## Example Output

```
Heartbeat skill audit complete.
Score: 39/50

Trigger         9/10 — correct trigger
Step coverage   6/10 — update-heartbeat and check-inbox done; log-event and list-tasks skipped
Reference acc.  9/10 — correct bus commands throughout
Execution qual. 8/10 — no errors
Output match    7/10 — heartbeat file updated correctly

Root cause: cron prompt is abbreviated (3 steps) vs. skill (4 steps).
Agent follows cron prompt, not full skill.

Diff written. Apply with:
patch <agent>/.claude/skills/heartbeat/SKILL.md < skill-improvement/heartbeat/2026-04-16-13-diff.patch
```

---

## Troubleshooting

**"No tool calls found"**
Check that you are parsing the nested structure correctly. Claude Code JSONL uses `entry['message']['content']`, not a flat `content` array on the top-level entry.

**"Diff does not apply cleanly"**
The skill was updated since the audit. Regenerate by re-running against the current SKILL.md.

**"Score seems wrong"**
Trust the rubric. Review the specific tool calls in analysis.md against the skill steps. The score reflects what the transcript shows.

---

## Reference

Install: clone into `~/.claude/skills/skill-autoresearch/`
Invoke: paste the trigger phrase into Claude Code
ManyChat keyword: AUTORESEARCH
