/**
 * Fail-loud parity for `cortextos bus soft-restart-all` (sprint quality add).
 *
 * The command is a best-effort batch restart: it attempts every enabled agent,
 * then decides the process exit. A partial batch failure (some agents fail,
 * some succeed) must exit NON-ZERO so it is never reported as a full success —
 * matching the fail-loud pattern in #570/#562/#38. The decision lives in the
 * pure `softRestartAllExit` helper, tested here without IPC/fs mocks.
 */
import { describe, it, expect } from 'vitest';
import { softRestartAllExit } from '../../../src/cli/soft-restart-exit';

describe('soft-restart-all fail-loud exit decision', () => {
  it('exits 0 when all targets succeed', () => {
    const r = softRestartAllExit(0, 3);
    expect(r.exitCode).toBe(0);
    expect(r.error).toBeUndefined();
  });

  it('exits non-zero on a PARTIAL batch failure (some fail, some succeed)', () => {
    const r = softRestartAllExit(1, 3);
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain('1 of 3');
  });

  it('exits non-zero when ALL targets fail', () => {
    const r = softRestartAllExit(3, 3);
    expect(r.exitCode).toBe(1);
    expect(r.error).toContain('3 of 3');
  });
});
