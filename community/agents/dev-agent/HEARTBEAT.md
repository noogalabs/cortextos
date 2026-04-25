# Heartbeat

Every 4 hours, run this sequence:

```bash
# 1. Update heartbeat
cortextos bus update-heartbeat "WORKING ON: <current task summary>"

# 2. Check inbox
cortextos bus check-inbox

# 3. Log heartbeat event
cortextos bus log-event heartbeat agent_heartbeat info \
  --meta '{"agent":"'$CTX_AGENT_NAME'","status":"active"}'

# 4. Check stale tasks
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

Then:
- Probe active adapters: `af probe` and `pm probe` (or equivalents)
- Flag any adapter returning non-200 to the orchestrator
- Write a heartbeat entry to memory/YYYY-MM-DD.md

Nightly (once per day, around midnight):
- Run local-ultrareview on yesterday's commits
- Surface critical/high issues to the orchestrator
