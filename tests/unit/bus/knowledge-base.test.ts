import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock child_process.execFileSync so the tests never actually spawn mmrag.py.
// By default the mock succeeds (simulating an OK ingest). Individual tests
// override behavior per-call to simulate failures.
const runFileSyncMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => runFileSyncMock(...args),
  };
});

// Import AFTER the mock is installed so the module binds to the mocked
// function rather than the real one.
const { ingestKnowledgeBase, ingestKnowledgeBaseChunked } = await import(
  '../../../src/bus/knowledge-base.js'
);

describe('ingestKnowledgeBaseChunked', () => {
  let frameworkRoot: string;
  let instanceId: string;

  beforeEach(() => {
    // Create an isolated fake framework root with the bits buildKBEnv touches
    // (a missing .env / secrets.env are tolerated — loadSecretsEnv just skips).
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-kb-chunked-'));
    mkdirSync(join(frameworkRoot, 'orgs', 'acme'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'knowledge-base', 'scripts'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'knowledge-base', 'venv', 'bin'), { recursive: true });
    // Stub a fake python3 so getVenvPython() resolves to something on disk.
    writeFileSync(join(frameworkRoot, 'knowledge-base', 'venv', 'bin', 'python3'), '');
    writeFileSync(join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py'), '');
    instanceId = 'test-instance';
    runFileSyncMock.mockReset();
    // Default: subprocess succeeds silently
    runFileSyncMock.mockReturnValue('');
  });

  afterEach(() => {
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  const baseOptions = () => ({
    org: 'acme',
    scope: 'shared' as const,
    frameworkRoot,
    instanceId,
  });

  it('handles empty input without spawning the subprocess', () => {
    const result = ingestKnowledgeBaseChunked([], baseOptions());

    expect(result).toEqual({
      totalFiles: 0,
      totalBatches: 0,
      successFiles: 0,
      failedFiles: 0,
      successBatches: 0,
      failedBatches: [],
    });
    expect(runFileSyncMock).not.toHaveBeenCalled();
  });

  it('runs a single batch when file count fits in one batch', () => {
    const paths = Array.from({ length: 10 }, (_, i) => `/fake/file-${i}.md`);

    const result = ingestKnowledgeBaseChunked(paths, {
      ...baseOptions(),
      batchSize: 25,
    });

    expect(result.totalFiles).toBe(10);
    expect(result.totalBatches).toBe(1);
    expect(result.successFiles).toBe(10);
    expect(result.failedFiles).toBe(0);
    expect(result.successBatches).toBe(1);
    expect(result.failedBatches).toEqual([]);
    expect(runFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('splits across multiple batches when file count exceeds batch size', () => {
    const paths = Array.from({ length: 60 }, (_, i) => `/fake/file-${i}.md`);

    const result = ingestKnowledgeBaseChunked(paths, {
      ...baseOptions(),
      batchSize: 25,
    });

    // 60 files / 25 batchSize = 3 batches (25 + 25 + 10)
    expect(result.totalFiles).toBe(60);
    expect(result.totalBatches).toBe(3);
    expect(result.successFiles).toBe(60);
    expect(result.successBatches).toBe(3);
    expect(result.failedBatches).toEqual([]);
    expect(runFileSyncMock).toHaveBeenCalledTimes(3);
  });

  it('uses the default batch size of 25 when not specified', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `/fake/file-${i}.md`);

    const result = ingestKnowledgeBaseChunked(paths, baseOptions());

    expect(result.totalBatches).toBe(2);
    expect(runFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it('continues after a batch failure and records the failed batch number', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `/fake/file-${i}.md`);

    // First call (batch 1) succeeds, second call (batch 2) throws
    runFileSyncMock
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        const err = new Error('spawnSync python3 ETIMEDOUT') as Error & { code?: string };
        err.code = 'ETIMEDOUT';
        throw err;
      });

    const result = ingestKnowledgeBaseChunked(paths, {
      ...baseOptions(),
      batchSize: 25,
    });

    expect(result.totalBatches).toBe(2);
    expect(result.successBatches).toBe(1);
    expect(result.failedBatches).toEqual([2]);
    expect(result.successFiles).toBe(25);
    // Second batch is 5 files (30 - 25); upper-bound the failed count.
    expect(result.failedFiles).toBe(5);
    expect(runFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it('records multiple failed batches without stopping the loop', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `/fake/file-${i}.md`);

    // Batches 1, 3, 5 succeed; batches 2, 4 fail
    let callCount = 0;
    runFileSyncMock.mockImplementation(() => {
      callCount += 1;
      if (callCount === 2 || callCount === 4) {
        throw new Error(`batch ${callCount} simulated failure`);
      }
      return '';
    });

    const result = ingestKnowledgeBaseChunked(paths, {
      ...baseOptions(),
      batchSize: 10,
    });

    expect(result.totalBatches).toBe(5);
    expect(result.successBatches).toBe(3);
    expect(result.failedBatches).toEqual([2, 4]);
    expect(result.successFiles).toBe(30);
    expect(result.failedFiles).toBe(20);
  });

  it('clamps a non-positive batchSize to the default (25)', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `/fake/file-${i}.md`);

    const result = ingestKnowledgeBaseChunked(paths, {
      ...baseOptions(),
      batchSize: 0,
    });

    // 0 would be an infinite loop; the impl must clamp to 25.
    expect(result.totalBatches).toBe(2);
    expect(result.successFiles).toBe(30);
  });

  it('passes through ingest options (scope, force) to each batch call', () => {
    const paths = Array.from({ length: 5 }, (_, i) => `/fake/file-${i}.md`);

    ingestKnowledgeBaseChunked(paths, {
      ...baseOptions(),
      scope: 'shared',
      force: true,
      batchSize: 25,
    });

    // Inspect the args passed to the subprocess — we should see the --force
    // flag in the mmrag.py argv for the single batch call.
    expect(runFileSyncMock).toHaveBeenCalledTimes(1);
    const callArgs = runFileSyncMock.mock.calls[0];
    // callArgs[0] = python path, callArgs[1] = argv array, callArgs[2] = options
    const argv = callArgs[1] as string[];
    expect(argv).toContain('ingest');
    expect(argv).toContain('--collection');
    expect(argv).toContain('shared-acme');
    expect(argv).toContain('--force');
  });

  it('throws a setup error for scope private without agent (no batch loop)', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `/fake/file-${i}.md`);

    // A deterministic config error must surface as a thrown exception from
    // the preflight, NOT be swallowed and converted into N fake batch
    // failures that count all files as failed.
    expect(() =>
      ingestKnowledgeBaseChunked(paths, {
        ...baseOptions(),
        scope: 'private',
        // agent intentionally omitted
        batchSize: 10,
      }),
    ).toThrow(/--agent.*required.*--scope private/);

    // Subprocess must never be invoked when the preflight rejects.
    expect(runFileSyncMock).not.toHaveBeenCalled();
  });

  it('does not throw on scope private when agent is provided', () => {
    const paths = Array.from({ length: 10 }, (_, i) => `/fake/file-${i}.md`);

    const result = ingestKnowledgeBaseChunked(paths, {
      ...baseOptions(),
      scope: 'private',
      agent: 'alice',
      batchSize: 25,
    });

    expect(result.totalBatches).toBe(1);
    expect(result.successFiles).toBe(10);
    expect(runFileSyncMock).toHaveBeenCalledTimes(1);
    // Private scope maps to the agent-<name> collection.
    const argv = runFileSyncMock.mock.calls[0][1] as string[];
    expect(argv).toContain('agent-alice');
  });

  it('ingestKnowledgeBase and ingestKnowledgeBaseChunked reject identically for the same misconfig', () => {
    // Genuine parity check: no manufactured mocks on the rejection path.
    // Both functions hit their own real preflight code and must produce
    // the same concrete Error for a --scope private missing agent config.
    const paths = ['/fake/a.md'];

    let nonChunkedErr: unknown;
    try {
      ingestKnowledgeBase(paths, {
        ...baseOptions(),
        scope: 'private',
        // agent intentionally omitted
      });
    } catch (e) {
      nonChunkedErr = e;
    }

    let chunkedErr: unknown;
    try {
      ingestKnowledgeBaseChunked(paths, {
        ...baseOptions(),
        scope: 'private',
        // agent intentionally omitted
        batchSize: 25,
      });
    } catch (e) {
      chunkedErr = e;
    }

    expect(nonChunkedErr).toBeInstanceOf(Error);
    expect(chunkedErr).toBeInstanceOf(Error);
    // Same concrete error message from the same real preflight code path.
    // The chunked variant uses the identical string as its sibling so users
    // see consistent feedback regardless of which ingest command they run.
    expect((nonChunkedErr as Error).message).toBe((chunkedErr as Error).message);
    expect((nonChunkedErr as Error).message).toMatch(/--agent.*--scope private/);
    // Neither variant invoked the subprocess — preflight caught both.
    expect(runFileSyncMock).not.toHaveBeenCalled();
  });
});
