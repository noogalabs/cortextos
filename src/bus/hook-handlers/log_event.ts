// Built-in handler: emits a follow-up bus event whose category/type/severity/meta come from hook.handler.
import { execFile } from 'child_process';
import type { HandlerFn } from '../hooks';
import type { Event } from '../../types/index';

export const logEventHandler: HandlerFn = (hook, event) => {
  const category = hook.handler.category ?? 'action';
  const type = hook.handler.type ?? 'hook_handler_log_event';
  const severity = hook.handler.severity ?? 'info';
  const meta = {
    ...(hook.handler.meta ?? {}),
    source_hook_id: hook.id,
    source_event_id: event.id,
  };
  try {
    execFile(
      'cortextos',
      ['bus', 'log-event', category, type, severity, '--meta', JSON.stringify(meta)],
      { timeout: 5000 },
      () => {},
    );
  } catch {}
  return { action: 'fire', reason: 'event_logged' };
};

export default logEventHandler;
