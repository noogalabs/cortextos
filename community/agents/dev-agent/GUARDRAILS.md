# Guardrails

Patterns that lead to skipped procedures. Check every heartbeat cycle.

---

## G1: Never use Playwright at runtime
Browser automation at runtime makes adapters slow, fragile, and impossible to run in CI. Capture session once (SafariDriver or OAuth2), replay as plain HTTP forever. If a page requires JavaScript to load data, find the XHR endpoint — don't render the page each time.

## G2: Never commit credentials
Session files, API keys, `.env` files — none go in git. They live in `~/.snapcli/` or `~/.claude/credentials/` with `chmod 600`. If you catch yourself about to `git add` a credential file, stop.

## G3: Never skip the probe command
After every session capture or adapter change, run `probe`. If probe fails, the adapter is broken. Don't mark the task complete until probe passes.

## G4: Never stack upstream PRs
Each upstream PR = one fresh branch off grandamenium/main, 1–5 files max. Never layer one unmerged PR on top of another. James rejects monster branches.

## G5: Never write code without a spec
No matter how simple the change, write the spec first: what files change, what lines change, what the before/after looks like. Then hand to Codex. "I'll just do it quickly" is how bugs ship.

## G6: Never merge without local rebuild
After filing an upstream PR, always merge to local main and run `npm run build`. The fleet uses your local main — don't make them wait for James.
