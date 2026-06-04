import { describe, it, expect } from 'vitest';
import { resolveSafeModel } from '../../../src/pty/codex-app-server-pty.js';

// Regression guard for the 2026-06-04 codie outage: the codex-app-server path
// sent no model on thread/turn requests, so codex-cli 0.130.0 picked its own
// default (gpt-5.3-codex) which the ChatGPT account is not entitled to → 400
// every turn. resolveSafeModel() must ALWAYS return an explicit, entitled model
// string so a request can never fall back to the CLI's unsafe default.
describe('resolveSafeModel', () => {
  it('passes through an allowlisted configured model', () => {
    expect(resolveSafeModel('gpt-5-codex')).toBe('gpt-5-codex');
    expect(resolveSafeModel('gpt-5.5')).toBe('gpt-5.5');
  });

  it('falls back to the default safe model for the unsafe gpt-5.3-codex (the outage model)', () => {
    expect(resolveSafeModel('gpt-5.3-codex')).toBe('gpt-5-codex');
    expect(resolveSafeModel('gpt-5.3-codex-spark')).toBe('gpt-5-codex');
  });

  it('falls back when the model is undefined (no config) — never returns null/undefined', () => {
    const result = resolveSafeModel(undefined);
    expect(result).toBe('gpt-5-codex');
    expect(result).toBeTruthy();
  });

  it('falls back on an empty string', () => {
    expect(resolveSafeModel('')).toBe('gpt-5-codex');
  });

  it('falls back on any unknown/unentitled model', () => {
    expect(resolveSafeModel('gpt-4o')).toBe('gpt-5-codex');
    expect(resolveSafeModel('o3')).toBe('gpt-5-codex');
    expect(resolveSafeModel('totally-made-up')).toBe('gpt-5-codex');
  });

  it('always returns a non-empty string (the core never-null invariant)', () => {
    for (const input of [undefined, '', 'gpt-5.3-codex', 'gpt-5-codex', 'gpt-5.5', 'junk']) {
      const result = resolveSafeModel(input);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
