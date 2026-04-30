// Day-3 scaffold: Codex pair lands the real dispatch logic. Until then, this
// returns a benign fire/not_implemented so a hook accidentally configured with
// handler_type: "bash" produces a clean hook_fire(not_implemented) audit
// entry instead of a misleading hook_block(handler_threw) — the latter would
// be indistinguishable from a real guardrail block in the telemetry stream.
import type { HandlerFn } from '../hooks';

export const bashSpawnHandler: HandlerFn = () => {
  return { action: 'fire', reason: 'not_implemented' };
};
