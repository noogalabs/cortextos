/**
 * CLI-level tests for `cortextos bus kb-ingest-chunked`.
 *
 * Seam philosophy: these tests mock at the subprocess boundary
 * (child_process.execFileSync) so the REAL ingestKnowledgeBase and
 * ingestKnowledgeBaseChunked implementations run inside the CLI action.
 * No mocks on the knowledge-base module itself.
 *
 * Scope: these tests cover CLI-specific behavior — how the commander
 * action translates function results into exit codes. The parity +
 * setup-error-propagation invariants are verified at the function
 * level in tests/unit/bus/knowledge-base.test.ts, not here: the CLI
 * action resolves `agent` from CTX_AGENT_NAME when --agent is omitted
 * (fallback to basename(cwd)), so the `scope private without agent`
 * misconfig is not reachable through the CLI wiring — env always fills
 * in a default agent. Testing the setup-error path at the CLI level
 * would require mocking resolveEnv, at which point it is no longer a
 * genuine end-to-end test. Function-level coverage is the right seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// Mock ONLY child_process.execFileSync so the real bus/knowledge-base
// module runs end-to-end through the CLI action.
const runFileSyncMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => runFileSyncMock(...args),
  };
});

// Import AFTER the mock is installed so busCommand's transitive import
// of child_process binds to the mocked function.
const { busCommand } = await import('../../../src/cli/bus.js');

describe('cortextos bus kb-ingest-chunked CLI', () => {
  let frameworkRoot: string;
  let testInstanceId: string;
  let kbRoot: string;

  beforeEach(() => {
    // Fake framework root with the venv bits getVenvPython() resolves to
    // and a stub mmrag.py so the real ingest path can build its argv.
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-kb-cli-fw-'));
    mkdirSync(join(frameworkRoot, 'knowledge-base', 'venv', 'bin'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'knowledge-base', 'scripts'), { recursive: true });
    writeFileSync(join(frameworkRoot, 'knowledge-base', 'venv', 'bin', 'python3'), '');
    writeFileSync(join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py'), '');

    // Unique instance id per test run so the real mkdirSync in ensureKBDirs
    // writes to a predictable tmpdir path we can clean up in afterEach.
    // resolveEnv hardcodes ~/.cortextos/<instanceId> — we use a dedicated
    // test-only instance id and rm it after.
    testInstanceId = `test-kb-cli-${process.pid}-${Date.now()}`;
    kbRoot = join(homedir(), '.cortextos', testInstanceId);

    process.env.CTX_ORG = 'acme';
    process.env.CTX_INSTANCE_ID = testInstanceId;
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;

    runFileSyncMock.mockReset();
    // Default: subprocess returns empty string (success).
    runFileSyncMock.mockReturnValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(frameworkRoot, { recursive: true, force: true });
    if (existsSync(kbRoot)) rmSync(kbRoot, { recursive: true, force: true });
    delete process.env.CTX_ORG;
    delete process.env.CTX_INSTANCE_ID;
    delete process.env.CTX_FRAMEWORK_ROOT;
  });

  it('exits 0 when all batches succeed', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);

    await busCommand.parseAsync([
      'node', 'cli', 'kb-ingest-chunked',
      '/fake/a.md', '/fake/b.md',
      '--org', 'acme',
      '--scope', 'shared',
    ]);

    expect(exitSpy).not.toHaveBeenCalled();
    // Real chunked function ran and invoked subprocess (one batch, 2 files).
    expect(runFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('exits non-zero when one batch fails (real chunked loop, mocked subprocess)', async () => {
    // 10 files at batch-size 5 → 2 batches. First succeeds, second throws.
    runFileSyncMock
      .mockReturnValueOnce('')
      .mockImplementationOnce(() => {
        throw new Error('spawnSync python3 ETIMEDOUT');
      });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);

    const paths = Array.from({ length: 10 }, (_, i) => `/fake/file-${i}.md`);

    await expect(
      busCommand.parseAsync([
        'node', 'cli', 'kb-ingest-chunked',
        ...paths,
        '--org', 'acme',
        '--scope', 'shared',
        '--batch-size', '5',
      ]),
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Both batches were attempted despite the failure.
    expect(runFileSyncMock).toHaveBeenCalledTimes(2);
  });
});
