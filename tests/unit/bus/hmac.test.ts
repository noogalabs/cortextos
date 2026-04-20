import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox } from '../../../src/bus/message';
import type { BusPaths } from '../../../src/types';

describe('Message Bus HMAC verification', () => {
  let testDir: string;
  let senderPaths: BusPaths;
  let receiverPaths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-bus-hmac-test-'));
    senderPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'sender'),
      inflight: join(testDir, 'inflight', 'sender'),
      processed: join(testDir, 'processed', 'sender'),
      logDir: join(testDir, 'logs', 'sender'),
      stateDir: join(testDir, 'state', 'sender'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    receiverPaths = {
      ...senderPaths,
      inbox: join(testDir, 'inbox', 'receiver'),
      inflight: join(testDir, 'inflight', 'receiver'),
      processed: join(testDir, 'processed', 'receiver'),
      logDir: join(testDir, 'logs', 'receiver'),
      stateDir: join(testDir, 'state', 'receiver'),
    };
    mkdirSync(join(testDir, 'config'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns a signed message when sender and receiver share the same key', () => {
    writeFileSync(join(testDir, 'config', 'bus-signing-key'), 'shared-key\n');

    const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'signed hello');
    const messages = checkInbox(receiverPaths);

    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(msgId);
    expect(messages[0].text).toBe('signed hello');
    expect(messages[0].sig).toBeTruthy();
  });

  it('rejects a message whose text was tampered after signing', () => {
    writeFileSync(join(testDir, 'config', 'bus-signing-key'), 'shared-key\n');

    sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'original text');

    const inboxFiles = readdirSync(receiverPaths.inbox).filter(file => file.endsWith('.json'));
    const inboxPath = join(receiverPaths.inbox, inboxFiles[0]);
    const payload = JSON.parse(readFileSync(inboxPath, 'utf-8'));
    payload.text = 'tampered text';
    writeFileSync(inboxPath, JSON.stringify(payload));

    const messages = checkInbox(receiverPaths);

    expect(messages).toEqual([]);
    const errorFiles = readdirSync(join(receiverPaths.inbox, '.errors')).filter(file => file.endsWith('.json'));
    expect(errorFiles).toHaveLength(1);
  });

  it('rejects a message when the verification key differs from the signing key', () => {
    const keyPath = join(testDir, 'config', 'bus-signing-key');
    writeFileSync(keyPath, 'key-A\n');

    sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'keyed');
    writeFileSync(keyPath, 'key-B\n');

    const messages = checkInbox(receiverPaths);

    expect(messages).toEqual([]);
    const errorFiles = readdirSync(join(receiverPaths.inbox, '.errors')).filter(file => file.endsWith('.json'));
    expect(errorFiles).toHaveLength(1);
  });

  it('accepts unsigned messages when no signing key is configured', () => {
    const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'legacy hello');
    const messages = checkInbox(receiverPaths);

    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(msgId);
    expect(messages[0].sig).toBeUndefined();
  });
});
