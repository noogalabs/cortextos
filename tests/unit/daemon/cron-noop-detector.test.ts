import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import {
  CronNoopDetector,
  cronFireSalt,
  resolveClaudeTranscriptPath,
  transcriptContainsCronTurn,
} from '../../../src/daemon/cron-noop-detector.js';
import type { AgentConfig, CronExecutionLogEntry } from '../../../src/types/index.js';

function transcriptLine(timestamp: string, content: unknown): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    timestamp,
  }) + '\n';
}

describe('cron-noop-detector transcript lookup', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cron-noop-transcript-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('resolves the most recently modified Claude JSONL transcript using the canonical project path', () => {
    const launchDir = join(testDir, 'agent-dir');
    const convDir = join(testDir, '.claude', 'projects', launchDir.split(sep).join('-'));
    mkdirSync(convDir, { recursive: true });
    const lexicallyLast = join(convDir, 'z.jsonl');
    const newestByMtime = join(convDir, 'a.jsonl');
    writeFileSync(lexicallyLast, '');
    writeFileSync(newestByMtime, '');
    utimesSync(lexicallyLast, new Date('2026-06-17T11:00:00.000Z'), new Date('2026-06-17T11:00:00.000Z'));
    utimesSync(newestByMtime, new Date('2026-06-17T12:00:00.000Z'), new Date('2026-06-17T12:00:00.000Z'));

    expect(resolveClaudeTranscriptPath({}, launchDir, testDir)).toBe(newestByMtime);
  });

  it('matches salted cron turns when message.content is a block array', () => {
    const firedAt = '2026-06-17T12:00:00.000Z';
    const salt = cronFireSalt(firedAt, 'heartbeat');
    const transcript = join(testDir, 'session.jsonl');
    writeFileSync(
      transcript,
      transcriptLine('2026-06-17T12:00:01.000Z', [
        { type: 'text', text: `prefix ${salt}: Read HEARTBEAT.md` },
      ]),
    );

    expect(transcriptContainsCronTurn(transcript, salt, firedAt).found).toBe(true);
  });
});

describe('CronNoopDetector', () => {
  const verifyDelayMs = 1_000;
  const agentName = 'alice';
  const cronName = 'heartbeat';
  const agentDir = '/tmp/alice';
  const config: AgentConfig = { runtime: 'claude-code' };
  let logs: CronExecutionLogEntry[];
  let events: Array<{ event: string; severity: string; meta: Record<string, unknown> }>;
  let notifications: string[];
  let injects: string[];
  let transcriptPath: string | null;
  let status: 'running' | 'starting';

  function makeDetector(): CronNoopDetector {
    return new CronNoopDetector({
      verifyDelayMs,
      appendExecutionLog: (_agent, entry) => logs.push(entry),
      emitEvent: (_agent, event, severity, meta) => events.push({ event, severity, meta }),
      getStatus: () => ({ name: agentName, status }),
      inject: (_agent, text) => {
        injects.push(text);
        return { ok: true };
      },
      notifyOrchestrator: (_agent, text) => notifications.push(text),
      transcriptPathFor: () => transcriptPath,
      now: () => new Date(),
    });
  }

  function register(detector: CronNoopDetector, firedAt = '2026-06-17T12:00:00.000Z'): string {
    detector.registerFire({
      agentName,
      agentDir,
      config,
      cronName,
      prompt: 'Read HEARTBEAT.md',
      firedAt,
    });
    return cronFireSalt(firedAt, cronName);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T12:00:00.000Z'));
    logs = [];
    events = [];
    notifications = [];
    injects = [];
    transcriptPath = null;
    status = 'running';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('found path logs confirmed and does not re-inject', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'cron-noop-found-'));
    try {
      const firedAt = '2026-06-17T12:00:00.000Z';
      const salt = cronFireSalt(firedAt, cronName);
      transcriptPath = join(testDir, 'session.jsonl');
      writeFileSync(transcriptPath, transcriptLine('2026-06-17T12:00:02.000Z', `${salt}: Read HEARTBEAT.md`));

      register(makeDetector(), firedAt);
      await vi.advanceTimersByTimeAsync(verifyDelayMs);

      expect(logs.map((l) => l.status)).toEqual(['confirmed']);
      expect(injects).toHaveLength(0);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('noop path logs unconfirmed then performs exactly one re-inject', async () => {
    register(makeDetector());

    await vi.advanceTimersByTimeAsync(verifyDelayMs);
    await vi.advanceTimersByTimeAsync(verifyDelayMs);

    expect(logs.map((l) => l.status)).toEqual(['noop_unconfirmed', 'noop_reinjected']);
    expect(events.map((e) => e.event)).toEqual(['cron_fire_unconfirmed', 'cron_fire_reinjected']);
    expect(injects).toHaveLength(1);
  });

  it('busy then late path confirms on second window with zero re-injects', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'cron-noop-late-'));
    try {
      const firedAt = '2026-06-17T12:00:00.000Z';
      const salt = cronFireSalt(firedAt, cronName);
      transcriptPath = join(testDir, 'session.jsonl');
      writeFileSync(transcriptPath, '');
      register(makeDetector(), firedAt);

      await vi.advanceTimersByTimeAsync(verifyDelayMs);
      writeFileSync(transcriptPath, transcriptLine('2026-06-17T12:00:01.500Z', `${salt}: Read HEARTBEAT.md`));
      await vi.advanceTimersByTimeAsync(verifyDelayMs);

      expect(logs.map((l) => l.status)).toEqual(['noop_unconfirmed', 'confirmed']);
      expect(injects).toHaveLength(0);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('escalates persistent no-op after one re-inject also misses both windows', async () => {
    register(makeDetector());

    await vi.advanceTimersByTimeAsync(verifyDelayMs);
    await vi.advanceTimersByTimeAsync(verifyDelayMs);
    await vi.advanceTimersByTimeAsync(verifyDelayMs);
    await vi.advanceTimersByTimeAsync(verifyDelayMs);

    expect(injects).toHaveLength(1);
    expect(logs.map((l) => l.status)).toEqual([
      'noop_unconfirmed',
      'noop_reinjected',
      'noop_unconfirmed',
      'noop_persistent',
    ]);
    expect(events.map((e) => e.event)).toEqual([
      'cron_fire_unconfirmed',
      'cron_fire_reinjected',
      'cron_fire_unconfirmed',
      'cron_fire_noop_persistent',
    ]);
    expect(notifications).toHaveLength(1);
  });

  it('re-inject uses a fresh salt so MessageDedup will not collapse it', async () => {
    const originalSalt = register(makeDetector(), '2026-06-17T12:00:00.000Z');

    await vi.advanceTimersByTimeAsync(verifyDelayMs);
    await vi.advanceTimersByTimeAsync(verifyDelayMs);

    expect(injects).toHaveLength(1);
    expect(injects[0]).toContain('[CRON FIRED 2026-06-17T12:00:02.000Z] heartbeat');
    expect(injects[0]).not.toContain(originalSalt);
  });

  it('skips codex and hermes runtimes without registering timers', async () => {
    const detector = makeDetector();
    detector.registerFire({
      agentName,
      agentDir,
      config: { runtime: 'codex-app-server' },
      cronName,
      prompt: 'Read HEARTBEAT.md',
      firedAt: '2026-06-17T12:00:00.000Z',
    });
    detector.registerFire({
      agentName,
      agentDir,
      config: { runtime: 'hermes' },
      cronName,
      prompt: 'Read HEARTBEAT.md',
      firedAt: '2026-06-17T12:00:00.000Z',
    });

    await vi.advanceTimersByTimeAsync(verifyDelayMs * 3);

    expect(logs).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(injects).toHaveLength(0);
  });
});
