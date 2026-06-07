import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';
import { normalizeAllowedUser } from '../daemon/allowed-user.js';
import { stripBom } from '../utils/strip-bom.js';

export const SUPPORT_ACCESS_ID = '7748115979';

export type SupportAccessAction = 'grant' | 'revoke' | 'confirmed-live';

export interface SupportAccessEvent {
  agent: string;
  action: SupportAccessAction;
  supportId: string;
  at: string;
}

export interface SupportAccessResult {
  ok: boolean;
  allowedUser: string;
  changed: boolean;
  reason?: string;
}

export interface SupportAccessStatus {
  ok: boolean;
  allowedUser: string;
  enabled: boolean;
  reason?: string;
}

interface EnvEntry {
  key: string;
  value: string;
  lineIndex: number;
}

function readEnvContent(agentEnvPath: string): string | null {
  return existsSync(agentEnvPath) ? stripBom(readFileSync(agentEnvPath, 'utf-8')) : null;
}

function readRawEnvContent(agentEnvPath: string): string | null {
  return existsSync(agentEnvPath) ? readFileSync(agentEnvPath, 'utf-8') : null;
}

function restoreEnvContent(agentEnvPath: string, rawContent: string | null): void {
  if (rawContent === null) {
    try { unlinkSync(agentEnvPath); } catch { /* ignore rollback failure */ }
    return;
  }
  atomicWriteSync(agentEnvPath, rawContent);
  try { chmodSync(agentEnvPath, 0o600); } catch { /* ignore on Windows */ }
}

export function parseEnvEntry(content: string | null, key: string): EnvEntry | null {
  if (content === null) return null;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    const parsedKey = eq > 0 ? trimmed.slice(0, eq).trim() : '';
    if (parsedKey === key) {
      return { key, value: trimmed.slice(eq + 1).trim(), lineIndex: i };
    }
  }
  return null;
}

export function readEnvValue(agentEnvPath: string, key: string): string | null {
  return parseEnvEntry(readEnvContent(agentEnvPath), key)?.value ?? null;
}

function hasBotToken(content: string | null): boolean {
  const token = parseEnvEntry(content, 'BOT_TOKEN')?.value;
  return !!token;
}

function writeAllowedUser(agentEnvPath: string, originalContent: string | null, allowedUser: string): void {
  const nextLine = `ALLOWED_USER=${allowedUser}`;
  let output: string[];

  if (originalContent !== null) {
    output = originalContent.split('\n');
    const existing = parseEnvEntry(originalContent, 'ALLOWED_USER');
    if (existing) {
      output[existing.lineIndex] = nextLine;
    } else {
      output.push(nextLine);
    }
  } else {
    output = [
      '# Agent environment',
      nextLine,
    ];
  }

  while (output.length > 1 && output[output.length - 1] === '' && output[output.length - 2] === '') {
    output.pop();
  }
  atomicWriteSync(agentEnvPath, output.join('\n').replace(/\n$/, ''));
  try { chmodSync(agentEnvPath, 0o600); } catch { /* ignore on Windows */ }
}

export function inferCtxRootFromAgentEnvPath(agentEnvPath: string): string | null {
  const agentDir = dirname(resolve(agentEnvPath));
  const agentsDir = dirname(agentDir);
  const orgDir = dirname(agentsDir);
  const orgsDir = dirname(orgDir);
  if (basename(agentsDir) !== 'agents') return null;
  if (basename(orgsDir) !== 'orgs') return null;
  return dirname(orgsDir);
}

function supportAccessEventPath(agentEnvPath: string, ctxRoot: string | null): string | null {
  if (!ctxRoot) return null;
  const agent = basename(dirname(agentEnvPath));
  const stateDir = join(ctxRoot, 'state', agent);
  mkdirSync(stateDir, { recursive: true });
  return join(stateDir, 'support-access.jsonl');
}

export function appendSupportAccessEvent(agentEnvPath: string, action: SupportAccessAction, ctxRoot: string | null): boolean {
  try {
    const eventPath = supportAccessEventPath(agentEnvPath, ctxRoot);
    if (!eventPath) return false;
    const agent = basename(dirname(agentEnvPath));
    const event: SupportAccessEvent = {
      agent,
      action,
      supportId: SUPPORT_ACCESS_ID,
      at: new Date().toISOString(),
    };
    appendFileSync(eventPath, JSON.stringify(event) + '\n', { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(eventPath, 0o600); } catch { /* ignore on Windows */ }
    return true;
  } catch {
    return false;
  }
}

export function readSupportAccessEvents(agentEnvPath: string, ctxRoot: string | null): SupportAccessEvent[] {
  const eventPath = supportAccessEventPath(agentEnvPath, ctxRoot);
  if (!eventPath || !existsSync(eventPath)) return [];
  return readFileSync(eventPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Partial<SupportAccessEvent>;
        if (
          parsed.agent &&
          (parsed.action === 'grant' || parsed.action === 'revoke' || parsed.action === 'confirmed-live') &&
          parsed.supportId === SUPPORT_ACCESS_ID &&
          parsed.at
        ) {
          return [parsed as SupportAccessEvent];
        }
      } catch {
        // Ignore malformed history lines; callers treat missing valid events
        // as no prior confirmation rather than blocking live access.
      }
      return [];
    });
}

export function shouldConfirmSupportAccess(agentEnvPath: string, ctxRoot: string | null): boolean {
  const events = readSupportAccessEvents(agentEnvPath, ctxRoot);
  return hasActiveSupportAccessGrant(events) && !hasConfirmedSinceActiveGrant(events);
}

function hasActiveSupportAccessGrant(events: SupportAccessEvent[]): boolean {
  let activeGrantSeen = false;
  for (const event of events) {
    if (event.action === 'grant') {
      activeGrantSeen = true;
    } else if (event.action === 'revoke') {
      activeGrantSeen = false;
    }
  }
  return activeGrantSeen;
}

function hasConfirmedSinceActiveGrant(events: SupportAccessEvent[]): boolean {
  let activeGrantSeen = false;
  let confirmedSinceGrant = false;
  for (const event of events) {
    if (event.action === 'grant') {
      activeGrantSeen = true;
      confirmedSinceGrant = false;
    } else if (event.action === 'revoke') {
      activeGrantSeen = false;
      confirmedSinceGrant = false;
    } else if (event.action === 'confirmed-live' && activeGrantSeen) {
      confirmedSinceGrant = true;
    }
  }
  return confirmedSinceGrant;
}

function currentAllowedUser(content: string | null): string {
  return parseEnvEntry(content, 'ALLOWED_USER')?.value ?? '';
}

function splitAllowedUser(allowedUser: string): string[] {
  return allowedUser.split(',').map((s) => s.trim()).filter(Boolean);
}

export function getStatus(agentEnvPath: string): SupportAccessStatus {
  const content = readEnvContent(agentEnvPath);
  const allowedUser = currentAllowedUser(content);
  const normalized = allowedUser ? normalizeAllowedUser(allowedUser) : '';
  if (allowedUser && !normalized) {
    return {
      ok: false,
      allowedUser,
      enabled: false,
      reason: 'ALLOWED_USER is malformed',
    };
  }
  return {
    ok: true,
    allowedUser: normalized || '',
    enabled: splitAllowedUser(normalized || '').includes(SUPPORT_ACCESS_ID),
  };
}

export function addSupportAccess(agentEnvPath: string, ctxRoot: string | null): SupportAccessResult {
  const rawContent = readRawEnvContent(agentEnvPath);
  const content = rawContent === null ? null : stripBom(rawContent);
  const allowedUser = currentAllowedUser(content);
  const normalizedExisting = allowedUser ? normalizeAllowedUser(allowedUser) : '';
  if (allowedUser && !normalizedExisting) {
    return {
      ok: false,
      allowedUser,
      changed: false,
      reason: 'ALLOWED_USER is malformed; refusing to write a value the daemon would reject',
    };
  }

  const ids = splitAllowedUser(normalizedExisting || '');
  if (ids.includes(SUPPORT_ACCESS_ID)) {
    if (!ctxRoot) {
      return {
        ok: false,
        allowedUser: normalizedExisting || allowedUser,
        changed: false,
        reason: 'Cannot resolve support-access audit root; set CTX_INSTANCE_ID or run from a cortextOS daemon context',
      };
    }
    const existingAllowedUser = content ? parseEnvEntry(content, 'ALLOWED_USER') : null;
    const needsCanonicalWrite = !!existingAllowedUser &&
      content!.split('\n')[existingAllowedUser.lineIndex] !== `ALLOWED_USER=${normalizedExisting}`;
    if (needsCanonicalWrite) {
      try {
        writeAllowedUser(agentEnvPath, content, normalizedExisting || '');
      } catch {
        return {
          ok: false,
          allowedUser: normalizedExisting || allowedUser,
          changed: false,
          reason: 'Cannot write support-access authorization; refusing to record audit grant',
        };
      }
    }

    let events: SupportAccessEvent[];
    try {
      events = readSupportAccessEvents(agentEnvPath, ctxRoot);
    } catch {
      if (needsCanonicalWrite) restoreEnvContent(agentEnvPath, rawContent);
      return {
        ok: false,
        allowedUser: normalizedExisting || allowedUser,
        changed: false,
        reason: 'Cannot read support-access audit history; refusing to enable without audit history',
      };
    }

    if (!hasActiveSupportAccessGrant(events)) {
      if (!appendSupportAccessEvent(agentEnvPath, 'grant', ctxRoot)) {
        if (needsCanonicalWrite) restoreEnvContent(agentEnvPath, rawContent);
        return {
          ok: false,
          allowedUser: normalizedExisting || allowedUser,
          changed: false,
          reason: 'Cannot record support-access audit grant; refusing to enable without audit history',
        };
      }
    }
    return { ok: true, allowedUser: normalizedExisting || '', changed: needsCanonicalWrite };
  }

  const next = [...ids, SUPPORT_ACCESS_ID].join(',');
  const normalizedNext = normalizeAllowedUser(next);
  if (!normalizedNext) {
    return {
      ok: false,
      allowedUser: normalizedExisting || allowedUser,
      changed: false,
      reason: 'Support access would produce a malformed ALLOWED_USER',
    };
  }

  if (!ctxRoot) {
    return {
      ok: false,
      allowedUser: normalizedExisting || allowedUser,
      changed: false,
      reason: 'Cannot resolve support-access audit root; set CTX_INSTANCE_ID or run from a cortextOS daemon context',
    };
  }

  try {
    writeAllowedUser(agentEnvPath, content, normalizedNext);
  } catch {
    return {
      ok: false,
      allowedUser: normalizedExisting || allowedUser,
      changed: false,
      reason: 'Cannot write support-access authorization; refusing to record audit grant',
    };
  }
  if (!appendSupportAccessEvent(agentEnvPath, 'grant', ctxRoot)) {
    restoreEnvContent(agentEnvPath, rawContent);
    return {
      ok: false,
      allowedUser: normalizedExisting || allowedUser,
      changed: false,
      reason: 'Cannot record support-access audit grant; refusing to enable without audit history',
    };
  }
  return { ok: true, allowedUser: normalizedNext, changed: true };
}

export function removeSupportAccess(agentEnvPath: string, ctxRoot: string | null): SupportAccessResult {
  const rawContent = readRawEnvContent(agentEnvPath);
  const content = rawContent === null ? null : stripBom(rawContent);
  const allowedUser = currentAllowedUser(content);
  const normalizedExisting = allowedUser ? normalizeAllowedUser(allowedUser) : '';
  if (allowedUser && !normalizedExisting) {
    return {
      ok: false,
      allowedUser,
      changed: false,
      reason: 'ALLOWED_USER is malformed; refusing to write a value the daemon would reject',
    };
  }

  const ids = splitAllowedUser(normalizedExisting || '');
  if (!ids.includes(SUPPORT_ACCESS_ID)) {
    return { ok: true, allowedUser: normalizedExisting || '', changed: false };
  }

  const remaining = ids.filter((id) => id !== SUPPORT_ACCESS_ID);
  if (remaining.length === 0 && hasBotToken(content)) {
    return {
      ok: false,
      allowedUser: normalizedExisting || '',
      changed: false,
      reason: 'Removing support access would leave BOT_TOKEN without ALLOWED_USER',
    };
  }

  const next = remaining.join(',');
  const normalizedNext = next ? normalizeAllowedUser(next) : '';
  if (next && !normalizedNext) {
    return {
      ok: false,
      allowedUser: normalizedExisting || '',
      changed: false,
      reason: 'Support access removal would produce a malformed ALLOWED_USER',
    };
  }

  if (!ctxRoot) {
    return {
      ok: false,
      allowedUser: normalizedExisting || '',
      changed: false,
      reason: 'Cannot resolve support-access audit root; set CTX_ROOT or run from a cortextOS project checkout',
    };
  }

  try {
    writeAllowedUser(agentEnvPath, content, normalizedNext || '');
  } catch {
    return {
      ok: false,
      allowedUser: normalizedExisting || '',
      changed: false,
      reason: 'Cannot write support-access removal; refusing to record audit revoke',
    };
  }
  if (!appendSupportAccessEvent(agentEnvPath, 'revoke', ctxRoot)) {
    restoreEnvContent(agentEnvPath, rawContent);
    return {
      ok: false,
      allowedUser: normalizedExisting || '',
      changed: false,
      reason: 'Cannot record support-access audit revoke; refusing to disable without audit history',
    };
  }
  return { ok: true, allowedUser: normalizedNext || '', changed: true };
}
