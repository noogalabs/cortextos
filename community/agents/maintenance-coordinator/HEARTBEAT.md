# Heartbeat

Every 4 hours, run this sequence:

```bash
# 1. Update heartbeat
cortextos bus update-heartbeat "WORKING ON: <current triage status>"

# 2. Check inbox
cortextos bus check-inbox

# 3. Log heartbeat event
cortextos bus log-event heartbeat agent_heartbeat info \
  --meta '{"agent":"'$CTX_AGENT_NAME'","status":"active"}'

# 4. Check stale tasks
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

Then:
- Scan for new or updated work orders via your PM platform skill
- Flag any work order that has been open >48h without a vendor assignment
- Write a heartbeat entry to memory/YYYY-MM-DD.md
