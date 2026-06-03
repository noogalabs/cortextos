import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { emitResult } from '../../../src/cli/bus';

/**
 * Unit tests for emitResult — the fails-loud result-envelope printer.
 *
 * Contract: signal failure ONLY on an unambiguous failure status ('error',
 * 'conflict', plus any caller-supplied extraFailStatuses such as
 * 'pii_detected'). Every other status — including valid non-success states
 * (up_to_date, ok, dry_run, empty, already_exists, installed, …), a status-less
 * object, and a bare array — must stay exit 0 so reads / idempotent ops don't
 * false-positive a cron's $? check.
 *
 * DRAIN-SAFE: emitResult sets `process.exitCode = 1` (NOT a raw process.exit)
 * so the top-level CLI completion routes through finalizeProcess(), draining
 * piped stdout before exit — a raw exit would truncate the $()-captured JSON
 * envelope. These tests assert process.exitCode rather than spying exit.
 */
describe('emitResult — fails-loud exit semantics (drain-safe)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let prevExitCode: number | string | undefined;

  beforeEach(() => {
    prevExitCode = process.exitCode;
    process.exitCode = 0; // deterministic baseline per case
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = prevExitCode;
  });

  it('always prints the result envelope', () => {
    emitResult({ status: 'ok', count: 3 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('"status": "ok"');
  });

  it('never calls a raw process.exit (drain-safety invariant)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => undefined) as never);
    emitResult({ status: 'error', error: 'boom' });
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("sets exitCode 1 on status 'error'", () => {
    emitResult({ status: 'error', error: 'boom' });
    expect(process.exitCode).toBe(1);
  });

  it("sets exitCode 1 on status 'conflict'", () => {
    emitResult({ status: 'conflict', message: 'merge conflict' });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    'up_to_date',
    'ok',
    'dry_run',
    'empty',
    'already_exists',
    'installed',
    'submitted',
    'contributed',
    'merged',
    'clean',
  ])("stays exitCode 0 on valid non-success status '%s' (no regression)", (status) => {
    emitResult({ status });
    expect(process.exitCode).toBe(0);
  });

  it('stays exitCode 0 on a no-status object', () => {
    emitResult({ count: 0, items: [] });
    expect(process.exitCode).toBe(0);
  });

  it('stays exitCode 0 on a bare array', () => {
    emitResult([{ id: 'a' }, { id: 'b' }]);
    expect(process.exitCode).toBe(0);
  });

  it('stays exitCode 0 on null / undefined', () => {
    emitResult(null);
    emitResult(undefined);
    expect(process.exitCode).toBe(0);
  });

  it("sets exitCode 1 on 'pii_detected' ONLY when supplied via extraFailStatuses (prepare-submission)", () => {
    emitResult({ status: 'pii_detected', piiFound: ['ssn'] });
    expect(process.exitCode).toBe(0);

    emitResult({ status: 'pii_detected', piiFound: ['ssn'] }, ['pii_detected']);
    expect(process.exitCode).toBe(1);
  });

  it("still sets exitCode 1 on 'error' even when extraFailStatuses is supplied", () => {
    emitResult({ status: 'error', error: 'x' }, ['pii_detected']);
    expect(process.exitCode).toBe(1);
  });
});
