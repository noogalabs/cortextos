# Bug Register Done Ledger — 2026-05-01

Commit hash baseline for this ledger: `7209fb5`.

## Daemon / Telegram

| Bug ID | Commit(s) | Primary file(s) | One-line fix summary | Acceptance test reference |
|---|---|---|---|---|
| B01 | `7209fb5` | `src/telegram/poller.ts` | Telegram poller now awaits handlers before advancing offset; failures preserve offset for redelivery. | `npm test` (telegram poller suite) |
| B13 | `7209fb5` | `src/daemon/index.ts` | Added exclusive daemon pidfile acquisition with stale-PID takeover and clear fail-fast on active owner. | `npm test` + daemon startup checks |
| B14 | `7209fb5` | `src/daemon/ipc-server.ts`, `dashboard/src/lib/ipc-client.ts`, `src/types/index.ts` | Introduced framed IPC protocol + 256KB cap + legacy fallback logging + synchronous completion acks. | `npm run typecheck`, `npm test` |
| B15 | `7209fb5` | `src/daemon/ipc-server.ts` | Tightened `spawn-worker` cwd validation to explicit allowlist roots. | `npm test` (daemon unit subset + full suite) |
| B16 | `7209fb5` | `src/telegram/media.ts`, `tests/unit/telegram/media.test.ts` | Added unique filename suffixing for Telegram media persistence to prevent overwrite collisions. | `npm test` |
| B17 | `7209fb5` | `src/daemon/fast-checker.ts` | Converted callback/ask-state decision writes to atomic pattern and added retry-read path for race tolerance. | `npm test` |
| B19 | `7209fb5` | `src/daemon/watchdog.ts` | Replaced hardcoded `origin/main` rollback fallback with default-branch detection via `origin/HEAD`. | `npm test`, `npm run typecheck` |
| B20 | `7209fb5` | `src/daemon/watchdog.ts` | Switched watchdog stability/recovery writes to atomic file writes. | `npm test`, `npm run typecheck` |

## Dashboard API / Auth

| Bug ID | Commit(s) | Primary file(s) | One-line fix summary | Acceptance test reference |
|---|---|---|---|---|
| B02 | `7209fb5` | `dashboard/src/app/api/tasks/[id]/route.ts` | Replaced dynamic `node dist/cli.js` route call with direct `bus/send-message.sh` invocation to avoid Turbopack path resolution issue. | `dashboard npm run build` (route error removed; fonts network caveat) |
| B03 | `7209fb5` | `dashboard/src/app/api/messages/stream/[agent]/route.ts` | Added per-agent authorization gate after JWT auth; unauthorized subscriptions return 403. | `npm test` |
| B04 | `7209fb5` | `dashboard/src/app/api/media/[...filepath]/route.ts` | Restricted media MIME allowlist and forced attachment for non-image types. | `npm test` |
| B09 | `7209fb5` | `dashboard/src/app/api/notifications/register/route.ts` | Added lock-guarded read-modify-write with atomic rename for push-token registration. | `npm test` |
| B18 | `7209fb5` | `dashboard/src/app/api/messages/stream/[agent]/route.ts` | Replaced per-client polling with shared watcher fanout and partial-line buffering for JSONL stream integrity. | `npm test` |
| B24 | `7209fb5` | `dashboard/src/app/api/auth/mobile/route.ts` | Added trusted-proxy allowlist (`TRUSTED_PROXIES`) logic for safe `X-Forwarded-For` usage in rate-limit identity. | `npm test`, `npm run typecheck` |
| B25 | `7209fb5` | `dashboard/src/app/api/media/[...filepath]/route.ts` | Sanitized 404 media responses to avoid filesystem path disclosure in API payloads. | `npm test` |

## Bus / Core Infra

| Bug ID | Commit(s) | Primary file(s) | One-line fix summary | Acceptance test reference |
|---|---|---|---|---|
| B10 | `7209fb5` | `src/bus/message.ts` | Enforced HMAC policy: unsigned messages are rejected when signing key is configured. | `npm test -- tests/unit/bus/hmac.test.ts tests/unit/bus/message.test.ts` |
| B11 | `7209fb5` | `src/bus/message.ts` | Unified `ackInbox` with same inbox lock domain as `checkInbox` to prevent concurrent mutation races. | `npm test -- tests/unit/bus/message.test.ts` |
| B12 | `7209fb5` | `src/utils/lock.ts`, `src/bus/message.ts`, `tests/unit/utils/lock.test.ts` | Added UUID ownership tokens (`acquireLockToken`) and token-validated release path with compatibility shim `acquireLock()`. | `npm test -- tests/unit/utils/lock.test.ts` |

## Hooks / Shell Ops

| Bug ID | Commit(s) | Primary file(s) | One-line fix summary | Acceptance test reference |
|---|---|---|---|---|
| B05 | `7209fb5` | `bus/hook-planmode-telegram.sh` | Plan approval hook now fails closed (deny) on missing creds, delivery failure, and timeout. | manual hook-path validation + `npm test` |
| B06 | `7209fb5` | `bus/hook-permission-telegram.sh` | `.claude/` auto-allow changed from substring to anchored trusted prefixes only. | manual hook-path validation + `npm test` |
| B07 | `7209fb5` | `bus/_ctx-env.sh`, `bus/kb-query.sh`, `bus/kb-collections.sh`, `bus/hook-*.sh` | Replaced shell `source` execution of env files with parser-based key/value loader to avoid arbitrary code execution. | `npm test`, `npm run typecheck` |

## Worker / PTY

| Bug ID | Commit(s) | Primary file(s) | One-line fix summary | Acceptance test reference |
|---|---|---|---|---|
| B21 | `7209fb5` | `src/daemon/worker-process.ts`, `src/types/index.ts`, `tests/unit/daemon/worker-process.test.ts` | Worker forced termination now reports `killed` status rather than incorrectly marking completed. | `npm test -- tests/unit/daemon/worker-process.test.ts` |
| B22 | `7209fb5` | `src/pty/agent-pty.ts` | Replaced loose trust heuristic with anchored allowlist prompt regexes for Enter auto-inject. | `npm test` |
| B23 | `7209fb5` | `src/pty/agent-pty.ts` | Upgraded PTY env parsing logic for quoted values and escaped sequences (dotenv-style behavior subset). | `npm run typecheck`, `npm test` |

## Data Model

| Bug ID | Commit(s) | Primary file(s) | One-line fix summary | Acceptance test reference |
|---|---|---|---|---|
| B08 | `7209fb5` | `dashboard/src/lib/config.ts` | Dashboard agent dedup now keys by `org:name` composite to preserve same-name agents across orgs. | `npm test` |

---

### Notes
- Dashboard production build in this environment remains subject to external Google Fonts network availability; this is orthogonal to the bug-fix set above.
- This ledger is scoped to fixes implemented in the current branch state as of 2026-05-01.
