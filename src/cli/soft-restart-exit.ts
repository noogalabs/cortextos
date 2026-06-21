/**
 * Exit-decision helper for `cortextos bus soft-restart-all`.
 *
 * Extracted from the command closure so the fail-loud behaviour can be
 * unit-tested without mocking IPC/fs. The command attempts EVERY target first
 * (best-effort batch restart), accumulates the failure count, then calls this
 * once: a non-zero exit when ANY agent failed, so a partial batch failure is
 * never silently reported as a full success.
 */
export function softRestartAllExit(
  failed: number,
  total: number,
): { exitCode: number; error?: string } {
  if (failed > 0) {
    return {
      exitCode: 1,
      error: `soft-restart-all: ${failed} of ${total} agent(s) failed to restart.`,
    };
  }
  return { exitCode: 0 };
}
