import type { TelegramAPI } from '../telegram/api.js';
import {
  SUPPORT_ACCESS_ID,
  appendSupportAccessEvent,
  shouldConfirmSupportAccess,
} from './support-access-core.js';

export const SUPPORT_ACCESS_CONFIRMATION = 'Support access is live for this agent.';

export async function resolveAgentHandle(
  api: Pick<TelegramAPI, 'getMe'>,
  fallbackHandle?: string,
): Promise<string | null> {
  try {
    const me = await api.getMe();
    const username = me?.result?.username;
    if (typeof username === 'string' && username.trim()) {
      return `@${username.trim().replace(/^@/, '')}`;
    }
  } catch {
    // Fall through to configured fallback.
  }
  if (fallbackHandle?.trim()) {
    return fallbackHandle.trim().startsWith('@') ? fallbackHandle.trim() : `@${fallbackHandle.trim()}`;
  }
  return null;
}

export function formatSupportAccessShareInstruction(agentHandle: string | null): string {
  const handle = agentHandle ?? '<agent bot handle>';
  return `Support access is enabled. Please share this bot handle with David: ${handle}. David support ID: ${SUPPORT_ACCESS_ID}.`;
}

export async function confirmSupportAccessOnFirstContact(params: {
  agentEnvPath: string;
  ctxRoot: string | null;
  api: Pick<TelegramAPI, 'sendMessage'>;
  fromId: number | undefined;
  log?: (message: string) => void;
}): Promise<boolean> {
  if (params.fromId !== Number(SUPPORT_ACCESS_ID)) return false;
  if (!shouldConfirmSupportAccess(params.agentEnvPath, params.ctxRoot)) return false;

  await params.api.sendMessage(SUPPORT_ACCESS_ID, SUPPORT_ACCESS_CONFIRMATION, undefined, { parseMode: null });
  if (!appendSupportAccessEvent(params.agentEnvPath, 'confirmed-live', params.ctxRoot)) {
    params.log?.('Support access live-confirmation audit root could not be resolved');
    return false;
  }
  params.log?.(`Support access confirmed live for support_id=${SUPPORT_ACCESS_ID}`);
  return true;
}
