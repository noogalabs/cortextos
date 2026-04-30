import { describe, it, expect } from 'vitest';
import { platform } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadAdapter } from '../../../src/pty/adapters/base';
import { anthropicAdapter } from '../../../src/pty/adapters/anthropic';
import type { AgentConfig, CtxEnv } from '../../../src/types/index';

function makeEnv(agentDir: string): CtxEnv {
  return {
    instanceId: 'test',
    ctxRoot: '/tmp/ctx',
    frameworkRoot: '/tmp/framework',
    agentName: 'test-agent',
    org: 'test-org',
    agentDir,
    projectRoot: '/tmp/project',
  };
}

describe('loadAdapter', () => {
  it('returns anthropic adapter for undefined vendor (default)', () => {
    expect(loadAdapter(undefined)).toBe(anthropicAdapter);
  });

  it('returns anthropic adapter for "anthropic"', () => {
    expect(loadAdapter('anthropic')).toBe(anthropicAdapter);
  });

  it('throws for unknown vendors at MVP', () => {
    expect(() => loadAdapter('openai')).toThrow(/Unknown vendor.*openai/);
    expect(() => loadAdapter('google')).toThrow(/Unknown vendor.*google/);
    expect(() => loadAdapter('grok')).toThrow(/Unknown vendor.*grok/);
  });
});

describe('anthropicAdapter — zero behavior change', () => {
  it('binary is platform-correct (claude / claude.cmd)', () => {
    const expected = platform() === 'win32' ? 'claude.cmd' : 'claude';
    expect(anthropicAdapter.binary).toBe(expected);
  });

  it('exposes 2-Enter bracketed-paste count for Claude TUI', () => {
    expect(anthropicAdapter.pasteEnterCount).toBe(2);
  });

  it('extractionRetries is 0 for Claude (no Ink-renderer spinner issue)', () => {
    expect(anthropicAdapter.extractionRetries).toBe(0);
  });

  it('envFilter is identity (Claude needs no env stripping)', () => {
    const env = { FOO: 'bar', CLAUDE_CODE_SKIP_AUTH: 'yes' };
    expect(anthropicAdapter.envFilter(env)).toEqual(env);
  });

  describe('buildArgs — same args as pre-refactor agent-pty.ts', () => {
    const config: AgentConfig = { model: 'claude-opus-4-7' };
    const env = makeEnv('/nonexistent-agent-dir');

    it('fresh mode: --dangerously-skip-permissions + --model + prompt', () => {
      const args = anthropicAdapter.buildArgs('fresh', 'hello', { config, env });
      expect(args).toEqual([
        '--dangerously-skip-permissions',
        '--model', 'claude-opus-4-7',
        'hello',
      ]);
    });

    it('continue mode: prepends --continue', () => {
      const args = anthropicAdapter.buildArgs('continue', 'resume', { config, env });
      expect(args).toEqual([
        '--continue',
        '--dangerously-skip-permissions',
        '--model', 'claude-opus-4-7',
        'resume',
      ]);
    });

    it('omits --model when unset', () => {
      const argsNoModel = anthropicAdapter.buildArgs(
        'fresh',
        'p',
        { config: {}, env },
      );
      expect(argsNoModel).toEqual([
        '--dangerously-skip-permissions',
        'p',
      ]);
    });

    it('appends local/*.md files as --append-system-prompt when present', () => {
      const tmpAgent = mkdtempSync(join(tmpdir(), 'aussie-adapter-test-'));
      try {
        const localDir = join(tmpAgent, 'local');
        mkdirSync(localDir);
        writeFileSync(join(localDir, '01-first.md'), 'FIRST');
        writeFileSync(join(localDir, '02-second.md'), 'SECOND');
        writeFileSync(join(localDir, 'ignored.txt'), 'NOT_MD');

        const args = anthropicAdapter.buildArgs(
          'fresh',
          'p',
          { config: {}, env: makeEnv(tmpAgent) },
        );

        const idx = args.indexOf('--append-system-prompt');
        expect(idx).toBeGreaterThan(-1);
        expect(args[idx + 1]).toBe('FIRST\n\nSECOND');
        expect(args[args.length - 1]).toBe('p');
      } finally {
        rmSync(tmpAgent, { recursive: true, force: true });
      }
    });

    it('skips --append-system-prompt when local/ dir is missing', () => {
      const args = anthropicAdapter.buildArgs(
        'fresh',
        'p',
        { config: {}, env },
      );
      expect(args).not.toContain('--append-system-prompt');
    });
  });
});
