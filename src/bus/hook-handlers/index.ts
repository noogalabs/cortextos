// Built-in hook handler registry. Day-3 pre-stage: scaffolds + log_event impl.

import { registerHandler, type HandlerType, type HandlerFn } from '../hooks';
import { logEventHandler } from './log_event';
import { bashSpawnHandler } from './bash_spawn';
import { sendMessageHandler } from './send_message';
import { webhookFetchHandler } from './webhook_fetch';

export { logEventHandler, bashSpawnHandler, sendMessageHandler, webhookFetchHandler };

export const BUILT_IN_HANDLERS: Record<HandlerType, HandlerFn> = {
  log_event: logEventHandler,
  bash: bashSpawnHandler,
  send_message: sendMessageHandler,
  webhook: webhookFetchHandler,
};

/**
 * Register all built-in handlers with the in-process registry.
 * Idempotent: replaces any prior registration for these types.
 * Returns the count registered (always 4).
 */
export function registerBuiltInHandlers(): number {
  let count = 0;
  for (const [type, fn] of Object.entries(BUILT_IN_HANDLERS) as Array<[HandlerType, HandlerFn]>) {
    registerHandler(type, fn);
    count++;
  }
  return count;
}
