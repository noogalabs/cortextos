import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateCronFire, readCronState, parseDurationMs } from '../../../src/bus/cron-state';
import * as lock from '../../../src/utils/lock';
import * as atomic from '../../../src/utils/atomic';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cron-state-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function cleanup() {
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
}

describe('parseDurationMs', () => {
  it('parses minutes', () => {
    expect(parseDurationMs('30m')).toBe(30 * 60_000);
  });

  it('parses hours', () => {
    expect(parseDurationMs('6h')).toBe(6 * 3_600_000);
    expect(parseDurationMs('24h')).toBe(24 * 3_600_000);
  });

  it('parses days', () => {
    expect(parseDurationMs('1d')).toBe(86_400_000);
  });

  it('parses weeks', () => {
    expect(parseDurationMs('2w')).toBe(2 * 604_800_000);
  });

  it('returns NaN for cron expressions', () => {
    expect(parseDurationMs('0 8 * * *')).toBeNaN();
    expect(parseDurationMs('*/5 * * * *')).toBeNaN();
  });

  it('returns NaN for empty string', () => {
    expect(parseDurationMs('')).toBeNaN();
  });

  it('returns NaN for unknown unit', () => {
    expect(parseDurationMs('5y')).toBeNaN();
    expect(parseDurationMs('10s')).toBeNaN();
  });
});

describe('readCronState', () => {
  it('returns empty state when file does not exist', () => {
    const state = readCronState(tmpDir);
    expect(state.crons).toEqual([]);
    cleanup();
  });
});

describe('updateCronFire', () => {
  it('creates a record when none exists', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const state = readCronState(tmpDir);
    expect(state.crons).toHaveLength(1);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBe('6h');
    expect(Date.parse(state.crons[0].last_fire)).not.toBeNaN();
    cleanup();
  });

  it('updates existing record for the same cron name', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const first = readCronState(tmpDir).crons[0].last_fire;

    // Ensure time advances
    const before = Date.now();
    updateCronFire(tmpDir, 'heartbeat', '6h');
    const second = readCronState(tmpDir).crons[0].last_fire;

    expect(Date.parse(second)).toBeGreaterThanOrEqual(before);
    expect(readCronState(tmpDir).crons).toHaveLength(1); // no duplicate
    cleanup();
  });

  it('accumulates records for different cron names', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    updateCronFire(tmpDir, 'autoresearch', '24h');
    const state = readCronState(tmpDir);
    expect(state.crons).toHaveLength(2);
    const names = state.crons.map(r => r.name);
    expect(names).toContain('heartbeat');
    expect(names).toContain('autoresearch');
    cleanup();
  });

  it('works without interval argument', () => {
    updateCronFire(tmpDir, 'heartbeat');
    const state = readCronState(tmpDir);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBeUndefined();
    cleanup();
  });

  it('survives a read-write-read cycle with correct values', () => {
    updateCronFire(tmpDir, 'inbox-triage', '2h');
    updateCronFire(tmpDir, 'heartbeat', '4h');
    const state = readCronState(tmpDir);
    const inbox = state.crons.find(r => r.name === 'inbox-triage');
    const hb = state.crons.find(r => r.name === 'heartbeat');
    expect(inbox?.interval).toBe('2h');
    expect(hb?.interval).toBe('4h');
    cleanup();
  });
});

// F10 — updateCronFire must serialize its read-modify-write under the
// per-agent stateDir lock and write atomically (tmp + rename), mirroring
// crons.ts. Without the lock, two concurrent callers can lose records;
// without the atomic write, a crash mid-write tears the file, which
// readCronState degrades to {crons: []} — wiping the catch-up reference.
describe('updateCronFire — locking + atomic write (F10)', () => {
  it('acquires the stateDir lock around the read-modify-write', () => {
    const withLock = vi.spyOn(lock, 'withFileLockSync');
    updateCronFire(tmpDir, 'heartbeat', '6h');
    expect(withLock).toHaveBeenCalled();
    expect(withLock.mock.calls.some(([dir]) => dir === tmpDir)).toBe(true);
    cleanup();
  });

  it('writes cron-state.json through atomicWriteSync', () => {
    const atomicWrite = vi.spyOn(atomic, 'atomicWriteSync');
    updateCronFire(tmpDir, 'heartbeat', '6h');
    expect(
      atomicWrite.mock.calls.some(([p]) => p === join(tmpDir, 'cron-state.json')),
    ).toBe(true);
    cleanup();
  });

  it('leaves no temp files and a cleanly parseable file behind', () => {
    updateCronFire(tmpDir, 'heartbeat', '6h');
    updateCronFire(tmpDir, 'autoresearch', '24h');
    const leftovers = readdirSync(tmpDir).filter(f => f.startsWith('.tmp.'));
    expect(leftovers).toEqual([]);
    const raw = readFileSync(join(tmpDir, 'cron-state.json'), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    // On-disk format unchanged: pretty-printed JSON + trailing newline.
    expect(raw.endsWith('\n')).toBe(true);
    cleanup();
  });

  it('a second writer cannot enter the critical section while the lock is held', () => {
    // Seed one record so a lost-update would be observable.
    updateCronFire(tmpDir, 'heartbeat', '6h');

    // Model the lost-update interleave deterministically (same shape as the
    // heartbeat-lost-update tests): writer A holds the stateDir lock; writer
    // B (a concurrent updateCronFire) must be refused entry, so it cannot
    // read a snapshot inside A's read→write window.
    lock.withFileLockSync(tmpDir, () => {
      expect(lock.acquireLock(tmpDir)).toBe(false);
    });

    // After A released, B's update applies cleanly and serially — both
    // records survive.
    updateCronFire(tmpDir, 'autoresearch', '24h');
    const state = readCronState(tmpDir);
    expect(state.crons.map(r => r.name).sort()).toEqual(['autoresearch', 'heartbeat']);
    cleanup();
  });

  it('interleaved updates to different crons never lose records', () => {
    for (let i = 0; i < 10; i++) {
      updateCronFire(tmpDir, `cron-${i % 3}`, '1h');
    }
    const state = readCronState(tmpDir);
    expect(state.crons).toHaveLength(3);
    expect(existsSync(join(tmpDir, 'cron-state.json'))).toBe(true);
    cleanup();
  });
});
