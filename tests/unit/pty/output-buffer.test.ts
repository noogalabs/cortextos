import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs.appendFileSync so tests don't actually write to disk. We still
// need the real existsSync etc. for other imports in the module graph.
const appendFileSyncMock = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    appendFileSync: (...args: unknown[]) => appendFileSyncMock(...args),
  };
});

const { OutputBuffer } = await import('../../../src/pty/output-buffer');

// Synthetic JWT used across tests. Has the canonical 3-segment shape and
// the `eyJ` header prefix so the redactor matches it. Length exceeds the
// {10,} per-segment minimum.
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXNlc3Npb24taWQifQ.abcdefghij_-abcdefghij';

beforeEach(() => {
  appendFileSyncMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OutputBuffer redaction', () => {
  it('single JWT in a single chunk: redacted in both disk log and in-memory buffer', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`session cookie: authjs.session-token=${FAKE_JWT}\n`);

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const writtenData = String(appendFileSyncMock.mock.calls[0][1]);
    expect(writtenData).toContain('[REDACTED_JWT]');
    expect(writtenData).not.toContain(FAKE_JWT);

    // In-memory ring buffer should also see the redacted form.
    const recent = buf.getRecent();
    expect(recent).toContain('[REDACTED_JWT]');
    expect(recent).not.toContain(FAKE_JWT);
  });

  it('multiple JWTs in one chunk: all redacted', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const another =
      'eyJxxxxxxxxxxxxxx.yyyyyyyyyyyyyyyy.zzzzzzzzzzzzzzzz__';
    buf.push(`a=${FAKE_JWT} b=${another} c=${FAKE_JWT}`);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    // Every JWT-shaped token replaced with the literal redaction marker.
    expect(written).not.toContain(FAKE_JWT);
    expect(written).not.toContain(another);
    const matches = (written.match(/\[REDACTED_JWT\]/g) || []).length;
    expect(matches).toBe(3);
  });

  it('non-JWT PTY data passes through unchanged (regression guard)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // TUI ANSI escapes, regular stdout, plausible-but-too-short alphanum.
    const tuiOutput =
      '\x1b[38;5;114m●\x1b[39m Running tests... version v1.2.3 hash=abc.def.ghi\n';
    buf.push(tuiOutput);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toBe(tuiOutput); // byte-for-byte identical
    expect(written).not.toContain('[REDACTED_JWT]');
  });

  it('bootstrap detection still works after redaction', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // Claude Code's permissions status bar line — contains "permissions"
    // which isBootstrapped() searches for. No JWT in this chunk — the
    // test guards that redaction does not accidentally break the ring
    // buffer's search path.
    buf.push('\x1b[2m ? \x1b[0mfor shortcuts                  permissions: bypass\n');
    expect(buf.isBootstrapped()).toBe(true);
  });

  it('JWT split across a chunk boundary IS redacted (buffer-aware holdback)', () => {
    // Split a JWT across two push() calls — the OS chunk-boundary case
    // that the stateless chunk-local redactor used to miss. push() now
    // holds back the trailing partial-JWT prefix and prepends it to the
    // next chunk, so the reassembled token is redacted before anything
    // reaches the disk log.
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const half1 = FAKE_JWT.slice(0, 40);
    const half2 = FAKE_JWT.slice(40);
    buf.push(`prefix ${half1}`);
    buf.push(`${half2} suffix\n`);

    // First write: only the non-token prefix reaches the log — the
    // partial JWT is held back.
    const firstWrite = String(appendFileSyncMock.mock.calls[0][1]);
    expect(firstWrite).toBe('prefix ');
    expect(firstWrite).not.toContain('eyJ');

    // Second write: held tail + second half reassembled and redacted.
    const secondWrite = String(appendFileSyncMock.mock.calls[1][1]);
    expect(secondWrite).toContain('[REDACTED_JWT]');
    expect(secondWrite).toContain(' suffix');
    expect(secondWrite).not.toContain(FAKE_JWT);

    // The full token never appears anywhere — log or in-memory buffer.
    const allWrites = appendFileSyncMock.mock.calls.map(c => String(c[1])).join('');
    expect(allWrites).not.toContain(FAKE_JWT);
    expect(buf.getRecent()).not.toContain(FAKE_JWT);
    expect(buf.getRecent()).toContain('[REDACTED_JWT]');
  });

  it('JWT split across THREE chunks is still redacted', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`token=${FAKE_JWT.slice(0, 20)}`);
    buf.push(FAKE_JWT.slice(20, 60));
    buf.push(`${FAKE_JWT.slice(60)}\n`);

    const allWrites = appendFileSyncMock.mock.calls.map(c => String(c[1])).join('');
    expect(allWrites).not.toContain(FAKE_JWT);
    expect(allWrites).toContain('[REDACTED_JWT]');
  });

  it('held-back tail is still visible (redacted) via getRecent for bootstrap/activity detection', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const partial = FAKE_JWT.slice(0, 40);
    buf.push(`output ends with a partial token ${partial}`);

    // The partial tail must not silently vanish from the in-memory view —
    // pollers (bootstrap, rate-limit, typing-indicator size checks) read
    // getRecent()/getSize() and need to see the latest bytes.
    expect(buf.getRecent()).toContain('output ends with a partial token');
    expect(buf.getRecent()).toContain(partial);
    expect(buf.getSize()).toBe(`output ends with a partial token ${partial}`.length);
  });

  it('partial-token holdback flushes unredacted when it turns out NOT to be a JWT', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // Looks like a JWT prefix at the boundary, but the next chunk reveals
    // it was ordinary text — everything must flush through unredacted and
    // in the original byte order.
    buf.push('checking eyJsomething');
    buf.push(' else entirely\n');

    const allWrites = appendFileSyncMock.mock.calls.map(c => String(c[1])).join('');
    expect(allWrites).toBe('checking eyJsomething else entirely\n');
    expect(allWrites).not.toContain('[REDACTED_JWT]');
  });

  it('oversized trailing base64 blob is emitted, not held back (MAX_PARTIAL_HOLDBACK cap)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // A legitimate base64-encoded JSON blob (starts with eyJ, no dots)
    // larger than the holdback cap — must NOT be withheld from the log.
    const bigBlob = 'eyJ' + 'A'.repeat(4000);
    buf.push(`payload=${bigBlob}`);

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toContain(bigBlob);
  });

  it('trailing COMPLETE JWT is redacted and emitted immediately (no indefinite holdback)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // Chunk ends exactly at the end of a complete JWT (e.g. last output
    // before the process exits). It must reach the log redacted rather
    // than being withheld forever waiting for a next chunk.
    buf.push(`cookie=${FAKE_JWT}`);

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toBe('cookie=[REDACTED_JWT]');
  });

  it('clear() resets the held-back tail', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`partial ${FAKE_JWT.slice(0, 40)}`);
    buf.clear();
    expect(buf.getRecent()).toBe('');
    expect(buf.getSize()).toBe(0);
  });

  it('short alphanumeric that resembles a truncated JWT is NOT redacted (length guard)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // "eyJab.x.y" has the right header prefix and the right shape but
    // segments are all too short — the {10,} length qualifier must
    // prevent this from matching.
    const shortTokenLike = 'eyJab.x.y';
    buf.push(`debug_token=${shortTokenLike} ok=true\n`);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toContain(shortTokenLike);
    expect(written).not.toContain('[REDACTED_JWT]');
  });
});
