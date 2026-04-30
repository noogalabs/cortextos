import type { AdapterContext, VendorAdapter } from './base.js';

const BINARY = 'codex';

const BYPASS_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--no-alt-screen',
  '--disable', 'shell_snapshot',
];

export const openaiAdapter: VendorAdapter = {
  name: 'openai',
  binary: BINARY,
  pasteEnterCount: 1,
  extractionRetries: 0,

  buildArgs(mode: 'fresh' | 'continue', prompt: string, ctx: AdapterContext): string[] {
    const args: string[] = [];

    if (mode === 'continue') {
      args.push('resume', '--last');
    }

    args.push(...BYPASS_FLAGS);

    const model = ctx.config.model;
    if (model) {
      args.push('--model', model);
    }

    args.push(prompt);

    return args;
  },

  envFilter(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith('CLAUDE_')) continue;
      out[key] = value;
    }
    return out;
  },
};
