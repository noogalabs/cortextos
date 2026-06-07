import { Command } from 'commander';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { resolveCanonicalCtxRoot } from '../utils/paths.js';
import { TelegramAPI } from '../telegram/api.js';
import {
  addSupportAccess,
  getStatus,
  readEnvValue,
  removeSupportAccess,
} from './support-access-core.js';
import {
  formatSupportAccessShareInstruction,
  resolveAgentHandle,
} from './support-access-notify.js';

interface SupportAccessOptions {
  agent?: string;
  org?: string;
  instance?: string;
}

interface ResolveEnvTargetOptions {
  requireInstanceRoot: boolean;
}

function findProjectRoot(): string {
  const candidates = [
    process.env.CORTEXTOS_DIR,
    process.env.CTX_FRAMEWORK_ROOT,
    process.env.CTX_PROJECT_ROOT,
    process.cwd(),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(join(c, 'orgs'))) return c;
  }
  return process.cwd();
}

function resolveCurrentAgentName(): string | null {
  return process.env.CTX_AGENT_NAME || null;
}

function resolveAgentDir(projectRoot: string, agentName: string, org?: string): { dir: string; org: string } | null {
  const orgsDir = join(projectRoot, 'orgs');
  if (!existsSync(orgsDir)) return null;

  if (org) {
    const dir = join(orgsDir, org, 'agents', agentName);
    return existsSync(dir) ? { dir, org } : null;
  }

  const orgs = readdirSync(orgsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  const matches = orgs.filter(o => existsSync(join(orgsDir, o, 'agents', agentName)));
  if (matches.length === 1) {
    return { dir: join(orgsDir, matches[0], 'agents', agentName), org: matches[0] };
  }
  if (matches.length > 1) {
    console.error(`Agent "${agentName}" exists under multiple orgs: ${matches.join(', ')}. Pass --org <name> to disambiguate.`);
    return null;
  }
  return null;
}

function resolveEnvTarget(
  opts: SupportAccessOptions,
  { requireInstanceRoot }: ResolveEnvTargetOptions,
): { envPath: string; ctxRoot: string | null } {
  const agentName = opts.agent || resolveCurrentAgentName();
  if (!agentName) {
    console.error('Error: pass --agent <name> or run inside an agent context with CTX_AGENT_NAME set.');
    process.exit(1);
  }

  const projectRoot = findProjectRoot();
  const resolved = resolveAgentDir(projectRoot, agentName, opts.org);
  if (!resolved) {
    console.error(`Error: agent "${agentName}" not found under ${projectRoot}/orgs/`);
    process.exit(1);
  }

  // Fail loud rather than silently defaulting the audit-log instance. If neither
  // --instance nor CTX_INSTANCE_ID is set, resolveCanonicalCtxRoot() would fall
  // back to the "default" instance, so an operator running from a checkout
  // outside an agent shell on a non-default deployment would write the consent
  // grant under a different instance root than the daemon confirms under,
  // silently splitting the support-access audit trail.
  if (requireInstanceRoot && !opts.instance && !process.env.CTX_INSTANCE_ID) {
    console.error(
      'Error: cannot determine daemon instance; pass --instance <id> or run inside an agent context with CTX_INSTANCE_ID set.',
    );
    process.exit(1);
  }

  const envPath = join(resolved.dir, '.env');
  return {
    envPath,
    ctxRoot: resolveCanonicalCtxRoot(opts.instance),
  };
}

function readBotToken(envPath: string): string | null {
  return readEnvValue(envPath, 'BOT_TOKEN');
}

async function resolveHandleForEnv(envPath: string): Promise<string | null> {
  const botToken = readBotToken(envPath);
  if (!botToken) return null;
  return resolveAgentHandle(new TelegramAPI(botToken));
}

async function enableSupportAccess(opts: SupportAccessOptions): Promise<void> {
  const { envPath, ctxRoot } = resolveEnvTarget(opts, { requireInstanceRoot: true });
  const result = addSupportAccess(envPath, ctxRoot);
  if (!result.ok) {
    console.error(`Support access not enabled: ${result.reason ?? 'unknown error'}`);
    process.exitCode = 1;
    return;
  }

  console.log(result.changed ? 'Support access enabled.' : 'Support access was already enabled.');
  console.log(`ALLOWED_USER=${result.allowedUser}`);
  console.log('');
  console.log(formatSupportAccessShareInstruction(await resolveHandleForEnv(envPath)));
  console.log('');
  console.log('Restart or reload the agent for the running daemon to pick up this .env change.');
}

function disableSupportAccess(opts: SupportAccessOptions): void {
  const { envPath, ctxRoot } = resolveEnvTarget(opts, { requireInstanceRoot: true });
  const result = removeSupportAccess(envPath, ctxRoot);
  if (!result.ok) {
    console.error(`Support access not disabled: ${result.reason ?? 'unknown error'}`);
    process.exitCode = 1;
    return;
  }

  console.log(result.changed ? 'Support access disabled.' : 'Support access was already disabled.');
  console.log(`ALLOWED_USER=${result.allowedUser}`);
  console.log('Restart or reload the agent for the running daemon to pick up this .env change.');
}

function showSupportAccessStatus(opts: SupportAccessOptions): void {
  const { envPath } = resolveEnvTarget(opts, { requireInstanceRoot: false });
  const status = getStatus(envPath);
  if (!status.ok) {
    console.error(`Support access status unavailable: ${status.reason ?? 'unknown error'}`);
    process.exitCode = 1;
    return;
  }
  console.log(status.enabled ? 'Support access: enabled' : 'Support access: disabled');
  console.log(`ALLOWED_USER=${status.allowedUser}`);
}

export const supportAccessCommand = new Command('support-access')
  .description('Toggle David support access for an agent by updating ALLOWED_USER')
  .addCommand(new Command('enable')
    .description('Add David support access to an agent .env')
    .option('--agent <name>', 'Agent name (defaults to CTX_AGENT_NAME)')
    .option('--org <org>', 'Organization name (auto-detected if only one)')
    .option('--instance <id>', 'Instance ID (required if CTX_INSTANCE_ID is not set)')
    .action(enableSupportAccess))
  .addCommand(new Command('disable')
    .description('Remove David support access from an agent .env')
    .option('--agent <name>', 'Agent name (defaults to CTX_AGENT_NAME)')
    .option('--org <org>', 'Organization name (auto-detected if only one)')
    .option('--instance <id>', 'Instance ID (required if CTX_INSTANCE_ID is not set)')
    .action(disableSupportAccess))
  .addCommand(new Command('status')
    .description('Show whether David support access is enabled')
    .option('--agent <name>', 'Agent name (defaults to CTX_AGENT_NAME)')
    .option('--org <org>', 'Organization name (auto-detected if only one)')
    .option('--instance <id>', 'Instance ID (required if CTX_INSTANCE_ID is not set)')
    .action(showSupportAccessStatus));
