import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramPoller, computePollBackoffMs, RETRY_AFTER_CEILING_MS } from '../../../src/telegram/poller';
import type { TelegramAPI } from '../../../src/telegram/api';
import type { TelegramUpdate } from '../../../src/types/index';

function makeMessageUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 1, type: 'private' },
      text,
    },
  };
}

function makeCallbackUpdate(updateId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: 1, is_bot: false, first_name: 'test' },
      data,
    } as any,
  };
}

function makeStubApi(updates: TelegramUpdate[]): { api: TelegramAPI; calls: number[] } {
  const calls: number[] = [];
  const api = {
    getUpdates: vi.fn(async (offset: number) => {
      calls.push(offset);
      const remaining = updates.filter((u) => u.update_id >= offset);
      return { result: remaining };
    }),
  } as unknown as TelegramAPI;
  return { api, calls };
}

describe('TelegramPoller — offset-after-handler', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('advances offset only after message handler succeeds', async () => {
    const { api } = makeStubApi([makeMessageUpdate(100, 'hello')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['hello']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('101');
  });

  it('does NOT advance offset if a message handler throws', async () => {
    const { api } = makeStubApi([makeMessageUpdate(200, 'boom')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onMessage(() => {
      throw new Error('inject failed');
    });

    // Handler errors are caught internally — pollOnce should not throw.
    await expect(poller.pollOnce()).resolves.toBeUndefined();

    // Offset file must not exist (or must still be 0) — update should redeliver.
    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('halts the batch on failure to preserve ordering', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(10, 'first'),
      makeMessageUpdate(11, 'second-will-fail'),
      makeMessageUpdate(12, 'third'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
      if (msg.text === 'second-will-fail') {
        throw new Error('inject failed');
      }
    });

    await poller.pollOnce();

    // First succeeded, second threw, third MUST NOT have run.
    expect(received).toEqual(['first', 'second-will-fail']);

    // Offset should be advanced past the first (11) but not past the second.
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('11');
  });

  it('persists offset per-update so a mid-batch crash preserves confirmed state', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(50, 'a'),
      makeMessageUpdate(51, 'b'),
      makeMessageUpdate(52, 'c'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const offsetsSeenDuringHandling: string[] = [];
    poller.onMessage(() => {
      // Read the persisted file mid-batch to prove per-update persistence.
      const f = join(stateDir, '.telegram-offset');
      offsetsSeenDuringHandling.push(existsSync(f) ? readFileSync(f, 'utf-8').trim() : 'none');
    });

    await poller.pollOnce();

    // Before processing 50, nothing persisted. Before 51, 51 persisted. Before 52, 52 persisted.
    expect(offsetsSeenDuringHandling).toEqual(['none', '51', '52']);

    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('53');
  });

  it('advances offset only after callback handler succeeds', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(300, 'approve')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onCallback((cb) => {
      received.push(cb.data ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['approve']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('301');
  });

  it('does NOT advance offset if a callback handler throws', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(400, 'deny')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onCallback(() => {
      throw new Error('callback broke');
    });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('routes message_reaction updates to registered reaction handlers and advances offset', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 500,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 123,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    const received: Array<{ msgId: number; emoji: string }> = [];
    poller.onReaction((r) => {
      const emoji = r.new_reaction[0]?.type === 'emoji' ? r.new_reaction[0].emoji : '?';
      received.push({ msgId: r.message_id, emoji });
    });

    await poller.pollOnce();

    expect(received).toEqual([{ msgId: 123, emoji: '👍' }]);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('501');
  });

  it('does NOT advance offset if a reaction handler throws', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 600,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 999,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '🔥' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onReaction(() => { throw new Error('reaction broke'); });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });
});

describe('TelegramPoller — poll backoff', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-backoff-'));
    // Silence the diagnostic error logging the backoff path emits.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Group A — pure function, no timers.
  it('grows exponentially then caps at capMs', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      computePollBackoffMs('Telegram API request timed out after 15s: getUpdates', n, 1000, 30000),
    );
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('honors a 429 retry_after hint regardless of attempt', () => {
    const msg = 'Telegram API error: Too Many Requests: retry after 7';
    expect(computePollBackoffMs(msg, 1, 1000, 30000)).toBe(7000);
    expect(computePollBackoffMs(msg, 5, 1000, 30000)).toBe(7000);
  });

  it('floors a retry_after of 0 to 1000ms', () => {
    expect(computePollBackoffMs('retry after 0', 3, 1000, 30000)).toBe(1000);
  });

  it('falls back to the exponential curve when there is no retry_after', () => {
    expect(computePollBackoffMs('Telegram API request failed: boom', 3, 1000, 30000)).toBe(4000);
  });

  it('clamps a retry_after above the ceiling and honors one below it unchanged', () => {
    const ceilingSecs = RETRY_AFTER_CEILING_MS / 1000;
    // Above the ceiling (e.g. a hostile "retry after 3600") is clamped down to it.
    const aboveSecs = ceilingSecs + 300;
    expect(computePollBackoffMs(`retry after ${aboveSecs}`, 1, 1000, 30000)).toBe(RETRY_AFTER_CEILING_MS);
    // Below the ceiling (a realistic flood-control wait that still exceeds the 30s
    // exponential cap) is honored as-is — proving the honor path does not reuse capMs.
    const belowSecs = ceilingSecs - 60;
    expect(computePollBackoffMs(`retry after ${belowSecs}`, 1, 1000, 30000)).toBe(belowSecs * 1000);
  });

  // Group B — loop integration under fake timers.
  function backoffApi(impl: () => Promise<unknown>): TelegramAPI {
    return { getUpdates: vi.fn(impl) } as unknown as TelegramAPI;
  }

  it('backs off exponentially and caps during a sustained error storm', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const delays = () => setTimeoutSpy.mock.calls.map((c) => Number(c[1]));

    const api = backoffApi(async () => {
      throw new Error('Telegram API request timed out after 15s: getUpdates');
    });
    const poller = new TelegramPoller(api, stateDir);
    const running = poller.start();

    // Flush the first pollOnce rejection microtask so the first backoff sleep is scheduled.
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i < 7; i++) {
      const d = delays();
      await vi.advanceTimersByTimeAsync(d[d.length - 1]);
    }

    expect(delays()).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);

    poller.stop();
    const d = delays();
    await vi.advanceTimersByTimeAsync(d[d.length - 1]);
    await running;
  });

  it('honors a 429 retry_after for the first backoff in the loop', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const delays = () => setTimeoutSpy.mock.calls.map((c) => Number(c[1]));

    const api = backoffApi(async () => {
      throw new Error('Telegram API error: Too Many Requests: retry after 5');
    });
    const poller = new TelegramPoller(api, stateDir);
    const running = poller.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(delays()[0]).toBe(5000);

    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await running;
  });

  it('resets the backoff counter after a successful poll', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const delays = () => setTimeoutSpy.mock.calls.map((c) => Number(c[1]));

    let call = 0;
    const api = backoffApi(async () => {
      call++;
      if (call === 3) return { result: [] }; // third poll succeeds
      throw new Error('Telegram API request timed out after 15s: getUpdates');
    });
    const poller = new TelegramPoller(api, stateDir);
    const running = poller.start();

    await vi.advanceTimersByTimeAsync(0); // call1 fail -> 1000
    await vi.advanceTimersByTimeAsync(1000); // call2 fail -> 2000
    await vi.advanceTimersByTimeAsync(2000); // call3 success -> reset -> sleep 1000
    await vi.advanceTimersByTimeAsync(1000); // call4 fail -> attempt 1 again -> 1000

    // fail(1000), fail(2000), success(1000 interval), fail(1000 — NOT 4000)
    expect(delays()).toEqual([1000, 2000, 1000, 1000]);

    poller.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  });

  it('still self-dies on a 409 Conflict without scheduling a backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const api = backoffApi(async () => {
      throw new Error('Telegram API error: Conflict: terminated by other getUpdates request');
    });
    const poller = new TelegramPoller(api, stateDir);
    const running = poller.start();

    await vi.advanceTimersByTimeAsync(0);
    await running;

    expect(poller.lastExitReason).toBe('conflict-self-die');
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
