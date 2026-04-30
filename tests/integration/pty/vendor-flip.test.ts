// Integration test for the vendor-adapter routing in AgentPTY.spawn().
// Mocks node-pty so no real binaries (claude/codex/gemini) are spawned.
// Asserts that the binary, args, and env passed to the underlying spawn fn
// match what the configured vendor adapter produces.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(() => ({
    pid: 99,
    write: () => undefined,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    kill: () => undefined,
    resize: () => undefined,
  })),
}));

vi.mock('node-pty', () => ({ spawn: mocks.spawn }));

// Skip secrets.env / agent .env file loading so test env is hermetic.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

import type { AgentConfig, CtxEnv } from '../../../src/types/index';

const TEST_ENV: CtxEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'test-agent',
  org: 'test-org',
  agentDir: '/tmp/fw/orgs/test-org/agents/test-agent',
  projectRoot: '/tmp/fw',
};

const PRESERVED_CLAUDE_VAR = 'CLAUDE_API_KEY';
const PRESERVED_CLAUDE_VALUE = 'sk-claude-test-fixture';

beforeEach(() => {
  mocks.spawn.mockClear();
  // Inject a CLAUDE_* var into process.env so getBaseEnv's keepVars list
  // copies it into ptyEnv. The adapter's envFilter is what we're verifying.
  process.env[PRESERVED_CLAUDE_VAR] = PRESERVED_CLAUDE_VALUE;
});

afterEach(() => {
  delete process.env[PRESERVED_CLAUDE_VAR];
});

function spawnAndCapture(config: AgentConfig, mode: 'fresh' | 'continue' = 'fresh', prompt = 'hi') {
  const pty = new AgentPTY(TEST_ENV, config);
  // Inject the spawn mock directly onto the private field — bypasses
  // the lazy `require('node-pty')` inside AgentPTY.spawn(), which
  // vitest's CJS mock interception does not always intercept reliably.
  (pty as unknown as { spawnFn: unknown }).spawnFn = mocks.spawn;
  return pty.spawn(mode, prompt).then(() => {
    const call = mocks.spawn.mock.calls[0];
    return {
      binary: call[0] as string,
      args: call[1] as string[],
      env: (call[2] as { env: Record<string, string> }).env,
    };
  });
}

describe('AgentPTY vendor flip — binary + args routing', () => {
  it('default config (no vendor) routes to anthropic adapter → claude binary', async () => {
    const captured = await spawnAndCapture({});
    expect(captured.binary).toMatch(/^claude(\.cmd)?$/);
    expect(captured.args).toContain('--dangerously-skip-permissions');
  });

  it('vendor="anthropic" routes to claude binary with claude flags', async () => {
    const captured = await spawnAndCapture({ vendor: 'anthropic', model: 'claude-opus-4-7' });
    expect(captured.binary).toMatch(/^claude(\.cmd)?$/);
    expect(captured.args).toContain('--dangerously-skip-permissions');
    expect(captured.args).toContain('--model');
    expect(captured.args[captured.args.indexOf('--model') + 1]).toBe('claude-opus-4-7');
  });

  it('vendor="openai" routes to codex binary with bypass triple', async () => {
    const captured = await spawnAndCapture({ vendor: 'openai', model: 'gpt-5.5' });
    expect(captured.binary).toBe('codex');
    expect(captured.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(captured.args).toContain('--no-alt-screen');
    expect(captured.args).toContain('--disable');
    expect(captured.args).toContain('shell_snapshot');
    expect(captured.args).toContain('--model');
    expect(captured.args[captured.args.indexOf('--model') + 1]).toBe('gpt-5.5');
  });

  it('vendor="google" routes to gemini binary with --yolo --sandbox false', async () => {
    const captured = await spawnAndCapture({ vendor: 'google', model: 'gemini-2.5-pro' });
    expect(captured.binary).toBe('gemini');
    expect(captured.args).toContain('--yolo');
    expect(captured.args).toContain('--sandbox');
    expect(captured.args[captured.args.indexOf('--sandbox') + 1]).toBe('false');
  });
});

describe('AgentPTY vendor flip — env filtering', () => {
  it('anthropic vendor preserves CLAUDE_* env vars (no stripping)', async () => {
    const captured = await spawnAndCapture({ vendor: 'anthropic' });
    expect(captured.env[PRESERVED_CLAUDE_VAR]).toBe(PRESERVED_CLAUDE_VALUE);
  });

  it('openai vendor strips CLAUDE_* env vars before spawn', async () => {
    const captured = await spawnAndCapture({ vendor: 'openai' });
    expect(captured.env[PRESERVED_CLAUDE_VAR]).toBeUndefined();
    for (const key of Object.keys(captured.env)) {
      expect(key).not.toMatch(/^CLAUDE_/);
    }
  });

  it('google vendor strips CLAUDE_* env vars before spawn', async () => {
    const captured = await spawnAndCapture({ vendor: 'google' });
    expect(captured.env[PRESERVED_CLAUDE_VAR]).toBeUndefined();
    for (const key of Object.keys(captured.env)) {
      expect(key).not.toMatch(/^CLAUDE_/);
    }
  });

  it('non-CLAUDE env vars (e.g. PATH) flow through for all vendors', async () => {
    for (const vendor of ['anthropic', 'openai', 'google'] as const) {
      const captured = await spawnAndCapture({ vendor });
      expect(captured.env.PATH).toBeDefined();
    }
  });
});

describe('AgentPTY vendor flip — continue mode per vendor', () => {
  it('anthropic continue mode prepends --continue', async () => {
    const captured = await spawnAndCapture({ vendor: 'anthropic' }, 'continue');
    expect(captured.args[0]).toBe('--continue');
  });

  it('openai continue mode prepends "resume --last" subcommand', async () => {
    const captured = await spawnAndCapture({ vendor: 'openai' }, 'continue');
    expect(captured.args[0]).toBe('resume');
    expect(captured.args[1]).toBe('--last');
  });

  it('google continue mode falls back to fresh (no CLI session-resume)', async () => {
    const fresh = await spawnAndCapture({ vendor: 'google' }, 'fresh');
    mocks.spawn.mockClear();
    const cont = await spawnAndCapture({ vendor: 'google' }, 'continue');
    expect(cont.args).toEqual(fresh.args);
  });
});

describe('AgentPTY vendor flip — error paths', () => {
  it('vendor="grok" throws with "Supported MVP vendors" message', async () => {
    const pty = new AgentPTY(TEST_ENV, { vendor: 'grok' as 'anthropic' });
    await expect(pty.spawn('fresh', 'hi')).rejects.toThrow(/Supported MVP vendors/);
  });

  it('vendor="invalid" throws with "Supported MVP vendors" message', async () => {
    const pty = new AgentPTY(TEST_ENV, { vendor: 'invalid' as 'anthropic' });
    await expect(pty.spawn('fresh', 'hi')).rejects.toThrow(/Supported MVP vendors/);
  });

  it('error message names the unknown vendor for diagnosability', async () => {
    const pty = new AgentPTY(TEST_ENV, { vendor: 'mystery' as 'anthropic' });
    await expect(pty.spawn('fresh', 'hi')).rejects.toThrow(/mystery/);
  });
});
