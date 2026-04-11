/**
 * CLI-level tests for `cortextos bus kb-ingest-chunked`.
 *
 * Verifies that the CLI action handler:
 *   1. Exits non-zero when ingestKnowledgeBaseChunked returns a partial
 *      failure (matches the existing kb-ingest contract so callers can
 *      detect partial success via exit code and re-run for dedup recovery).
 *   2. Lets deterministic setup errors (e.g. scope private without agent)
 *      propagate as hard failures — they must NOT be swallowed by the
 *      CLI layer, mirroring the sibling `kb-ingest` command's behavior
 *      where ingestKnowledgeBase() throws straight through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the knowledge-base module BEFORE busCommand imports it, so the
// commander action wiring calls our stubs instead of the real subprocess
// machinery. All four exports used by bus.ts are stubbed.
const ingestKnowledgeBaseMock = vi.fn();
const ingestKnowledgeBaseChunkedMock = vi.fn();
const ensureKBDirsMock = vi.fn();
const queryKnowledgeBaseMock = vi.fn();

vi.mock('../../../src/bus/knowledge-base.js', () => ({
  ingestKnowledgeBase: ingestKnowledgeBaseMock,
  ingestKnowledgeBaseChunked: ingestKnowledgeBaseChunkedMock,
  ensureKBDirs: ensureKBDirsMock,
  queryKnowledgeBase: queryKnowledgeBaseMock,
}));

// Import AFTER the mock is installed.
const { busCommand } = await import('../../../src/cli/bus.js');

describe('cortextos bus kb-ingest-chunked CLI', () => {
  beforeEach(() => {
    ingestKnowledgeBaseMock.mockReset();
    ingestKnowledgeBaseChunkedMock.mockReset();
    ensureKBDirsMock.mockReset();
    queryKnowledgeBaseMock.mockReset();
    // resolveEnv reads CTX_ORG; make sure an org is present so the
    // command does not bail out on its "--org required" guard.
    process.env.CTX_ORG = 'acme';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CTX_ORG;
  });

  it('exits 0 when all batches succeed', async () => {
    ingestKnowledgeBaseChunkedMock.mockReturnValue({
      totalFiles: 5,
      totalBatches: 1,
      successFiles: 5,
      failedFiles: 0,
      successBatches: 1,
      failedBatches: [],
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);

    await busCommand.parseAsync([
      'node', 'cli', 'kb-ingest-chunked',
      '/fake/a.md', '/fake/b.md',
      '--org', 'acme',
      '--scope', 'shared',
    ]);

    // Clean runs must NOT call process.exit at all.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(ingestKnowledgeBaseChunkedMock).toHaveBeenCalledTimes(1);
  });

  it('exits non-zero when ingestKnowledgeBaseChunked reports a partial failure', async () => {
    ingestKnowledgeBaseChunkedMock.mockReturnValue({
      totalFiles: 50,
      totalBatches: 2,
      successFiles: 25,
      failedFiles: 25,
      successBatches: 1,
      failedBatches: [2],
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);

    await expect(
      busCommand.parseAsync([
        'node', 'cli', 'kb-ingest-chunked',
        '/fake/a.md', '/fake/b.md',
        '--org', 'acme',
        '--scope', 'shared',
      ]),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('lets deterministic setup errors propagate as hard failures (parity with kb-ingest)', async () => {
    // Simulate the real preflight behavior: scope=private without agent
    // throws from inside ingestKnowledgeBaseChunked. The CLI must NOT
    // swallow it and must NOT convert it into a silent exit(1) — the
    // error should surface through commander just like kb-ingest does.
    ingestKnowledgeBaseChunkedMock.mockImplementation(() => {
      throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);

    await expect(
      busCommand.parseAsync([
        'node', 'cli', 'kb-ingest-chunked',
        '/fake/a.md',
        '--org', 'acme',
        '--scope', 'private',
        // --agent intentionally omitted
      ]),
    ).rejects.toThrow(/--agent.*--scope private/);

    // process.exit must NOT have been called — the thrown error propagated
    // up through commander, which is the parity behavior we want.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('propagates the same setup error shape as the sibling kb-ingest command', async () => {
    // Verify parity: kb-ingest also lets the setup error throw through.
    // Both should reject the same way for the same misconfiguration.
    ingestKnowledgeBaseMock.mockImplementation(() => {
      throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    });
    ingestKnowledgeBaseChunkedMock.mockImplementation(() => {
      throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);

    const siblingReject = busCommand
      .parseAsync([
        'node', 'cli', 'kb-ingest',
        '/fake/a.md',
        '--org', 'acme',
        '--scope', 'private',
      ])
      .catch((e: Error) => e);

    const chunkedReject = busCommand
      .parseAsync([
        'node', 'cli', 'kb-ingest-chunked',
        '/fake/a.md',
        '--org', 'acme',
        '--scope', 'private',
      ])
      .catch((e: Error) => e);

    const [siblingErr, chunkedErr] = await Promise.all([siblingReject, chunkedReject]);

    expect(siblingErr).toBeInstanceOf(Error);
    expect(chunkedErr).toBeInstanceOf(Error);
    expect((siblingErr as Error).message).toMatch(/--agent.*--scope private/);
    expect((chunkedErr as Error).message).toMatch(/--agent.*--scope private/);
    // Neither command should have silently exited — errors must propagate.
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
