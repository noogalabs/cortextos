import { writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync, lstatSync, realpathSync, readlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomically write data to a file by writing to a temp file first,
 * then renaming. Rename is atomic on the same filesystem.
 * Matches the bash pattern: printf > .tmp.file && mv .tmp.file file
 *
 * When `keepBak` is true (default: false), the CURRENT file is copied to
 * `<filePath>.bak` before the rename.  This gives callers a single-step
 * rollback point without the cost of maintaining a full backup chain.
 * The `.bak` write is best-effort — if it fails the main write still proceeds.
 *
 * Symlink-aware: if `filePath` is a symlink (commonly the case for shared
 * fleet agent-instruction files like CLAUDE.md/AGENTS.md/ONBOARDING.md/SKILL.md),
 * the write is routed THROUGH the link to its real target. A naive
 * temp-file + rename onto the link path would replace the symlink with a
 * regular file and detach it from the shared target. For non-symlinks the
 * behavior is byte-identical to a plain atomic create/overwrite.
 */
export function atomicWriteSync(filePath: string, data: string, keepBak = false): void {
  // Resolve the rename DESTINATION. For a symlink we must write through to the
  // real target (and create the temp in the real target's dir so the rename
  // stays same-filesystem/atomic). lstat ENOENT => path does not exist yet,
  // which is the plain atomic-create path and MUST NOT crash.
  let destPath = filePath;
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      // Resolve the link to its real target. For a DANGLING symlink (target
      // does not exist — e.g. the shared target was deleted), realpathSync
      // FOLLOWS the link and throws ENOENT. In that case we must NOT fall back
      // to filePath (that would replace the symlink with a regular file via
      // rename and detach it). Instead resolve the link's INTENDED target from
      // readlinkSync and write THROUGH to create it, leaving the link intact.
      try {
        destPath = realpathSync(filePath);
      } catch {
        // Dangling symlink: write through to the link's declared target.
        // readlinkSync returns the target even when it does not exist; resolve
        // relative targets against the link's own directory.
        destPath = resolve(dirname(filePath), readlinkSync(filePath));
      }
    }
  } catch {
    // lstat ENOENT (or other lstat failure): the path itself is absent —
    // treat as a brand-new file at filePath. This is the create path used for
    // first writes of enabled-agents.json, cron-state.json, config.json,
    // catalog.json, etc. — must not throw here.
  }

  const dir = dirname(destPath);
  mkdirSync(dir, { recursive: true });

  // Best-effort backup of the current file before overwriting. The backup
  // SOURCE is destPath (the real current target — captures live content even
  // through a symlink), but the backup is written at `filePath + '.bak'` (the
  // link/given path). readCronsWithStatus() recovers from `filePath + '.bak'`,
  // so the .bak must land at the given path — NOT the resolved target — for both
  // symlink and non-symlink callers. (For a non-symlink filePath === destPath,
  // so this is byte-identical to a plain backup.)
  if (keepBak && existsSync(destPath)) {
    try {
      copyFileSync(destPath, filePath + '.bak');
    } catch {
      // Ignore backup errors — do not block the main write.
    }
  }

  const tmpPath = join(dir, `.tmp.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmpPath, data + '\n', { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, destPath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}
