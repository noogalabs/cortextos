---
name: pm-dane-iq-playbook
effort: low
description: "Dane IQ operational reference for Blue. Triage decision tree, vendor scoring, escalation thresholds, habitability rules — distilled from the TriageSupervisor, VendorSelectionSupervisor, and their worker agents."
triggers: ["dane iq rules", "how does triage work", "vendor scoring", "escalation rules", "how urgent", "pm playbook"]
---

# Dane IQ Operational Playbook

> Reference for Blue's triage and vendor decisions. Distilled from TriageSupervisor, VendorSelectionSupervisor, SafetyCheckAgent, EmergencyTriageAgent, AvailabilityScorerAgent, RatingAnalyzerAgent, and EscalationManagerAgent.

---

## Part 1: Triage Decision Tree

### Step 1 — Keyword safety scan (instant, no AI)

Run description through the safety pattern list. First match wins. Order matters: critical before high before medium before low.

#### CRITICAL (riskLevel: critical — evacuate/call immediately)

| Trigger | Action |
|---------|--------|
| sparking / spark from outlet / smoking outlet / electrical burning / burning smell from outlet | Turn off main breaker. Call electrician. |
| electric shock / got shocked / tingling from outlet | Do not touch. Power off at breaker. |
| gas smell / smell gas / rotten egg smell / propane smell / natural gas leak | Evacuate. Call gas company. Do not use switches. |
| flooding / water everywhere / burst pipe / gushing water / pipe burst | Turn off main water valve. Call plumber immediately. |
| ceiling leak / water through ceiling / ceiling dripping | Move items below. Turn off water. Emergency plumber. |
| ceiling falling / ceiling collapsed / wall cracking badly / floor sagging | Evacuate. Call emergency services. |

**Exclusions:** "gas station", "gas can", "gas grill", "sparkler", "spark plug", "water bottle", "watering", "small crack" — these exclude their respective patterns.

#### HIGH (riskLevel: high — same-day response, do not wait for next business day)

| Trigger | Action |
|---------|--------|
| no heat / heater not working / furnace not working (NOT water heater) | Emergency HVAC — health risk |
| no ac / no air conditioning / no cooling / ac not working | Emergency HVAC — heat risk |
| water heater not working / no hot water / cold water only | Priority plumber — 24h max |
| toilet overflow / sewage backup / sewage smell | Biohazard — plumber within 4h |

#### Life-safety temperature escalation (EmergencyTriageAgent rules)

| Condition | Level |
|-----------|-------|
| No heat + outdoor temp <= 32°F | life_safety |
| No heat + elderly/infants/medical conditions present | life_safety (any temp) |
| No AC + outdoor temp >= 95°F + vulnerable occupants | life_safety |
| No AC + outdoor temp >= 95°F (no vulnerable occupants) | property_damage |

#### MEDIUM (canWaitForVendor: true, same-week response)

leak / leaking / dripping (not gas leak), outlet not working / no power in room / circuit breaker, strange noise / grinding / banging pipes.

#### LOW (routine, standard SLA)

slow drain, light flickering, door stuck, window stuck, lock broken, minor cosmetic.

---

### Step 2 — Trade classification

Priority: (1) safety risk type → (2) equipment in photo → (3) description keywords → (4) handyman fallback.

| Risk Type | Trade | Complexity |
|-----------|-------|-----------|
| gas_leak / flooding / sewage_backup | plumber | complex |
| electrical_fire | electrician | complex |
| structural_failure | handyman | complex |
| no_heat_winter / no_cooling_heat / mechanical_noise | hvac | moderate |
| water_heater_failure | plumber | moderate |
| water_leak / minor_plumbing | plumber | simple |
| electrical_outlet / minor_electrical | electrician | simple/moderate |
| door_stuck | window_door | simple |

**Equipment photo → trade:** HVAC/furnace/thermostat → hvac; water heater → plumber; refrigerator/washer/dryer/oven → appliance_repair; toilet/faucet/disposal → plumber; electrical panel/outlet → electrician.

---

### Step 3 — Urgency classification (final)

| Urgency | Definition | Dispatch strategy |
|---------|-----------|------------------|
| emergency | Safety risk / property damage risk / resident displacement | parallel (all 3 vendors at once) |
| urgent | Impacts daily living but not dangerous (no hot water, AC out in summer) | sequential (#1 first, #2 if declined) |
| routine | Can wait 24–48h (minor leak, cosmetic) | sequential |

**Hard rule:** If safety riskLevel is "high" or "critical" → urgency must be "emergency".

---

## Part 2: Vendor Scoring Criteria

### Search radius by urgency

| Urgency | Max distance |
|---------|-------------|
| emergency | 50 miles |
| urgent / routine | 25 miles |

Emergency also requires `after_hours = true` on vendor. Non-emergency does not filter by after_hours.

### Hard exclusions (any one = vendor ineligible)

| Rule | Condition |
|------|-----------|
| NOT_ACTIVE | enabled=false OR onboarding_status != ACTIVE |
| MISSING_CONTACT | phone is null |
| TRADE_NOT_MATCH | vendor not in vendor_trades for requested trade |
| CAPACITY_FULL | active_jobs >= max_active_jobs |
| IN_COOLDOWN | last_contacted_at + cooldown_minutes > now |
| OUTSIDE_RADIUS | job zip not within service_radius_miles from base_zip |
| NOT_AFTER_HOURS | priority is CRITICAL and vendor.after_hours = false |
| W9/COI/LICENSE | doc status not met (unless emergency override enabled for org) |

**Emergency compliance override:** If `allow_emergency_override = true` (default), CRITICAL priority bypasses compliance checks — vendor gets `compliance_warning` flag instead of exclusion.

### Availability score (0–100)

| Component | Max points | Formula |
|-----------|-----------|---------|
| Response rate | 40 | (accepts + declines) / offers_sent * 40 |
| Acceptance rate | 30 | accepts / (accepts + declines) * 30; neutral 15 if no history |
| Speed score | 20 | <15min→20; 15-59min→15; 1-4h→10; 4-24h→5; ≥24h→0; null→10 |
| Recency/reliability | 10 | reliability_score / 10 |
| After-hours bonus | +10 | Only if: emergency + after-hours time + vendor.after_hours=true |

After-hours time = before 08:00 or at/after 18:00 weekdays; any time on weekends.
New vendor (0 offers): score = 50, expectedResponseTime = 60 min.

**Tiers:** ≥80 highly_available | ≥60 available | ≥40 sometimes_available | <40 rarely_available

### Quality score (0–100, from ratings table, 365-day lookback)

| Component | Range | Formula |
|-----------|-------|---------|
| Base | 0–60 | (averageRating / 5) * 60 |
| Consistency | 5–20 | std_dev <0.5→20; <1.0→15; <1.5→10; ≥1.5→5 |
| Recent trend | -10 to +10 | +10 if recent avg > overall + 0.3; -10 if recent avg < overall - 0.3 |
| Volume confidence | 0–10 | ≥20 ratings→10; ≥10→5; ≥5→2 |
| Complaint penalty | up to -30 | complaintRate * -30 |

**Red flags (significantly lower Claude ranking):** ≥3 complaints in 90 days, declining trend, std_dev ≥1.5, complaintRate > 0.15.

**Hard disqualifier:** Average rating < 3.5 → do not rank in top 3.

### Claude ranking weights by urgency

| Urgency | Weight order |
|---------|-------------|
| emergency | distance + availability > rating |
| urgent | balanced (all equal) |
| routine | rating > availability > distance |

### Score formula (raw DB layer, before Claude ranking)

```
score = 1.0
score -= min(distanceMiles / 100, 0.30)      // max distance penalty: -0.30
score -= (activeJobs / maxActiveJobs) * 0.20  // max capacity penalty: -0.20
score += (reliabilityScore / 100) * 0.15      // max reliability bonus: +0.15
score = max(score, 0.1)                        // floor
```

Sort: preferred tier → bench tier → overflow tier. Within tier: score descending.

---

## Part 3: Offer Expiry and SMS Templates

| Urgency | Offer expires | SMS format |
|---------|--------------|-----------|
| emergency | 15 min | "URGENT: [issue] at [address]. Need ASAP. [link]" |
| high | 60 min | "Hi [Name], got a [issue] at [address] - can you help [timeframe]? [link]" |
| medium/low | 60 min | "Hey [Name], work order for [issue] at [address]. Available [timeframe]? [link]" |

---

## Part 4: SLA Targets

| Level | Acknowledge | Dispatch |
|-------|-------------|---------|
| life_safety | 5 min | 15 min |
| property_damage | 10 min | 30 min |
| urgent | 30 min | 2h |
| routine (high pm priority) | 2h | 24h |
| routine (normal) | 24h | 5 business days |

---

## Part 5: Escalation Thresholds

### Escalate immediately (no retry)

- safety_emergency (type) — any severity
- severity = critical — any type
- vip_contact — any severity

### Auto-retry before escalating

| Type | Wait | Max retries |
|------|------|------------|
| no_vendors_available | 15 min | 3 |
| all_vendors_declined | 30 min | 2 |
| integration_failure | 5 min | 5 |
| agent_error | 2 min | 3 |

### Escalation routes

| Situation | Contact | Channel | SLA |
|-----------|---------|---------|-----|
| safety_emergency | on_call | phone | immediate |
| no vendors / all declined (critical) | maintenance_director + property_manager | sms | 1h |
| no vendors / all declined (non-critical) | maintenance_director + property_manager | email | 4h |
| cost exceeds limit | property_manager | email | 4h |
| complaint (high/critical) | property_manager | sms | 1h |
| complaint (low/medium) | support_team | email | 24h |
| repeat failure | maintenance_director + property_manager | email | 4h |

### Priority codes

- P0 Critical: severity=critical OR type=safety_emergency
- P1 Urgent: no_vendors, all_declined, vip_contact, severity=high
- P2 High: complaint, cost_exceeds, deal_at_risk, repeat_failure, severity=medium
- P3 Normal: everything else

---

## Part 6: Org-Level Config Flags

| Flag | Default | Effect on Blue's decisions |
|------|---------|--------------------------|
| dispatch_mode | "auto" | "suggestion" = PM must approve via SMS before vendors are contacted |
| suggestion_timeout_minutes | 30 | How long PM has to reply in suggestion mode |
| dispatch_top_n | 5 | Vendor pool size |
| dispatch_expand_minutes | 10 | When to expand search to next tier |
| ask_for_data_plate_photo | false | Whether to prompt vendor for equipment data plate photo |
| notify_pm_on_escalation | true | Whether PM is notified on escalation events |

**Note for AscendOps:** `ask_for_data_plate_photo` has been enabled for David's org. Vendor SMS acceptance now triggers the data plate photo prompt.

---

*Sources: TriageSupervisor.ts, SafetyCheckAgent.ts, EmergencyTriageAgent.ts, VendorTypeClassifierAgent.ts, VendorSelectionSupervisor.ts, AvailabilityScorerAgent.ts, RatingAnalyzerAgent.ts, vendorSelection.ts, EscalationManagerAgent.ts, orgSettingsService.ts. Distilled 2026-04-14.*
