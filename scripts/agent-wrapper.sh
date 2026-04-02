#!/usr/bin/env bash
# agent-wrapper.sh - Wrapper script for launchd-managed Claude Code agents
# Handles crash counting, environment loading, rate limit detection, and respawn
# Usage: agent-wrapper.sh <agent_name> <template_root>
#
# Lifecycle:
#   1. launchd starts this script
#   2. We create a tmux session and run claude inside it (provides PTY)
#   3. Claude bootstraps, creates /loop crons, runs until timeout (default 71h)
#   4. Timer restarts Claude CLI with --continue (reloads configs, preserves conversation)
#
# User can attach to any agent: tmux attach -t ctx-<instance>-<agent_name>
#
# NOTE: --dangerously-skip-permissions is required for headless mode.
# Agent boundaries are enforced via AGENTS.md instructions, not CLI permissions.

set -euo pipefail

AGENT="$1"
TEMPLATE_ROOT="$2"

# Load instance ID from repo .env or environment
REPO_ENV="${TEMPLATE_ROOT}/.env"
if [[ -f "${REPO_ENV}" ]]; then
    CTX_INSTANCE_ID=$(grep '^CTX_INSTANCE_ID=' "${REPO_ENV}" | cut -d= -f2)
fi
CTX_INSTANCE_ID="${CTX_INSTANCE_ID:-default}"

CTX_ROOT="${CTX_ROOT:-${HOME}/.cortextos/${CTX_INSTANCE_ID}}"

# Agent directory: from env var (set by launchd) or legacy path
AGENT_DIR="${CTX_AGENT_DIR:-${TEMPLATE_ROOT}/agents/${AGENT}}"
CTX_ORG="${CTX_ORG:-}"

LOG_DIR="${CTX_ROOT}/logs/${AGENT}"
mkdir -p "${LOG_DIR}"
# Redirect wrapper stderr to log file for debugging
exec 2>>"${LOG_DIR}/stderr.log"
CRASH_LOG="${LOG_DIR}/crashes.log"
CRASH_COUNT_FILE="${LOG_DIR}/.crash_count_today"
MAX_CRASHES_PER_DAY=3

# Singleton: prevent duplicate wrappers per agent.
# If an old wrapper is still running (e.g., in graceful_shutdown), kill it.
WRAPPER_PID_FILE="${CTX_ROOT}/state/${AGENT:-}/.wrapper.pid"
mkdir -p "${CTX_ROOT}/state/${AGENT}"
if [[ -f "${WRAPPER_PID_FILE}" ]]; then
    OLD_WRAPPER_PID=$(cat "${WRAPPER_PID_FILE}" 2>/dev/null || echo "")
    if [[ -n "${OLD_WRAPPER_PID}" && "${OLD_WRAPPER_PID}" != "$$" ]] && kill -0 "${OLD_WRAPPER_PID}" 2>/dev/null; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Killing stale wrapper (pid ${OLD_WRAPPER_PID}) for ${AGENT}" >> "${LOG_DIR}/activity.log"
        kill "${OLD_WRAPPER_PID}" 2>/dev/null || true
        # Give it a moment to die before continuing
        sleep 2
        # Force-kill if still alive
        kill -9 "${OLD_WRAPPER_PID}" 2>/dev/null || true
    fi
fi
echo $$ > "${WRAPPER_PID_FILE}"

# tmux session name includes org if present
if [[ -n "${CTX_ORG}" ]]; then
    TMUX_SESSION="ctx-${CTX_INSTANCE_ID}-${CTX_ORG}-${AGENT}"
else
    TMUX_SESSION="ctx-${CTX_INSTANCE_ID}-${AGENT}"
fi

mkdir -p "${LOG_DIR}"

# Source environment file if it exists (for bot tokens, API keys, etc.)
ENV_FILE="${AGENT_DIR}/.env"
if [[ -f "${ENV_FILE}" ]]; then
    set -a
    source "${ENV_FILE}"
    set +a
fi

# Agents get their environment from .env files only (no shell profile sourcing for security)

export CTX_AGENT_NAME="${AGENT}"
export CTX_INSTANCE_ID="${CTX_INSTANCE_ID}"
export CTX_ROOT="${CTX_ROOT}"
export CTX_FRAMEWORK_ROOT="${TEMPLATE_ROOT}"
export CTX_PROJECT_ROOT="${CTX_PROJECT_ROOT:-}"
export CTX_ORG="${CTX_ORG:-}"
export CTX_AGENT_DIR="${AGENT_DIR}"

# Check crash count for today (single-line format: date:count)
TODAY=$(date +%Y-%m-%d)
if [[ -f "${CRASH_COUNT_FILE}" ]]; then
    STORED_DATE=$(cut -d: -f1 "${CRASH_COUNT_FILE}" 2>/dev/null || echo "")
    CRASH_COUNT=$(cut -d: -f2 "${CRASH_COUNT_FILE}" 2>/dev/null || echo "0")
else
    STORED_DATE=""
    CRASH_COUNT=0
fi

if [[ "${STORED_DATE}" != "${TODAY}" ]]; then
    CRASH_COUNT=0
fi

# Check if we've exceeded crash limit
if [[ ${CRASH_COUNT} -ge ${MAX_CRASHES_PER_DAY} ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) HALTED: ${AGENT} exceeded ${MAX_CRASHES_PER_DAY} crashes today. Manual restart required." >> "${CRASH_LOG}"

    # Alert via Telegram
    if [[ -n "${BOT_TOKEN:-}" && -n "${CHAT_ID:-}" ]]; then
        curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
            -d chat_id="${CHAT_ID}" \
            -d text="ALERT: ${AGENT} has crashed ${MAX_CRASHES_PER_DAY} times today and has been halted. Run: ./enable-agent.sh ${AGENT} --restart" \
            > /dev/null 2>&1 || true
    fi

    sleep 86400
    exit 1
fi

# Staggered startup delay to avoid simultaneous API hits
DELAY=$(jq -r '.startup_delay // 0' "${AGENT_DIR}/config.json" 2>/dev/null || echo "0")
# Validate DELAY is numeric to prevent shell injection via malicious config.json
if [[ ! "${DELAY}" =~ ^[0-9]+$ ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) WARNING: Invalid startup_delay '${DELAY}', defaulting to 0" >> "${LOG_DIR}/activity.log"
    DELAY=0
fi
sleep "${DELAY}"

# Session duration: config override, or default 71 hours (255600s)
# /loop crons expire at 72h, so we restart 1h before that
# Set "max_session_seconds" in config.json for testing (e.g. 300)
MAX_SESSION=$(jq -r '.max_session_seconds // 255600' "${AGENT_DIR}/config.json" 2>/dev/null || echo "255600")
# Validate MAX_SESSION is numeric to prevent shell injection
if [[ ! "${MAX_SESSION}" =~ ^[0-9]+$ ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) WARNING: Invalid max_session_seconds '${MAX_SESSION}', defaulting to 255600" >> "${LOG_DIR}/activity.log"
    MAX_SESSION=255600
fi

# Model override: set "model" in config.json (e.g. "claude-haiku-4-5-20251001")
MODEL_FLAG=""
MODEL=$(jq -r '.model // empty' "${AGENT_DIR}/config.json" 2>/dev/null || echo "")
# Validate MODEL to prevent injection (only alphanumeric, dots, hyphens)
if [[ -n "${MODEL}" ]]; then
    if [[ ! "${MODEL}" =~ ^[a-zA-Z0-9._-]+$ ]]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) WARNING: Invalid model name '${MODEL}', ignoring" >> "${LOG_DIR}/activity.log"
        MODEL=""
    else
        MODEL_FLAG="--model ${MODEL}"
    fi
fi

# Working directory override: set "working_directory" in config.json to launch
# Claude Code in a different project directory. The agent's identity (AGENTS.md,
# settings.json, .env) stays centralized here; only the cwd changes.
WORK_DIR=$(jq -r '.working_directory // empty' "${AGENT_DIR}/config.json" 2>/dev/null || echo "")
LAUNCH_DIR="${AGENT_DIR}"
EXTRA_FLAGS=()

if [[ -n "${WORK_DIR}" ]]; then
    if [[ ! -d "${WORK_DIR}" ]]; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: working_directory '${WORK_DIR}' does not exist" >&2
        exit 1
    fi
    LAUNCH_DIR="${WORK_DIR}"
    # Inject agent identity into system prompt (since we're not in AGENT_DIR).
    # NOTE: Only AGENTS.md is injected here. If the agent has additional bootstrap
    # files (SOUL.md, GOALS.md, skills, etc.), AGENTS.md should reference them so
    # they are loaded automatically. The --add-dir flag below gives Claude access
    # to read these files from AGENT_DIR.
    EXTRA_FLAGS+=(--append-system-prompt-file "${AGENT_DIR}/AGENTS.md")
    # Merge settings: project settings as base, agent settings take precedence.
    # This preserves the target project's hooks/permissions while overlaying agent-specific config.
    AGENT_SETTINGS="${AGENT_DIR}/.claude/settings.json"
    PROJECT_SETTINGS="${LAUNCH_DIR}/.claude/settings.json"
    if [[ -f "${AGENT_SETTINGS}" ]]; then
        if [[ -f "${PROJECT_SETTINGS}" ]]; then
            # Merge: project as base, agent settings override
            MERGED_SETTINGS="${LOG_DIR}/.merged-settings.json"
            python3 -c "
import json, sys
base = json.load(open(sys.argv[1]))
override = json.load(open(sys.argv[2]))
def deep_merge(b, o):
    result = dict(b)
    for k, v in o.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = deep_merge(result[k], v)
        elif k in result and isinstance(result[k], list) and isinstance(v, list):
            result[k] = result[k] + [x for x in v if x not in result[k]]
        else:
            result[k] = v
    return result
json.dump(deep_merge(base, override), open(sys.argv[3], 'w'), indent=2)
" "${PROJECT_SETTINGS}" "${AGENT_SETTINGS}" "${MERGED_SETTINGS}" 2>/dev/null
            if [[ -f "${MERGED_SETTINGS}" ]]; then
                EXTRA_FLAGS+=(--settings "${MERGED_SETTINGS}")
            else
                # Fallback to agent settings only if merge fails
                EXTRA_FLAGS+=(--settings "${AGENT_SETTINGS}")
            fi
        else
            EXTRA_FLAGS+=(--settings "${AGENT_SETTINGS}")
        fi
    fi
    # Give agent access to central repo for bus scripts, config, etc.
    EXTRA_FLAGS+=(--add-dir "${TEMPLATE_ROOT}")
fi

# Current UTC time injected into prompts so agents can compare fire_at timestamps
# for once-crons to determine if they should be recreated or expired.
NOW_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# First-boot onboarding: if no .onboarded marker exists, append onboarding instructions
ONBOARDED_MARKER="${CTX_ROOT}/state/${AGENT}/.onboarded"
ONBOARDING_APPEND=""
if [[ ! -f "${ONBOARDED_MARKER}" ]] && [[ -f "${AGENT_DIR}/ONBOARDING.md" ]]; then
    ONBOARDING_APPEND=" IMPORTANT: This is your FIRST BOOT. Before doing anything else, read ONBOARDING.md and complete the onboarding protocol. Do not proceed with normal operations until onboarding is done."
fi

# STARTUP_PROMPT: used for fresh starts (hard-restart or first-ever launch)
STARTUP_PROMPT="You are starting a new session. Current UTC time: ${NOW_UTC}. Read AGENTS.md and all bootstrap files listed there. Then restore your crons from config.json: for each entry with type \"recurring\" (or no type field), call /loop {interval} {prompt}; for each entry with type \"once\", compare fire_at against the current UTC time above — if fire_at is still in the future recreate it with CronCreate (recurring: false), if fire_at is in the past delete that entry from config.json. Run CronList first to avoid duplicates. After setting up crons, send a Telegram message to the user saying you are back online.${ONBOARDING_APPEND}"

# CONTINUE_PROMPT: used when resuming via --continue (timer refresh or self-restart)
CONTINUE_PROMPT="SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC time: ${NOW_UTC}. Your full conversation history is preserved. Re-read AGENTS.md and ALL bootstrap files listed there. Restore your crons from config.json: for each entry with type \"recurring\" (or no type field), call /loop {interval} {prompt}; for each entry with type \"once\", compare fire_at against the current UTC time above — if fire_at is still in the future recreate it with CronCreate (recurring: false), if fire_at is in the past delete that entry from config.json. Run CronList first — no duplicates. Check inbox. Resume normal operations."

# Force-fresh marker: written by hard-restart.sh to signal a clean slate is needed.
# Without the marker, launchd respawns always use --continue to preserve conversation history.
FORCE_FRESH_MARKER="${CTX_ROOT}/state/${AGENT}/.force-fresh"
mkdir -p "${CTX_ROOT}/state/${AGENT}"

# Write a restart marker BEFORE killing old tmux so the old session's
# SessionEnd hook correctly categorizes the exit as planned (not a crash).
echo "new wrapper instance starting" > "${CTX_ROOT}/state/${AGENT}/.restart-planned"

# Kill any existing tmux session for this agent (stale from previous run).
# The old Claude's SessionEnd hook will fire and find the .restart-planned marker.
tmux kill-session -t "${TMUX_SESSION}" 2>/dev/null || true

# Brief pause for old session's SessionEnd hook to fire and consume the marker
sleep 2

# Clean any remaining stale markers after the old session has had time to use them
rm -f "${CTX_ROOT}/state/${AGENT}/.restart-planned"
rm -f "${CTX_ROOT}/state/${AGENT}/.session-refresh"
rm -f "${CTX_ROOT}/state/${AGENT}/.user-restart"

cd "${LAUNCH_DIR}"

# Determine start mode
# Check if there's actually a conversation to continue by looking for .jsonl files
# in Claude's project conversation directory (based on the actual launch directory).
CONV_DIR="${HOME}/.claude/projects/-$(echo "${LAUNCH_DIR}" | tr '/' '-')"
HAS_CONVERSATION=false
if [[ -d "${CONV_DIR}" ]] && ls "${CONV_DIR}"/*.jsonl &>/dev/null; then
    HAS_CONVERSATION=true
fi

if [[ -f "${FORCE_FRESH_MARKER}" ]]; then
    START_MODE="fresh"
    rm -f "${FORCE_FRESH_MARKER}"
elif [[ "${HAS_CONVERSATION}" == "false" ]]; then
    START_MODE="fresh"
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) No conversation found for ${AGENT}, using fresh start" >> "${LOG_DIR}/activity.log"
else
    START_MODE="continue"
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Starting ${AGENT} mode=${START_MODE} (session cap: ${MAX_SESSION}s)" >> "${LOG_DIR}/activity.log"

# Register skills/commands as Telegram bot / autocomplete commands
if [[ -n "${BOT_TOKEN:-}" ]]; then
    REGISTER_SCRIPT="${TEMPLATE_ROOT}/scripts/register-telegram-commands.sh"
    if [[ -f "${REGISTER_SCRIPT}" ]]; then
        bash "${REGISTER_SCRIPT}" "${BOT_TOKEN}" "${LAUNCH_DIR}" "${AGENT_DIR}" \
            >> "${LOG_DIR}/activity.log" 2>&1 || true
    fi
fi

# Prevent Mac from sleeping while agent runs
caffeinate -is -w $$ &

# LOCAL OVERRIDE PATTERN (upgradeability mechanism)
# Users place custom .md files in agents/{agent}/local/ to add context that
# persists across git pull updates. These override/extend the repo versions.
# .gitignore excludes local/ so user customizations are never clobbered.
# Files are concatenated and passed as --append-system-prompt to Claude.
LOCAL_PROMPT_FILE=""
LOCAL_DIR="${AGENT_DIR}/local"
if [[ -d "${LOCAL_DIR}" ]]; then
    LOCAL_FILES=$(find "${LOCAL_DIR}" -name '*.md' -type f 2>/dev/null | sort)
    if [[ -n "${LOCAL_FILES}" ]]; then
        LOCAL_CONTENT=""
        while IFS= read -r lf; do
            LOCAL_CONTENT="${LOCAL_CONTENT}
--- $(basename "${lf}") ---
$(cat "${lf}")
"
        done <<< "${LOCAL_FILES}"
        LOCAL_PROMPT_FILE="${LOG_DIR}/.local-prompt"
        printf '%s' "${LOCAL_CONTENT}" > "${LOCAL_PROMPT_FILE}"
    fi
fi

# Serialize EXTRA_FLAGS for use in generated scripts and tmux commands
# Use printf %q to safely quote each flag (handles single quotes, spaces, etc.)
EXTRA_FLAGS_STR=""
for flag in "${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}"; do
    EXTRA_FLAGS_STR+=" $(printf '%q' "${flag}")"
done

# Safely quote values for generated shell scripts (handles single quotes, etc.)
Q_LAUNCH_DIR=$(printf '%q' "${LAUNCH_DIR}")
Q_STARTUP_PROMPT=$(printf '%q' "${STARTUP_PROMPT}")
Q_CONTINUE_PROMPT=$(printf '%q' "${CONTINUE_PROMPT}")

# Build the initial launch command based on start mode
if [[ "${START_MODE}" == "fresh" ]]; then
    LAUNCHER="${LOG_DIR}/.launch.sh"
    cat > "${LAUNCHER}" << LAUNCH_SCRIPT
#!/usr/bin/env bash
cd ${Q_LAUNCH_DIR}
ARGS=(--dangerously-skip-permissions)
${MODEL_FLAG:+ARGS+=(--model ${MODEL})}
LOCAL_FILE="${LOG_DIR}/.local-prompt"
if [[ -f "\${LOCAL_FILE}" ]]; then
    ARGS+=(--append-system-prompt "\$(cat "\${LOCAL_FILE}")")
fi
EXTRA=(${EXTRA_FLAGS_STR})
ARGS+=("\${EXTRA[@]+"\${EXTRA[@]}"}")
exec claude "\${ARGS[@]}" ${Q_STARTUP_PROMPT}
LAUNCH_SCRIPT
    chmod +x "${LAUNCHER}"
    INITIAL_CMD="bash '${LAUNCHER}'"
else
    INITIAL_CMD="cd ${Q_LAUNCH_DIR} && claude --continue --dangerously-skip-permissions ${MODEL_FLAG}${EXTRA_FLAGS_STR} ${Q_CONTINUE_PROMPT}"
fi

# ── Layer 3: Write .cortextos-env for bus script fallback ─────────────────
# Bus scripts source this file when CTX_ vars aren't in the environment.
# This is the most reliable layer - it's a file on disk, not dependent on
# env var inheritance through tmux/process chains.
cat > "${AGENT_DIR}/.cortextos-env" << ENVFILE
CTX_INSTANCE_ID=${CTX_INSTANCE_ID}
CTX_ROOT=${CTX_ROOT}
CTX_FRAMEWORK_ROOT=${TEMPLATE_ROOT}
CTX_AGENT_NAME=${AGENT}
CTX_ORG=${CTX_ORG:-}
CTX_AGENT_DIR=${AGENT_DIR}
CTX_PROJECT_ROOT=${CTX_PROJECT_ROOT:-}
ENVFILE

# Start claude inside a tmux session
# tmux provides the PTY that claude needs to stay in interactive mode
# where /loop crons can fire. Without a PTY, claude exits immediately.
tmux new-session -d -s "${TMUX_SESSION}" bash

# ── Layer 1: Set tmux session environment vars ───────────────────────────
# These propagate to new windows/panes created in this session.
tmux set-environment -t "${TMUX_SESSION}" CTX_INSTANCE_ID "${CTX_INSTANCE_ID}"
tmux set-environment -t "${TMUX_SESSION}" CTX_ROOT "${CTX_ROOT}"
tmux set-environment -t "${TMUX_SESSION}" CTX_FRAMEWORK_ROOT "${TEMPLATE_ROOT}"
tmux set-environment -t "${TMUX_SESSION}" CTX_AGENT_NAME "${AGENT}"
tmux set-environment -t "${TMUX_SESSION}" CTX_ORG "${CTX_ORG:-}"
tmux set-environment -t "${TMUX_SESSION}" CTX_AGENT_DIR "${AGENT_DIR}"
tmux set-environment -t "${TMUX_SESSION}" CTX_PROJECT_ROOT "${CTX_PROJECT_ROOT:-}"

# ── Layer 1b: Remove agent-specific vars from global tmux env ────────────
# The tmux server inherits its global env from whichever agent-wrapper starts
# it first (typically the orchestrator). Without this, every session inherits
# CTX_AGENT_NAME=<orchestrator> and CTX_AGENT_DIR=.../orchestrator from the
# global env, causing bus scripts (send-message, send-telegram) to route as
# FROM=<orchestrator> regardless of which agent is actually running.
# Per-session env (set above) is correct per-agent; global must stay clean.
tmux set-environment -g -u CTX_AGENT_NAME 2>/dev/null || true
tmux set-environment -g -u CTX_AGENT_DIR 2>/dev/null || true

# ── Layer 2: Export vars in the tmux shell BEFORE launching claude ───────
# tmux new-session starts an isolated bash shell that does NOT inherit parent
# process env vars. We must explicitly export them inside the tmux shell so
# Claude Code's Bash tool inherits them.
tmux send-keys -t "${TMUX_SESSION}:0.0" \
    "export CTX_INSTANCE_ID='${CTX_INSTANCE_ID}' CTX_ROOT='${CTX_ROOT}' CTX_FRAMEWORK_ROOT='${TEMPLATE_ROOT}' CTX_AGENT_NAME='${AGENT}' CTX_ORG='${CTX_ORG:-}' CTX_AGENT_DIR='${AGENT_DIR}' CTX_PROJECT_ROOT='${CTX_PROJECT_ROOT:-}'" Enter

# Capture tmux pane output to stdout.log for dashboard viewing
STDOUT_LOG="${LOG_DIR}/stdout.log"
tmux pipe-pane -t "${TMUX_SESSION}:0.0" -o "cat >> '${STDOUT_LOG}'"

tmux send-keys -t "${TMUX_SESSION}:0.0" "${INITIAL_CMD}" Enter

# Handle external SIGTERM (e.g., launchctl unload) gracefully
graceful_shutdown() {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) SIGTERM received for ${AGENT}" >> "${CRASH_LOG}"
    # Kill background timer and fast-checker to prevent orphaned processes
    kill "${TIMER_PID}" 2>/dev/null || true
    if [[ -n "${FAST_PID:-}" ]]; then
        kill "${FAST_PID}" 2>/dev/null || true
    fi
    # Only kill the tmux session if we still own it (no new wrapper has taken over).
    CURRENT_OWNER=$(cat "${WRAPPER_PID_FILE}" 2>/dev/null || echo "")
    if [[ "${CURRENT_OWNER}" == "$$" ]] && tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
        tmux send-keys -t "${TMUX_SESSION}:0.0" \
            "SYSTEM SHUTDOWN: SIGTERM received. Session ending in 5 seconds." Enter
        sleep 5
        # Re-check ownership — new wrapper may have started during the sleep
        CURRENT_OWNER=$(cat "${WRAPPER_PID_FILE}" 2>/dev/null || echo "")
        if [[ "${CURRENT_OWNER}" == "$$" ]]; then
            tmux kill-session -t "${TMUX_SESSION}" 2>/dev/null || true
        fi
    fi
    rm -f "${WRAPPER_PID_FILE}" 2>/dev/null || true
    exit 0
}
trap graceful_shutdown SIGTERM SIGINT

# Background timer: restart Claude CLI with --continue after MAX_SESSION seconds
(
    while true; do
        sleep ${MAX_SESSION}
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) SESSION_REFRESH after ${MAX_SESSION}s agent=${AGENT}" >> "${CRASH_LOG}"
        # Write marker so crash-alert knows this is a planned refresh
        echo "71h session limit" > "${CTX_ROOT}/state/${AGENT}/.session-refresh"

        if tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
            tmux send-keys -t "${TMUX_SESSION}:0.0" C-c
            sleep 1
            tmux send-keys -t "${TMUX_SESSION}:0.0" "/exit" Enter
            sleep 3

            CLAUDE_PID=$(tmux list-panes -t "${TMUX_SESSION}" -F '#{pane_pid}' 2>/dev/null | head -1)
            if [[ -n "$CLAUDE_PID" ]]; then
                pkill -P "$CLAUDE_PID" 2>/dev/null || true
                sleep 2
            fi

            # Kill old fast-checker and start fresh one
            rm -f "${CTX_ROOT}/state/${AGENT}/.fast-checker.pid"
            pkill -f "fast-checker.sh ${AGENT} " 2>/dev/null || true
            sleep 1
            if [[ -f "${TEMPLATE_ROOT}/scripts/fast-checker.sh" ]]; then
                bash "${TEMPLATE_ROOT}/scripts/fast-checker.sh" "${AGENT}" "${TMUX_SESSION}" "${AGENT_DIR}" "${TEMPLATE_ROOT}" \
                    >> "${LOG_DIR}/fast-checker.log" 2>&1 &
            fi

            # Refresh NOW_UTC for the continue prompt at session refresh time
            REFRESH_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
            REFRESH_PROMPT="SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC time: ${REFRESH_UTC}. Your full conversation history is preserved. Re-read AGENTS.md and ALL bootstrap files listed there. Restore your crons from config.json: for each entry with type \"recurring\" (or no type field), call /loop {interval} {prompt}; for each entry with type \"once\", compare fire_at against the current UTC time above — if fire_at is still in the future recreate it with CronCreate (recurring: false), if fire_at is in the past delete that entry from config.json. Run CronList first — no duplicates. Check inbox. Resume normal operations."
            Q_REFRESH_PROMPT=$(printf '%q' "${REFRESH_PROMPT}")

            tmux send-keys -t "${TMUX_SESSION}:0.0" \
                "cd ${Q_LAUNCH_DIR} && claude --continue --dangerously-skip-permissions ${MODEL_FLAG}${EXTRA_FLAGS_STR} ${Q_REFRESH_PROMPT}" Enter

            echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Relaunched ${AGENT} with --continue" >> "${LOG_DIR}/activity.log"
        else
            break
        fi
    done
) &
TIMER_PID=$!

# Kill any stale fast-checker for this agent before starting a fresh one.
rm -f "${CTX_ROOT}/state/${AGENT}/.fast-checker.pid"
pkill -f "fast-checker.sh ${AGENT} " 2>/dev/null || true

# Start fast message checker (Telegram + inbox polling every 3s)
FAST_PID=""
FAST_CHECKER="${TEMPLATE_ROOT}/scripts/fast-checker.sh"
if [[ -f "${FAST_CHECKER}" ]]; then
    bash "${FAST_CHECKER}" "${AGENT}" "${TMUX_SESSION}" "${AGENT_DIR}" "${TEMPLATE_ROOT}" \
        >> "${LOG_DIR}/fast-checker.log" 2>&1 &
    FAST_PID=$!
fi

# Wait for the tmux session to end
while tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; do
    # Watchdog: restart fast-checker if it died unexpectedly
    if [[ -n "${FAST_PID:-}" ]] && ! kill -0 "${FAST_PID}" 2>/dev/null; then
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) fast-checker died (pid ${FAST_PID}), restarting" >> "${LOG_DIR}/fast-checker.log"
        rm -f "${CTX_ROOT}/state/${AGENT}/.fast-checker.pid"
        bash "${FAST_CHECKER}" "${AGENT}" "${TMUX_SESSION}" "${AGENT_DIR}" "${TEMPLATE_ROOT}" \
            >> "${LOG_DIR}/fast-checker.log" 2>&1 &
        FAST_PID=$!
    fi
    sleep 5
done

EXIT_CODE=0

# If we get here, tmux session ended
kill ${TIMER_PID} 2>/dev/null || true

# Kill fast checker alongside session
if [[ -n "${FAST_PID:-}" ]]; then
    kill "${FAST_PID}" 2>/dev/null || true
fi

# Check for rate limiting
if tail -20 "${LOG_DIR}/stderr.log" 2>/dev/null | grep -qi "rate.limit\|429\|capacity"; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) RATE_LIMITED agent=${AGENT}" >> "${CRASH_LOG}"
    RATE_COUNT=$(grep -c "RATE_LIMITED" "${CRASH_LOG}" 2>/dev/null || echo "0")
    BACKOFF=$((300 * (RATE_COUNT > 3 ? 4 : RATE_COUNT + 1)))
    sleep ${BACKOFF}
    exit 0
fi

# Check if this was a planned refresh or unexpected exit
if tail -1 "${CRASH_LOG}" 2>/dev/null | grep -q "SESSION_REFRESH"; then
    exit 0
fi

# Unexpected exit - claude died or crashed
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) EXIT agent=${AGENT}" >> "${CRASH_LOG}"
echo "${TODAY}:$((CRASH_COUNT + 1))" > "${CRASH_COUNT_FILE}"
exit 1
