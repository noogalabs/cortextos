import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { readMaxCrashesPerDay, notifyAgents, safeCrashCount } from '../../../src/hooks/hook-crash-alert';

describe('safeCrashCount NaN-guard (bug-hunt #8)', () => {
  // Mirrors AgentProcess.safeCrashCount. All four hook crash-count sites route
  // through this helper (same-day increment :212, read-only :224, cap compare
  // :263, display :319), so guaranteeing finite coercion here guarantees no
  // NaN reaches the writeback or the `crashCount < maxCrashes` cap comparison.

  it('valid numeric token parses unchanged', () => {
    expect(safeCrashCount('0')).toBe(0);
    expect(safeCrashCount('3')).toBe(3);
    expect(safeCrashCount('10')).toBe(10);
  });

  it('non-numeric token coerces to safe 0 (not NaN)', () => {
    expect(safeCrashCount('abc')).toBe(0);
    expect(Number.isFinite(safeCrashCount('abc'))).toBe(true);
  });

  it('undefined token (no colon in file) coerces to safe 0', () => {
    expect(safeCrashCount(undefined)).toBe(0);
    expect(Number.isFinite(safeCrashCount(undefined))).toBe(true);
  });

  it('empty string coerces to safe 0', () => {
    expect(safeCrashCount('')).toBe(0);
  });

  it('literal "NaN" token coerces to safe 0 (kills self-propagation)', () => {
    // The bug self-propagates by writing back `${today}:NaN`; on next read
    // parseInt("NaN") is NaN again. The guard breaks the cycle.
    expect(safeCrashCount('NaN')).toBe(0);
  });

  it('negative token coerces to safe 0', () => {
    expect(safeCrashCount('-5')).toBe(0);
  });

  it('same-day increment still accumulates for valid counts (interplay preserved)', () => {
    // Hook crash path is `safeCrashCount(count) + 1` when date === today.
    expect(safeCrashCount('3') + 1).toBe(4);
  });

  it('same-day increment of a garbage count is cap-safe first crash, not NaN', () => {
    // Garbage → 0 → 0 + 1 = 1, so the cap comparison stays meaningful and
    // counting resumes from a real number instead of writing back `:NaN`.
    expect(safeCrashCount('abc') + 1).toBe(1);
    expect(safeCrashCount(undefined) + 1).toBe(1);
  });
});


describe('readMaxCrashesPerDay', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when agentDir is undefined', () => {
    expect(readMaxCrashesPerDay(undefined)).toBeNull();
  });

  it('returns null when config.json is missing', () => {
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when config.json is malformed', () => {
    writeFileSync(join(tmp, 'config.json'), '{ not valid json', 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when max_crashes_per_day is missing', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ agent_name: 'x' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns the configured number when present', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 10 }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBe(10);
  });

  it('returns null when max_crashes_per_day is not a number', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 'ten' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });
});

describe('notifyAgents', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('sends one bus send-message per recipient', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'uncaught exception',
      lastTask: 'building hooks',
      crashCount: 2,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses cortextos bus send-message with priority high', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'r',
      lastTask: 't',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('cortextos');
    expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'chief', 'high']);
  });

  it('body includes all required fields', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'daemon-crashed',
      reason: 'PTY null write',
      lastTask: 'idle',
      crashCount: 3,
      restartAttempted: false,
      recipients: ['analyst'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('agent=dev');
    expect(body).toContain('type=daemon-crashed');
    expect(body).toContain('reason: PTY null write');
    expect(body).toContain('last status: idle');
    expect(body).toContain('crashes today: 3');
    expect(body).toContain('restart attempted: no');
  });

  it('marks restart attempted yes when crashCount under limit', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    expect(execFileMock.mock.calls[0][1][4]).toContain('restart attempted: yes');
  });

  it('uses fallback strings when reason and lastTask are empty', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('reason: none');
    expect(body).toContain('last status: unknown');
  });

  it('does not throw when execFile throws synchronously', () => {
    execFileMock.mockImplementationOnce(() => { throw new Error('exec failed'); });
    expect(() => notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    })).not.toThrow();
    // Second recipient still attempted
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
