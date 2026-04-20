import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteSync, ensureDir } from '../../../src/utils/atomic';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual };
});

describe('atomic utilities', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-atomic-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('atomicWriteSync writes data plus newline to target path', () => {
    const targetPath = join(testDir, 'output.txt');

    atomicWriteSync(targetPath, 'hello world');

    expect(readFileSync(targetPath, 'utf-8')).toBe('hello world\n');
  });

  it('atomicWriteSync leaves no temp files behind after success', () => {
    const targetPath = join(testDir, 'result.json');

    atomicWriteSync(targetPath, '{"ok":true}');

    const files = readdirSync(testDir);
    expect(files).toContain('result.json');
    expect(files.filter(file => file.startsWith('.tmp.'))).toEqual([]);
  });

  it('atomicWriteSync creates missing parent directories', () => {
    const targetPath = join(testDir, 'deep', 'nested', 'dir', 'file.txt');

    atomicWriteSync(targetPath, 'created');

    expect(readFileSync(targetPath, 'utf-8')).toBe('created\n');
  });

  it('atomicWriteSync sets file mode to 0o600', () => {
    const targetPath = join(testDir, 'secure.txt');

    atomicWriteSync(targetPath, 'secret');

    expect(statSync(targetPath).mode & 0o777).toBe(0o600);
  });

  it('atomicWriteSync cleans up temp file on write failure', () => {
    const targetPath = join(testDir, 'broken.txt');
    const realWriteFileSync = fs.writeFileSync;

    vi.spyOn(fs, 'writeFileSync').mockImplementation(((path, data, options) => {
      if (String(path).includes('.tmp.')) {
        throw new Error('simulated temp write failure');
      }
      return realWriteFileSync(path, data, options as Parameters<typeof fs.writeFileSync>[2]);
    }) as typeof fs.writeFileSync);

    expect(() => atomicWriteSync(targetPath, 'nope')).toThrow('simulated temp write failure');
    expect(existsSync(targetPath)).toBe(false);
    expect(readdirSync(testDir).filter(file => file.startsWith('.tmp.'))).toEqual([]);
  });

  it('ensureDir creates nested directories recursively', () => {
    const dirPath = join(testDir, 'one', 'two', 'three');

    ensureDir(dirPath);

    expect(statSync(dirPath).isDirectory()).toBe(true);
  });

  it('ensureDir is idempotent when called twice', () => {
    const dirPath = join(testDir, 'repeat', 'path');

    expect(() => {
      ensureDir(dirPath);
      ensureDir(dirPath);
    }).not.toThrow();
  });
});
