import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// PRODUCTION-PATH casualties for per-agent CTX_WHISPER_LANG (heavy-seat F1/F2):
// the message travels through the REAL AgentManager telegram closure and the
// REAL processMediaMessage; only process/transport layers and the final
// transcribeVoice sink are mocked. The assertions read the ACTUAL transcribe
// call arguments — not helper return values.

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string; dir: any; config: any;
    constructor(name: string, dir: any, config?: any) { this.name = name; this.dir = dir; this.config = config ?? {}; }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'running' }; }
    getAgentDir() { return typeof this.dir === 'string' ? this.dir : this.dir?.agentDir; }
    getConfig() { return this.config; }
    injectMessage() { return true; }
    onExit() { /* no-op */ }
    setTelegramHandle() { /* no-op */ }
    onStatusChanged() { /* no-op */ }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    async start() { /* no-op */ }
    stop() { /* no-op */ }
    wake() { /* no-op */ }
    async handleCallback() { /* no-op */ }
    async handleActivityCallback() { /* no-op */ }
    isDuplicate() { return false; }
    queueTelegramMessage() { /* no-op */ }
    static formatTelegramTextMessage(from: string, chatId: any, text: string) {
      return `[tg ${from}/${chatId}] ${text}`;
    }
    static formatTelegramMediaMessage(from: string, chatId: any, media: any) {
      return `[tg-media ${from}/${chatId}] ${JSON.stringify(media)}`;
    }
  },
}));

// Real TelegramAPI would hit HTTP; the media path needs getFile + downloadFile
// to succeed so the voice branch reaches transcription.
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    async getFile() { return { result: { file_path: 'voice/remote.ogg' } }; }
    async downloadFile() { return Buffer.from('fake-ogg-bytes'); }
    async sendMessage() { return { ok: true }; }
    async setMyCommands() { return { ok: true }; }
  },
}));

// Capture every poller's registered message handler, keyed by construction order.
const capturedHandlers: Array<(msg: any) => void> = [];
vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    onMessage(cb: (msg: any) => void) { capturedHandlers.push(cb); }
    onCallback() { /* no-op */ }
    onReaction() { /* no-op */ }
    async start() { /* no-op */ }
    stop() { /* no-op */ }
  },
}));

// Spy the transcription SINK; keep the real validators so the manager's
// extraction-time validation is the code under test.
const transcribeSpy = vi.fn(async () => 'stub transcript');
vi.mock('../../../src/telegram/transcribe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/telegram/transcribe.js')>();
  return { ...actual, transcribeVoice: transcribeSpy };
});

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

function writeAgent(frameworkRoot: string, name: string, whisperLang?: string): string {
  const dir = join(frameworkRoot, 'orgs', 'acme', 'agents', name);
  mkdirSync(dir, { recursive: true });
  const lines = ['BOT_TOKEN=123456:AAAvalidtoken', 'CHAT_ID=1', 'ALLOWED_USER=42'];
  if (whisperLang !== undefined) lines.push(`CTX_WHISPER_LANG=${whisperLang}`);
  writeFileSync(join(dir, '.env'), lines.join('\n') + '\n');
  return dir;
}

function voiceMessage(id: number) {
  return {
    message_id: id,
    date: 1700000000 + id,
    chat: { id: 1 },
    from: { id: 42, first_name: 'Tester' },
    voice: { file_id: `file-${id}`, duration: 2 },
  };
}

describe('per-agent CTX_WHISPER_LANG through the production media path', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-wl-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    capturedHandlers.length = 0;
    transcribeSpy.mockClear();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('F1: two concurrent agents keep DISTINCT languages, read from the actual transcribe call arguments', async () => {
    const alphaDir = writeAgent(frameworkRoot, 'alpha', 'no');
    const betaDir = writeAgent(frameworkRoot, 'beta', 'de');

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    await am.startAgent('alpha', alphaDir, {}, 'acme');
    await am.startAgent('beta', betaDir, {}, 'acme');
    expect(capturedHandlers.length).toBeGreaterThanOrEqual(2);

    // Fire both agents' handlers CONCURRENTLY — the per-agent value must come
    // from each closure, not from any shared/global last-writer state.
    capturedHandlers[0](voiceMessage(101));
    capturedHandlers[1](voiceMessage(102));

    await vi.waitFor(() => expect(transcribeSpy).toHaveBeenCalledTimes(2));

    const langs = transcribeSpy.mock.calls
      .map((call: any[]) => call[1]?.language)
      .sort();
    expect(langs).toEqual(['de', 'no']);
  });

  it('F2: an invalid per-agent code is rejected LOUDLY at startup and never reaches transcription', async () => {
    const gammaDir = writeAgent(frameworkRoot, 'gamma', 'not-a-lang!!');

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    await am.startAgent('gamma', gammaDir, {}, 'acme');

    // Diagnostic at startup, attributed to the agent:
    const warned = logSpy.mock.calls.some((c) =>
      String(c[0]).includes('[gamma]') && String(c[0]).includes("CTX_WHISPER_LANG 'not-a-lang!!'"));
    expect(warned).toBe(true);

    // And the invalid value never travels: the transcribe call gets undefined
    // (daemon default), so whisper never sees the bad code.
    capturedHandlers[0](voiceMessage(103));
    await vi.waitFor(() => expect(transcribeSpy).toHaveBeenCalledTimes(1));
    expect(transcribeSpy.mock.calls[0][1]?.language).toBeUndefined();
  });

  it('F2 control: a valid per-agent code travels unchanged (negative control for the validator)', async () => {
    const deltaDir = writeAgent(frameworkRoot, 'delta', 'pt');

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    await am.startAgent('delta', deltaDir, {}, 'acme');

    capturedHandlers[0](voiceMessage(104));
    await vi.waitFor(() => expect(transcribeSpy).toHaveBeenCalledTimes(1));
    expect(transcribeSpy.mock.calls[0][1]?.language).toBe('pt');

    const warned = logSpy.mock.calls.some((c) => String(c[0]).includes('CTX_WHISPER_LANG'));
    expect(warned).toBe(false);
  });
});
