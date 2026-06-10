import { describe, it, expect } from 'vitest';

// Unit tests for context-threshold % extraction logic.
// These test the regex and ANSI-stripping that Signal 3 uses,
// isolated from the full FastChecker class.

const ANSI_STRIP_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
// Mirrors the production regex in src/daemon/fast-checker.ts (Signal 3 / F7):
// anchor on the "context" suffix of the real status line, model-agnostic.
const CTX_PCT_RE = /(\d{1,3})%[^\n]{0,15}context/;

function extractCtxPct(tail: string): number | null {
  const stripped = tail.replace(ANSI_STRIP_RE, '');
  const m = stripped.match(CTX_PCT_RE);
  return m ? parseInt(m[1], 10) : null;
}

describe('context threshold % extraction', () => {
  it('extracts % from clean status line', () => {
    const tail = '[Sonnet 4.6] main · 33% context used';
    expect(extractCtxPct(tail)).toBe(33);
  });

  it('extracts % from ANSI-escaped status line', () => {
    // ANSI cursor-forward codes (ESC[1C) interspersed between tokens
    const tail = '\x1b[1C[Sonnet\x1b[1C 4.6]\x1b[1C main · 75%\x1b[1C context used';
    expect(extractCtxPct(tail)).toBe(75);
  });

  it('extracts % for Opus model', () => {
    const tail = 'some output\n[Opus 4.5] feature · 82% context used\nmore output';
    expect(extractCtxPct(tail)).toBe(82);
  });

  it('extracts % for Haiku model', () => {
    const tail = '[Haiku 4.5] main · 12% context used';
    expect(extractCtxPct(tail)).toBe(12);
  });

  it('is model-agnostic — extracts % for a non-Claude badge (F7)', () => {
    const tail = '[Fable 5] main · 84% context used';
    expect(extractCtxPct(tail)).toBe(84);
  });

  it('returns null when no status line present', () => {
    const tail = 'normal tool output without a status line';
    expect(extractCtxPct(tail)).toBeNull();
  });

  it('returns null for uppercase log-tag percentages without a context suffix', () => {
    // These false-positived under the old badge-prefix regex.
    for (const tail of [
      '[INFO] download progress 85%',
      '[WARN] retry budget 90%',
      '[ERROR] disk usage 95%',
      '[BUILD] bundle shrunk 88%',
    ]) {
      expect(extractCtxPct(tail)).toBeNull();
    }
  });
});

describe('context threshold cooldown logic', () => {
  it('injection fires when pct >= threshold and not in cooldown', () => {
    const threshold = 70;
    const pct = 75;
    const triggeredAt = 0; // never triggered
    const now = Date.now();
    const COOLDOWN_MS = 10 * 60 * 1000;

    const shouldInject = pct >= threshold &&
      (triggeredAt === 0 || now - triggeredAt > COOLDOWN_MS);
    expect(shouldInject).toBe(true);
  });

  it('no re-injection within cooldown window', () => {
    const threshold = 70;
    const pct = 75;
    const now = Date.now();
    const COOLDOWN_MS = 10 * 60 * 1000;
    const triggeredAt = now - (5 * 60 * 1000); // triggered 5 min ago (within cooldown)

    const shouldInject = pct >= threshold &&
      (triggeredAt === 0 || now - triggeredAt > COOLDOWN_MS);
    expect(shouldInject).toBe(false);
  });

  it('fallback hard restart fires after 15 min of no agent response', () => {
    const threshold = 70;
    const pct = 75;
    const now = Date.now();
    const COOLDOWN_MS = 10 * 60 * 1000;
    const FALLBACK_MS = 15 * 60 * 1000;
    const triggeredAt = now - (16 * 60 * 1000); // triggered 16 min ago

    const inCooldown = now - triggeredAt <= COOLDOWN_MS;
    const shouldFallback = !inCooldown && now - triggeredAt > FALLBACK_MS;
    expect(inCooldown).toBe(false);
    expect(shouldFallback).toBe(true);
  });
});
