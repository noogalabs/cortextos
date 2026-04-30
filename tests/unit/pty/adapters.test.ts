import { describe, it, expect } from 'vitest';
import { platform } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadAdapter } from '../../../src/pty/adapters/base';
import { anthropicAdapter } from '../../../src/pty/adapters/anthropic';
import { openaiAdapter } from '../../../src/pty/adapters/openai';
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

  it('returns openai adapter for "openai"', () => {
    expect(loadAdapter('openai')).toBe(openaiAdapter);
  });

  it('throws for vendors not yet implemented at MVP', () => {
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

describe('openaiAdapter', () => {
  const env = makeEnv('/nonexistent-agent-dir');

  it('binary is "codex" (no platform-specific .cmd suffix)', () => {
    expect(openaiAdapter.binary).toBe('codex');
  });

  it('exposes 1-Enter bracketed-paste count for Codex TUI', () => {
    expect(openaiAdapter.pasteEnterCount).toBe(1);
  });

  it('extractionRetries is 0 (no Ink-renderer spinner like Gemini)', () => {
    expect(openaiAdapter.extractionRetries).toBe(0);
  });

  describe('envFilter — strips CLAUDE_* leakage', () => {
    it('removes CLAUDE_CODE_SKIP_*_AUTH (corrupts Codex auth detection)', () => {
      const out = openaiAdapter.envFilter({
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
        CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
        CLAUDE_API_KEY: 'sk-test',
        CLAUDE_OPUS_MODEL: 'opus-4-7',
      });
      expect(out).toEqual({});
    });

    it('passes through OPENAI_KEY, CODEX_HOME, and other non-Claude vars', () => {
      const out = openaiAdapter.envFilter({
        OPENAI_KEY: 'sk-openai',
        CODEX_HOME: '/Users/me/.codex-seats/seat-a',
        PATH: '/usr/bin',
        CLAUDE_CODE_SKIP_AUTH: '1',
      });
      expect(out).toEqual({
        OPENAI_KEY: 'sk-openai',
        CODEX_HOME: '/Users/me/.codex-seats/seat-a',
        PATH: '/usr/bin',
      });
    });
  });

  describe('buildArgs', () => {
    const config: AgentConfig = { model: 'gpt-5.5' };

    it('fresh mode: bypass flags + --model + prompt (no resume)', () => {
      const args = openaiAdapter.buildArgs('fresh', 'hello', { config, env });
      expect(args).toEqual([
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
        '--disable', 'shell_snapshot',
        '--model', 'gpt-5.5',
        'hello',
      ]);
    });

    it('continue mode: prepends "resume --last" subcommand', () => {
      const args = openaiAdapter.buildArgs('continue', 'resume me', { config, env });
      expect(args).toEqual([
        'resume', '--last',
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
        '--disable', 'shell_snapshot',
        '--model', 'gpt-5.5',
        'resume me',
      ]);
    });

    it('omits --model when unset (codex picks default)', () => {
      const args = openaiAdapter.buildArgs('fresh', 'p', { config: {}, env });
      expect(args).toEqual([
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
        '--disable', 'shell_snapshot',
        'p',
      ]);
    });

    it('always includes the bypass triple for SIGTTIN/TTY safety', () => {
      const fresh = openaiAdapter.buildArgs('fresh', 'p', { config: {}, env });
      const cont = openaiAdapter.buildArgs('continue', 'p', { config: {}, env });
      for (const args of [fresh, cont]) {
        expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
        expect(args).toContain('--no-alt-screen');
        expect(args).toContain('--disable');
        expect(args).toContain('shell_snapshot');
      }
    });
  });
});
