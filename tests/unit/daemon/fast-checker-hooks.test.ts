// Regression coverage for the RFC #15 Day-1 dispatcher integration in FastChecker.
// Pairs with the framework-side coverage at tests/unit/bus/hooks.test.ts and
// tests/integration/bus/hook-flow.test.ts. Specifically tests the consumer
// side: boot wiring of registerBuiltInHandlers, CTX_ORG validation gate, the
// hot-reload watcher attach, and the eventLogTailTick byte-counting behavior.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('child_process', () => ({ exec: vi.fn(), execFile: vi.fn() }));
vi.mock('../../../src/bus/message.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bus/message.js')>();
  return { ...actual, sendMessage: vi.fn() };
});
vi.mock('../../../src/slack/api.js', () => ({
  SlackAPI: vi.fn().mockImplementation(function () {
    return {
      getHistory: vi.fn(),
      getUserName: vi.fn().mockResolvedValue('Test User'),
      postMessage: vi.fn(),
    };
  }),
}));

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastChecker } from '../../../src/daemon/fast-checker';
import {
  clearHandlerRegistry,
  _getRegisteredHandler,
} from '../../../src/bus/hooks';
import type { BusPaths } from '../../../src/types';

function createMockAgent(name = 'test-agent') {
  return {
    name,
    isBootstrapped: vi.fn().mockReturnValue(true),
    injectMessage: vi.fn().mockReturnValue(true),
    write: vi.fn(),
    getOutputBuffer: vi.fn().mockReturnValue({ getRecent: () => '' }),
    getConfig: vi.fn().mockReturnValue({}),
  } as any;
}

function createTestPaths(testDir: string): BusPaths {
  const paths: BusPaths = {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox'),
    inflight: join(testDir, 'inflight'),
    processed: join(testDir, 'processed'),
    logDir: join(testDir, 'logs'),
    stateDir: join(testDir, 'state'),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
  for (const dir of Object.values(paths)) {
    if (dir !== testDir) mkdirSync(dir, { recursive: true });
  }
  return paths;
}

// Minimal hooks.json fixture matching one log_event hook on category=action,type=test_event.
function writeHooksJson(orgDir: string): void {
  mkdirSync(orgDir, { recursive: true });
  const hooks = {
    schema_version: '0.1',
    hooks: [
      {
        id: 'h-test',
        event_pattern: { category: 'action', type: 'test_event' },
        handler_type: 'log_event',
        handler: { category: 'action', type: 'test_event_logged', severity: 'info', meta: {} },
        agent_filter: [],
        priority: 100,
        enabled: true,
      },
    ],
  };
  writeFileSync(join(orgDir, 'hooks.json'), JSON.stringify(hooks));
}

describe('FastChecker — RFC #15 Day-1 dispatcher integration', () => {
  let testDir: string;
  let frameworkRoot: string;
  let paths: BusPaths;
  const ORIGINAL_CTX_ORG = process.env.CTX_ORG;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-fc-hooks-'));
    frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-fr-'));
    paths = createTestPaths(testDir);
    clearHandlerRegistry();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(frameworkRoot, { recursive: true, force: true });
    if (ORIGINAL_CTX_ORG === undefined) delete process.env.CTX_ORG;
    else process.env.CTX_ORG = ORIGINAL_CTX_ORG;
    clearHandlerRegistry();
  });

  it('startHookDispatcher wires registerBuiltInHandlers — log_event handler is registered after boot', () => {
    const orgDir = join(frameworkRoot, 'orgs', 'testorg');
    writeHooksJson(orgDir);
    process.env.CTX_ORG = 'testorg';

    const checker = new FastChecker(createMockAgent(), paths, frameworkRoot) as unknown as {
      startHookDispatcher: () => void;
    };
    checker.startHookDispatcher();

    expect(_getRegisteredHandler('log_event')).toBeTruthy();
    expect(_getRegisteredHandler('bash')).toBeTruthy();
    expect(_getRegisteredHandler('send_message')).toBeTruthy();
    expect(_getRegisteredHandler('webhook')).toBeTruthy();
  });

  it('startHookDispatcher rejects path-traversal CTX_ORG — validateOrgName gates load', () => {
    process.env.CTX_ORG = '../../etc';
    const logSpy = vi.fn();
    const checker = new FastChecker(createMockAgent(), paths, frameworkRoot, { log: logSpy }) as unknown as {
      startHookDispatcher: () => void;
      hookRegistry: { hooks: unknown[] };
      hookRegistryPath: string;
      hookOrg: string | null;
    };
    checker.startHookDispatcher();

    // Disabled-due-to-invalid-CTX_ORG log line emitted; registry stays empty.
    expect(logSpy).toHaveBeenCalled();
    const logged = logSpy.mock.calls.flat().join(' ');
    expect(logged).toMatch(/invalid CTX_ORG|disabled/i);
    expect(checker.hookRegistry.hooks).toEqual([]);
    expect(checker.hookRegistryPath).toBe('');
    expect(checker.hookOrg).toBeNull();
    // No handlers registered when dispatcher is disabled at the org-validation gate.
    expect(_getRegisteredHandler('log_event')).toBeUndefined();
  });

  it('startHookDispatcher attaches hot-reload watcher when hooks.json exists at boot', () => {
    const orgDir = join(frameworkRoot, 'orgs', 'testorg');
    writeHooksJson(orgDir);
    process.env.CTX_ORG = 'testorg';

    const checker = new FastChecker(createMockAgent(), paths, frameworkRoot) as unknown as {
      startHookDispatcher: () => void;
      hookRegistryWatcher: unknown;
      hookRegistry: { hooks: unknown[] };
    };
    checker.startHookDispatcher();

    expect(checker.hookRegistryWatcher).not.toBeNull();
    expect(checker.hookRegistry.hooks).toHaveLength(1);

    // Cleanup the watcher so the test process can exit.
    const watcher = checker.hookRegistryWatcher as { close?: () => void };
    if (watcher && typeof watcher.close === 'function') watcher.close();
  });

  it('eventLogTailTick advances eventLogPosition by actual bytes read and processes new lines', () => {
    const orgDir = join(frameworkRoot, 'orgs', 'testorg');
    writeHooksJson(orgDir);
    process.env.CTX_ORG = 'testorg';

    const agent = createMockAgent();
    const checker = new FastChecker(agent, paths, frameworkRoot) as unknown as {
      startHookDispatcher: () => void;
      eventLogTailTick: () => void;
      eventLogPosition: number;
      eventLogCurrentPath: string;
      hookRegistry: { hooks: Array<{ id: string }> };
    };
    checker.startHookDispatcher();
    expect(checker.hookRegistry.hooks).toHaveLength(1);

    // Compute the path the tailer is watching, then write a single matching event.
    const today = new Date().toISOString().split('T')[0];
    const eventsDir = join(paths.analyticsDir, 'events', agent.name);
    mkdirSync(eventsDir, { recursive: true });
    const eventLogPath = join(eventsDir, `${today}.jsonl`);
    const event1 = JSON.stringify({
      id: 'evt-1',
      agent: agent.name,
      org: 'testorg',
      timestamp: new Date().toISOString(),
      category: 'action',
      event: 'test_event',
      severity: 'info',
      metadata: {},
    });
    writeFileSync(eventLogPath, event1 + '\n');

    // Force tailer to point at this path (computeEventLogPath is private).
    (checker as unknown as { eventLogCurrentPath: string }).eventLogCurrentPath = eventLogPath;
    (checker as unknown as { eventLogPosition: number }).eventLogPosition = 0;

    checker.eventLogTailTick();
    const posAfterFirst = checker.eventLogPosition;
    expect(posAfterFirst).toBeGreaterThan(0);
    expect(posAfterFirst).toBe(Buffer.byteLength(event1 + '\n', 'utf-8'));

    // Append a second line, tick again, position must advance by exactly the new bytes.
    const event2 = JSON.stringify({
      id: 'evt-2',
      agent: agent.name,
      org: 'testorg',
      timestamp: new Date().toISOString(),
      category: 'action',
      event: 'test_event',
      severity: 'info',
      metadata: {},
    });
    appendFileSync(eventLogPath, event2 + '\n');
    checker.eventLogTailTick();
    expect(checker.eventLogPosition).toBe(
      Buffer.byteLength(event1 + '\n' + event2 + '\n', 'utf-8'),
    );
  });
});
