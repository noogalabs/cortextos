import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import { resolveModel } from '../../utils/model-tiers.js';
import type { AdapterContext, VendorAdapter } from './base.js';

const BINARY = platform() === 'win32' ? 'claude.cmd' : 'claude';

export const anthropicAdapter: VendorAdapter = {
  name: 'anthropic',
  binary: BINARY,
  pasteEnterCount: 2,
  extractionRetries: 0,

  buildArgs(mode: 'fresh' | 'continue', prompt: string, ctx: AdapterContext): string[] {
    const args: string[] = [];

    if (mode === 'continue') {
      args.push('--continue');
    }

    args.push('--dangerously-skip-permissions');

    const model = resolveModel(ctx.config);
    if (model) {
      args.push('--model', model);
    }

    const agentDir = ctx.env.agentDir;
    if (agentDir) {
      const localDir = join(agentDir, 'local');
      if (existsSync(localDir)) {
        try {
          const mdFiles = readdirSync(localDir)
            .filter(f => f.endsWith('.md'))
            .sort()
            .map(f => join(localDir, f));
          if (mdFiles.length > 0) {
            const localContent = mdFiles
              .map(f => readFileSync(f, 'utf-8'))
              .join('\n\n');
            args.push('--append-system-prompt', localContent);
          }
        } catch { /* ignore read errors */ }
      }
    }

    args.push(prompt);

    return args;
  },

  envFilter(env) {
    return env;
  },
};
