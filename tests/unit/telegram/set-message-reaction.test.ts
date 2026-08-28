import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramAPI } from '../../../src/telegram/api';

// Same fetch-stub shape as send-message.test.ts: queue responses, record calls.
type MockResponse = { status: number; body: any };

let responseQueue: MockResponse[] = [];
let callLog: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  responseQueue = [];
  callLog = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      callLog.push({ url, body });
      const next = responseQueue.shift();
      if (!next) throw new Error('fetch called with no queued response');
      return {
        ok: next.status === 200,
        status: next.status,
        json: async () => next.body,
        text: async () => JSON.stringify(next.body),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TelegramAPI.setMessageReaction', () => {
  it('posts a single-emoji reaction in Telegram reaction shape', async () => {
    responseQueue.push({ status: 200, body: { ok: true, result: true } });
    const api = new TelegramAPI('111:AAA');
    await api.setMessageReaction('chat1', 42, ['👍']);

    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toContain('/setMessageReaction');
    expect(callLog[0].body.chat_id).toBe('chat1');
    expect(callLog[0].body.message_id).toBe(42);
    expect(callLog[0].body.reaction).toEqual([{ type: 'emoji', emoji: '👍' }]);
  });

  it('clears the reaction with an empty emoji array', async () => {
    responseQueue.push({ status: 200, body: { ok: true, result: true } });
    const api = new TelegramAPI('111:AAA');
    await api.setMessageReaction(7, 99, []);

    expect(callLog).toHaveLength(1);
    expect(callLog[0].body.chat_id).toBe(7);
    expect(callLog[0].body.message_id).toBe(99);
    expect(callLog[0].body.reaction).toEqual([]);
  });

  it('surfaces a Telegram API error instead of swallowing it', async () => {
    responseQueue.push({
      status: 400,
      body: { ok: false, description: 'message to react not found' },
    });
    const api = new TelegramAPI('111:AAA');
    await expect(api.setMessageReaction('chat1', 1, ['👍'])).rejects.toThrow();
  });
});
