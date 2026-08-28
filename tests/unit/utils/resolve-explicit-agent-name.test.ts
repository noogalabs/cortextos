import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveExplicitAgentName } from '../../../src/utils/env';

describe('resolveExplicitAgentName', () => {
  const savedEnv = process.env.CTX_AGENT_NAME;
  const savedCwd = process.cwd();
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'explicit-actor-'));
    process.chdir(workDir);
    delete process.env.CTX_AGENT_NAME;
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(workDir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.CTX_AGENT_NAME;
    else process.env.CTX_AGENT_NAME = savedEnv;
  });

  it('returns null with no env var and no .cortextos-env — the cwd basename is NOT an attribution', () => {
    // workDir has a basename; resolveEnv().agentName would be truthy here.
    // The explicit resolver must refuse it.
    expect(resolveExplicitAgentName()).toBeNull();
  });

  it('returns the env var when set', () => {
    process.env.CTX_AGENT_NAME = 'collie';
    expect(resolveExplicitAgentName()).toBe('collie');
  });

  it('returns the .cortextos-env value when the env var is absent', () => {
    writeFileSync(join(workDir, '.cortextos-env'), 'CTX_AGENT_NAME=blue\n');
    expect(resolveExplicitAgentName()).toBe('blue');
  });

  it('treats whitespace-only env values as absent', () => {
    process.env.CTX_AGENT_NAME = '   ';
    expect(resolveExplicitAgentName()).toBeNull();
  });
});
