import { appendFileSync } from 'fs';

// Dynamic import for strip-ansi (ESM module)
let stripAnsi: (text: string) => string;
async function loadStripAnsi() {
  if (!stripAnsi) {
    const mod = await import('strip-ansi');
    stripAnsi = mod.default;
  }
  return stripAnsi;
}

/**
 * Ring buffer for PTY output. Replaces tmux capture-pane.
 * Stores raw output chunks and provides search/retrieval with ANSI stripping.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private maxChunks: number;
  private logPath: string | null;

  constructor(maxChunks: number = 1000, logPath?: string) {
    this.maxChunks = maxChunks;
    this.logPath = logPath || null;
  }

  /**
   * Push new output data into the buffer.
   * Also streams to log file if configured.
   */
  push(data: string): void {
    this.chunks.push(data);
    if (this.chunks.length > this.maxChunks) {
      this.chunks.shift();
    }

    // Stream to log file (replaces tmux pipe-pane)
    if (this.logPath) {
      try {
        appendFileSync(this.logPath, data, 'utf-8');
      } catch {
        // Ignore log write errors
      }
    }
  }

  /**
   * Get the last N chunks of output joined together.
   */
  getRecent(n?: number): string {
    const count = n || this.chunks.length;
    return this.chunks.slice(-count).join('');
  }

  /**
   * Search for a pattern in recent output (ANSI codes stripped).
   * Used for bootstrap detection ("permissions" text).
   */
  async search(pattern: string): Promise<boolean> {
    const strip = await loadStripAnsi();
    const text = strip(this.getRecent());
    return text.includes(pattern);
  }

  /**
   * Synchronous search for simple patterns.
   * Does basic ANSI stripping inline (strips ESC[ sequences).
   */
  searchSync(pattern: string): boolean {
    const text = this.getRecent().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    return text.includes(pattern);
  }

  /**
   * Check if agent has bootstrapped (permissions prompt appeared).
   */
  isBootstrapped(): boolean {
    // Look for Claude Code's status bar which shows "permissions" as a mode indicator.
    // Avoid false positives from the trust folder prompt which also contains permission-related text.
    // The status bar appears after Claude has fully initialized and is ready for input.
    const recent = this.getRecent();
    const cleaned = recent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    // Trust prompt contains "trust this folder" - exclude that
    if (cleaned.includes('trust') && !cleaned.includes('> ')) {
      return false;
    }
    return cleaned.includes('permissions');
  }

  /**
   * Get the total size of buffered output in bytes.
   * Useful for activity detection (typing indicator).
   */
  getSize(): number {
    let size = 0;
    for (const chunk of this.chunks) {
      size += chunk.length;
    }
    return size;
  }

  /**
   * Check whether the recent PTY output contains signatures of an Anthropic
   * API rate-limit or overload response. Used by the daemon to distinguish
   * rate-limit exits from real crashes so it can apply an extended pause
   * instead of the normal crash-backoff cycle.
   *
   * Patterns matched (case-insensitive, ANSI stripped):
   *   - "overloaded_error" / "overloaded" (HTTP 529 body)
   *   - "rate_limit_error" / "rate limit" / "rate-limit"
   *   - "too many requests"
   *   - "quota exceeded" / "usage limit"
   *   - "529"
   */
  hasRateLimitSignature(): boolean {
    // Only scan the last 200 chunks — rate-limit messages appear near session end
    const text = this.chunks.slice(-200).join('').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
    return (
      text.includes('overloaded_error') ||
      text.includes('rate_limit_error') ||
      text.includes('rate limit') ||
      text.includes('rate-limit') ||
      text.includes('too many requests') ||
      text.includes('quota exceeded') ||
      text.includes('usage limit') ||
      // HTTP 529 status line or JSON error code
      (text.includes('529') && (text.includes('overload') || text.includes('error')))
    );
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.chunks = [];
  }
}
