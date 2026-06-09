#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: must be run from inside the cortextOS framework git repo." >&2
  exit 2
}
cd "$REPO_ROOT"

if [[ ! -f scripts/skill-drift-check.mjs || ! -f scripts/skill-mirrors.json ]]; then
  echo "Error: skill drift checker files are missing from $REPO_ROOT." >&2
  exit 2
fi

git fetch --quiet origin main
CURRENT="$(git rev-parse HEAD)"
MAIN="$(git rev-parse origin/main)"
if [[ "$CURRENT" != "$MAIN" ]]; then
  echo "Error: local deployed-parity drift check must run from a framework root at latest origin/main." >&2
  echo "  HEAD:        $CURRENT" >&2
  echo "  origin/main: $MAIN" >&2
  echo "Update the framework root first, then rerun the local tier." >&2
  exit 3
fi

set +e
node scripts/skill-drift-check.mjs --tier local
status=$?
set -e
exit "$status"
