import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: string;
    constructor(name: string, dir: string) {
      this.name = name;
      this.dir = dir;
    }
    async start() {}
    async stop() {}
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() {}
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() {}
    stop() {}
    wake() {}
  },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor() {}
  },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    start() {}
    stop() {}
  },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager.discoverAndStart discovery behavior', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-discovery-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('does not start anything when orgs directory is missing', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('passes config.json fields through as the third startAgent argument', async () => {
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    writeFileSync(
      join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice', 'config.json'),
      JSON.stringify({ model: 'claude-test', enabled: true }),
    );

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(
      'alice',
      join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'),
      expect.objectContaining({ model: 'claude-test', enabled: true }),
      'acme',
    );
  });

  it('passes an empty config object when config.json is missing', async () => {
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(
      'alice',
      join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'),
      {},
      'acme',
    );
  });

  it('ignores non-directory entries in org and agent listings', async () => {
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'file.txt'), 'not an org agent dir');
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'notadir.txt'), 'not an agent dir');

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(
      'alice',
      join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'),
      {},
      'acme',
    );
  });

  it('continues scanning other orgs when one org agents path cannot be read', async () => {
    mkdirSync(join(frameworkRoot, 'orgs', 'orgA'), { recursive: true });
    writeFileSync(join(frameworkRoot, 'orgs', 'orgA', 'agents'), 'not a directory');
    mkdirSync(join(frameworkRoot, 'orgs', 'orgB', 'agents', 'bravo'), { recursive: true });

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(
      'bravo',
      join(frameworkRoot, 'orgs', 'orgB', 'agents', 'bravo'),
      {},
      'orgB',
    );
  });

  it('skips orgs that have no agents subdirectory', async () => {
    mkdirSync(join(frameworkRoot, 'orgs', 'acme'), { recursive: true });

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).not.toHaveBeenCalled();
  });
});
