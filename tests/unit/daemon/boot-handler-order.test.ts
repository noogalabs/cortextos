/**
 * tests/unit/daemon/boot-handler-order.test.ts — F2 regression guard
 *
 * The daemon's signal handlers (SIGINT/SIGTERM → graceful stopAll) and
 * fatal-error handlers (uncaughtException/unhandledRejection → crash markers
 * + crash history) MUST be registered BEFORE the long boot work:
 * ipcServer.start() and agentManager.discoverAndStart() (serial multi-agent
 * boot — can take minutes). If a SIGTERM or crash lands during boot with no
 * handlers installed, no markers are written: every already-started agent's
 * SessionEnd hook fires a false CRASH alert and no crash history is recorded.
 *
 * Daemon.start() performs process-global side effects (umask, PID file,
 * process.on registration, process.exit on bad env), so executing it inside
 * the test runner is not safely feasible. Instead this is a source-order
 * static check: handler registrations must appear textually before the boot
 * calls inside src/daemon/index.ts. Crude but it directly pins the F2 fix —
 * any reorder back to handlers-after-boot fails loudly here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const DAEMON_INDEX = join(__dirname, '..', '..', '..', 'src', 'daemon', 'index.ts');

describe('F2: daemon boot order — handlers before boot work', () => {
  const src = readFileSync(DAEMON_INDEX, 'utf-8');

  const idx = (needle: string): number => {
    const i = src.indexOf(needle);
    expect(i, `expected to find ${JSON.stringify(needle)} in src/daemon/index.ts`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('registers SIGINT/SIGTERM handlers before discoverAndStart()', () => {
    const boot = idx('.discoverAndStart()');
    expect(idx("process.on('SIGINT'")).toBeLessThan(boot);
    expect(idx("process.on('SIGTERM'")).toBeLessThan(boot);
  });

  it('registers fatal-error handlers before discoverAndStart()', () => {
    const boot = idx('.discoverAndStart()');
    expect(idx("process.on('uncaughtException'")).toBeLessThan(boot);
    expect(idx("process.on('unhandledRejection'")).toBeLessThan(boot);
  });

  it('registers all handlers before the IPC server starts', () => {
    const ipcStart = idx('.ipcServer.start()');
    expect(idx("process.on('SIGINT'")).toBeLessThan(ipcStart);
    expect(idx("process.on('SIGTERM'")).toBeLessThan(ipcStart);
    expect(idx("process.on('uncaughtException'")).toBeLessThan(ipcStart);
    expect(idx("process.on('unhandledRejection'")).toBeLessThan(ipcStart);
    expect(idx("process.on('exit'")).toBeLessThan(ipcStart);
  });
});
